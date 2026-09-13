#!/usr/bin/env python3
"""Offline end-to-end test of panel collection in a background window.

A local HTTPS server (throwaway self-signed certificate) plays www.amazon.com through
--host-resolver-rules, so windows the extension opens itself (which Playwright routing
cannot intercept) still stay offline. HTTPS is required: amazon.com is HSTS-preloaded, so
Chrome upgrades any http:// navigation to it.
Checks that auto collect walks pages in its own window, never drives a user's open Amazon
tab, saves the ASINs and closes the window; that a single scan closes after one page; and
that Stop and closing the window both end the session.
"""

from __future__ import annotations

import json
import ssl
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

from playwright.sync_api import sync_playwright

EXT = Path(__file__).resolve().parents[1]
REQUESTS: list[str] = []


def wait_js(page: Any, expression: str, arg: Any = None, timeout: float = 10_000) -> None:
    """Poll a (possibly async) JS predicate; wait_for_function does not await async predicates."""
    deadline = time.monotonic() + timeout / 1000
    while True:
        if page.evaluate(expression, arg) if arg is not None else page.evaluate(expression):
            return
        if time.monotonic() > deadline:
            raise AssertionError(f"timed out after {timeout:.0f} ms waiting for: {expression[:160]}")
        page.wait_for_timeout(100)


def search_html(asin: str, next_href: str | None) -> str:
    item = (
        f'<div data-component-type="s-search-result" data-asin="{asin}">'
        f"<h2><span>Fixture item {asin}</span></h2>"
        '<span class="a-price"><span class="a-offscreen">$25.00</span></span>'
        '<i class="a-icon-star"><span>4.5 out of 5 stars</span></i>'
        '<span aria-label="120 ratings">120</span></div>'
    )
    nxt = f'<a class="s-pagination-next" href="{next_href}">Next</a>' if next_href else ""
    return f"<html><head><title>Fixture search</title></head><body>{item}{nxt}</body></html>"


