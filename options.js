// LOCAL MODE: Lisans aktivasyonu kaldırıldı. Bu sayfa yalnızca bilgi amaçlıdır.
// Eski lisans anahtarı/durum verileri varsa temizlenir.
document.addEventListener('DOMContentLoaded', () => {
    chrome.storage.local.set({ licenseStatus: 'active', licenseMessage: 'Yerel Mod' });
    chrome.storage.local.remove(['licenseKey', 'machineId', 'localBansPushed']);
});
