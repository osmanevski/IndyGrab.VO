// Paylaşılan tema uygulayıcı (tüm eklenti sayfaları).
// Tercih: chrome.storage.local.theme = 'dark' (varsayılan) | 'light'.
// - Sayfa açılışında uygular
// - storage.onChanged ile canlı günceller (bir sayfada değiştirince hepsi değişir)
// - id="theme-toggle" olan herhangi bir butonla aç/kapa yapar (event delegation)
(function () {
    function apply(theme) {
        const t = theme === 'light' ? 'light' : 'dark';
        document.documentElement.setAttribute('data-theme', t);
        try { localStorage.setItem('idg_theme', t); } catch (e) {}
        document.querySelectorAll('#theme-toggle').forEach(btn => {
            btn.textContent = t === 'light' ? '🌙' : '☀️';
            btn.title = t === 'light' ? 'Koyu moda geç' : 'Aydınlık moda geç';
        });
    }

    // Anlık uygula (FOUC azaltma): önce localStorage önbelleği, sonra storage'dan kesinleştir.
    try {
        const cached = localStorage.getItem('idg_theme');
        if (cached) document.documentElement.setAttribute('data-theme', cached);
    } catch (e) {}

    chrome.storage.local.get(['theme'], (d) => apply(d.theme || 'dark'));

    chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && changes.theme) apply(changes.theme.newValue || 'dark');
    });

    document.addEventListener('click', (e) => {
        if (!e.target.closest('#theme-toggle')) return;
        chrome.storage.local.get(['theme'], (d) => {
            const next = (d.theme || 'dark') === 'dark' ? 'light' : 'dark';
            chrome.storage.local.set({ theme: next });
        });
    });
})();
