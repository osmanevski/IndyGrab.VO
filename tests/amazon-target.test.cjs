const test = require("node:test");
const assert = require("node:assert/strict");

const { createAmazonTarget } = require("../amazon-target.js");

function makeElement() {
    const listeners = new Map();
    return {
        children: [],
        dataset: {},
        disabled: false,
        selectedIndex: 0,
        value: "",
        textContent: "",
        addEventListener(type, listener) {
            listeners.set(type, listener);
        },
        appendChild(child) {
            this.children.push(child);
            if (child.selected) this.value = child.value;
        },
        replaceChildren() {
            this.children = [];
            this.value = "";
        },
        dispatch(type) {
            listeners.get(type)?.();
        }
    };
}

function makeHarness(initialTabs) {
    let tabs = initialTabs.map(tab => ({ ...tab }));
    const sent = [];
    const select = makeElement();
    const refreshButton = makeElement();
    const status = makeElement();
    const elements = {
        "amazon-target-select": select,
        "amazon-target-refresh": refreshButton,
        "amazon-target-status": status
    };
    const chrome = {
        tabs: {
            query: async () => tabs.map(tab => ({ ...tab })),
            get: async id => {
                const tab = tabs.find(candidate => candidate.id === id);
                if (!tab) throw new Error("No tab with id");
                return { ...tab };
            },
            sendMessage: async (id, message) => {
                sent.push({ id, message });
                return { ok: true };
            },
            onRemoved: { addListener() {} },
            onUpdated: { addListener() {} }
        }
    };
    const document = {
        getElementById: id => elements[id] || null,
        createElement: () => makeElement()
    };
    return {
        api: createAmazonTarget(chrome, document),
        select,
        status,
        sent,
        setTabs(nextTabs) {
            tabs = nextTabs.map(tab => ({ ...tab }));
        }
    };
}

test("accepts only the Amazon hosts present in the manifest", () => {
    const { api } = makeHarness([]);
    for (const url of [
        "https://amazon.com/s?k=lamp",
        "http://www.amazon.co.uk/dp/B000000000",
        "https://smile.amazon.de/",
        "https://www.amazon.ca/",
        "https://amazon.com.au/"
    ]) assert.equal(api.isSupportedAmazonUrl(url), true, url);

    for (const url of [
        "https://amazon.com.example.org/",
        "https://notamazon.com/",
        "https://amazon.fr/",
        "ftp://amazon.com/file",
        "not a url"
    ]) assert.equal(api.isSupportedAmazonUrl(url), false, url);
});

test("reports no target when no supported Amazon tab is open", async () => {
    const harness = makeHarness([
        { id: 1, active: true, url: "chrome-extension://id/research.html", title: "IndyGrab" },
        { id: 2, url: "https://amazon.com.example.org/", title: "Deceptive" }
    ]);
    await harness.api.initialize();

    assert.equal(await harness.api.getTab(), null);
    assert.equal(harness.select.disabled, true);
    assert.match(harness.status.textContent, /Amazon sekmesi açın/);
});

test("preserves an explicit target selection across refreshes", async () => {
    const harness = makeHarness([
        { id: 11, active: true, lastAccessed: 10, url: "https://www.amazon.com/a", title: "First" },
        { id: 22, active: false, lastAccessed: 20, url: "https://www.amazon.de/b", title: "Second" }
    ]);
    await harness.api.initialize();
    assert.equal((await harness.api.getTab()).id, 11, "active supported tab is preferred initially");

    harness.select.value = "22";
    harness.select.dispatch("change");
    await harness.api.refresh();
    assert.equal((await harness.api.getTab()).id, 22);

    harness.setTabs([
        { id: 11, active: true, lastAccessed: 30, url: "https://www.amazon.com/a", title: "First" },
        { id: 22, active: false, lastAccessed: 20, url: "https://www.amazon.de/b", title: "Second" }
    ]);
    await harness.api.refresh();
    assert.equal((await harness.api.getTab()).id, 22, "refresh does not override the explicit choice");
});

test("does not silently switch when an explicitly selected target closes", async () => {
    const harness = makeHarness([
        { id: 11, active: true, url: "https://www.amazon.com/a", title: "First" },
        { id: 22, url: "https://www.amazon.de/b", title: "Second" }
    ]);
    await harness.api.initialize();
    harness.select.value = "22";
    harness.select.dispatch("change");
    await harness.api.refresh();

    harness.setTabs([{ id: 11, active: true, url: "https://www.amazon.com/a", title: "First" }]);
    await harness.api.refresh();

    assert.equal(await harness.api.getTab(), null);
    assert.equal(harness.select.disabled, false, "remaining targets can still be selected explicitly");
    assert.match(harness.status.textContent, /artık kullanılamıyor/);
});

test("sends collection commands to the chosen Amazon tab", async () => {
    const harness = makeHarness([
        { id: 31, active: true, url: "chrome-extension://id/research.html", title: "Panel" },
        { id: 32, active: false, lastAccessed: 100, url: "https://www.amazon.ca/s?k=desk", title: "Amazon" }
    ]);
    await harness.api.initialize();
    await harness.api.sendMessage({ startAutoCollect: true });

    assert.deepEqual(harness.sent, [{ id: 32, message: { startAutoCollect: true } }]);
});
