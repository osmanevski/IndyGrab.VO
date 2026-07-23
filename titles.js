document.addEventListener("DOMContentLoaded", () => {
    const tbody = document.getElementById("titles-body");
    const statTotal = document.getElementById("stat-total");
    const statCompleted = document.getElementById("stat-completed");
    const statMissing = document.getElementById("stat-missing");
    const statFetched = document.getElementById("stat-fetched");
    const statBanned = document.getElementById("stat-banned");
    const statBoxes = document.querySelectorAll(".stat-box");
    
    const modal = document.getElementById("desc-modal");
    const modalText = document.getElementById("modal-body-text");
    const closeModal = document.getElementById("close-modal");
    const paginationDiv = document.getElementById("titles-pagination");
    
    const statusFilter = document.getElementById("status-filter");
    const liveSearchInput = document.getElementById("live-search");
    const clearDynamicBtn = document.getElementById("clear-dynamic-btn");
    const fetchMissingBtn = document.getElementById("fetch-missing-btn");
    const generateAiBtn = document.getElementById("generate-ai-btn");
    const stopAiBtn = document.getElementById("stop-ai-btn");
    
    const copyPageBtn = document.getElementById("copy-page-btn");
    const copyAllBtn = document.getElementById("copy-all-btn");
    const exportCsvBtn = document.getElementById("export-csv-btn");
    const mixBtn = document.getElementById("mix-data-btn");

    const apiStatusText = document.getElementById("api-status-text");

    let missingAsins = [];
    let fetchedAsins = [];
    let bannedAsins = [];
    let currentFilteredAsins = []; 
    let searchTerm = "";
    
    let currentPage = 1;
    const ITEMS_PER_PAGE = 150;

    function showToast(message, type = 'success') {
        let container = document.getElementById('toast-container');
        if (!container) {
            container = document.createElement('div');
            container.id = 'toast-container';
            document.body.appendChild(container);
        }
        const toast = document.createElement('div');
        toast.className = `toast toast-${type}`;
        toast.innerHTML = `${type === 'success' ? '✅' : '⚠️'} ${message}`;
        container.appendChild(toast);
        setTimeout(() => {
            toast.style.animation = 'slideOutRight 0.3s ease forwards';
            setTimeout(() => toast.remove(), 300);
        }, 3000);
    }

    function escapeHTML(str) {
        if (!str) return '';
        return str.toString().replace(/[&<>'"]/g, tag => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'}[tag] || tag));
    }

    async function updateApiDashboard() {
        const { geminiApiKeys = [], generatedTitles = {} } = await chrome.storage.local.get(['geminiApiKeys', 'generatedTitles']);
        const keyCount = geminiApiKeys.length;
        let aiCount = 0;
        for(let key in generatedTitles) {
            if(generatedTitles[key].aiTitle) aiCount++;
        }
        if(keyCount === 0) {
            apiStatusText.textContent = `Anahtar Yok!`;
            apiStatusText.style.color = "#e74c3c";
        } else {
            apiStatusText.textContent = `${keyCount} Key | Üretim: ${aiCount}`;
            apiStatusText.style.color = "#2ecc71";
        }
    }

    liveSearchInput.addEventListener('input', (e) => {
        searchTerm = e.target.value.toLowerCase();
        currentPage = 1;
        loadTableData();
    });

    statBoxes.forEach(box => {
        box.addEventListener('click', () => {
            const filterVal = box.dataset.filter;
            statusFilter.value = filterVal;
            
            statBoxes.forEach(b => b.classList.remove('active'));
            box.classList.add('active');
            
            currentPage = 1;
            loadTableData();
        });
    });

    statusFilter.addEventListener("change", () => {
        statBoxes.forEach(b => b.classList.remove('active'));
        const activeBox = document.querySelector(`.stat-box[data-filter="${statusFilter.value}"]`);
        if(activeBox) activeBox.classList.add('active');
        
        currentPage = 1;
        loadTableData();
    });

    async function loadTableData() {
        updateApiDashboard();
        const { generatedTitles = {}, memoryAsins = [] } = await chrome.storage.local.get(["generatedTitles", "memoryAsins"]);
        
        chrome.runtime.sendMessage({ action: "getTitleQueueStatus" }, (response) => {
            const detailsQueue = response?.detailsQueue || [];
            const titleQueue = response?.titleQueue || [];
            const processingDetails = response?.processingDetails;
            const processingTitle = response?.processingTitle; 
            
            const isQueueActive = detailsQueue.length > 0 || titleQueue.length > 0 || processingDetails || processingTitle;
            
            if (isQueueActive) {
                stopAiBtn.style.display = "inline-block";
                fetchMissingBtn.style.opacity = "0.5";
                fetchMissingBtn.style.pointerEvents = "none";
                generateAiBtn.style.opacity = "0.5";
                generateAiBtn.style.pointerEvents = "none";
            } else {
                stopAiBtn.style.display = "none";
                fetchMissingBtn.style.opacity = "1";
                fetchMissingBtn.style.pointerEvents = "auto";
                generateAiBtn.style.opacity = "1";
                generateAiBtn.style.pointerEvents = "auto";
            }

            let completedCount = 0;
            missingAsins = [];
            fetchedAsins = [];
            bannedAsins = [];
            
            const masterList = [];
            const displayedAsins = new Set();
            
            memoryAsins.forEach(asin => {
                masterList.push(asin);
                displayedAsins.add(asin);
            });
            
            for (const asin in generatedTitles) {
                if (!displayedAsins.has(asin) && generatedTitles[asin].aiTitle) {
                    masterList.push(asin);
                    displayedAsins.add(asin);
                }
            }

            const rowsData = masterList.map(asin => {
                let amzTitle = "Veri Yok", desc = "", aiTitle = "", status = "missing", customLabel = null;
                
                if (processingDetails === asin) {
                    status = "processing";
                    amzTitle = "Amazon'dan Çekiliyor...";
                    customLabel = "Veri Çekiliyor...";
                } else if (processingTitle === asin) {
                    status = "processing";
                    const data = generatedTitles[asin] || {};
                    amzTitle = data.amazonTitle || "Bilinmiyor";
                    desc = data.description || "";
                    customLabel = "AI Üretiyor...";
                } else if (detailsQueue.includes(asin)) {
                    status = "queued";
                    customLabel = "Veri Kuyruğu";
                    amzTitle = "Kuyrukta...";
                } else if (titleQueue.includes(asin)) {
                    status = "queued";
                    customLabel = "AI Kuyruğu";
                    const data = generatedTitles[asin] || {};
                    amzTitle = data.amazonTitle || "Kuyrukta...";
                    desc = data.description || "";
                } else if (generatedTitles[asin]) {
                    const data = generatedTitles[asin];
                    amzTitle = data.amazonTitle || "Bilinmiyor";
                    desc = data.description || "";
                    
                    if (data.bannedMatch) {
                        status = "banned";
                        aiTitle = `Yasaklı Kelime: ${data.bannedMatch}`;
                        bannedAsins.push(asin);
                    } else if (data.aiTitle) {
                        status = "completed";
                        aiTitle = data.aiTitle;
                        completedCount++;
                    } else if (data.description) {
                        status = "fetched";
                        fetchedAsins.push(asin);
                    } else {
                        missingAsins.push(asin);
                    }
                } else {
                    missingAsins.push(asin);
                }

                return { asin, amzTitle, desc, aiTitle, status, customLabel };
            });

            statTotal.textContent = memoryAsins.length;
            statCompleted.textContent = completedCount;
            statMissing.textContent = missingAsins.length;
            statFetched.textContent = fetchedAsins.length;
            statBanned.textContent = bannedAsins.length;

            const filterVal = statusFilter.value;
            let filteredData = rowsData;
            
            if (filterVal !== 'all') {
                if (filterVal === 'processing_queued') {
                    filteredData = rowsData.filter(r => r.status === 'processing' || r.status === 'queued');
                } else {
                    filteredData = rowsData.filter(r => r.status === filterVal);
                }
            }

            if (searchTerm) {
                filteredData = filteredData.filter(r => 
                    r.asin.toLowerCase().includes(searchTerm) ||
                    r.amzTitle.toLowerCase().includes(searchTerm) ||
                    (r.aiTitle && r.aiTitle.toLowerCase().includes(searchTerm)) ||
                    (r.desc && r.desc.toLowerCase().includes(searchTerm))
                );
            }

            currentFilteredAsins = filteredData.map(r => r.asin);

            if (filterVal === 'all') clearDynamicBtn.textContent = `Tümünü Sil (${currentFilteredAsins.length})`;
            else if (filterVal === 'completed') clearDynamicBtn.textContent = `Tamamlananları Sil (${currentFilteredAsins.length})`;
            else if (filterVal === 'missing') clearDynamicBtn.textContent = `İşlenmeyenleri Sil (${currentFilteredAsins.length})`;
            else if (filterVal === 'fetched') clearDynamicBtn.textContent = `Verisi Hazır Olanları Sil (${currentFilteredAsins.length})`;
            else if (filterVal === 'banned') clearDynamicBtn.textContent = `Yasaklıları Sil (${currentFilteredAsins.length})`;
            else if (filterVal === 'processing_queued') clearDynamicBtn.textContent = `Kuyruktakileri Sil (${currentFilteredAsins.length})`;

            const totalItems = filteredData.length;
            const totalPages = Math.ceil(totalItems / ITEMS_PER_PAGE);
            if (currentPage > totalPages) currentPage = totalPages || 1;
            
            const startIndex = (currentPage - 1) * ITEMS_PER_PAGE;
            const paginatedData = filteredData.slice(startIndex, startIndex + ITEMS_PER_PAGE);

            tbody.innerHTML = "";
            paginatedData.forEach(item => {
                tbody.appendChild(createRow(item.asin, item.amzTitle, item.desc, item.aiTitle, item.status, item.customLabel));
            });

            renderPagination(totalItems, totalPages);
            
            fetchMissingBtn.style.display = missingAsins.length > 0 ? "inline-block" : "none";
            fetchMissingBtn.textContent = `Tüm Eksikleri Çek (${missingAsins.length})`;

            generateAiBtn.style.display = fetchedAsins.length > 0 ? "inline-block" : "none";
            generateAiBtn.textContent = `Hazır Olanları Üret (${fetchedAsins.length})`;

            mixBtn.style.display = memoryAsins.length > 1 ? "inline-block" : "none";
        });
    }

    function createRow(asin, amzTitle, desc, aiTitle, status, customLabel = null) {
        const tr = document.createElement("tr");
        let statusBadge = "";
        let actionBtn = "";
        let aiTitleHtml = "";
        let rowClass = `row-${status}`; 
        
        if (status === "completed") {
            statusBadge = `<span class="badge completed">Tamamlandı</span>`;
            actionBtn = `<button class="btn btn-copy-single" data-asin="${asin}" data-title="${escapeHTML(aiTitle)}">Kopyala</button>
                         <button class="btn btn-regenerate-single" data-asin="${asin}">Tekrar</button>`;
            
            const charCount = aiTitle.length;
            let countColor = charCount > 80 ? "#e74c3c" : "#aaa";
            aiTitleHtml = `<div class="editable-title" data-asin="${asin}" title="Düzenlemek için tıklayın">${escapeHTML(aiTitle)}</div>
                           <span class="char-count" style="color:${countColor};">(${charCount} Karakter)</span>`;
            
        } else if (status === "banned") {
            statusBadge = `<span class="badge banned">Yasaklı</span>`;
            actionBtn = `<span style="color:#e74c3c; font-size:12px; font-weight:bold;">Otomatik Elendi</span>`;
            aiTitleHtml = `<div style="color:#e74c3c; font-style:italic;">${escapeHTML(aiTitle)}</div>`; 
        } else if (status === "fetched") {
            statusBadge = `<span class="badge fetched">Veri Hazır</span>`;
            actionBtn = `<button class="btn btn-generate-single" data-asin="${asin}">AI Üret</button>`;
            aiTitleHtml = `<div style="color:#aaa; font-style:italic;">Üretim Bekliyor</div>`;
        } else if (status === "processing" || status === "queued") {
            statusBadge = `<span class="badge ${status === 'processing' ? 'processing' : 'queued'}">${customLabel || 'İşlemde'}</span>`;
            actionBtn = `<button class="btn" disabled style="background:#4a4a4a;">Bekle</button>`;
            aiTitleHtml = `<div style="color:#7f8c8d; font-style:italic;">İşlem Sürüyor...</div>`;
        } else if (status === "missing") {
            statusBadge = `<span class="badge missing">İşlenmedi</span>`;
            actionBtn = `<button class="btn btn-fetch-single" data-asin="${asin}">Veri Çek</button>`;
            aiTitleHtml = `<div style="color:#7f8c8d; font-style:italic;">Önce Veri Çekilmeli</div>`;
        }

        let descHtml = desc ? `<button class="btn btn-desc view-desc-btn" data-desc="${escapeHTML(desc)}">Özellikler</button>` : `<span style="color:#555;">Yok</span>`;

        tr.className = rowClass;
        tr.innerHTML = `
            <td><a href="https://www.amazon.com/dp/${asin}" target="_blank">${asin}</a></td>
            <td>${escapeHTML(amzTitle)}</td>
            <td>${descHtml}</td>
            <td>${aiTitleHtml}</td>
            <td>${statusBadge}</td>
            <td><div style="display:flex; gap:5px; align-items:center;">${actionBtn}</div></td>
        `;
        return tr;
    }

    function renderPagination(totalItems, totalPages) {
        paginationDiv.innerHTML = '';
        
        if (totalPages <= 1) {
            paginationDiv.style.display = 'none';
            return;
        }
        
        paginationDiv.style.display = 'flex';
        
        const prevBtn = document.createElement('button');
        prevBtn.textContent = '◀ Önceki';
        prevBtn.disabled = currentPage === 1;
        prevBtn.onclick = () => { currentPage--; loadTableData(); };
        
        const info = document.createElement('span');
        info.className = 'pagination-info';
        info.textContent = ` Sayfa ${currentPage} / ${totalPages} `;
        
        const nextBtn = document.createElement('button');
        nextBtn.textContent = 'Sonraki ▶';
        nextBtn.disabled = currentPage === totalPages;
        nextBtn.onclick = () => { currentPage++; loadTableData(); };
        
        paginationDiv.appendChild(prevBtn);
        paginationDiv.appendChild(info);
        paginationDiv.appendChild(nextBtn);
    }

    stopAiBtn.addEventListener("click", () => {
        chrome.runtime.sendMessage({ action: "stopQueues" }, () => {
            showToast("Kuyruk işlemi başarıyla durduruldu.", "success");
            loadTableData();
        });
    });

    tbody.addEventListener("click", (e) => {
        if (e.target.classList.contains("view-desc-btn")) {
            modalText.innerHTML = e.target.dataset.desc || "Veri yok.";
            modal.style.display = "flex";
        }

        if (e.target.classList.contains("editable-title")) {
            if (e.target.contentEditable !== "true") {
                e.target.contentEditable = "true";
                e.target.focus();
                
                const range = document.createRange();
                const sel = window.getSelection();
                range.selectNodeContents(e.target);
                range.collapse(false);
                sel.removeAllRanges();
                sel.addRange(range);
            }
        }
        
        if (e.target.classList.contains("btn-copy-single")) {
            const asin = e.target.dataset.asin;
            const title = e.target.dataset.title;
            navigator.clipboard.writeText(`${asin};${title}`);
            showToast("Başlık kopyalandı!", "success");
        }

        if (e.target.classList.contains("btn-fetch-single")) {
            chrome.runtime.sendMessage({ action: "queueForDetails", asins: [e.target.dataset.asin] }, () => loadTableData());
        }

        if (e.target.classList.contains("btn-generate-single") || e.target.classList.contains("btn-regenerate-single")) {
            chrome.runtime.sendMessage({ action: "queueForTitleGeneration", asins: [e.target.dataset.asin] }, () => loadTableData());
        }
    });

    tbody.addEventListener("blur", async (e) => {
        if (e.target.classList.contains("editable-title")) {
            e.target.contentEditable = "false";
            const newTitle = e.target.textContent.trim();
            const asin = e.target.dataset.asin;
            
            const { generatedTitles = {} } = await chrome.storage.local.get("generatedTitles");
            if (generatedTitles[asin] && generatedTitles[asin].aiTitle !== newTitle) {
                generatedTitles[asin].aiTitle = newTitle;
                await chrome.storage.local.set({ generatedTitles });
                showToast("Düzenleme kaydedildi", "success");
            } else {
                e.target.textContent = generatedTitles[asin]?.aiTitle || "";
            }
        }
    }, true);

    tbody.addEventListener("keydown", (e) => {
        if (e.target.classList.contains("editable-title") && e.key === "Enter") {
            e.preventDefault();
            e.target.blur();
        }
    });

    fetchMissingBtn.addEventListener("click", () => {
        if (missingAsins.length === 0) return;
        showToast("Veri çekme işlemi kuyruğa alındı.", "success");
        chrome.runtime.sendMessage({ action: "queueForDetails", asins: missingAsins }, () => loadTableData());
    });

    generateAiBtn.addEventListener("click", () => {
        if (fetchedAsins.length === 0) return;
        showToast("AI başlık üretimi başlatıldı.", "success");
        chrome.runtime.sendMessage({ action: "queueForTitleGeneration", asins: fetchedAsins }, () => loadTableData());
    });

    clearDynamicBtn.addEventListener("click", async () => {
        if (currentFilteredAsins.length === 0) return;
        
        const filterName = statusFilter.options[statusFilter.selectedIndex].text;
        if(confirm(`"${filterName}" filtresindeki toplam ${currentFilteredAsins.length} adet ürün HAFIZADAN KALICI OLARAK SİLİNECEK! Emin misiniz?`)) {
            
            const { memoryAsins = [], generatedTitles = {} } = await chrome.storage.local.get(['memoryAsins', 'generatedTitles']);
            
            const asinsToRemove = new Set(currentFilteredAsins);
            const newMemoryAsins = memoryAsins.filter(a => !asinsToRemove.has(a));
            
            asinsToRemove.forEach(a => delete generatedTitles[a]);
            
            await chrome.storage.local.set({ memoryAsins: newMemoryAsins, generatedTitles });
            currentPage = 1;
            showToast("Silme işlemi başarıyla tamamlandı.", "success");
            loadTableData();
        }
    });

    mixBtn.addEventListener("click", async () => {
        const { memoryAsins = [] } = await chrome.storage.local.get("memoryAsins");
        if (memoryAsins.length < 2) return;
        
        for (let i = memoryAsins.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [memoryAsins[i], memoryAsins[j]] = [memoryAsins[j], memoryAsins[i]];
        }
        
        await chrome.storage.local.set({ memoryAsins });
        showToast("Ürünler rastgele karıştırıldı!", "success");
        loadTableData();
    });

    copyPageBtn.addEventListener("click", () => {
        let copyText = "";
        let count = 0;
        
        const tbodyRows = tbody.querySelectorAll("tr");
        tbodyRows.forEach(row => {
            const copyBtn = row.querySelector(".btn-copy-single");
            if(copyBtn) {
                copyText += `${copyBtn.dataset.asin};${copyBtn.dataset.title}\n`;
                count++;
            }
        });
        
        if (copyText) {
            navigator.clipboard.writeText(copyText.trim());
            showToast(`${count} adet başlık kopyalandı!`, "success");
        } else {
            showToast("Bu sayfada kopyalanacak başlık yok.", "error");
        }
    });

    copyAllBtn.addEventListener("click", async () => {
        const { generatedTitles = {}, memoryAsins = [] } = await chrome.storage.local.get(["generatedTitles", "memoryAsins"]);
        let copyText = "";
        let count = 0;
        
        memoryAsins.forEach(asin => {
            const data = generatedTitles[asin];
            if (data && data.aiTitle && !data.bannedMatch) {
                copyText += `${asin};${data.aiTitle}\n`;
                count++;
            }
        });
        
        if (copyText) {
            navigator.clipboard.writeText(copyText.trim());
            showToast(`Toplam ${count} adet başlık kopyalandı!`, "success");
        } else {
            showToast("Kopyalanacak tamamlanmış başlık bulunamadı.", "error");
        }
    });

    exportCsvBtn.addEventListener("click", async () => {
        const { generatedTitles = {}, memoryAsins = [] } = await chrome.storage.local.get(["generatedTitles", "memoryAsins"]);
        let csvContent = "\uFEFFASIN;Ebay AI Title\n"; 
        let count = 0;
        
        memoryAsins.forEach(asin => {
            const data = generatedTitles[asin];
            if (data && data.aiTitle && !data.bannedMatch) {
                const safeTitle = data.aiTitle.replace(/"/g, '""');
                csvContent += `${asin};"${safeTitle}"\n`;
                count++;
            }
        });
        
        if (count === 0) {
            showToast("İndirilecek tamamlanmış başlık yok.", "error");
            return;
        }

        const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.setAttribute("href", url);
        link.setAttribute("download", `ASL_Titles_${new Date().toISOString().split('T')[0]}.csv`);
        link.style.visibility = 'hidden';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        showToast(`${count} ürün Excel'e (CSV) aktarıldı!`, "success");
    });

    closeModal.addEventListener("click", () => modal.style.display = "none");
    window.addEventListener("click", (e) => { if (e.target === modal) modal.style.display = "none"; });

    chrome.storage.onChanged.addListener((changes, area) => {
        if (area === "local" && (changes.generatedTitles || changes.memoryAsins)) {
            loadTableData();
        }
    });

    chrome.runtime.onMessage.addListener((message) => {
        if (message.action === "titleGenerationUpdate") loadTableData();
    });

    loadTableData();
    setInterval(loadTableData, 5000);
});