let detailsQueue = [];
let titleQueue = [];
let isProcessingDetails = false;
let isProcessingTitles = false;
let processingDetailsAsin = null;
let processingTitleAsin = null;
let stopRequested = false;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === "queueForDetails") {
        stopRequested = false;
        const newAsins = message.asins.filter(a => !detailsQueue.includes(a) && processingDetailsAsin !== a);
        if (newAsins.length > 0) {
            detailsQueue.push(...newAsins);
            processDetailsQueue();
        }
        sendResponse({status: "queued"});
    }
    if (message.action === "queueForTitleGeneration") {
        stopRequested = false;
        const newAsins = message.asins.filter(a => !titleQueue.includes(a) && processingTitleAsin !== a);
        if (newAsins.length > 0) {
            titleQueue.push(...newAsins);
            processTitleQueue();
        }
        sendResponse({status: "queued"});
    }
    if (message.action === "stopQueues") {
        stopRequested = true;
        detailsQueue = [];
        titleQueue = [];
        sendResponse({status: "stopped"});
    }
    if (message.action === "getTitleQueueStatus") {
        sendResponse({ 
            detailsQueue: detailsQueue, 
            titleQueue: titleQueue, 
            processingDetails: processingDetailsAsin,
            processingTitle: processingTitleAsin 
        });
    }
});

function checkBannedWords(text, bannedWordsString) {
    if (!bannedWordsString) return null;
    const bannedWordsArray = bannedWordsString.split(',').map(w => w.trim().toLowerCase()).filter(w => w);
    const lowerText = text.toLowerCase();
    const escapeRegExp = (string) => string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    
    for (const word of bannedWordsArray) {
        const regex = new RegExp(`\\b${escapeRegExp(word)}\\b`);
        if (regex.test(lowerText)) return word; 
    }
    return null;
}

async function processDetailsQueue() {
    if (isProcessingDetails) return;
    isProcessingDetails = true;

    while (detailsQueue.length > 0 && !stopRequested) {
        const asin = detailsQueue.shift();
        processingDetailsAsin = asin;
        chrome.runtime.sendMessage({ action: "titleGenerationUpdate" });
        
        try {
            const details = await fetchAmazonDetails(asin);
            const { bannedWords = "" } = await chrome.storage.local.get("bannedWords");
            const combinedText = `${details.title} ${details.description}`;
            const bannedMatch = checkBannedWords(combinedText, bannedWords);
            const { generatedTitles = {} } = await chrome.storage.local.get("generatedTitles");
            
            generatedTitles[asin] = {
                ...(generatedTitles[asin] || {}),
                amazonTitle: details.title,
                description: details.description,
                bannedMatch: bannedMatch
            };
            
            await chrome.storage.local.set({ generatedTitles });

            if (!bannedMatch) {
                if (!titleQueue.includes(asin) && processingTitleAsin !== asin) {
                    titleQueue.push(asin);
                    processTitleQueue(); 
                }
            }

        } catch (error) {}
        
        processingDetailsAsin = null;
        chrome.runtime.sendMessage({ action: "titleGenerationUpdate" });
        await new Promise(resolve => setTimeout(resolve, 1000)); 
    }

    isProcessingDetails = false;
}

async function processTitleQueue() {
    if (isProcessingTitles) return;
    isProcessingTitles = true;

    while (titleQueue.length > 0 && !stopRequested) {
        const asin = titleQueue.shift();
        processingTitleAsin = asin;
        chrome.runtime.sendMessage({ action: "titleGenerationUpdate" });
        
        try {
            const { generatedTitles: tempTitles = {} } = await chrome.storage.local.get("generatedTitles");
            const data = tempTitles[asin];
            
            if (!data || !data.description || data.bannedMatch) {
                processingTitleAsin = null;
                continue;
            }

            let { geminiApiKeys } = await chrome.storage.local.get('geminiApiKeys');
            if (!geminiApiKeys || geminiApiKeys.length === 0) {
                const { geminiApiKey } = await chrome.storage.local.get('geminiApiKey');
                if (geminiApiKey) geminiApiKeys = [geminiApiKey];
                else {
                    processingTitleAsin = null;
                    continue;
                }
            }

            const newTitle = await generateEbayTitle(data.amazonTitle, data.description, geminiApiKeys);

            if (newTitle && !newTitle.error) {
                const { generatedTitles = {} } = await chrome.storage.local.get("generatedTitles");
                generatedTitles[asin] = {
                    ...(generatedTitles[asin] || {}),
                    aiTitle: newTitle
                };
                await chrome.storage.local.set({ generatedTitles });
            }
        } catch (error) {}
        
        processingTitleAsin = null;
        chrome.runtime.sendMessage({ action: "titleGenerationUpdate" });
        await new Promise(resolve => setTimeout(resolve, 2000)); 
    }

    isProcessingTitles = false;
}

