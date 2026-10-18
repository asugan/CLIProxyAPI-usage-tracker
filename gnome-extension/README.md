# CLIProxy Quota — GNOME üst panel eklentisi

Ubuntu 24.04 / GNOME Shell **46** ve CLIProxyAPI **v8** için hazırlanmıştır. Electron uygulamasından bağımsızdır; ek npm paketi, daemon veya veritabanı gerektirmez.

## Özellikler

- Üst panelde `C %68 · O %42`: Claude / OpenAI-Codex için hesaplar ve bilinen kota pencereleri arasındaki **en düşük kalan yüzde**. Toplam kapasite veya otomatik seçilen aktif hesap değildir.
- Tıklanınca her etkin OAuth hesabının 5 saatlik / haftalık kotaları ve yenilenme süreleri. Sunucu döndürürse Claude Opus/Sonnet/OAuth haftalık ve Codex aylık pencereleri de gösterilir.
- Varsayılan 20 dakikalık yenileme; elle sorgular arasında en az 60 saniye. 429 yanıtında `Retry-After` kadar, belirtilmemişse 15 dakika bekleme.
- Hatalarda son başarılı veri korunur ve güncel olmadığı belirtilir. `?` bilinmeyen kota, `!` hata veya eksik veri anlamına gelir. Süresi geçmiş bir pencerenin yenilendiği varsayılmaz.
- Yönetim anahtarı yalnızca GNOME Keyring'de tutulur; GSettings'te veya kaynak kodunda tutulmaz. Tarayıcı çerezi ve OAuth dosyası okunmaz.

## Paketleme ve kurulum

Bu klasörde:

```bash
npm test
npm run build
gnome-extensions install dist/cliproxy-quota@asugan.shell-extension.zip
```

İlk kurulumdan sonra oturumu kapatıp açın. Ardından:

```bash
gnome-extensions enable cliproxy-quota@asugan
gnome-extensions prefs cliproxy-quota@asugan
```

Ayarlar'da `http://127.0.0.1:8317` ve CLIProxyAPI **yönetim anahtarını** girip Kaydet'e basın. Normal proxy API anahtarı aynı değildir. Yanlış anahtarın tekrar tekrar gönderilmesini önlemek için yönetim API'si 401/403 döndürdüğünde sorgular ayarlar yeniden kaydedilene kadar durur.

Paketlemek için Python 3 ve `glib-compile-schemas`; çalıştırmak için Soup 3, GTK 4, libadwaita ve libsecret GObject introspection paketleri gerekir. Eksikse Ubuntu paketleri: `gir1.2-soup-3.0 gir1.2-secret-1 gir1.2-adw-1 gir1.2-gtk-4.0 libglib2.0-bin`.

Güncellemede mevcut eklentiyi devre dışı bırakıp paketi `gnome-extensions install --force ...` ile kurun; oturumu yeniden açın. Kod değişiklikleri Shell tarafından önbelleğe alınır. Kullanılan diğer eklentileri kapatmanız gerekmez.

## Veri akışı ve güvenlik

`GET /v8/management/credentials` → etkin `claude` / `codex` hesapları → `POST /v8/management/requests/api-call` ile sağlayıcının kullanım uç noktası. `$TOKEN$` yer tutucusunu CLIProxyAPI doldurur. Dönen yönetim yanıtının içindeki `status_code` ayrıca kontrol edilir.

Hesap adları ve kota verileri yalnızca bellekte tutulur. Kullanım kuyruğu tüketilmez, proxy ayarları değiştirilmez, kota sıfırlama veya oturum yenileme işlemi başlatılmaz. Sağlayıcı token yenileme işlemleri CLIProxyAPI'nin sorumluluğundadır. Kota sorgusu model üretimi isteği göndermez.

Yönetim anahtarı geniş yetkilidir. Yalnızca güvendiğiniz CLIProxyAPI adresini girin. Yerel HTTP dışında HTTPS gerekir; yönlendirmeler takip edilmez. SSH tüneli kullanabilirsiniz. TLS doğrulaması kapatılmaz.

Anahtarı silmek için GNOME **Parolalar ve Anahtarlar** uygulamasındaki `CLIProxy Quota` kaydını silin ve eklentiyi kapatın. Eklentiyi kaldırmak Keyring kaydını otomatik silmez.

## Doğrulama sınırları

13 test saf veri dönüşümlerini ve gerçek GJS/Soup istemcisini yerel sahte HTTP sunucusuna karşı doğrular. `npm run build` GSettings şemasını da doğrular. GNOME 46 üzerinde yalıtılmış headless oturumda panel menüsünün açılması, başarısız sorguda eski verinin korunması ve kapatıp yeniden etkinleştirme ayrıca denendi. Ayar penceresinin oluşturulması gerçek GTK/libadwaita ile, görünür pencere açmadan doğrulandı.

Gerçek hesap kotaları ve Keyring'e anahtar kaydetme ancak kendi anahtarınızla bağlandıktan sonra uçtan uca kontrol edilebilir. Tema, ekran ölçekleme ve klavye davranışı kendi oturumunuzda ayrıca denenmelidir; başka Shell sürümleri için uyumluluk iddiası yoktur.

Sağlayıcı kota uç noktaları değişebilir. Desteklenmeyen/eksik alanlardan sahte yüzde veya sınırsız kullanım üretilmez. İlk sürüm Codex ek model / code-review kotalarını, bakiye ve ücret istatistiklerini kapsamaz.

Hata günlüğü:

```bash
journalctl --user -b -o cat /usr/bin/gnome-shell
```
