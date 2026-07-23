importScripts('title_generator.js');

let settings = { extensionCookies: {} };
const domainId = 1;
let trackingInterval = null;
let stockTrackingInterval = null;
let trackedAsins = [];
let stockTrackedAsins = [];
let trackingResults = {};
let stockResults = {};
let priceHistory = {};
let timerState = { startTime: Date.now(), remainingTime: 60 * 60, isRunning: false };
let activeScrolls = {};
const CONCURRENT_REQUEST_LIMIT = 5;
const REQUEST_DELAY = 500;
const CACHE_DURATION = 800;
const CAPTCHA_RETRY_DELAY = 120000;
// LOCAL MODE: Uzak sunucu (Google Apps Script) adresi kaldırıldı.
let automationState = 'stopped';
let storeQueue = [];
let activeAutomationTabs = [];
let automationConcurrency = 1;
let automationWindowId = null;
let fetchingTabs = {};
let analysisState = 'stopped';
let activeAnalysisTabs = [];
let analysisWindowId = null;
let autoAiQueue = [];
let isAutoAiRunning = false;
const FETCH_ALL_CONCURRENCY = 5;
let fetchAllState = 'stopped';
let fetchAllQueue = [];
let activeFetchAllTabs = [];

chrome.storage.local.get(['analysisState', 'activeAnalysisTabs', 'analysisWindowId'], (d) => {
    if(d.analysisState) analysisState = d.analysisState;
    if(d.activeAnalysisTabs) activeAnalysisTabs = d.activeAnalysisTabs || [];
    if(d.analysisWindowId) analysisWindowId = d.analysisWindowId;
});

chrome.storage.local.get(['fetchAllState', 'fetchAllQueue', 'activeFetchAllTabs'], (d) => {
    if (d.fetchAllState) fetchAllState = d.fetchAllState;
    if (d.fetchAllQueue) fetchAllQueue = d.fetchAllQueue || [];
    if (d.activeFetchAllTabs) activeFetchAllTabs = d.activeFetchAllTabs || [];
    if (fetchAllState === 'running') processFetchAllQueue();
});

async function validateActiveTabs() {
    try {
        const currentTabs = await chrome.tabs.query({});
        const currentTabIds = new Set(currentTabs.map(t => t.id));
        const originalLength = activeAnalysisTabs.length;
        activeAnalysisTabs = activeAnalysisTabs.filter(t => currentTabIds.has(t.tabId));
        if (activeAnalysisTabs.length !== originalLength) {
            await chrome.storage.local.set({ activeAnalysisTabs });
        }
    } catch (e) {}
}

async function validateAutomationTabs() {
    try {
        const currentTabs = await chrome.tabs.query({});
        const currentTabIds = new Set(currentTabs.map(t => t.id));
        const originalLength = activeAutomationTabs.length;
        activeAutomationTabs = activeAutomationTabs.filter(t => currentTabIds.has(t.tabId));
        if (activeAutomationTabs.length !== originalLength) {
            await chrome.storage.local.set({ activeAutomationTabs });
        }
    } catch (e) {}
}

async function validateFetchAllTabs() {
    try {
        const currentTabs = await chrome.tabs.query({});
        const currentTabIds = new Set(currentTabs.map(t => t.id));
        const originalLength = activeFetchAllTabs.length;
        activeFetchAllTabs = activeFetchAllTabs.filter(t => currentTabIds.has(t.tabId));
        if (activeFetchAllTabs.length !== originalLength) {
            await chrome.storage.local.set({ activeFetchAllTabs });
        }
    } catch (e) {}
}

// "Tümünü Çek" için Amazon'da yığılma olmaması adına AI kuyruğuyla aynı desen:
// aynı anda en fazla FETCH_ALL_CONCURRENCY sekme açık kalır, biri kapanınca sıradaki açılır.
async function processFetchAllQueue() {
    if (fetchAllState !== 'running') return;
    await validateFetchAllTabs();
    while (activeFetchAllTabs.length < FETCH_ALL_CONCURRENCY) {
        const nextIndex = fetchAllQueue.findIndex(item => item.status === 'waiting');
        if (nextIndex === -1) break;
        fetchAllQueue[nextIndex].status = 'active';
        try {
            const tab = await chrome.tabs.create({ url: fetchAllQueue[nextIndex].url, active: false });
            fetchingTabs[tab.id] = fetchAllQueue[nextIndex].itemId;
            activeFetchAllTabs.push({ tabId: tab.id, itemId: fetchAllQueue[nextIndex].itemId });
            await chrome.storage.local.set({ fetchAllQueue, activeFetchAllTabs });
        } catch (e) {
            break;
        }
    }
    const hasWaiting = fetchAllQueue.some(i => i.status === 'waiting');
    if (!hasWaiting && activeFetchAllTabs.length === 0) {
        fetchAllState = 'stopped';
        fetchAllQueue = [];
        await chrome.storage.local.set({ fetchAllState, fetchAllQueue });
        chrome.runtime.sendMessage({ action: 'fetchAllQueueFinished' }).catch(() => {});
    }
}

async function processQueueLoop() {
    if (analysisState !== 'running') return;
    await validateActiveTabs();
    let { analysisQueue = [] } = await chrome.storage.local.get('analysisQueue');
    analysisQueue = analysisQueue.map(item => typeof item === 'string' ? { url: item, status: 'waiting' } : item);
    while (activeAnalysisTabs.length < 7) {
        const nextItemIndex = analysisQueue.findIndex(item => item.status === 'waiting');
        if (nextItemIndex === -1) break;
        const item = analysisQueue[nextItemIndex];
        const analysisUrl = await applyScanMode(item.url, 'idg_analysis');
        analysisQueue[nextItemIndex].status = 'active';
        const tab = await chrome.tabs.create({ url: analysisUrl, active: false, windowId: analysisWindowId || undefined });
        activeAnalysisTabs.push({ tabId: tab.id, url: item.url });
        await chrome.storage.local.set({ analysisQueue, activeAnalysisTabs });
        // Aynı anda 7 sekme birden açılınca hepsi eBay taramasına neredeyse aynı anda
        // başlıyordu; açılışları biraz yayarak ani istek yığılmasını azaltıyoruz.
        if (activeAnalysisTabs.length < 7) await new Promise(r => setTimeout(r, 2000));
    }
    const hasWaiting = analysisQueue.some(i => i.status === 'waiting');
    if (!hasWaiting && activeAnalysisTabs.length === 0) {
        analysisState = 'stopped';
        await chrome.storage.local.set({ analysisState });
        sendSheetLog('Analiz_Kuyrugu_Bitti');
    }
}

