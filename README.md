# IndyGrab.VO

AI destekli, **tamamen yerel çalışan** bir Chrome eklentisi (Manifest V3). Amazon ve eBay üzerinde dropshipping / online arbitraj için ürün araştırmayı otomatikleştirir. Hiçbir lisans sunucusuna bağlı değildir ve dışarıya veri göndermez; tüm veriler tarayıcının yerel deposunda tutulur.

## Özellikler

**eBay ürün araştırma**
- Satıcı mağazalarını (canlı listelemeler veya satılmış ürünler) otomatik tarayıp potansiyel ürünleri toplar
- Mağaza adı / `/str/` linki / `/usr/` / `/sch/?_ssn=` girdisini otomatik olarak gerçek satıcıya çözer
- Ürün başına satış hızı (7/14/30 gün) verisi; ayarlanabilir "yakalama hassasiyeti" (Geniş / Normal / Sıkı)
- DOM'dan bağımsız sayfalama (URL `_pgn` tabanlı)

**AI (Google Gemini)**
- Ürün görseli + başlık üzerinden VeRO/marka/patent **risk skorlaması**
- Aynı ürünü satan rakip satıcıları bulmak için **görsel karşılaştırma**
- Kullanıcının kendi Gemini API anahtarıyla çalışır (yerel depoda saklanır)

**Amazon**
- Ürün/arama sayfalarında ASIN toplama, filtreleme ve toplu detay çekme

**Ana panel:** Araştırma, Amazon toplama, ASIN havuzu, kara listeler ve Mixer.

## Kurulum

1. `chrome://extensions` sayfasını açın
2. Sağ üstten **Geliştirici modu**'nu etkinleştirin
3. **Paketlenmemiş yükle** → bu klasörü seçin
4. Eklenti simgesi → **AI Araştırma** → **🔑 API Key Yönetimi** kısmına kendi [Google Gemini API anahtarınızı](https://aistudio.google.com/app/apikey) girin

## Gizlilik

Eklenti yalnızca sizin belirttiğiniz eBay/Amazon sayfalarına ve — AI özellikleri için — doğrudan Google Gemini API'sine bağlanır. Lisans doğrulama, telemetri veya uzak sunucu senkronizasyonu **yoktur**.
