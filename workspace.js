// Read-only presentation of existing filter values; no additional collection engine.
document.addEventListener('DOMContentLoaded', () => {
    const fields = ['rating','feedback','maxFeedback','minPrice','maxPrice','maxBsr','shipping','asinCount','stock','sort','bannedWords'];
    function renderFilters() {
        chrome.storage.local.get(fields, values => {
            const target = document.getElementById('active-filter-summary');
            if (!target) return;
            const chips = [];
            if (values.rating) chips.push(`Puan ≥ ${values.rating}`);
            if (values.feedback || values.maxFeedback) chips.push(`Yorum: ${values.feedback || 0}–${values.maxFeedback || 'sınırsız'}`);
            if (values.minPrice || values.maxPrice) chips.push(`Fiyat: ${values.minPrice || 0}–${values.maxPrice || 'sınırsız'}`);
            if (values.shipping && values.shipping !== 'all') chips.push(`Teslimat: ${{prime:'Prime','1-day':'1 gün','2-day':'2 gün'}[values.shipping] || values.shipping}`);
            if (values.stock && values.stock !== 'ignore') chips.push(values.stock === 'exclude_warning' ? 'Stok uyarısı hariç' : `Stok ≥ ${values.stock}`);
            if (values.maxBsr) chips.push(`Alt kategori sırası: ${({10000:'Gevşek',3000:'Orta',1000:'Sıkı'})[values.maxBsr] || 'Özel'} (≤ ${Number(values.maxBsr).toLocaleString('tr-TR')})`);
            const words = Array.isArray(values.bannedWords) ? values.bannedWords : String(values.bannedWords || '').split(',').filter(w => w.trim());
            if (words.length) chips.push(`${words.length} yasaklı kelime`);
            chips.push(`Arama başına ${values.asinCount || 5} ASIN`);
            target.replaceChildren(...chips.map(text => {
                const chip = document.createElement('span'); chip.className = 'filter-chip'; chip.textContent = text; return chip;
            }));
        });
    }
    renderFilters();
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && fields.some(key => key in changes)) renderFilters();
    });
    // Inner Amazon navigation and sidebar must describe the same visible workspace.
    document.querySelectorAll('.tab[data-tab]').forEach(tab => tab.addEventListener('click', () => {
        const isMemory = tab.dataset.tab === 'memory';
        document.querySelectorAll('.nav-btn').forEach(button => {
            const current = button.dataset.target === 'section-amazon' && button.dataset.amazonTab === (isMemory ? 'memory' : 'collect');
            button.classList.toggle('active', current);
            if (current) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
        });
        document.getElementById('workspace-title').textContent = isMemory ? 'ASIN havuzu' : 'Amazon toplama';
        document.getElementById('workspace-description').textContent = isMemory
            ? 'Toplanan ASIN’leri düzenle ve dışa aktar.'
            : 'Kaynağını seç, ürün filtrelerini belirle ve ASIN havuzunu oluştur.';
        document.querySelector('.source-picker').hidden = isMemory;
        history.replaceState(null, '', '#section-amazon/' + (isMemory ? 'memory' : 'collect'));
    }));
});