async function processAutoAiQueue() {
    if (isAutoAiRunning) return;
    isAutoAiRunning = true;
    while (autoAiQueue.length > 0) {
        const product = autoAiQueue.shift();
        await new Promise(resolve => setTimeout(resolve, 2000));
        let { geminiApiKeys } = await chrome.storage.local.get('geminiApiKeys');
        if (!geminiApiKeys || geminiApiKeys.length === 0) {
            const { geminiApiKey } = await chrome.storage.local.get('geminiApiKey');
            if (geminiApiKey) {
                geminiApiKeys = [geminiApiKey];
                await chrome.storage.local.set({ geminiApiKeys });
            } else {
                autoAiQueue = [];
                break;
            }
        }
        try {
            const result = await analyzeImageWithGemini(
                product.imageUrl,
                product.title,
                product.ebayPrice || "0",
                product.sellerName || "Unknown",
                geminiApiKeys
            );
            if (result && !result.error && result.riskScore !== undefined) {
                const { potentialProducts = [] } = await chrome.storage.local.get("potentialProducts");
                const pIndex = potentialProducts.findIndex(p => p.itemId === product.itemId);
                if (pIndex !== -1) {
                    potentialProducts[pIndex].riskScore = result.riskScore;
                    potentialProducts[pIndex].riskReason = result.reason;
                    await chrome.storage.local.set({ potentialProducts });
                }
            }
        } catch (e) {}
    }
    isAutoAiRunning = false;
}

function broadcastAutomationState() {
    chrome.runtime.sendMessage({ action: 'automationStateUpdate', state: automationState }).catch(error => { });
}

async function markProductAsFetched(itemId) {
    if (!itemId) return;
    try {
        const { potentialProducts = [] } = await chrome.storage.local.get("potentialProducts");
        const productIndex = potentialProducts.findIndex(p => p.itemId === itemId);
        if (productIndex > -1) {
            potentialProducts[productIndex].fetched = true;
            await chrome.storage.local.set({ potentialProducts });
        }
    } catch (e) {}
}

async function cleanUpBlacklist() {
    const { sellerBlacklist = {} } = await chrome.storage.local.get('sellerBlacklist');
    const now = Date.now();
    let updatedBlacklist = {};
    let needsUpdate = false;
    for (const url in sellerBlacklist) {
        const expirationTime = sellerBlacklist[url];
        if (expirationTime > now) {
            updatedBlacklist[url] = expirationTime;
        } else {
            needsUpdate = true;
        }
    }
    if (needsUpdate) {
        await chrome.storage.local.set({ sellerBlacklist: updatedBlacklist });
    }
}

async function syncGlobalBlacklist() {
    // LOCAL MODE: Uzak sunucu senkronizasyonu tamamen kaldırıldı. Blacklist yereldir.
    return;
}

async function sendSheetLog(event, data = {}) {
    // LOCAL MODE: Telemetri tamamen kaldırıldı. Hiçbir veri dışarı gönderilmez.
    return;
}

async function checkAndSendDailyReport() {
    const { lastReportDate } = await chrome.storage.local.get('lastReportDate');
    const today = new Date().toLocaleDateString('tr-TR');
    if (lastReportDate !== today) {
        await sendSheetLog('Günlük_Sistem_Raporu', { status: 'Otomatik Rapor' });
        await syncGlobalBlacklist();
        await chrome.storage.local.set({ lastReportDate: today });
    }
}

// Kayıtlı mağaza linkleri LH_Sold içermeden (temiz) saklanır; Canlı/Satılmış tarama
// modu sekme açılırken burada uygulanır. Böylece mod değişince linkleri yeniden
// eklemek gerekmez ve eski (sold gömülü) kayıtlar da her iki modda çalışır.
async function applyScanMode(rawUrl, flagParam) {
    const { scanMode = 'live' } = await chrome.storage.local.get('scanMode');
    try {
        const url = new URL(rawUrl);
        if (scanMode === 'sold') {
            url.searchParams.set('LH_Sold', '1');
            url.searchParams.set('LH_Complete', '1');
        } else {
            url.searchParams.delete('LH_Sold');
            url.searchParams.delete('LH_Complete');
        }
        if (flagParam) url.searchParams.set(flagParam, 'true');
        return url.toString();
    } catch (e) {
        return rawUrl + (rawUrl.includes('?') ? '&' : '?') + (flagParam ? flagParam + '=true' : '');
    }
}

async function processNextInQueue() {
    if (automationState !== 'running') return;
    await validateAutomationTabs();
    let { storeQueue = [] } = await chrome.storage.local.get('storeQueue');
    storeQueue = storeQueue.map(item => item.status ? item : { ...item, status: 'waiting' });
    while (activeAutomationTabs.length < automationConcurrency) {
        const nextItemIndex = storeQueue.findIndex(item => item.status === 'waiting');
        if (nextItemIndex === -1) break;
        const linkInfo = storeQueue[nextItemIndex];
        const urlToVisit = await applyScanMode(linkInfo.url, 'idg_auto');
        const { savedSellerLinks = [] } = await chrome.storage.local.get('savedSellerLinks');
        const linkIndex = savedSellerLinks.findIndex(l => l.url === linkInfo.url);
        if (linkIndex !== -1) {
            savedSellerLinks[linkIndex].visited = true;
            await chrome.storage.local.set({ savedSellerLinks });
        }
        storeQueue[nextItemIndex].status = 'active';
        try {
            const tab = await chrome.tabs.create({ 
                url: urlToVisit, 
                active: false,
                windowId: automationWindowId || undefined
            });
            activeAutomationTabs.push({ tabId: tab.id, url: linkInfo.url });
            await chrome.storage.local.set({ storeQueue, activeAutomationTabs });
            if (activeAutomationTabs.length < automationConcurrency) await new Promise(r => setTimeout(r, 2000));
        } catch(e) {
            automationState = 'stopped';
            await chrome.storage.local.set({ automationState });
            broadcastAutomationState();
            break;
        }
    }
    const hasWaiting = storeQueue.some(i => i.status === 'waiting');
    if (!hasWaiting && activeAutomationTabs.length === 0) {
        automationState = 'stopped';
        storeQueue = [];
        activeAutomationTabs = [];
        automationWindowId = null;
        await chrome.storage.local.set({ automationState, storeQueue, activeAutomationTabs, automationWindowId });
        broadcastAutomationState();
        sendSheetLog('Otomasyon_Tamamlandı');
    }
}

