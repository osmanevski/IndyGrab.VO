// Popup: hızlı durum + Amazon ASIN toplayıcı + hafıza görüntüleme.
// Yönetim (filtre/hafıza/kara liste) kontrol panelinde (research.html).
// NOT: popup.js burada YÜKLENMEZ; bu dosya kendi kendine yeterlidir.
document.addEventListener('DOMContentLoaded', () => {
    const $ = (id) => document.getElementById(id);
    const MEMORY_LIMIT = 20000;

    const open = (page) => {
        chrome.tabs.create({ url: chrome.runtime.getURL(page) });
        window.close();
    };
    document.querySelectorAll('[data-open]').forEach(el => {
        el.addEventListener('click', (e) => {
            e.preventDefault();
            open(el.getAttribute('data-open'));
        });
    });

    // ---------- Durum & sayaçlar ----------
    function refreshStats() {
        chrome.storage.local.get(['memoryAsins', 'potentialProducts', 'savedSellerLinks'], (d) => {
            const set = (id, v) => { const el = $(id); if (el) el.textContent = v; };
            set('stat-asins', (d.memoryAsins || []).length);
            set('stat-products', (d.potentialProducts || []).length);
            set('stat-stores', (d.savedSellerLinks || []).length);
        });
    }
    refreshStats();

    chrome.storage.local.get(['automationState'], (d) => {
        const el = $('auto-state');
        if (!el) return;
        const s = d.automationState || 'stopped';
        const map = { running: ['Tarama sürüyor', '#22c983'], paused: ['Duraklatıldı', '#f5ad42'], stopped: ['Beklemede', '#8b95a5'] };
        const [text, color] = map[s] || map.stopped;
        el.textContent = text;
        el.style.color = color;
        const dot = $('auto-dot');
        if (dot) dot.style.background = color;
    });

    // ---------- Hafıza görüntüleme (ASIN sayacına tıklayınca) ----------
    const memoryStat = $('memory-stat');
    const memoryPanel = $('memory-panel');
    const memoryList = $('memory-list');

    function renderMemory() {
        chrome.storage.local.get('memoryAsins', (d) => {
            const asins = d.memoryAsins || [];
            const title = $('memory-title');
            if (title) title.textContent = `Hafıza (${asins.length} ASIN)`;
            if (!memoryList) return;
            if (asins.length === 0) {
                memoryList.innerHTML = '<span class="empty">Hafıza boş.</span>';
                return;
            }
            // Popup'ı kilitlememek için ilk 500 tanesini göster.
            const shown = asins.slice(0, 500);
            memoryList.textContent = shown.join('\n');
            if (asins.length > shown.length) {
                const more = document.createElement('div');
                more.className = 'empty';
                more.style.marginTop = '6px';
                more.textContent = `… ve ${asins.length - shown.length} tane daha (tümü için Kopyala)`;
                memoryList.appendChild(more);
            }
        });
    }

    if (memoryStat) {
        memoryStat.addEventListener('click', () => {
            const isOpen = memoryPanel.classList.toggle('open');
            memoryStat.classList.toggle('open', isOpen);
            if (isOpen) renderMemory();
        });
    }

    const memoryCopy = $('memory-copy');
    if (memoryCopy) {
        memoryCopy.addEventListener('click', () => {
            chrome.storage.local.get('memoryAsins', (d) => {
                const asins = d.memoryAsins || [];
                if (asins.length === 0) return;
                navigator.clipboard.writeText(asins.join('\n')).then(() => {
                    memoryCopy.textContent = 'Kopyalandı ✓';
                    setTimeout(() => { memoryCopy.textContent = 'Kopyala'; }, 1200);
                }).catch(() => {});
            });
        });
    }

    // ---------- Amazon ASIN toplayıcı ----------
    const collectBtn = $('collect-btn');
    const autoStartBtn = $('auto-start-btn');
    const autoStopBtn = $('auto-stop-btn');
    const saveBtn = $('save-memory-btn');
    const asinBox = $('asin-box');
    const collectHint = $('collect-hint');

    let activeTabId = null;
    let onAmazon = false;

    function setHint(text, warn) {
        if (!collectHint) return;
        collectHint.textContent = text;
        collectHint.classList.toggle('warn', !!warn);
    }

    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const tab = tabs && tabs[0];
        activeTabId = tab ? tab.id : null;
        onAmazon = !!(tab && tab.url && /:\/\/[^/]*amazon\./i.test(tab.url));
        if (!onAmazon) {
            setHint('Amazon sayfası değil', true);
            [collectBtn, autoStartBtn, autoStopBtn].forEach(b => { if (b) b.disabled = true; });
            if (asinBox) asinBox.innerHTML = '<span class="empty">Toplamak için bir Amazon arama sayfası aç.</span>';
        } else {
            setHint('Hazır');
        }
        renderAsinList();
    });

    function renderAsinList() {
        chrome.storage.local.get('asinList', (d) => {
            const list = d.asinList || [];
            if (saveBtn) {
                saveBtn.textContent = `Hafızaya Kaydet (${list.length} ASIN)`;
                saveBtn.disabled = list.length === 0;
            }
            if (!asinBox) return;
            if (list.length === 0) {
                asinBox.innerHTML = onAmazon
                    ? '<span class="empty">Henüz ASIN yok. “Sayfayı Tara”ya bas.</span>'
                    : '<span class="empty">Toplamak için bir Amazon arama sayfası aç.</span>';
                return;
            }
            asinBox.textContent = list.join('\n');
        });
    }

    function sendToTab(payload, hint) {
        if (!activeTabId) return;
        setHint(hint || 'Çalışıyor…');
        chrome.tabs.sendMessage(activeTabId, payload, () => {
            // İçerik betiği yoksa sessizce geç (lastError okunmazsa konsola hata basar).
            if (chrome.runtime.lastError) setHint('Sayfa yenilenmeli', true);
        });
    }

    if (collectBtn) collectBtn.addEventListener('click', () => sendToTab({ requestASINs: true }, 'Taranıyor…'));
    if (autoStartBtn) autoStartBtn.addEventListener('click', () => sendToTab({ startAutoCollect: true }, 'Oto toplama açık'));
    if (autoStopBtn) autoStopBtn.addEventListener('click', () => sendToTab({ stopAutoCollect: true }, 'Durduruldu'));

    if (saveBtn) {
        saveBtn.addEventListener('click', () => {
            chrome.storage.local.get(['asinList', 'memoryAsins'], (d) => {
                const list = d.asinList || [];
                if (list.length === 0) return;
                let memory = [...new Set([...(d.memoryAsins || []), ...list])];
                let limited = false;
                if (memory.length > MEMORY_LIMIT) {
                    memory = memory.slice(0, MEMORY_LIMIT);
                    limited = true;
                }
                chrome.storage.local.set({ memoryAsins: memory, asinList: [] }, () => {
                    setHint(limited ? 'Hafıza limiti doldu' : `${list.length} ASIN kaydedildi`, limited);
                    refreshStats();
                    renderAsinList();
                    if (memoryPanel && memoryPanel.classList.contains('open')) renderMemory();
                });
            });
        });
    }

    // İçerik betiği tarama bitince asinList'i günceller → canlı yansıt.
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local') return;
        if (changes.asinList) {
            renderAsinList();
            const n = (changes.asinList.newValue || []).length;
            if (n > 0) setHint(`${n} ASIN bulundu`);
        }
        if (changes.memoryAsins) {
            refreshStats();
            if (memoryPanel && memoryPanel.classList.contains('open')) renderMemory();
        }
    });
});
