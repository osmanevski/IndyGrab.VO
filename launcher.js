// Popup artık yalnızca bir başlatıcı: yönetim tamamen research.html (AI Araştırma) panelinde.
// Burada sadece hızlı durum bilgisi + panel/araç kısayolları var.
document.addEventListener('DOMContentLoaded', () => {
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

    // Hızlı durum: hafızadaki ASIN, potansiyel ürün, mağaza linki sayıları
    chrome.storage.local.get(['memoryAsins', 'potentialProducts', 'savedSellerLinks'], (d) => {
        const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
        set('stat-asins', (d.memoryAsins || []).length);
        set('stat-products', (d.potentialProducts || []).length);
        set('stat-stores', (d.savedSellerLinks || []).length);
    });

    // Otomasyon durumu rozeti
    chrome.storage.local.get(['automationState'], (d) => {
        const el = document.getElementById('auto-state');
        if (!el) return;
        const s = d.automationState || 'stopped';
        const map = { running: ['Tarama sürüyor', '#22c983'], paused: ['Duraklatıldı', '#f5ad42'], stopped: ['Beklemede', '#8b95a5'] };
        const [text, color] = map[s] || map.stopped;
        el.textContent = text;
        el.style.color = color;
        const dot = document.getElementById('auto-dot');
        if (dot) dot.style.background = color;
    });
});