chrome.tabs.onRemoved.addListener(async (tabId, removeInfo) => {
    const autoTabIndex = activeAutomationTabs.findIndex(t => t.tabId === tabId);
    if (autoTabIndex !== -1) {
        const closedTabInfo = activeAutomationTabs[autoTabIndex];
        activeAutomationTabs.splice(autoTabIndex, 1);
        await chrome.storage.local.set({ activeAutomationTabs });
        const urlToBlacklist = closedTabInfo.url;
        const { sellerBlacklist = {} } = await chrome.storage.local.get('sellerBlacklist');
        const existingBanDate = sellerBlacklist[urlToBlacklist];
        const now = Date.now();
        const isPermanentlyBanned = existingBanDate && existingBanDate > (now + (10000 * 24 * 60 * 60 * 1000));
        if (!isPermanentlyBanned) {
            const expirationDate = Date.now() + (15 * 24 * 60 * 60 * 1000);
            sellerBlacklist[urlToBlacklist] = expirationDate;
            await chrome.storage.local.set({ sellerBlacklist });
        }
        let { storeQueue = [] } = await chrome.storage.local.get('storeQueue');
        const queueIndex = storeQueue.findIndex(item => item.url === closedTabInfo.url && item.status === 'active');
        if (queueIndex !== -1) {
            storeQueue[queueIndex].status = 'completed';
            await chrome.storage.local.set({ storeQueue });
        }
        if (automationState === 'running') {
            processNextInQueue();
        }
    }
    const tabIndex = activeAnalysisTabs.findIndex(t => t.tabId === tabId);
    if (tabIndex !== -1) {
        const closedTabInfo = activeAnalysisTabs[tabIndex];
        activeAnalysisTabs.splice(tabIndex, 1);
        await chrome.storage.local.set({ activeAnalysisTabs });
        let { analysisQueue = [] } = await chrome.storage.local.get('analysisQueue');
        const queueIndex = analysisQueue.findIndex(item => item.url === closedTabInfo.url && item.status === 'active');
        if (queueIndex !== -1) {
            analysisQueue[queueIndex].status = 'completed';
            await chrome.storage.local.set({ analysisQueue });
        }
        processQueueLoop();
    }
    const fetchAllIndex = activeFetchAllTabs.findIndex(t => t.tabId === tabId);
    if (fetchAllIndex !== -1) {
        const closedInfo = activeFetchAllTabs[fetchAllIndex];
        activeFetchAllTabs.splice(fetchAllIndex, 1);
        const qIndex = fetchAllQueue.findIndex(item => item.itemId === closedInfo.itemId && item.status === 'active');
        if (qIndex !== -1) fetchAllQueue[qIndex].status = 'completed';
        await chrome.storage.local.set({ activeFetchAllTabs, fetchAllQueue });
        if (fetchAllState === 'running') processFetchAllQueue();
    }
});

function cookieToString(cookies) {
    if (!Array.isArray(cookies)) return "";
    let result = "";
    cookies.forEach(cookie => {
        if (cookie.value && cookie.value !== "-" && cookie.value !== "delete") {
            result += `${cookie.name}=${cookie.value}; `;
        }
    });
    return result.trim();
}

