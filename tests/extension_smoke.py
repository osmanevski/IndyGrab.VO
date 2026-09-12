#!/usr/bin/env python3
"""Headless smoke test for the real unpacked IndyGrab extension.

This test uses an isolated Chromium profile and blocks every HTTP(S) request. It
validates the extension UI with local fixture data; it does not test live sites.
"""

from __future__ import annotations

import base64
from urllib.parse import unquote
import argparse
import json
import sys
import tempfile
import traceback
from pathlib import Path
from typing import Any, Callable

from playwright.sync_api import Page, Playwright, sync_playwright


DEFAULT_EXTENSION_DIR = Path(__file__).resolve().parents[1]
DEFAULT_ARTIFACT_DIR = Path("/private/tmp/indygrab-qa artifacts")
FIXTURE_IMAGE = (
    "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='640' height='480' "
    "viewBox='0 0 640 480'%3E%3Crect width='640' height='480' fill='%23e9edf2'/%3E"
    "%3Cpath d='M160 330h320l-48-176H208z' fill='%2328a36a'/%3E"
    "%3Ccircle cx='252' cy='356' r='28' fill='%23242a32'/%3E"
    "%3Ccircle cx='400' cy='356' r='28' fill='%23242a32'/%3E%3C/svg%3E"
)

FIXTURE_IMAGE = "data:image/svg+xml;base64," + base64.b64encode(unquote(FIXTURE_IMAGE.split(",", 1)[1]).encode()).decode()

def fixture_storage() -> dict[str, Any]:
    return {
        "theme": "dark",
        "language": "tr",
        "potentialProducts": [
            {
                "itemId": "fixture-001",
                "title": "Katlanabilir Kamp Arabası",
                "imageUrl": FIXTURE_IMAGE,
                "sellerName": "north-star-outlet",
                "amazonSearchUrl": "https://www.amazon.com/s?k=folding+camp+wagon",
                "ebayPrice": "$89.90",
                "customerCount": 18,
                "riskScore": 2,
                "riskReason": "Genel ürün; belirgin marka riski yok.",
            },
            {
                "itemId": "fixture-002",
                "title": "Paslanmaz Çelik Mutfak Rafı",
                "imageUrl": FIXTURE_IMAGE,
                "sellerName": "home-lab-supply",
                "amazonSearchUrl": "https://www.amazon.com/s?k=stainless+kitchen+rack",
                "ebayPrice": "$42.50",
                "customerCount": 9,
            },
            {
                "itemId": "fixture-003",
                "title": "Ayarlanabilir Dizüstü Bilgisayar Standı",
                "imageUrl": FIXTURE_IMAGE,
                "sellerName": "desk-works",
                "amazonSearchUrl": "https://www.amazon.com/s?k=adjustable+laptop+stand",
                "ebayPrice": "$31.25",
                "customerCount": 5,
                "fetched": True,
            },
        ],
        "savedSellerLinks": [
            {"url": "https://www.ebay.com/sch/i.html?_ssn=north-star-outlet&_ipg=240", "visited": True},
            {"url": "https://www.ebay.com/sch/i.html?_ssn=home-lab-supply&_ipg=240", "visited": False},
            {"url": "https://www.ebay.com/sch/i.html?_ssn=desk-works&_ipg=240", "visited": False},
        ],
        "memoryAsins": ["B0FIXTURE01", "B0FIXTURE02", "B0FIXTURE03"],
        "analysisQueue": [],
        "sellerBlacklist": {},
        "forbiddenMainCategories": ["Restricted fixture"],
        "forbiddenSubCategories": ["Fixture subcategory"],
        "autoCollectActive": False,
        "asinList": [],
    }


class SmokeRun:
    def __init__(self, artifact_dir: Path) -> None:
        self.artifact_dir = artifact_dir
        self.passed: list[str] = []
        self.failures: list[dict[str, str]] = []
        self.page_errors: list[str] = []
        self.console_errors: list[str] = []
        self.screenshots: list[str] = []

    def check(self, name: str, action: Callable[[], None]) -> None:
        try:
            action()
            self.passed.append(name)
        except Exception as exc:  # Keep running so one visual failure does not hide the rest.
            self.failures.append(
                {
                    "name": name,
                    "error": f"{type(exc).__name__}: {exc}",
                    "traceback": traceback.format_exc(limit=5),
                }
            )

    def screenshot(self, page: Page, name: str) -> None:
        path = self.artifact_dir / name
        page.screenshot(path=str(path), full_page=True)
        self.screenshots.append(str(path))

    def summary(self) -> dict[str, Any]:
        return {
            "kind": "headless-unpacked-extension-smoke",
            "live_sites_tested": False,
            "passed": self.passed,
            "failures": self.failures,
            "page_errors": self.page_errors,
            "console_errors": self.console_errors,
            "screenshots": self.screenshots,
            "ok": not self.failures and not self.page_errors,
        }


