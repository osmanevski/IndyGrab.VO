(function (root, factory) {
    const api = factory(root.chrome, root.document);

    if (typeof module === "object" && module.exports) {
        module.exports = { createAmazonTarget: factory };
    } else {
        root.IndyGrabAmazonTarget = api;
    }
})(typeof globalThis !== "undefined" ? globalThis : this, function createAmazonTarget(chromeApi, documentApi) {
    "use strict";

    const AMAZON_DOMAINS = [
        "amazon.com",
        "amazon.co.uk",
        "amazon.de",
        "amazon.ca",
        "amazon.com.au"
    ];

    let selectedTabId = null;
    let explicitlySelected = false;
    let initialized = false;

    function isSupportedAmazonUrl(value) {
        try {
            const url = new URL(value);
            const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
            return (url.protocol === "https:" || url.protocol === "http:") &&
                AMAZON_DOMAINS.some(domain => hostname === domain || hostname.endsWith(`.${domain}`));
        } catch (_error) {
            return false;
        }
    }

    function getElements() {
        return {
            select: documentApi && documentApi.getElementById("amazon-target-select"),
            refreshButton: documentApi && documentApi.getElementById("amazon-target-refresh"),
            status: documentApi && documentApi.getElementById("amazon-target-status")
        };
    }

    function setStatus(message, state) {
        const { status } = getElements();
        if (!status) return;
        status.textContent = message;
        status.dataset.state = state || "info";
    }

    function tabLabel(tab) {
        const title = (tab.title || "Amazon").trim();
        try {
            return `${title} — ${new URL(tab.url).hostname}`;
        } catch (_error) {
            return title;
        }
    }

    async function querySupportedTabs() {
        if (!chromeApi || !chromeApi.tabs || !chromeApi.tabs.query) return [];
        const tabs = await chromeApi.tabs.query({});
        return (tabs || []).filter(tab => Number.isInteger(tab.id) && isSupportedAmazonUrl(tab.url));
    }

    function chooseInitialTab(tabs) {
        return tabs.find(tab => tab.active) ||
            tabs.slice().sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0] ||
            null;
    }

    function render(tabs, selectedTab) {
        const { select } = getElements();
        if (select) {
            select.replaceChildren();

            if (tabs.length === 0) {
                const option = documentApi.createElement("option");
                option.value = "";
                option.textContent = "Açık Amazon sekmesi yok";
                select.appendChild(option);
                select.disabled = true;
            } else {
                tabs.forEach(tab => {
                    const option = documentApi.createElement("option");
                    option.value = String(tab.id);
                    option.textContent = tabLabel(tab);
                    option.selected = Boolean(selectedTab && tab.id === selectedTab.id);
                    select.appendChild(option);
                });
                select.disabled = false;
                if (!selectedTab) select.selectedIndex = -1;
            }
        }

        if (selectedTab) {
            setStatus(`Hedef hazır: ${tabLabel(selectedTab)}`, "ready");
        } else if (tabs.length > 0 && explicitlySelected) {
            setStatus("Seçtiğiniz Amazon sekmesi artık kullanılamıyor. Bir hedef seçin.", "error");
        } else {
            setStatus("Devam etmek için desteklenen bir Amazon sekmesi açın.", "empty");
        }
    }

    async function refresh() {
        const tabs = await querySupportedTabs();
        let selectedTab = tabs.find(tab => tab.id === selectedTabId) || null;

        if (!selectedTab && !explicitlySelected) {
            selectedTab = chooseInitialTab(tabs);
            selectedTabId = selectedTab ? selectedTab.id : null;
        } else if (!selectedTab) {
            selectedTabId = null;
        }

        render(tabs, selectedTab);
        return tabs;
    }

    async function getTab() {
        if (!initialized) await initialize();
        if (selectedTabId === null) {
            await refresh();
            if (selectedTabId === null) return null;
        }

        try {
            const tab = await chromeApi.tabs.get(selectedTabId);
            if (tab && isSupportedAmazonUrl(tab.url)) return tab;
        } catch (_error) {
            // The selected tab was closed between discovery and use.
        }

        const wasExplicit = explicitlySelected;
        selectedTabId = null;
        await refresh();
        if (wasExplicit) return null;
        return selectedTabId === null ? null : chromeApi.tabs.get(selectedTabId);
    }

    async function sendMessage(message, knownTab) {
        const tab = knownTab || await getTab();
        if (!tab) {
            const error = new Error("AMAZON_TARGET_UNAVAILABLE");
            error.code = "AMAZON_TARGET_UNAVAILABLE";
            throw error;
        }
        return chromeApi.tabs.sendMessage(tab.id, message);
    }

    async function initialize() {
        if (initialized) return refresh();
        initialized = true;

        const { select, refreshButton } = getElements();
        if (select) {
            select.addEventListener("change", () => {
                const nextId = Number(select.value);
                if (!Number.isInteger(nextId)) return;
                selectedTabId = nextId;
                explicitlySelected = true;
                void refresh();
            });
        }
        if (refreshButton) refreshButton.addEventListener("click", () => void refresh());

        if (chromeApi && chromeApi.tabs) {
            if (chromeApi.tabs.onRemoved) {
                chromeApi.tabs.onRemoved.addListener(tabId => {
                    if (tabId === selectedTabId) void refresh();
                });
            }
            if (chromeApi.tabs.onUpdated) {
                chromeApi.tabs.onUpdated.addListener((tabId, changeInfo) => {
                    if (tabId === selectedTabId && changeInfo.url !== undefined) void refresh();
                });
            }
        }

        return refresh();
    }

    return {
        getTab,
        refresh,
        initialize,
        sendMessage,
        setStatus,
        isSupportedAmazonUrl
    };
});