class FakeAmazon(BaseHTTPRequestHandler):
    def log_message(self, *_args: Any) -> None:
        pass

    def do_GET(self) -> None:  # noqa: N802
        REQUESTS.append(self.path)
        parsed = urlparse(self.path)
        query = parse_qs(parsed.query)
        keyword = query.get("k", [""])[0]
        page = int(query.get("page", ["1"])[0])
        if parsed.path != "/s":
            body, status = "<html><body>not found</body></html>", 404
        elif keyword == "bg":
            body, status = search_html(f"B0BGPAGE0{page}", "/s?k=bg&page=2" if page == 1 else None), 200
        elif keyword == "user-tab":
            body, status = search_html(f"B0USERTAB{page}", f"/s?k=user-tab&page={page + 1}"), 200
        elif keyword == "single":
            body, status = search_html("B0SINGLE01", "/s?k=single&page=2"), 200
        elif keyword == "loop":
            time.sleep(1.2)
            body, status = search_html(f"B0LOOP{page:04d}", f"/s?k=loop&page={page + 1}"), 200
        else:
            body, status = search_html("B0OTHER001", None), 200
        data = body.encode()
        self.send_response(status)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def main() -> int:
    failures: list[str] = []

    def check(condition: bool, message: str) -> None:
        if not condition:
            failures.append(message)

    certs = tempfile.TemporaryDirectory(prefix="indygrab-fake-amazon-cert-")
    cert, key = Path(certs.name, "cert.pem"), Path(certs.name, "key.pem")
    subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
                    "-subj", "/CN=www.amazon.com", "-keyout", str(key), "-out", str(cert)],
                   check=True, capture_output=True)
    server = ThreadingHTTPServer(("127.0.0.1", 0), FakeAmazon)
    tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    tls.load_cert_chain(str(cert), str(key))
    server.socket = tls.wrap_socket(server.socket, server_side=True)
    port = server.server_address[1]
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f"https://www.amazon.com:{port}"

    with sync_playwright() as p, tempfile.TemporaryDirectory(prefix="indygrab-bg-collect-") as profile:
        ctx = p.chromium.launch_persistent_context(
            profile, channel="chromium", headless=True, viewport={"width": 1280, "height": 900},
            ignore_https_errors=True,
            args=[
                f"--disable-extensions-except={EXT}", f"--load-extension={EXT}",
                "--host-resolver-rules=MAP www.amazon.com 127.0.0.1, MAP * ~NOTFOUND",
                "--ignore-certificate-errors",
            ],
        )
        try:
            worker = ctx.service_workers[0] if ctx.service_workers else ctx.wait_for_event("serviceworker", timeout=15_000)
            ext_id = worker.url.split("/")[2]
            worker.evaluate("d => chrome.storage.local.set(d)", {"memoryAsins": [], "asinList": [], "theme": "dark"})
            windows = lambda: worker.evaluate("async () => (await chrome.windows.getAll()).length")

            user_tab = ctx.new_page()
            user_tab.goto(f"{base}/s?k=user-tab")
            panel = ctx.new_page()
            errors: list[str] = []
            panel.on("pageerror", lambda e: errors.append(str(e)))
            panel.goto(f"chrome-extension://{ext_id}/research.html#section-amazon/collect", wait_until="networkidle")
            panel.locator('.nav-btn[data-target="section-amazon"][data-amazon-tab="collect"]').click()
            base_windows = windows()

            # 1) Auto collect: own window walks two pages, the user's tab is left alone.
            panel.locator("#bg-collect-input").fill(f"{base}/s?k=bg")
            panel.locator("#startAutoBtn").click()
            wait_js(panel, "async () => Boolean((await chrome.storage.local.get('bgCollectSession')).bgCollectSession)")
            check(windows() == base_windows + 1, "auto collect should open exactly one extra window")
            check(panel.locator("#stopAutoBtn").is_enabled() and panel.locator("#startAutoBtn").is_disabled(), "buttons while running")
            user_tab.reload()  # a user tab loading a search page while auto collect is active
            wait_js(panel, "async () => !(await chrome.storage.local.get('bgCollectSession')).bgCollectSession", timeout=45_000)
            state = panel.evaluate("chrome.storage.local.get(['memoryAsins', 'bgCollectLast', 'autoCollectActive', 'autoCollectTabId'])")
            check({"B0BGPAGE01", "B0BGPAGE02"} <= set(state["memoryAsins"]), f"auto collect pool: {state['memoryAsins']}")
            check(state["bgCollectLast"]["reason"] == "auto_collect_page_limit", f"auto end reason: {state['bgCollectLast']}")
            check(state["autoCollectActive"] is False and state["autoCollectTabId"] is None, f"flags after auto: {state}")
            wait_js(panel, "async () => (await chrome.windows.getAll()).length === " + str(base_windows), timeout=10_000)
            user_tab.wait_for_timeout(1500)
            check("page=2" not in user_tab.url, f"user tab must not be navigated: {user_tab.url}")
            check(not any(r.startswith("/s?k=user-tab&page=2") for r in REQUESTS), "user tab page 2 was requested")
            check(not any(a.startswith("B0USERTAB") for a in state["memoryAsins"]), "user tab ASINs must not enter the pool")
            check("pencere kapandı" in panel.locator("#bg-collect-status").inner_text(), panel.locator("#bg-collect-status").inner_text())

            # 2) Single scan: one page, list shown, window closes, no navigation.
            panel.locator("#bg-collect-input").fill(f"{base}/s?k=single")
            panel.locator("#updateBtn").click()
            wait_js(panel, "async () => (await chrome.storage.local.get('bgCollectLast')).bgCollectLast?.reason === 'single_done'", timeout=30_000)
            wait_js(panel, "async () => (await chrome.storage.local.get('asinList')).asinList?.includes('B0SINGLE01')")
            check("B0SINGLE01" in panel.locator("#asinOutput").inner_text(), "single scan result shown in panel")
            check(not any(r.startswith("/s?k=single&page=2") for r in REQUESTS), "single scan must not paginate")
            wait_js(panel, "async () => (await chrome.windows.getAll()).length === " + str(base_windows), timeout=10_000)

            # 3) Stop button ends a running auto collect and closes its window.
            panel.locator("#bg-collect-input").fill(f"{base}/s?k=loop")
            panel.locator("#startAutoBtn").click()
            wait_js(panel, "async () => Boolean((await chrome.storage.local.get('bgCollectSession')).bgCollectSession)")
            panel.wait_for_timeout(1500)
            panel.locator("#stopAutoBtn").click()
            wait_js(panel, "async () => (await chrome.storage.local.get('bgCollectLast')).bgCollectLast?.reason === 'stopped_by_user'", timeout=15_000)
            wait_js(panel, "async () => (await chrome.windows.getAll()).length === " + str(base_windows), timeout=10_000)
            check(panel.evaluate("chrome.storage.local.get('autoCollectActive')")["autoCollectActive"] is False, "stop clears auto flag")

            # 4) Closing the background window by hand ends the session too.
            panel.locator("#startAutoBtn").click()
            wait_js(panel, "async () => Boolean((await chrome.storage.local.get('bgCollectSession')).bgCollectSession)")
            worker.evaluate("async () => { const s = (await chrome.storage.local.get('bgCollectSession')).bgCollectSession; await chrome.windows.remove(s.windowId); }")
            wait_js(panel, "async () => (await chrome.storage.local.get('bgCollectLast')).bgCollectLast?.reason === 'window_closed'", timeout=15_000)
            check(panel.evaluate("chrome.storage.local.get('autoCollectActive')")["autoCollectActive"] is False, "closing window clears auto flag")
            check(panel.locator("#startAutoBtn").is_enabled() and panel.locator("#stopAutoBtn").is_disabled(), "buttons after window closed")

            # 5) Empty limits mean no limit (regression: they used to be clamped to 1).
            panel.locator("#autoPageLimit").fill("")
            panel.locator("#autoPageLimit").dispatch_event("change")
            wait_js(panel, "async () => !('autoPageLimit' in (await chrome.storage.local.get('autoPageLimit')))")
            check(panel.locator("#autoPageLimit").input_value() == "", "empty page limit stays empty")
            check(not errors, f"page errors: {errors}")
        finally:
            ctx.close()
            server.shutdown()
            certs.cleanup()

    print(json.dumps({"ok": not failures, "failures": failures, "requests": len(REQUESTS)}, ensure_ascii=False, indent=2))
    return 0 if not failures else 1


if __name__ == "__main__":
    sys.exit(main())