def visible_top_sections(page: Page) -> list[str]:
    return page.locator(".container > section").evaluate_all(
        "sections => sections.filter(section => getComputedStyle(section).display !== 'none')"
        ".map(section => section.id)"
    )


def assert_workspace(page: Page, button_selector: str, expected_section: str) -> None:
    button = page.locator(button_selector)
    assert button.count() == 1, f"expected one nav button for {button_selector}, found {button.count()}"
    button.click()
    page.wait_for_function(
        "sectionId => getComputedStyle(document.getElementById(sectionId)).display !== 'none'",
        arg=expected_section,
    )
    assert visible_top_sections(page) == [expected_section]

    # Clicking the active destination again must leave one workspace visible.
    button.click()
    assert visible_top_sections(page) == [expected_section]


def assert_inner_panel(page: Page, expected: str) -> None:
    states = page.locator("#section-amazon > .amazon-panel .tab-content").evaluate_all(
        "panels => Object.fromEntries(panels.map(panel => [panel.id, getComputedStyle(panel).display !== 'none']))"
    )
    assert states.get(expected) is True, states
    assert sum(1 for visible in states.values() if visible) == 1, states


def wait_for_extension_worker(context: Any) -> Any:
    workers = context.service_workers
    if workers:
        return workers[0]
    return context.wait_for_event("serviceworker", timeout=15_000)


