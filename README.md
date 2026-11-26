# Çelikler Hesaplar — iOS uygulaması (IPA)

Süt, veresiye, yem ve veteriner ilaç kayıtlarını tutan **Hesaplar** uygulamasının
(https://celiksut.netlify.app) iPhone'a kurulabilen IPA sürümü.

Uygulamanın HTML dosyaları `www/` klasöründedir. GitHub Actions bu dosyaları
[Capacitor](https://capacitorjs.com) ile bir iOS uygulamasına sarar ve imzasız bir
`Hesaplar.ipa` dosyası üretir.

## Klasörler

| Yol | İçerik |
| --- | --- |
| `www/index.html` | Uygulamanın kendisi (tek HTML dosyası) |
| `www/sync-store.js` | Cihaza kayıt + bulut eşitleme (`https://celiksut.netlify.app/api/sync`) |
| `www/manifest.webmanifest`, `www/app-icon.svg`, `www/service-worker.js` | Web uygulaması (PWA) dosyaları |
| `resources/` | iOS simgesi (1024×1024) ve açılış ekranı |
| `capacitor.config.json` | Uygulama adı, paket kimliği (`com.celikler.hesaplar`) |
| `.github/workflows/ios-ipa.yml` | IPA'yı derleyen GitHub Actions iş akışı (tek başına da çalışır) |
| `www/kurulum.html` | GitHub kurulum sayfası (IPA'ya konmaz) |
| `www/indir/` | HTML ve tüm proje ZIP dosyaları, indirme sayfası (IPA'ya konmaz) |

## GitHub ile IPA oluşturma

Depo hazır: https://github.com/mehmetcelik14015/hesaplar-ipa — IPA'yı oradaki **Actions**
sekmesinden indir, yenisi için **Run workflow**'a bas.

**En kolay yol (tek dosya):** Netlify'daki sitenin `/kurulum` sayfasını aç
(https://html-github-ipa.netlify.app/kurulum). GitHub kullanıcı adını yaz, sırayla
düğmelere bas: boş depo oluşturulur, iş akışı dosyası içi dolu şekilde açılır, sen
yalnızca **Commit changes**'a basarsın. Derleme kendiliğinden başlar.

`.github/workflows/ios-ipa.yml` tek başına çalışır: depoda `www/` yoksa HTML dosyalarını
canlı siteden (`celiksut.netlify.app`) indirir, gerekli düzeltmeleri uygular, simgeyi ve
açılış ekranını `app-icon.svg`'den üretir. Bu yüzden her derlemede canlı sitedeki son sürüm alınır.

**Tüm projeyle:** Bu projedeki tüm dosyaları (`.github` klasörü dahil) bir GitHub deposuna
yüklersen iş akışı depodaki `www/` ve `resources/` dosyalarını kullanır.

Her iki durumda da: **Actions → iOS IPA oluştur → Run workflow**. İş bittiğinde
(yaklaşık 5–10 dk) çalışma sayfasının altındaki **Artifacts** bölümünden **Hesaplar-ipa**
dosyasını indir, içinden `Hesaplar.ipa` çıkar.

## IPA'yı iPhone'a kurma

Üretilen IPA **imzasızdır** (Apple geliştirici hesabı gerektirmez). Telefona kurmak için
kendi Apple kimliğinle imzalayan bir araç kullan: **Sideloadly**, **AltStore** veya
**TrollStore** (destekleyen iOS sürümlerinde). Ücretsiz Apple kimliğiyle imzalanan
uygulamalar 7 günde bir yeniden imzalanmalıdır; ücretli geliştirici hesabında bu süre 1 yıldır.

## Yerelde çalıştırma (Mac)

```bash
npm install
npx cap add ios      # yalnızca ilk sefer
npx cap sync ios
npx cap open ios     # Xcode açılır, telefona doğrudan kurabilirsin
```

Web sürümünü denemek için `www/` klasörünü herhangi bir statik sunucuyla açman yeterli
(ör. `npx serve www`). Netlify'da bu klasör yayınlanır ve `/api/*` istekleri canlı siteye yönlendirilir.

## Güncelleme

Canlı sitede değişiklik yaptığında yeni `index.html` ve `sync-store.js` dosyalarını `www/`
içine kopyala. `sync-store.js` içindeki `PRODUCTION_ORIGIN` değeri
`https://celiksut.netlify.app` olarak kalmalı; uygulama kayıtları buradan eşitler.