async function checkPriceAndStock(asin) {
    const existingResult = stockResults[asin] || {};
    if (existingResult.lastUpdated && (Date.now() - existingResult.lastUpdated) / 1000 < CACHE_DURATION) {
        return existingResult;
    }
    const productLink = `https://www.amazon.com/dp/${asin}`;
    try {
        const userCookies = await chrome.cookies.getAll({ url: "https://www.amazon.com" }).catch(() => []);
        if (!userCookies || userCookies.length === 0) {
            return { price: "Error: No Cookies", stock: "Unknown", prime: "Unknown", title: "Login Required", lastUpdated: Date.now(), status: "fail", image: "" };
        }
        const cookieHeader = cookieToString(userCookies);
        await new Promise(resolve => setTimeout(resolve, REQUEST_DELAY));
        const response = await fetch(productLink, {
            method: "GET",
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
                "Accept-Language": "en-US,en;q=0.5",
                "Referer": "https://www.amazon.com",
                "Cookie": cookieHeader,
                "Connection": "keep-alive",
                "Upgrade-Insecure-Requests": "1"
            },
            credentials: "include"
        });
        if (response.status !== 200) {
            return { price: `Error: HTTP ${response.status}`, stock: "Unknown", prime: "Unknown", title: "Network Error", lastUpdated: Date.now(), status: "fail", image: "" };
        }
        const text = await response.text();
        if (!text || text.length < 100) {
            return { price: "Error: Empty Response", stock: "Unknown", prime: "Unknown", title: "Invalid Data", lastUpdated: Date.now(), status: "fail", image: "" };
        }
        const captchaIndicators = [
            /captcha/i,
            /verify your identity/i,
            /enter the characters/i,
            /recaptcha/i,
            /not a robot/i
        ];
        if (captchaIndicators.some(indicator => indicator.test(text))) {
            if (trackingInterval) {
                clearInterval(trackingInterval);
                trackingInterval = null;
            }
            if (stockTrackingInterval) {
                clearInterval(stockTrackingInterval);
                stockTrackingInterval = null;
            }
            chrome.runtime.sendMessage({ type: "captchaDetected", asin }, (response) => {});
            setTimeout(() => {
                if (trackedAsins.length > 0) {
                    trackingInterval = setInterval(trackAsins, 60 * 60 * 1000);
                    trackAsins();
                }
                if (stockTrackedAsins.length > 0) {
                    stockTrackingInterval = setInterval(trackStockAsins, 60 * 60 * 1000);
                    trackStockAsins();
                }
            }, CAPTCHA_RETRY_DELAY);
            return { price: "Error: CAPTCHA Detected", stock: "Unknown", prime: "Unknown", title: "CAPTCHA Required", lastUpdated: Date.now(), status: "fail", image: "" };
        }
        let price = "Unknown";
        const priceSelectors = [
            /<span[^>]*class="[^\"]*a-price[^\"]*"[^>]*>[\s\S]*?<span[^>]*class="a-offscreen"[^>]*>[\$\{\}]*([\d,.]+)/i,
            /<span[^>]*id="priceblock_ourprice"[^>]*>[\$\{\}]*([\d,.]+)/i,
            /<span[^>]*class="a-price-whole"[^>]*>([\d,.]+)/i,
            /<div[^>]*class="a-price"[^>]*>[\s\S]*?<span[^>]*>[\$\{\}]*([\d,.]+)/i,
            /<span[^>]*id="price"[^>]*>[\$\{\}]*([\d,.]+)/i
        ];
        for (const regex of priceSelectors) {
            const match = regex.exec(text);
            if (match) {
                price = `$${match[1]}`;
                break;
            }
        }
        let oldPrice = priceHistory[asin] || "N/A";
        if (price !== "Unknown") {
            priceHistory[asin] = price;
            chrome.storage.local.set({ priceHistory });
        }
        let stock = "Out of Stock";
        const stockButtonSelectors = [
            /<input[^>]*id="add-to-cart-button"[^>]*>/i,
            /<input[^>]*id="buy-now-button"[^>]*>/i,
            /<button[^>]*id="add-to-cart-button"[^>]*>/i,
            /<button[^>]*id="buy-now-button"[^>]*>/i
        ];
        for (const regex of stockButtonSelectors) {
            if (text.match(regex)) {
                stock = "In Stock";
                break;
            }
        }
        let prime = "Not Prime";
        const primeSelector = /<i[^>]*class="[^\"]*a-icon-prime[^\"]*"[^>]*role="img"[^>]*aria-label="prime"[^>]*>/i;
        if (text.match(primeSelector)) {
            prime = "Prime";
        }
        let title = "N/A";
        const titleSelectors = [
            /<span[^>]*id="productTitle"[^>]*class="[^\"]*a-size-large[^\"]*"[^>]*>([\s\S]*?)<\/span>/i,
            /<h1[^>]*id="title"[^>]*class="a-size-large[^>]*>([\s\S]*?)<\/h1>/i,
            /<span[^>]*class="a-size-extra-large"[^>]*>([\s\S]*?)<\/span>/i,
            /<title[^>]*>([\s\S]*?)(?: - Amazon\.com[\s\S]*?)<\/title>/i,
            /<div[^>]*id="productTitle"[^>]*>([\s\S]*?)<\/div>/,
            /<span[^>]*id="[^\"]*title[^\"]*"[^>]*>([\s\S]*?)<\/span>/i
        ];
        for (const regex of titleSelectors) {
            const match = regex.exec(text);
            if (match && match[1]) {
                let rawTitle = match[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
                if (rawTitle) {
                    title = rawTitle.length > 100 ? rawTitle.substring(0, 100) + "..." : rawTitle;
                    break;
                }
            }
        }
        let image = "";
        const landingImageBlockSelector = /<span[^>]*class="a-declarative"[^>]*data-action="main-image-click"[^>]*>[\s\S]*?<img[^>]*src=["'](.*?\.jpg)["'][^>]*?(?:data-old-hires=["'](.*?\.jpg)["'])?[^>]*?(?:data-a-dynamic-image=["'](.*?)["'])?[^>]*>/i;
        let imageMatch = text.match(landingImageBlockSelector);
        if (imageMatch) {
            const hiresImage = imageMatch[2];
            if (hiresImage) {
                image = hiresImage;
            } else if (imageMatch[3]) {
                try {
                    const dynamicImages = JSON.parse(imageMatch[3].replace(/"/g, '"'));
                    let maxSize = 0;
                    let largestImage = "";
                    for (const [url, dimensions] of Object.entries(dynamicImages)) {
                        const size = dimensions[0];
                        if (size > maxSize) {
                            maxSize = size;
                            largestImage = url;
                        }
                    }
                    image = largestImage || imageMatch[1];
                } catch (e) {
                    image = imageMatch[1];
                }
            } else {
                image = imageMatch[1];
            }
        } else {
            const ivLargeImageSelector = /<div[^>]*id="ivLargeImage"[^>]*>[\s\S]*?<img[^>]*src=["'](.*?\.jpg)["'][^>]*>/i;
            imageMatch = text.match(ivLargeImageSelector);
            if (imageMatch) {
                image = imageMatch[1];
            }
        }
        if (image) {
            image = image.replace(/\._+AC_([A-Z09_]+?)(\.jpg|\.webp)/g, "._AC_SL1500$2");
        }
        const status = (response.status === 200 && price !== "Unknown" && stock !== "Unknown" && title !== "N/A" && image && prime !== "Unknown") ? "success" : "fail";
        return { price, oldPrice, prime, stock, title, lastUpdated: Date.now(), status, image };
    } catch (err) {
        return { price: "Error: " + err.message, oldPrice: "N/A", prime: "Unknown", stock: "Unknown", title: "Error", lastUpdated: Date.now(), status: "fail", image: "" };
    }
}

async function trackAsins() {
    const chunks = [];
    for (let i = 0; i < trackedAsins.length; i += CONCURRENT_REQUEST_LIMIT) {
        chunks.push(trackedAsins.slice(i, i + CONCURRENT_REQUEST_LIMIT));
    }
    for (const chunk of chunks) {
        const promises = chunk.map(asin => checkPriceAndStock(asin).then(result => {
            trackingResults[asin] = result;
        }));
        await Promise.all(promises);
    }
    chrome.runtime.sendMessage({ type: "trackingUpdate", results: trackingResults }, (response) => {});
    chrome.storage.local.set({ trackingResults });
}

async function trackStockAsins() {
    const chunks = [];
    for (let i = 0; i < stockTrackedAsins.length; i += CONCURRENT_REQUEST_LIMIT) {
        chunks.push(stockTrackedAsins.slice(i, i + CONCURRENT_REQUEST_LIMIT));
    }
    for (const chunk of chunks) {
        const promises = chunk.map(asin => checkPriceAndStock(asin).then(result => {
            stockResults[asin] = result;
        }));
        await Promise.all(promises);
    }
    chrome.runtime.sendMessage({ type: "stockTrackingUpdate", results: stockResults }, (response) => {});
    chrome.storage.local.set({ stockResults });
}

function updateTimer() {
    chrome.storage.local.get("timerState", (data) => {
        let currentTimerState = data.timerState || { startTime: Date.now(), remainingTime: 60 * 60, isRunning: false };
        if (!currentTimerState.isRunning) {
            return;
        }
        let elapsed = Math.floor((Date.now() - currentTimerState.startTime) / 1000);
        let timeLeft = 60 * 60 - elapsed;
        if (timeLeft <= 0) {
            currentTimerState.isRunning = false;
            currentTimerState.remainingTime = 0;
        } else {
            currentTimerState.remainingTime = timeLeft;
        }
        chrome.storage.local.set({ timerState: currentTimerState }, () => {
            try {
                chrome.runtime.sendMessage({ type: "timerUpdate" }, (response) => {
                    if (chrome.runtime.lastError) {
                        setTimeout(() => {
                            chrome.runtime.sendMessage({ type: "timerUpdate" });
                        }, 1000);
                    }
                });
            } catch (e) {}
        });
    });
    checkAndSendDailyReport();
}

async function getOrCreateFolder(folderName, parentId = '1') {
    const searchResults = await chrome.bookmarks.search({ title: folderName });
    const existingFolder = searchResults.find(bookmark => bookmark.parentId === parentId && !bookmark.url);
    if (existingFolder) {
        return existingFolder.id;
    } else {
        const newFolder = await chrome.bookmarks.create({
            parentId: parentId,
            title: folderName
        });
        return newFolder.id;
    }
}

const aiResultCache = new Map();

async function analyzeImageWithGemini(imageUrl, title, price, seller, apiKeys) {
    if (aiResultCache.has(imageUrl)) return aiResultCache.get(imageUrl);
const prompt = `ROLE: You are an elite, highly vigilant risk assessment AI for Amazon-to-eBay dropshippers. Your absolute priority is to protect the seller's account from suspensions caused by VeRO strikes, Design Patents, dangerous goods, and compliance violations.

PRODUCT DETAILS:
- Title: "${title}"
- Price: ${price}
- Seller: ${seller}

STRICT SCORING RULES (1-10):

1. TRULY SAFE (Score 1-3): 
- Generic, unbranded utility items, plain household goods, standard unpatented accessories, clothing with generic patterns. NO complex electronics.

2. MODERATE RISK (Score 4-6): 
- Simple wired electronics (basic USB cables), unbranded cosmetics/supplements, basic mechanical tools. Requires human review.

3. HIGH RISK / VeRO TRAPS (Score 7-10) - FLAG IMMEDIATELY:
- MAJOR BRANDS & VeRO: Apple, Nike, Lego, Disney, Sony, etc.
- WIRELESS & ELECTRONICS: Items with Bluetooth, Wi-Fi, or 2.4GHz (FCC/compliance risk).
- HAZMAT & BATTERIES: Lithium batteries, rechargeable items, flammables.
- DESIGN PATENTS: Items with highly specific, modern, or "ergonomic" molds (e.g., vertical mice).
- MEDICAL & WEAPONS: FDA-approved products, drugs, knives, tactical gear.
- VISUAL COPYRIGHTS: The image contains celebrity faces, movie characters, or hidden brand logos/watermarks not mentioned in the title.

CRITICAL EXCEPTION (Aftermarket Rule): 
If the title contains 'compatible with', 'for', or 'fits' (E.g., 'Clear Case for iPhone 15') AND the original brand's logo is ABSOLUTELY NOT on the product image, consider this generic/safe (Score 1-3). However, if the target brand's logo is visible on the image, immediately score it 10.

OUTPUT FORMAT:
Return ONLY a raw, valid JSON object without markdown blocks.
- "riskScore" must be an integer.
- "reason" must be MAXIMUM 5 WORDS stating the main risk (e.g., "Lithium battery hazard", "VeRO brand violation", "Safe generic product").

Example Output:
{"riskScore": 9, "reason": "VeRO brand violation (Nike)"}`;
    try {
        const imgRes = await fetch(imageUrl);
        if(!imgRes.ok) return { error: true, reason: "Görsel indirilemedi" };
        const blob = await imgRes.blob();
        const bitmap = await createImageBitmap(blob);
        let { width, height } = bitmap;
        const maxDim = 1024; 
        if (width > maxDim || height > maxDim) {
            if (width > height) { height = Math.round((height * maxDim) / width); width = maxDim; }
            else { width = Math.round((width * maxDim) / height); height = maxDim; }
        }
        const canvas = new OffscreenCanvas(width, height);
        const ctx = canvas.getContext('2d');
        ctx.drawImage(bitmap, 0, 0, width, height);
        const compressedBlob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.8 });
        const base64 = await new Promise(r => {
            const reader = new FileReader();
            reader.onloadend = () => r(reader.result.split(',')[1]);
            reader.readAsDataURL(compressedBlob);
        });
        const targetModel = "gemini-3.1-flash-lite";
        for (const apiKey of apiKeys) {
            const url = `https://generativelanguage.googleapis.com/v1beta/models/${targetModel}:generateContent?key=${apiKey}`;
            const res = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: "image/jpeg", data: base64 } }] }],
                    safetySettings: [
                        { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
                        { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
                        { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
                        { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }
                    ],
                    generationConfig: { 
                        responseMimeType: "application/json",
                        responseSchema: {
                            type: "OBJECT",
                            properties: {
                                riskScore: { type: "INTEGER", minimum: 1, maximum: 10 },
                                reason: { type: "STRING" }
                            },
                            required: ["riskScore", "reason"]
                        },
                        thinkingConfig: { thinkingLevel: "LOW" },
                        temperature: 0,
                        maxOutputTokens: 80
                    }
                })
            });
            if (res.status === 429) continue;
            if (!res.ok) continue;
            const data = await res.json();
            if (!data.candidates || data.candidates.length === 0) {
                let blockReason = data.promptFeedback?.blockReason || "Güvenlik Engeli";
                return { error: true, reason: "API: " + blockReason };
            }
            const text = data.candidates[0]?.content?.parts?.[0]?.text;
            if (text) {
                try {
                    let cleanText = text.replace(/```json/gi, '').replace(/```/g, '').trim();
                    const startIdx = cleanText.indexOf('{');
                    const endIdx = cleanText.lastIndexOf('}');
                    if (startIdx !== -1 && endIdx !== -1) {
                        cleanText = cleanText.substring(startIdx, endIdx + 1);
                    }
                    const result = JSON.parse(cleanText);
                    let finalScore = result.riskScore ?? result.score ?? result.risk_score ?? result.RiskScore ?? result.puan ?? 0;
                    let finalReason = result.reason ?? result.explanation ?? result.Reason ?? result.sebep ?? "Bilinmiyor";
                    result.riskScore = parseInt(finalScore) || 0;
                    result.reason = finalReason;
                    aiResultCache.set(imageUrl, result);
                    return result;
                } catch (parseErr) {
                    return { error: true, reason: "Parse Hata" };
                }
            } else {
                 return { error: true, reason: "Boş Yanıt" };
            }
        }
        return { error: true, reason: "Çalışan API Key Yok" };
    } catch (e) {
        return { error: true, reason: "Bağlantı Hatası" };
    }
}

