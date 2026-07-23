let hasFetched = false;
let autoCollectInterval = null;
let totalAsinsCollected = 0;

function isSearchPage() {
    return window.location.pathname.includes('/s') && window.location.search.includes('?');
}

function isProductPage() {
    return window.location.pathname.includes('/dp/') || window.location.pathname.includes('/gp/product/');
}

function extractASINs(isAutoSaveMode = false) {
    if (hasFetched && !isAutoSaveMode) return;

    const pageUrl = window.location.href;

    chrome.storage.local.get(['collectedPages', 'autoCollectActive', 'autoPageLimit', 'autoAsinLimit', 'memoryAsins', 'blacklistAsins'], (data) => {
        let collectedPages = data.collectedPages || {};
        let autoCollectActive = data.autoCollectActive || false;
        let autoPageLimit = data.autoPageLimit || Infinity;
        let autoAsinLimit = data.autoAsinLimit || Infinity;
        let memoryAsins = data.memoryAsins || [];
        let blacklistAsins = data.blacklistAsins || [];

        if (collectedPages[pageUrl] && !isAutoSaveMode) {
            hasFetched = true;
            if (autoCollectActive) navigateToNextPage();
            return;
        }

        chrome.storage.local.get(
            ["rating", "feedback", "maxFeedback", "shipping", "asinCount", "minPrice", "maxPrice", "stock", "sort", "bannedWords"],
            (filters) => {
                let collectedASINs = new Set();
                let availableItems = [];

                if (isSearchPage()) {
                    let items = document.querySelectorAll("[data-asin]:not([data-asin=''])") ||
                               document.querySelectorAll("div[data-component-type='s-search-result']");
                    if (!items.length) {
                        items = document.querySelectorAll("div.s-result-item");
                    }

                    if (!items.length) {
                        if(isAutoSaveMode) {
                            chrome.runtime.sendMessage({ action: 'closeSelf' });
                        } else {
                            hasFetched = true;
                            chrome.storage.local.set({ asinList: [] }, () => {
                                chrome.runtime.sendMessage({ asinList: [] });
                                if (autoCollectActive) navigateToNextPage();
                            });
                        }
                        return;
                    }

                    items.forEach((item) => {
                        let productId = item.getAttribute('data-asin');
                        if (!productId || productId.length !== 10 || collectedASINs.has(productId) || blacklistAsins.includes(productId)) return;
                        collectedASINs.add(productId);

                        let productInfo = extractProductInfo(item, filters);
                        if (!productInfo) return;

                        if (applyFilters(productInfo, filters)) {
                            availableItems.push({ asin: productId, price: productInfo.price });
                        }
                    });
                }

                if (isProductPage()) {
                    let productId = document.querySelector('#ASIN')?.value ||
                                   document.querySelector('[name=ASIN]')?.value;
                    if (productId && productId.length === 10 && !collectedASINs.has(productId) && !blacklistAsins.includes(productId)) {
                        collectedASINs.add(productId);
                        let productInfo = extractProductInfo(document.body, filters);
                        if (productInfo && applyFilters(productInfo, filters)) {
                            availableItems.push({ asin: productId, price: productInfo.price });
                        }
                    }
                }
                
                let asinCount = filters.asinCount || 5;
                let asinList = sortAndSelectItems(availableItems, asinCount, filters.sort);

                if (isAutoSaveMode) {
                    if (asinList.length > 0) {
                        chrome.storage.local.get("memoryAsins", (memData) => {
                            let currentMemory = memData.memoryAsins || [];
                            let combinedAsins = [...currentMemory, ...asinList];
                            let uniqueAsins = [...new Set(combinedAsins)];
                            let wasLimited = false;

                            if (uniqueAsins.length > 20000) {
                                uniqueAsins = uniqueAsins.slice(0, 20000);
                                wasLimited = true;
                            }

                            chrome.storage.local.set({ memoryAsins: uniqueAsins }, () => {
                                if (wasLimited) {
                                    chrome.runtime.sendMessage({ notification: "memory_limit_exceeded" });
                                } else {
                                    chrome.runtime.sendMessage({ notification: "ebay_asins_saved", count: asinList.length });
                                }
                                chrome.runtime.sendMessage({ action: 'closeSelf' });
                            });
                        });
                    } else {
                        chrome.runtime.sendMessage({ action: 'closeSelf' });
                    }
                } 
                else {
                    if (!availableItems.length) {
                        hasFetched = true;
                        chrome.storage.local.set({ asinList: [] }, () => {
                            chrome.runtime.sendMessage({ asinList: [] });
                            if (autoCollectActive) navigateToNextPage();
                        });
                        return;
                    }

                    if (autoCollectActive && asinList.length > 0) {
                        let combinedAsins = [...memoryAsins, ...asinList];
                        let uniqueAsins = [...new Set(combinedAsins)];

                        if (uniqueAsins.length > 20000) {
                            uniqueAsins = uniqueAsins.slice(0, 20000);
                            chrome.runtime.sendMessage({ notification: "memory_limit_exceeded" });
                        } else {
                            chrome.runtime.sendMessage({ notification: "saved_to_memory" });
                        }

                        chrome.storage.local.set({ memoryAsins: uniqueAsins }, () => {
                            totalAsinsCollected = uniqueAsins.length;
                            if (totalAsinsCollected >= autoAsinLimit) {
                                stopAutoCollect("auto_collect_asin_limit");
                                return;
                            }
                        });
                    }

                    chrome.storage.local.set({ asinList: asinList }, () => {
                        chrome.runtime.sendMessage({ asinList: asinList });
                        collectedPages[pageUrl] = true;
                        chrome.storage.local.set({ collectedPages: collectedPages }, () => {
                            if (autoCollectActive) {
                                if (totalAsinsCollected >= autoAsinLimit) {
                                    stopAutoCollect("auto_collect_asin_limit");
                                    return;
                                }
                                navigateToNextPage();
                            }
                        });
                    });

                    hasFetched = true;
                }
            }
        );
    });
}

