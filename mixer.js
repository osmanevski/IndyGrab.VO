document.addEventListener("DOMContentLoaded", function () {
    const elements = {
        inputAsins: document.getElementById("inputAsins"),
        mixButton: document.getElementById("mixButton"),
        outputAsins: document.getElementById("outputAsins"),
        copyButton: document.getElementById("copyButton"),
        downloadButton: document.getElementById("downloadButton"),
        notification: document.getElementById("mixer-notification"),
        duplicatesButton: document.getElementById("duplicatesButton"),
        duplicatesList: document.getElementById("duplicatesList"),
        duplicatesContent: document.getElementById("duplicatesContent")
    };

    function showNotification(message, duration) {
        elements.notification.textContent = message;
        elements.notification.classList.remove("hidden");
        setTimeout(() => {
            elements.notification.classList.add("hidden");
        }, duration);
    }

    elements.mixButton.addEventListener("click", function () {
        const inputText = elements.inputAsins.value.trim();
        if (!inputText) {
            showNotification("En az bir ASIN gir.", 2000);
            return;
        }

        let asins = inputText.split("\n").map(line => line.trim()).filter(line => line);
        const uniqueAsins = [...new Set(asins)];
        const duplicates = asins.filter((item, index) => asins.indexOf(item) !== index);

        for (let i = uniqueAsins.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [uniqueAsins[i], uniqueAsins[j]] = [uniqueAsins[j], uniqueAsins[i]];
        }

        elements.outputAsins.value = uniqueAsins.join("\n");
        elements.copyButton.disabled = false;
        elements.downloadButton.disabled = false;
        elements.duplicatesButton.disabled = duplicates.length === 0;

        if (duplicates.length > 0) {
            elements.duplicatesContent.replaceChildren(...duplicates.map(asin => { const item = document.createElement("li"); item.textContent = asin; return item; }));
        } else {
            elements.duplicatesContent.innerHTML = "<li>Tekrar eden kayıt yok.</li>";
        }

        showNotification(`${uniqueAsins.length} benzersiz ASIN karıştırıldı.`, 2000);
    });

    elements.copyButton.addEventListener("click", function () {
        const outputText = elements.outputAsins.value;
        if (!outputText) {
            showNotification("Kopyalanacak kayıt yok.", 2000);
            return;
        }
        navigator.clipboard.writeText(outputText).then(() => {
            showNotification("ASIN’ler kopyalandı.", 1000);
        }).catch(() => {
            showNotification("Kopyalama başarısız.", 1000);
        });
    });

    elements.downloadButton.addEventListener("click", function () {
        const outputText = elements.outputAsins.value;
        if (!outputText) {
            showNotification("İndirilecek kayıt yok.", 2000);
            return;
        }
        const blob = new Blob([outputText], { type: "text/plain" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `shuffled_asins_${new Date().toISOString()}.txt`;
        a.click();
        URL.revokeObjectURL(url);
        showNotification("ASIN’ler indirildi.", 1000);
    });

    elements.duplicatesButton.addEventListener("click", function () {
        elements.duplicatesList.classList.toggle("hidden");
    });
});