async function compareImagesWithGemini(mainImageUrl, targetImageUrl, apiKeys) {
const prompt = `
    Compare these two images strictly.
    Image 1 is the reference product.
    Image 2 is a candidate product.
    CRITERIA FOR MATCH:
    1. Identical object shape and design.
    2. Identical camera angle and perspective.
    3. Identical lighting and shadows.
    4. Identical positioning of the object in the frame.
    STEP 1: Analyze the differences in angle, lighting, background, and object details.
    STEP 2: Conclude if they are derived from the EXACT SAME source photograph (ignoring minor resolution differences).
    Output JSON ONLY in this format:
    {
      "analysis": "Brief step-by-step comparison...",
      "isMatch": true/false
    }
    `;
    try {
        const [img1, img2] = await Promise.all([mainImageUrl, targetImageUrl].map(async (url) => {
            const res = await fetch(url);
            if (!res.ok) throw new Error("Görsel indirilemedi");
            const blob = await res.blob();
            const data = await new Promise(r => {
                const reader = new FileReader();
                reader.onloadend = () => r(reader.result.split(',')[1]);
                reader.readAsDataURL(blob);
            });
            return { data, mimeType: blob.type || 'image/jpeg' };
        }));
        const targetModel = "gemini-3.1-flash-lite";
        for (const apiKey of apiKeys) {
            const url = `https://generativelanguage.googleapis.com/v1beta/models/${targetModel}:generateContent?key=${apiKey}`;
            const payload = {
                contents: [{
                    parts: [
                        { text: prompt },
                        { inline_data: { mime_type: img1.mimeType, data: img1.data } },
                        { inline_data: { mime_type: img2.mimeType, data: img2.data } }
                    ]
                }],
                generationConfig: {
                    responseMimeType: "application/json",
                    responseSchema: {
                        type: "OBJECT",
                        properties: {
                            analysis: { type: "STRING" },
                            isMatch: { type: "BOOLEAN" }
                        },
                        required: ["analysis", "isMatch"]
                    },
                    thinkingConfig: { thinkingLevel: "LOW" },
                    temperature: 0,
                    maxOutputTokens: 200
                }
            };
            const res = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            if (res.status === 429) continue;
            if (!res.ok) continue;
            const data = await res.json();
            const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
            if (text) {
                const jsonStr = text.replace(/```json|```/g, '').trim();
                return JSON.parse(jsonStr);
            }
        }
        return { error: true, reason: "API Hatası" };
    } catch (e) {
        return { error: true, reason: "Bağlantı/Görsel Hatası" };
    }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === "analyzeProductRisk") {
        (async () => {
            let { geminiApiKeys } = await chrome.storage.local.get('geminiApiKeys');
            if (!geminiApiKeys || geminiApiKeys.length === 0) {
                const { geminiApiKey } = await chrome.storage.local.get('geminiApiKey');
                if (geminiApiKey) {
                    geminiApiKeys = [geminiApiKey];
                    await chrome.storage.local.set({ geminiApiKeys }); 
                } else {
                    sendResponse({ error: true, reason: "Key Yok" });
                    return;
                }
            }
            const result = await analyzeImageWithGemini(
                message.imageUrl, 
                message.title, 
                message.price, 
                message.seller, 
                geminiApiKeys
            );
            sendResponse(result);
        })();
        return true;
    }
    if (message.action === "compareImages") {
        (async () => {
            let { geminiApiKeys } = await chrome.storage.local.get('geminiApiKeys');
            if (!geminiApiKeys || geminiApiKeys.length === 0) {
                const { geminiApiKey } = await chrome.storage.local.get('geminiApiKey');
                if (geminiApiKey) geminiApiKeys = [geminiApiKey];
                else {
                    sendResponse({ error: true, reason: "Key Yok" });
                    return;
                }
            }
            const result = await compareImagesWithGemini(
                message.mainImageUrl,
                message.targetImageUrl,
                geminiApiKeys
            );
            sendResponse(result);
        })();
        return true;
    }
    if (message.action === "initiateSmoothScroll") {
        const tabId = sender.tab.id;
        if (!tabId || activeScrolls[tabId]) {
            sendResponse({ status: "already_running_or_invalid" });
            return true;
        }
        const scrollStep = 10;
        const scrollInterval = 30;
        activeScrolls[tabId] = setInterval(async () => {
            try {
                const results = await chrome.scripting.executeScript({
                    target: { tabId: tabId },
                    func: (step) => {
                        window.scrollBy(0, step);
                        return (window.innerHeight + window.scrollY) >= document.body.scrollHeight;
                    },
                    args: [scrollStep]
                });
                if (results && results[0] && results[0].result === true) {
                    clearInterval(activeScrolls[tabId]);
                    delete activeScrolls[tabId];
                }
            } catch (error) {
                clearInterval(activeScrolls[tabId]);
                delete activeScrolls[tabId];
            }
        }, scrollInterval);
        sendResponse({ status: "started" });
        return true;
    }
    if (message.action === "createBookmark") {
        (async () => {
            try {
                const folderId = await getOrCreateFolder("IndyGrab.VO");
                await chrome.bookmarks.create({ parentId: folderId, title: message.title, url: message.url });
                sendResponse({ status: "success" });
            } catch (error) {
                sendResponse({ status: "error", message: error.toString() });
            }
        })();
        return true;
    }
    if (message.action === "openTabInBackground") {
        (async () => {
            const tab = await chrome.tabs.create({ 
                url: message.url, 
                active: false,
                windowId: sender.tab.windowId 
            });
            if (message.itemId) {
                fetchingTabs[tab.id] = message.itemId;
            }
            sendResponse({ status: "success" });
        })();
        return true;
    }
    if (message.action === "startFetchAllQueue") {
        (async () => {
            if (fetchAllState === 'running') {
                sendResponse({ status: "already_running", total: fetchAllQueue.length });
                return;
            }
            const { potentialProducts = [] } = await chrome.storage.local.get("potentialProducts");
            const toFetch = potentialProducts.filter(p => !p.fetched);
            if (toFetch.length === 0) {
                sendResponse({ status: "empty" });
                return;
            }
            fetchAllQueue = toFetch.map(p => ({ itemId: p.itemId, url: p.amazonSearchUrl + '&indygrab_auto_collect=true', status: 'waiting' }));
            fetchAllState = 'running';
            activeFetchAllTabs = [];
            await chrome.storage.local.set({ fetchAllState, fetchAllQueue, activeFetchAllTabs });
            processFetchAllQueue();
            sendResponse({ status: "started", total: fetchAllQueue.length });
        })();
        return true;
    }
    if (message.action === "getFetchAllQueueStatus") {
        sendResponse({
            state: fetchAllState,
            total: fetchAllQueue.length,
            remaining: fetchAllQueue.filter(i => i.status !== 'completed').length,
            active: activeFetchAllTabs.length
        });
        return true;
    }
    if (message.action === 'closeSelf') {
        if (sender.tab && sender.tab.id) {
            const tabId = sender.tab.id;
            const itemId = fetchingTabs[tabId];
            if (itemId) {
                markProductAsFetched(itemId);
                delete fetchingTabs[tabId];
            }
            chrome.tabs.remove(tabId);
            sendResponse({ status: "success" });
        } else {
            sendResponse({ status: "error", message: "Tab ID not found." });
        }
        return true;
    }
    if (message.action === "solveCaptcha") {
        (async () => {
            try {
                const tab = await chrome.tabs.create({ 
                    url: message.url, 
                    active: false,
                    windowId: sender.tab.windowId
                });
                setTimeout(async () => {
                    try {
                        const currentTabInfo = await chrome.tabs.get(tab.id);
                        if (currentTabInfo) await chrome.tabs.remove(tab.id);
                    } catch (e) {} finally {
                        if (sender.tab && sender.tab.id) {
                            chrome.tabs.sendMessage(sender.tab.id, { action: "captchaSolved" }).catch(e => {});
                        }
                    }
                }, 2000);
                sendResponse({ status: "solving" });
            } catch (error) {
                sendResponse({ status: "error", message: error.toString() });
            }
        })();
        return true;
    }
    if (message.action === "removePotentialProduct") {
        (async () => {
            const { potentialProducts = [] } = await chrome.storage.local.get("potentialProducts");
            const updatedProducts = potentialProducts.filter(p => p.itemId !== message.itemId);
            await chrome.storage.local.set({ potentialProducts: updatedProducts });
            sendResponse({ status: "success" });
        })();
        return true;
    }
    if (message.action === "clearPotentialProducts") {
        (async () => {
            await chrome.storage.local.set({ potentialProducts: [] });
            sendResponse({ status: "success" });
            sendSheetLog('Potansiyel_Ürünler_Temizlendi');
        })();
        return true;
    }
    if (message.action === "addPotentialProduct") {
        (async () => {
            const { potentialProducts = [] } = await chrome.storage.local.get("potentialProducts");
            const isAlreadyAdded = potentialProducts.some(p => p.itemId === message.product.itemId);
            if (!isAlreadyAdded) {
                potentialProducts.unshift(message.product);
                await chrome.storage.local.set({ potentialProducts });
                autoAiQueue.push(message.product);
                processAutoAiQueue();
                sendResponse({ status: "success", added: true });
            } else {
                sendResponse({ status: "success", added: false, message: "Already exists." });
            }
        })();
        return true;
    }
    if (message.action === "getPotentialProducts") {
        (async () => {
            const { potentialProducts = [] } = await chrome.storage.local.get("potentialProducts");
            sendResponse({ status: "success", products: potentialProducts });
        })();
        return true;
    }
    if (message.action === 'automationControl') {
        (async () => {
            switch (message.command) {
                case 'start':
                    automationConcurrency = message.concurrency || 1; 
                    if (sender.tab && sender.tab.windowId) {
                        automationWindowId = sender.tab.windowId;
                        await chrome.storage.local.set({ automationWindowId });
                    }
                    if (automationState === 'paused') {
                        automationState = 'running';
                        await chrome.storage.local.set({ automationState });
                        broadcastAutomationState();
                        processNextInQueue();
                    } else {
                        const { savedSellerLinks = [], sellerBlacklist = {} } = await chrome.storage.local.get(['savedSellerLinks', 'sellerBlacklist']);
                        const now = Date.now();
                        const linksToProcess = savedSellerLinks.filter(link => {
                            const expirationDate = sellerBlacklist[link.url];
                            if (expirationDate && expirationDate > now) {
                                return false; 
                            }
                            return true;
                        });
                        if (linksToProcess.length === 0) {
                            sendResponse({ status: 'no_links' });
                            return;
                        }
                        storeQueue = linksToProcess.map(link => ({ url: link.url, status: 'waiting' }));
                        automationState = 'running';
                        activeAutomationTabs = []; 
                        await chrome.storage.local.set({ automationState, storeQueue, activeAutomationTabs });
                        broadcastAutomationState();
                        processNextInQueue();
                    }
                    sendResponse({ status: 'started' });
                    sendSheetLog('Otomasyon_Başlatıldı');
                    break;
                case 'pause':
                    if (automationState === 'running') {
                        automationState = 'paused';
                        await chrome.storage.local.set({ automationState });
                        broadcastAutomationState();
                        sendResponse({ status: 'paused' });
                        sendSheetLog('Otomasyon_Durduruldu');
                    } else {
                        sendResponse({ status: 'not_running' });
                    }
                    break;
                case 'stop':
                    automationState = 'stopped';
                    storeQueue = [];
                    automationWindowId = null;
                    activeAutomationTabs = [];
                    await chrome.storage.local.set({ automationState, storeQueue, automationWindowId, activeAutomationTabs });
                    broadcastAutomationState();
                    sendResponse({ status: 'stopped' });
                    sendSheetLog('Otomasyon_Sonlandırıldı');
                    break;
            }
        })();
        return true;
    }
    if (message.action === "controlAnalysisQueue") {
        (async () => {
            if (message.command === "start") {
                if (sender.tab && sender.tab.windowId) {
                    analysisWindowId = sender.tab.windowId;
                    await chrome.storage.local.set({ analysisWindowId });
                }
                analysisState = 'running';
                await chrome.storage.local.set({ analysisState });
                processQueueLoop();
                sendSheetLog('Analiz_Kuyrugu_Baslatildi');
            } else if (message.command === "stop") {
                analysisState = 'stopped';
                analysisWindowId = null;
                await chrome.storage.local.set({ analysisState, analysisWindowId });
            }
            sendResponse({ status: "ok" });
        })();
        return true;
    }
    if (message.action === "forceProcessItem") {
        (async () => {
            if (activeAnalysisTabs.length >= 7) {
                sendResponse({ status: "full", message: "Limit full" });
                return;
            }
            let { analysisQueue = [] } = await chrome.storage.local.get('analysisQueue');
            const index = message.index;
            if (analysisQueue[index] && analysisQueue[index].status === 'waiting') {
                const item = analysisQueue[index];
                const analysisUrl = await applyScanMode(item.url, 'idg_analysis');
                analysisQueue[index].status = 'active';
                const tab = await chrome.tabs.create({ url: analysisUrl, active: false, windowId: analysisWindowId || undefined });
                activeAnalysisTabs.push({ tabId: tab.id, url: item.url });
                await chrome.storage.local.set({ analysisQueue, activeAnalysisTabs });
                if (analysisState === 'stopped') {
                    analysisState = 'running';
                    await chrome.storage.local.set({ analysisState });
                }
                sendResponse({ status: "success" });
            } else {
                sendResponse({ status: "error", message: "Not found." });
            }
        })();
        return true;
    }
    if (message.action === 'getAutomationState') {
        sendResponse({ state: automationState });
        return true;
    }
    if (message.action === 'addSellerLinks') {
        (async () => {
            const { savedSellerLinks = [] } = await chrome.storage.local.get('savedSellerLinks');
            sendSheetLog('Mağaza_Linkleri_Eklendi', { count: message.count });
            sendResponse({ status: 'success' });
        })();
        return true;
    }
    if (message.action === 'clearSellerLinks') {
        (async () => {
            await chrome.storage.local.set({ savedSellerLinks: [] });
            sendSheetLog('Mağaza_Linkleri_Temizlendi');
            sendResponse({ status: 'success' });
        })();
        return true;
    }
    if (message.asinList) {
        sendResponse({ status: "received" });
        return true;
    }
    if (message.action === "blockStoreForever") {
        (async () => {
            let urlToBlock = message.url;
            const autoTabIndex = activeAutomationTabs.findIndex(t => t.tabId === sender.tab.id);
            if (autoTabIndex !== -1) {
                urlToBlock = activeAutomationTabs[autoTabIndex].url;
            }
            const { sellerBlacklist = {} } = await chrome.storage.local.get('sellerBlacklist');
            const foreverDate = Date.now() + (36135 * 24 * 60 * 60 * 1000); 
            sellerBlacklist[urlToBlock] = foreverDate;
            await chrome.storage.local.set({ sellerBlacklist });
            sendResponse({ status: "success" });
            // LOCAL MODE: Blacklist girişi yalnızca yerelde saklanır, sunucuya gönderilmez.
        })();
        return true;
    }
    if (message.action === "forceSyncBlacklist") {
        syncGlobalBlacklist().then(() => {
            sendResponse({ status: "success" });
        });
        return true;
    }
});

