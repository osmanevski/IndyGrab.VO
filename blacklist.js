document.addEventListener("DOMContentLoaded", function () {
    const translations = {
        en: {
            blacklist_title: "Blacklist",
            add_to_blacklist: "Add to Blacklist",
            added_to_blacklist: "Added to blacklist!",
            blacklist_asin_invalid: "Invalid ASIN! Must be 10 characters starting with 'B0'.",
            blacklist_asin_exists: "ASIN already in blacklist!",
            blacklist_asin_deleted: "ASIN removed from blacklist!",
            bulk_upload_success: "Bulk upload completed: {added} ASINs added, {skipped} skipped (invalid or duplicates).",
            bulk_upload_no_valid_asins: "No valid ASINs found in the file!",
            bulk_upload_error: "Error reading file. Please ensure it's a valid .txt or .csv file.",
            select_all: "Select All",
            delete_selected: "Delete Selected",
            no_asins_selected: "No ASINs selected!",
            selected_asins_deleted: "{count} ASIN(s) removed from blacklist!"
        },
        tr: {
            blacklist_title: "Kara Liste",
            add_to_blacklist: "Kara Listeye Ekle",
            added_to_blacklist: "Kara listeye eklendi!",
            blacklist_asin_invalid: "Geçersiz ASIN! 10 karakter olmalı ve 'B0' ile başlamalı.",
            blacklist_asin_exists: "ASIN zaten kara listede!",
            blacklist_asin_deleted: "ASIN kara listeden çıkarıldı!",
            bulk_upload_success: "Toplu yükleme tamamlandı: {added} ASIN eklendi, {skipped} atlandı (geçersiz veya tekrar eden).",
            bulk_upload_no_valid_asins: "Dosyada geçerli ASIN bulunamadı!",
            bulk_upload_error: "Dosya okuma hatası. Lütfen geçerli bir .txt veya .csv dosyası olduğundan emin olun.",
            select_all: "Hepsini Seç",
            delete_selected: "Seçilenleri Sil",
            no_asins_selected: "Hiç ASIN seçilmedi!",
            selected_asins_deleted: "{count} ASIN kara listeden çıkarıldı!"
        }
    };

    let blacklistAsinInput = document.getElementById("blacklistAsinInput");
    let addBlacklistBtn = document.getElementById("addBlacklistBtn");
    let blacklistFileInput = document.getElementById("blacklistFileInput");
    let uploadBlacklistBtn = document.getElementById("uploadBlacklistBtn");
    let selectAllCheckbox = document.getElementById("selectAllCheckbox");
    let deleteSelectedBtn = document.getElementById("deleteSelectedBtn");
    let blacklistOutput = document.getElementById("blacklistOutput");
    let notification = document.getElementById("notification");
    let prevPageBtn = document.getElementById("prevPageBtn");
    let nextPageBtn = document.getElementById("nextPageBtn");
    let pageInfo = document.getElementById("pageInfo");
    let paginationControls = document.getElementById("paginationControls");

    let currentLang = "en";
    let allAsins = [];
    let selectedAsins = new Set();
    let currentPage = 1;
    const ITEMS_PER_PAGE = 100;

    chrome.storage.local.get("language", (data) => {
        currentLang = data.language || "en";
        updateLanguage();
        updateBlacklistUI();
    });

    function updateLanguage() {
        document.querySelectorAll("[data-i18n]").forEach(element => {
            const key = element.getAttribute("data-i18n");
            element.textContent = translations[currentLang][key];
        });
        document.documentElement.lang = currentLang;
        document.querySelector('label[for="selectAllCheckbox"]').textContent = translations[currentLang].select_all;
        deleteSelectedBtn.textContent = translations[currentLang].delete_selected;
    }

    function updateBlacklistUI() {
        chrome.storage.local.get("blacklistAsins", (data) => {
            allAsins = data.blacklistAsins || [];
            const maxPage = Math.ceil(allAsins.length / ITEMS_PER_PAGE) || 1;
            if (currentPage > maxPage) currentPage = maxPage;
            renderPage();
        });
    }

    function renderPage() {
        blacklistOutput.innerHTML = `<p>${translations[currentLang].blacklist_title} (${allAsins.length})</p>`;

        if (allAsins.length === 0) {
            selectAllCheckbox.disabled = true;
            deleteSelectedBtn.disabled = true;
            paginationControls.style.display = "none";
            return;
        }

        selectAllCheckbox.disabled = false;
        deleteSelectedBtn.disabled = false;
        paginationControls.style.display = "flex";

        const start = (currentPage - 1) * ITEMS_PER_PAGE;
        const end = Math.min(start + ITEMS_PER_PAGE, allAsins.length);
        const pageAsins = allAsins.slice(start, end);

        const fragment = document.createDocumentFragment();

        pageAsins.forEach(asin => {
            const row = document.createElement("div");
            row.className = "asin-row";

            const checkbox = document.createElement("input");
            checkbox.type = "checkbox";
            checkbox.className = "asin-checkbox";
            checkbox.dataset.asin = asin;
            checkbox.checked = selectedAsins.has(asin);

            const deleteIcon = document.createElement("img");
            deleteIcon.src = "images/delete-icon.png";
            deleteIcon.className = "delete-icon";
            deleteIcon.title = "Delete ASIN";
            deleteIcon.dataset.asin = asin;

            const asinSpan = document.createElement("span");
            asinSpan.className = "asin-column";
            const link = document.createElement("a");
            link.href = `https://www.amazon.com/dp/${asin}`;
            link.textContent = asin;
            link.target = "_blank";
            asinSpan.appendChild(link);

            row.appendChild(checkbox);
            row.appendChild(deleteIcon);
            row.appendChild(asinSpan);
            fragment.appendChild(row);
        });

        blacklistOutput.appendChild(fragment);

        prevPageBtn.disabled = currentPage === 1;
        nextPageBtn.disabled = end >= allAsins.length;
        pageInfo.textContent = `${currentPage} / ${Math.ceil(allAsins.length / ITEMS_PER_PAGE) || 1}`;

        updateSelectAllState();
    }

    function updateSelectAllState() {
        selectAllCheckbox.checked = allAsins.length > 0 && selectedAsins.size === allAsins.length;
    }

    blacklistOutput.addEventListener("change", (e) => {
        if (e.target.classList.contains("asin-checkbox")) {
            const asin = e.target.dataset.asin;
            if (e.target.checked) {
                selectedAsins.add(asin);
            } else {
                selectedAsins.delete(asin);
            }
            updateSelectAllState();
        }
    });

    blacklistOutput.addEventListener("click", (e) => {
        if (e.target.classList.contains("delete-icon")) {
            const asin = e.target.dataset.asin;
            allAsins = allAsins.filter(a => a !== asin);
            selectedAsins.delete(asin);
            chrome.storage.local.set({ blacklistAsins: allAsins }, () => {
                const maxPage = Math.ceil(allAsins.length / ITEMS_PER_PAGE) || 1;
                if (currentPage > maxPage) currentPage = maxPage;
                renderPage();
                showNotification(translations[currentLang].blacklist_asin_deleted, 1000);
            });
        }
    });

    prevPageBtn.addEventListener("click", () => {
        if (currentPage > 1) {
            currentPage--;
            renderPage();
        }
    });

    nextPageBtn.addEventListener("click", () => {
        const maxPage = Math.ceil(allAsins.length / ITEMS_PER_PAGE);
        if (currentPage < maxPage) {
            currentPage++;
            renderPage();
        }
    });

    addBlacklistBtn.addEventListener("click", () => {
        const asin = blacklistAsinInput.value.trim();
        if (!asin || asin.length !== 10 || !asin.startsWith("B0")) {
            showNotification(translations[currentLang].blacklist_asin_invalid, 2000);
            return;
        }
        chrome.storage.local.get("blacklistAsins", (data) => {
            let currentAsins = data.blacklistAsins || [];
            if (currentAsins.includes(asin)) {
                showNotification(translations[currentLang].blacklist_asin_exists, 2000);
                return;
            }
            currentAsins.push(asin);
            chrome.storage.local.set({ blacklistAsins: currentAsins }, () => {
                updateBlacklistUI();
                blacklistAsinInput.value = "";
                showNotification(translations[currentLang].added_to_blacklist, 1000);
            });
        });
    });

    uploadBlacklistBtn.addEventListener("click", () => {
        const file = blacklistFileInput.files[0];
        if (!file) {
            showNotification(translations[currentLang].bulk_upload_error, 2000);
            return;
        }

        const reader = new FileReader();
        reader.onload = function (e) {
            try {
                const content = e.target.result;
                const asins = content.split(/[\n,]/)
                    .map(asin => asin.trim())
                    .filter(asin => asin !== "");

                if (asins.length === 0) {
                    showNotification(translations[currentLang].bulk_upload_no_valid_asins, 2000);
                    return;
                }

                chrome.storage.local.get("blacklistAsins", (data) => {
                    let currentAsins = data.blacklistAsins || [];
                    let addedCount = 0;
                    let skippedCount = 0;
                    let asinSet = new Set(currentAsins);

                    asins.forEach(asin => {
                        if (asin.length === 10 && asin.startsWith("B0")) {
                            if (!asinSet.has(asin)) {
                                asinSet.add(asin);
                                currentAsins.push(asin);
                                addedCount++;
                            } else {
                                skippedCount++;
                            }
                        } else {
                            skippedCount++;
                        }
                    });

                    chrome.storage.local.set({ blacklistAsins: currentAsins }, () => {
                        updateBlacklistUI();
                        blacklistFileInput.value = "";
                        const message = translations[currentLang].bulk_upload_success
                            .replace("{added}", addedCount)
                            .replace("{skipped}", skippedCount);
                        showNotification(message, 3000);
                    });
                });
            } catch (error) {
                showNotification(translations[currentLang].bulk_upload_error, 2000);
            }
        };
        reader.onerror = function () {
            showNotification(translations[currentLang].bulk_upload_error, 2000);
        };
        reader.readAsText(file);
    });

    selectAllCheckbox.addEventListener("change", () => {
        if (selectAllCheckbox.checked) {
            allAsins.forEach(asin => selectedAsins.add(asin));
        } else {
            selectedAsins.clear();
        }
        renderPage();
    });

    deleteSelectedBtn.addEventListener("click", () => {
        if (selectedAsins.size === 0) {
            showNotification(translations[currentLang].no_asins_selected, 2000);
            return;
        }

        const count = selectedAsins.size;
        allAsins = allAsins.filter(asin => !selectedAsins.has(asin));
        
        chrome.storage.local.set({ blacklistAsins: allAsins }, () => {
            selectedAsins.clear();
            const maxPage = Math.ceil(allAsins.length / ITEMS_PER_PAGE) || 1;
            if (currentPage > maxPage) currentPage = maxPage;
            updateBlacklistUI();
            selectAllCheckbox.checked = false;
            const message = translations[currentLang].selected_asins_deleted.replace("{count}", count);
            showNotification(message, 2000);
        });
    });

    function showNotification(message, duration) {
        notification.textContent = message;
        notification.classList.add("show");
        setTimeout(() => {
            notification.classList.remove("show");
        }, duration);
    }

});