def run(playwright: Playwright, extension_dir: Path, artifact_dir: Path, result: SmokeRun) -> None:
    manifest = extension_dir / "manifest.json"
    baseline_path = extension_dir / "docs" / "ui-contract-baseline.json"
    if not manifest.is_file():
        raise FileNotFoundError(f"manifest not found: {manifest}")
    if not baseline_path.is_file():
        raise FileNotFoundError(f"UI baseline not found: {baseline_path}")

    with tempfile.TemporaryDirectory(prefix="indygrab-playwright-profile-") as profile_dir:
        context = playwright.chromium.launch_persistent_context(
            profile_dir,
            channel="chromium",
            headless=True,
            reduced_motion="reduce",
            viewport={"width": 1440, "height": 1000},
            args=[
                f"--disable-extensions-except={extension_dir}",
                f"--load-extension={extension_dir}",
            ],
        )
        try:
            context.route("http://**/*", lambda route: route.abort("blockedbyclient"))
            context.route("https://**/*", lambda route: route.abort("blockedbyclient"))

            worker = wait_for_extension_worker(context)
            extension_id = worker.url.split("/")[2]
            worker.evaluate("data => chrome.storage.local.set(data)", fixture_storage())

            page = context.pages[0] if context.pages else context.new_page()
            page.on("pageerror", lambda error: result.page_errors.append(str(error)))
            page.on(
                "console",
                lambda message: result.console_errors.append(message.text)
                if message.type == "error"
                else None,
            )
            page.goto(f"chrome-extension://{extension_id}/research.html", wait_until="networkidle")
            page.wait_for_function("document.readyState === 'complete'")
            page.wait_for_timeout(750)

            def baseline_ids() -> None:
                baseline = json.loads(baseline_path.read_text(encoding="utf-8"))
                ids = baseline["pages"]["research.html"]["ids"]
                counts = page.evaluate(
                    "ids => Object.fromEntries(ids.map(id => [id, document.querySelectorAll('#' + CSS.escape(id)).length]))",
                    ids,
                )
                invalid = {key: value for key, value in counts.items() if value != 1}
                assert not invalid, f"baseline IDs missing or duplicated: {invalid}"

            result.check("baseline research.html IDs occur exactly once", baseline_ids)

            def seeded_content() -> None:
                page.locator('.nav-btn[data-target="section-products"]').click()
                page.wait_for_selector("#product-list .product-card")
                assert page.locator("#product-list .product-card").count() == 3
                page.locator('.nav-btn[data-target="section-stores"]').click()
                page.wait_for_selector("#store-links-list .store-link-item")
                assert page.locator("#store-links-list .store-link-item").count() == 3

            result.check("representative products, stores, and memory load from extension storage", seeded_content)

            nav_cases = [
                ('.nav-btn[data-target="section-stores"]', "section-stores"),
                ('.nav-btn[data-target="section-products"]', "section-products"),
                ('.nav-btn[data-target="section-queue"]', "section-queue"),
                ('.nav-btn[data-target="section-blacklist"]', "section-blacklist"),
                ('.nav-btn[data-target="section-forbidden-cats"]', "section-forbidden-cats"),
                ('.nav-btn[data-target="section-settings"]', "section-settings"),
            ]
            for selector, section_id in nav_cases:
                result.check(
                    f"navigation keeps only {section_id} visible, including repeat click",
                    lambda selector=selector, section_id=section_id: assert_workspace(page, selector, section_id),
                )

            def amazon_collect_navigation() -> None:
                selector = '.nav-btn[data-target="section-amazon"][data-amazon-tab="collect"]'
                assert_workspace(page, selector, "section-amazon")
                assert_inner_panel(page, "collect")

            def amazon_memory_navigation() -> None:
                selector = '.nav-btn[data-target="section-amazon"][data-amazon-tab="memory"]'
                assert_workspace(page, selector, "section-amazon")
                assert_inner_panel(page, "memory")
                assert page.locator("#memoryOutput .asin-row").count() == 3

            result.check("Amazon collect nav shows only the collect panel", amazon_collect_navigation)
            result.check("Amazon memory nav shows only the populated memory panel", amazon_memory_navigation)

            def filtering_and_no_target() -> None:
                page.locator('.nav-btn[data-target="section-amazon"][data-amazon-tab="collect"]').click()
                page.locator('.tab[data-tab="filtering"]').click()
                assert_inner_panel(page, "filtering")
                page.locator("#filtering details").nth(1).locator("summary").click()
                page.locator("#minPriceFilter").fill("12.5")
                page.locator("#maxPriceFilter").fill("0")
                page.wait_for_function(
                    "async () => { const d = await chrome.storage.local.get(['minPrice', 'maxPrice']);"
                    " return d.minPrice === 12.5 && d.maxPrice === 0; }"
                )
                values = page.evaluate("chrome.storage.local.get(['minPrice', 'maxPrice'])")
                assert values == {"minPrice": 12.5, "maxPrice": 0}
                assert page.locator("#amazon-target-select").is_disabled()
                assert "Amazon sekmesi" in page.locator("#amazon-target-status").inner_text()

            result.check("filters save numeric minimum and zero upper limit without an Amazon tab", filtering_and_no_target)

            settings_ids = [
                "toggleStock",
                "togglePrime",
                "toggleRating",
                "toggleBannedWarning",
                "toggleCopyIcon",
                "toggleSaveIcon",
                "toggleEbayIcon",
                "bsrDisplayMode",
                "ebayChartDefaultDays",
                "ebayChartDisplay",
                "schDisplayMode",
                "schSellerSaleDays",
                "schDisplay7Days",
                "schDisplay14Days",
                "schDisplay30Days",
                "schDataDisplay",
                "schDisplaySold",
                "schDisplayWatchers",
                "schDisplayAvailable",
            ]

            def settings_controls() -> None:
                page.locator('.nav-btn[data-target="section-settings"]').click()
                counts = page.evaluate(
                    "ids => Object.fromEntries(ids.map(id => [id, document.querySelectorAll('#' + CSS.escape(id)).length]))",
                    settings_ids,
                )
                assert all(value == 1 for value in counts.values()), counts

            result.check("moved Amazon and eBay display settings remain present", settings_controls)

            def embedded_tools() -> None:
                count_before = len(context.pages)
                assert page.locator('a[href="titles.html"]').count() == 0
                assert_workspace(page, '.nav-btn[data-target="section-mixer"]', 'section-mixer')
                page.locator('#inputAsins').fill('B0TEST0001\nB0TEST0002\nB0TEST0001')
                page.locator('#mixButton').click()
                assert set(page.locator('#outputAsins').input_value().splitlines()) == {'B0TEST0001','B0TEST0002'}
                page.locator('#duplicatesButton').click()
                assert page.locator('#duplicatesContent').inner_text() == 'B0TEST0001'
                with page.expect_download() as info:
                    page.locator('#downloadButton').click()
                assert set(Path(info.value.path()).read_text().splitlines()) == {'B0TEST0001','B0TEST0002'}
                assert_workspace(page, '.nav-btn[data-target="section-asin-blacklist"]', 'section-asin-blacklist')
                page.locator('#blacklistAsinInput').fill('B0TEST0001')
                page.locator('#addBlacklistBtn').click()
                page.wait_for_function("async () => (await chrome.storage.local.get('blacklistAsins')).blacklistAsins.includes('B0TEST0001')")
                assert 'B0TEST0001' in page.locator('#blacklistOutput').inner_text()
                page.locator('#blacklistFileInput').set_input_files({'name':'asins.txt','mimeType':'text/plain','buffer':b'B0TEST0002\nB0TEST0003'})
                page.locator('#uploadBlacklistBtn').click()
                page.wait_for_function("async () => (await chrome.storage.local.get('blacklistAsins')).blacklistAsins.length === 3")
                assert len(context.pages) == count_before
                page.locator('.nav-btn[data-target="section-amazon"][data-amazon-tab="collect"]').click()
                page.locator('[data-workspace="section-asin-blacklist"]').click()
                assert visible_top_sections(page) == ['section-asin-blacklist']
                result.screenshot(page, 'blacklist-embedded.png')
                page.locator('.nav-btn[data-target="section-mixer"]').click()
                result.screenshot(page, 'mixer-embedded.png')

            result.check('Mixer and ASIN blacklist work within panel without new tabs', embedded_tools)

            def asin_exports() -> None:
                page.locator('.nav-btn[data-target="section-amazon"][data-amazon-tab="memory"]').click()
                with page.expect_download() as info:
                    page.locator('#exportCsvBtn').click()
                lines = Path(info.value.path()).read_text().splitlines()
                assert lines[0] == 'ASIN' and set(lines[1:]) == {'B0FIXTURE01','B0FIXTURE02','B0FIXTURE03'}
                with page.expect_download() as info:
                    page.locator('#exportJsonBtn').click()
                items = json.loads(Path(info.value.path()).read_text())['items']
                assert all(set(item) == {'asin'} for item in items) and len(items) == 3

            result.check('CSV and JSON export ASIN data without title preparation', asin_exports)

            def real_collection_fixture() -> None:
                # Fulfil synthetic HTML locally: the extension runs its real content script,
                # target selection and filters, but no Amazon server is contacted.
                def amazon_fixture(route: Any) -> None:
                    asin = "B0QA000001" if "first" in route.request.url else "B0QA000002"
                    html = "<html><head><title>Fixture Amazon search</title></head><body>" + (
                        '<div data-component-type="s-search-result" data-asin="' + asin + '">'
                        '<h2><span>Plain storage basket</span></h2>'
                        '<span class="a-price"><span class="a-offscreen">$25.00</span></span>'
                        '<i class="a-icon-star"><span>4.5 out of 5 stars</span></i>'
                        '<span aria-label="120 ratings">120</span></div>'
                    ) + "</body></html>"
                    route.fulfill(status=200, content_type="text/html", body=html)
                context.route("https://www.amazon.com/s?*", amazon_fixture)
                first = context.new_page()
                first.goto("https://www.amazon.com/s?k=fixture-first")
                second = context.new_page()
                second.goto("https://www.amazon.com/s?k=fixture-second")
                page.bring_to_front()
                page.locator('.nav-btn[data-target="section-amazon"][data-amazon-tab="collect"]').click()
                page.locator("#amazon-target-refresh").click()
                page.wait_for_function("document.getElementById('amazon-target-select').options.length === 2")
                target_id = page.evaluate("async () => (await chrome.tabs.query({})).find(t => t.url.includes('fixture-first')).id")
                page.locator("#amazon-target-select").select_option(str(target_id))
                page.evaluate("chrome.storage.local.set({asinList: [], collectedPages: {}, visitedPages: [], minPrice: 12.5, maxPrice: 0})")
                page.locator("#updateBtn").click()
                page.wait_for_function("async () => { const d = await chrome.storage.local.get('asinList'); return d.asinList?.length === 1 && d.asinList[0] === 'B0QA000001'; }", timeout=15000)
                assert "B0QA000001" in page.locator("#asinOutput").inner_text()
                page.locator("#saveToMemoryBtn").click()
                page.wait_for_function("async () => (await chrome.storage.local.get('memoryAsins')).memoryAsins.includes('B0QA000001')")
                first.close()
                page.locator("#updateBtn").click()
                page.wait_for_timeout(150)
                assert page.locator("#amazon-target-select").input_value() == ""
                assert "B0QA000002" not in page.evaluate("chrome.storage.local.get('memoryAsins')")["memoryAsins"]
                second.close()
                page.evaluate("chrome.storage.local.set({memoryAsins:['B0FIXTURE01','B0FIXTURE02','B0FIXTURE03'],asinList:[]})")

            result.check("real content-script collection targets selected fixture and saves filtered ASIN", real_collection_fixture)

            def restore_memory_deep_link() -> None:
                page.goto(f"chrome-extension://{extension_id}/research.html#section-amazon/memory", wait_until="networkidle")
                page.reload(wait_until="networkidle")
                page.wait_for_function("document.getElementById('memory').classList.contains('active')")
                assert_inner_panel(page, "memory")
                assert visible_top_sections(page) == ["section-amazon"]

            result.check("reload restores the ASIN pool deep link", restore_memory_deep_link)

            def visual_artifacts() -> None:
                page.set_viewport_size({"width": 1440, "height": 1000})
                page.evaluate("chrome.storage.local.set({theme: 'dark'})")
                page.wait_for_function("document.documentElement.dataset.theme === 'dark'")
                page.locator('.nav-btn[data-target="section-products"]').click()
                result.screenshot(page, "products-dark-1440x1000.png")

                page.locator("#theme-toggle").click()
                page.wait_for_function("document.documentElement.dataset.theme === 'light'")
                stored_theme = page.evaluate("chrome.storage.local.get('theme')")
                assert stored_theme.get("theme") == "light"
                result.screenshot(page, "products-light-1440x1000.png")

                page.locator("#theme-toggle").click()
                page.wait_for_function("document.documentElement.dataset.theme === 'dark'")
                page.locator('.nav-btn[data-target="section-stores"]').click()
                result.screenshot(page, "stores-dark-1440x1000.png")

                page.locator('.nav-btn[data-target="section-amazon"][data-amazon-tab="collect"]').click()
                page.locator('.tab[data-tab="filtering"]').click()
                result.screenshot(page, "amazon-filter-dark-1440x1000.png")

            result.check("dark/light theme toggle and wide visual artifacts", visual_artifacts)

            def narrow_layout(width: int) -> None:
                page.set_viewport_size({"width": width, "height": 1000})
                page.locator('.nav-btn[data-target="section-products"]').click()
                page.wait_for_timeout(100)
                dimensions = page.evaluate(
                    "() => ({docScroll: document.documentElement.scrollWidth, docClient: document.documentElement.clientWidth,"
                    " bodyScroll: document.body.scrollWidth, bodyClient: document.body.clientWidth})"
                )
                assert dimensions["docScroll"] <= dimensions["docClient"], dimensions
                assert dimensions["bodyScroll"] <= dimensions["bodyClient"], dimensions
                result.screenshot(page, f"products-dark-{width}x1000.png")

            result.check("760px viewport has no body overflow", lambda: narrow_layout(760))
            result.check("390px viewport has no body overflow", lambda: narrow_layout(390))

            def no_page_errors() -> None:
                page.wait_for_timeout(250)
                assert not result.page_errors, result.page_errors

            result.check("research page emits no uncaught page errors", no_page_errors)
        finally:
            context.close()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--extension-dir", type=Path, default=DEFAULT_EXTENSION_DIR)
    parser.add_argument("--artifact-dir", type=Path, default=DEFAULT_ARTIFACT_DIR)
    args = parser.parse_args()
    args.artifact_dir.mkdir(parents=True, exist_ok=True)
    result = SmokeRun(args.artifact_dir)

    try:
        with sync_playwright() as playwright:
            run(playwright, args.extension_dir.resolve(), args.artifact_dir.resolve(), result)
    except Exception as exc:
        result.failures.append(
            {
                "name": "smoke test setup",
                "error": f"{type(exc).__name__}: {exc}",
                "traceback": traceback.format_exc(limit=8),
            }
        )

    summary = result.summary()
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0 if summary["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