function extractProductInfo(item, filters) {
    try {
        let rating = null;
        const ratingSelectors = [
            'i.a-icon-star > span.a-icon-alt',
            'i.a-icon-star-small > span.a-icon-alt',
            '[aria-label*="out of 5 stars"]',
            '.a-icon-star .a-icon-alt',
            '#averageCustomerReviews [data-hook="average-star-rating"] span'
        ];

        for (const selector of ratingSelectors) {
            const ratingElement = item.querySelector(selector);
            if (ratingElement) {
                let ratingText = ratingElement.textContent || ratingElement.getAttribute("aria-label") || "";
                const match = ratingText.match(/([\d.]+)\s*(out of 5 stars|stars)/i);
                if (match && match[1]) {
                    rating = parseFloat(match[1]);
                    if (rating > 0 && rating <= 5) break;
                }
            }
        }

        let feedback = 0;
        const feedbackSelectors = [
            "[data-hook='total-review-count']",
            "[href*='#customerReviews']",
            "span.a-size-small.puis-normal-weight-text.s-underline-text",
            "[aria-label*='ratings']",
            ".a-size-small.a-link-normal",
            "[class*='rating']"
        ];

        let feedbackElement = null;
        for (const selector of feedbackSelectors) {
            feedbackElement = item.querySelector(selector);
            if (feedbackElement) break;
        }

        if (feedbackElement) {
            let feedbackText = feedbackElement.textContent || feedbackElement.getAttribute("aria-label") || "";
            if (feedbackText.toLowerCase().includes('k')) {
                feedback = parseFloat(feedbackText.match(/[\d.]+/)) * 1000;
            } else if (feedbackText.toLowerCase().includes('m')) {
                feedback = parseFloat(feedbackText.match(/[\d.]+/)) * 1000000;
            } else {
                feedback = parseInt(feedbackText.replace(/[^\d]/g, '')) || 0;
            }
        }

        let deliveryTime = 99;
        let deliveryTextElement = item.querySelector("span.a-color-base, [aria-label*='delivery'], .a-row.a-size-base.a-color-secondary");
        let deliveryText = deliveryTextElement ? (deliveryTextElement.textContent || deliveryTextElement.getAttribute("aria-label") || "").toLowerCase() : "";
        if (deliveryText.match(/one-day|same-day|tomorrow|overnight/i)) deliveryTime = 1;
        else if (deliveryText.match(/two-day|2-day/i)) deliveryTime = 2;
        else if (deliveryText.match(/(\d+)\s*(day|days|gün)/i)) {
            deliveryTime = parseInt(deliveryText.match(/(\d+)\s*(day|days|gün)/i)[1]);
        }

        let isPrime = false;
        if (item.querySelector(".a-icon-prime") ||
            item.querySelector(".a-icon-addon-prime") ||
            item.querySelector(".puis-npa-prime-upsell-blue-color")) {
            isPrime = true;
        }

        let price = null;
        let priceElement = item.querySelector(".sx-price, .s-price, span.a-price > span.a-offscreen, .a-price-whole, [data-a-price='whole']");
        if (priceElement) {
            let priceText = priceElement.textContent || "";
            price = parseFloat(priceText.replace(/[^\d.]/g, "")) || null;
        }

        if (price === null || price < (filters.minPrice || 0) || price > (filters.maxPrice || Infinity)) return null;

        let stock = Infinity;
        let hasStockWarning = false;
        let stockTextElements = item.querySelectorAll('span[aria-label*="left in stock"], span[aria-label*="available"], .a-size-base.a-color-price, #availability span.a-size-base.a-color-price, .a-size-medium, .a-color-price, .a-text-price, [data-a-color="price"]');

        for (let stockElement of stockTextElements) {
            let stockText = stockElement.textContent.trim() || "";
            if (stockText.match(/out of stock|stokta yok/i)) {
                stock = 0;
                break;
            }
            if (stockText.match(/in stock|available|stokta/i)) {
                const stockMatch = stockText.match(/Only (\d+) left in stock|Stokta sadece (\d+) adet kaldı|(\d+) in stock|Only (\d+) available/i);
                if (stockMatch) {
                    stock = parseInt(stockMatch[1] || stockMatch[2] || stockMatch[3] || stockMatch[4]);
                    hasStockWarning = stock <= 15;
                    break;
                }
            }
        }

        let brandElement = item.querySelector("span.a-size-base-plus.a-color-base:not([data-hook='amazons-choice-label']), .a-size-base.a-color-secondary, [id='bylineInfo']");
        let brand = brandElement ? brandElement.textContent.trim().toLowerCase() : "";
        brand = brand.replace(/amazon's choice|amazonun seçimi/gi, '').trim();

        let titleElement = item.querySelector("h2 a span, .a-size-medium.a-color-base.a-text-normal, #productTitle, h2 span:not([data-hook='amazons-choice-label'])");
        let title = titleElement ? titleElement.textContent.trim().toLowerCase() : "";
        title = title.replace(/amazon's choice|amazonun seçimi/gi, '').trim();

        return { rating, feedback, deliveryTime, isPrime, price, stock, hasStockWarning, brand, title };
    } catch (error) {
        return null;
    }
}

function applyFilters(productInfo, filters) {
    const { rating, feedback, maxFeedback, shipping, minPrice, maxPrice, stock: stockFilter, bannedWords } = filters;

    if (rating && productInfo.rating !== null && productInfo.rating < rating) return false;
    if (productInfo.feedback < feedback) return false;
    if (maxFeedback && productInfo.feedback > maxFeedback) return false;
    if (shipping === "prime" && !productInfo.isPrime) return false;
    if (shipping === "1-day" && productInfo.deliveryTime !== 1) return false;
    if (shipping === "2-day" && productInfo.deliveryTime > 2) return false;
    if (productInfo.price < minPrice || productInfo.price > maxPrice) return false;
    if (stockFilter === "exclude_warning" && productInfo.hasStockWarning) return false;
    if (stockFilter !== "ignore" && stockFilter !== "exclude_warning" && productInfo.stock < stockFilter) return false;

    if (bannedWords) {
        const bannedWordsArray = bannedWords.split(',').map(word => word.trim().toLowerCase()).filter(w => w);
        const combinedText = `${productInfo.brand || ''} ${productInfo.title || ''}`.toLowerCase();
        
        const escapeRegExp = (string) => {
            return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        };

        for (const word of bannedWordsArray) {
            const regex = new RegExp(`\\b${escapeRegExp(word)}\\b`);
            if (regex.test(combinedText)) {
                return false;
            }
        }
    }

    const symbols = ['©', '™', '®'];
    const wordsInTitle = (productInfo.title || '').split(/\s+/);
    for (const word of wordsInTitle) {
        for (const symbol of symbols) {
            if (word.includes(symbol)) {
                return false;
            }
        }
    }

    return true;
}

function sortAndSelectItems(items, asinCount, sortType) {
    let sortedItems = [...items];

    switch (sortType) {
        case "price_low_to_high":
            sortedItems.sort((a, b) => {
                if (a.price === null) return 1;
                if (b.price === null) return -1;
                return a.price - b.price;
            });
            break;
        case "price_high_to_low":
            sortedItems.sort((a, b) => {
                if (a.price === null) return 1;
                if (b.price === null) return -1;
                return b.price - a.price;
            });
            break;
        case "random":
            for (let i = sortedItems.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [sortedItems[i], sortedItems[j]] = [sortedItems[j], sortedItems[i]];
            }
            break;
        default:
            break;
    }

    return sortedItems.slice(0, asinCount).map(item => item.asin);
}

function navigateToNextPage() {
    chrome.storage.local.get(['autoPageLimit', 'autoCollectActive', 'visitedPages'], (data) => {
        let autoPageLimit = data.autoPageLimit || Infinity;
        let autoCollectActive = data.autoCollectActive || false;
        let visitedPages = data.visitedPages || [];

        const currentUrl = window.location.href;
        if (!visitedPages.includes(currentUrl)) {
            visitedPages.push(currentUrl);
        }

        if (autoCollectActive && visitedPages.length >= autoPageLimit) {
            chrome.storage.local.set({ visitedPages: [] }, () => {
                stopAutoCollect("auto_collect_page_limit");
            });
            return;
        }

        const nextPageLink = document.querySelector("a.s-pagination-next, .s-pagination-item.s-pagination-next, a[aria-label*='Next page']");
        if (nextPageLink && !nextPageLink.classList.contains('s-pagination-disabled')) {
            chrome.storage.local.set({ visitedPages: visitedPages }, () => {
                window.location.href = nextPageLink.href;
            });
        } else {
            chrome.storage.local.set({ visitedPages: [] }, () => {
                stopAutoCollect("auto_collect_page_limit");
            });
        }
    });
}

function stopAutoCollect(reason) {
    chrome.storage.local.set({ autoCollectActive: false, visitedPages: [] }, () => {
        clearInterval(autoCollectInterval);
        autoCollectInterval = null;
        totalAsinsCollected = 0;
        hasFetched = false;
        chrome.runtime.sendMessage({ autoCollectStopped: true, reason });
    });
}

const urlParams = new URLSearchParams(window.location.search);
const isAutoSaveMode = urlParams.get('indygrab_auto_collect') === 'true';

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.requestASINs) {
        hasFetched = false;
        extractASINs();
    }
    if (message.startAutoCollect) {
        chrome.storage.local.set({ autoCollectActive: true, visitedPages: [] }, () => {
            hasFetched = false;
            totalAsinsCollected = 0;
            extractASINs();
            if (!autoCollectInterval) {
                autoCollectInterval = setInterval(() => {
                    if (!isSearchPage()) {
                        stopAutoCollect("auto_collect_page_limit");
                        return;
                    }
                    hasFetched = false;
                    extractASINs();
                }, 5000);
            }
        });
    }
    if (message.stopAutoCollect) {
        stopAutoCollect("auto_collect_stopped");
    }
    if (message.refreshASINs) {
        hasFetched = false;
        chrome.storage.local.get(['collectedPages', 'visitedPages'], (data) => {
            let collectedPages = data.collectedPages || {};
            let visitedPages = data.visitedPages || [];
            collectedPages[window.location.href] = false;
            visitedPages = visitedPages.filter(url => url !== window.location.href);
            chrome.storage.local.set({ collectedPages, visitedPages }, () => {
                extractASINs();
            });
        });
    }
    if (message.action === 'saveToMemory') {
        const asin = message.product.asin;
        chrome.storage.local.get("memoryAsins", (data) => {
            let memoryAsins = data.memoryAsins || [];
            if (!memoryAsins.includes(asin)) {
                memoryAsins.push(asin);
                if (memoryAsins.length > 20000) {
                    memoryAsins = memoryAsins.slice(-20000);
                    chrome.runtime.sendMessage({ notification: "memory_limit_exceeded" });
                }
                chrome.storage.local.set({ memoryAsins: memoryAsins }, () => {
                    chrome.runtime.sendMessage({ notification: "saved_to_memory" });
                    sendResponse({ success: true });
                });
            } else {
                sendResponse({ success: false, error: 'This ASIN is already in memory.' });
            }
        });
        return true;
    }
});

if (isSearchPage() || isProductPage()) {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => extractASINs(isAutoSaveMode));
    } else {
        extractASINs(isAutoSaveMode);
    }
}