function updateBadge() {
    chrome.storage.local.get("memoryAsins", (data) => {
        let memoryAsins = data.memoryAsins || [];
        chrome.action.setBadgeText({ text: memoryAsins.length > 0 ? memoryAsins.length.toString() : '' });
        chrome.action.setBadgeBackgroundColor({ color: '#FF0000' });
    });
}

updateBadge();

chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.memoryAsins) {
        updateBadge();
    }
});

chrome.runtime.onInstalled.addListener(() => {
    cleanUpBlacklist();
    checkAndSendDailyReport();
    chrome.storage.local.set({ activeAnalysisTabs: [], activeAutomationTabs: [], activeFetchAllTabs: [] });
    syncGlobalBlacklist();
});

chrome.runtime.onStartup.addListener(() => {
    checkAndSendDailyReport();
    chrome.storage.local.set({ activeAnalysisTabs: [], activeAutomationTabs: [], activeFetchAllTabs: [] });
    syncGlobalBlacklist();
});

chrome.storage.local.get([
    "extensionCookies", "trackedAsins", "stockAsins", "trackingResults", "stockResults", "priceHistory", "timerState",
    "automationState", "storeQueue", "activeAutomationTabs", "automationWindowId"
], data => {
    if (data.extensionCookies) settings.extensionCookies = JSON.parse(data.extensionCookies);
    if (data.trackedAsins) trackedAsins = data.trackedAsins;
    if (data.stockAsins) stockTrackedAsins = data.stockAsins;
    if (data.trackingResults) trackingResults = data.trackingResults;
    if (data.stockResults) stockResults = data.stockResults;
    if (data.priceHistory) priceHistory = data.priceHistory;
    if (data.timerState) timerState = data.timerState;
    if (data.automationState) automationState = data.automationState;
    if (data.storeQueue) storeQueue = data.storeQueue;
    if (data.activeAutomationTabs) activeAutomationTabs = data.activeAutomationTabs || [];
    if (data.automationWindowId) automationWindowId = data.automationWindowId;
    cleanUpBlacklist();
    if (automationState === 'running' && activeAutomationTabs.length === 0) {
        automationState = 'paused';
        chrome.storage.local.set({ automationState });
    }
    if (trackedAsins.length > 0) trackAsins();
    if (timerState.isRunning) updateTimer();
});

setInterval(updateTimer, 1000);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'checkLicenseOnPopupOpen') {
        // LOCAL MODE: Lisans doğrulaması devre dışı. Her zaman aktif kabul edilir.
        chrome.storage.local.set({ licenseStatus: 'active', licenseMessage: 'Yerel Mod' });
    }
});