async function fetchAmazonDetails(asin) {
    try {
        const response = await fetch(`https://www.amazon.com/dp/${asin}`);
        const text = await response.text();
        
        const decodeEntities = (str) => {
            return str.replace(/&#(\d+);/g, (match, dec) => String.fromCharCode(dec))
                      .replace(/&amp;/g, '&')
                      .replace(/&quot;/g, '"')
                      .replace(/&lt;/g, '<')
                      .replace(/&gt;/g, '>')
                      .replace(/&apos;/g, "'")
                      .replace(/&#x27;/gi, "'");
        };

        let title = "Amazon Ürünü";
        const titleMatch = text.match(/<span[^>]*id="productTitle"[^>]*>([\s\S]*?)<\/span>/i);
        if (titleMatch && titleMatch[1]) {
            let rawTitle = titleMatch[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
            title = decodeEntities(rawTitle);
        }

        let descriptionParts = [];
        const featureMatch = text.match(/<div[^>]*id="feature-bullets"[^>]*>([\s\S]*?)<\/ul>/i);
        if (featureMatch && featureMatch[1]) descriptionParts.push(featureMatch[1]);

        const descMatch = text.match(/<div[^>]*id="productDescription"[^>]*>([\s\S]*?)<\/div>/i);
        if (descMatch && descMatch[1]) descriptionParts.push(descMatch[1]);

        const aplusMatch = text.match(/<div[^>]*id="aplus"[^>]*>([\s\S]*?)<\/div>/i);
        if (aplusMatch && aplusMatch[1]) descriptionParts.push(aplusMatch[1]);

        const importantInfoMatch = text.match(/<div[^>]*id="importantInformation"[^>]*>([\s\S]*?)<\/div>/i);
        if (importantInfoMatch && importantInfoMatch[1]) descriptionParts.push(importantInfoMatch[1]);

        let description = descriptionParts.join(' ')
            .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
            .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
        
        description = decodeEntities(description);
        
        return { title, description };
    } catch (e) {
        return { title: "Bilinmeyen Ürün", description: "" };
    }
}

async function generateEbayTitle(title, description, apiKeys) {
const prompt = `You are an expert eBay SEO copywriter. Create a high-converting eBay product title optimized for the Cassini search algorithm.

STRICT TITLE RULES:
1. LENGTH: Exactly 75-80 characters. Maximize the space without going over.
2. VeRO SAFETY: Remove ALL brand names (e.g., Apple, Sony, Nike). If fitment is required, use "For [Brand]" or "Fits [Brand]" ONLY if absolutely essential for the item to make sense.
3. KEYWORD HIERARCHY (CRITICAL): Place the most searched, highly relevant core keywords in the FIRST 3-4 words. Cassini weighs early words much heavier.
4. STRUCTURE: [Core Keyword] + [High-Volume Synonyms] + [Key Feature/Material] + [Size/Color/Quantity] + [Use Case].
5. NO FLUFF: Do not use subjective or wasted words (e.g., Wow, Look, Awesome, Premium, High Quality, New, Cheap, Hot). 
6. ALLOWED VALUABLE ADJECTIVES: Use functional, highly-searched adjectives if true (e.g., Heavy-Duty, Waterproof, Portable, Wireless, Vintage).
7. FORMATTING: Title Case. Use digits (2, not Two). NO symbols (?, !, ®, ™, commas, periods). Replace hyphens or slashes with spaces.
8. HUMAN READABILITY: The title must read naturally to a human to ensure a high Click-Through Rate (CTR). Do not just output a random list of disconnected keywords.

ORIGINAL DATA:
- Title: ${title}
- Features: ${description}

OUTPUT: Return ONLY the raw generated title string. No explanations, no quotes, no conversational text.`;

    const targetModel = "gemini-3.1-flash-lite";
    for (const apiKey of apiKeys) {
        try {
            const url = `https://generativelanguage.googleapis.com/v1beta/models/${targetModel}:generateContent?key=${apiKey}`;
            const res = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{ parts: [{ text: prompt }] }],
                    generationConfig: {
                        thinkingConfig: { thinkingLevel: "LOW" },
                        temperature: 0.2,
                        maxOutputTokens: 60
                    }
                })
            });
            if (res.status === 429) continue;
            if (!res.ok) continue;
            
            const data = await res.json();
            const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
            if (text) {
                return text.replace(/"/g, '').replace(/\n/g, '').trim().substring(0, 80);
            }
        } catch(e) {
            continue;
        }
    }
    return { error: true };
}
