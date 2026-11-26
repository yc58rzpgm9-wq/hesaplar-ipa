# Android APK

APK, `.github/workflows/android-apk.yml` iş akışıyla GitHub Actions üzerinde derlenir.

1. Bu projedeki tüm dosyaları (`.github` klasörü dahil) GitHub deposuna yükleyin.
2. Actions sekmesinde **Android APK oluştur** iş akışını seçin ve **Run workflow** düğmesine basın.
3. Bittiğinde çalışma sayfasının altındaki **Artifacts** bölümünden `Hesaplar-apk` dosyasını indirin. İçinden `Hesaplar.apk` çıkar.
4. APK'yı telefona atıp açın. "Bilinmeyen kaynaklardan yükleme" izni istenirse verin.

Bu APK debug imzasıyla derlenir; kişisel kullanım için uygundur. Google Play'e yüklemek için ayrıca release imzası gerekir.
