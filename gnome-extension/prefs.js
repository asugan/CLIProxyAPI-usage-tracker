import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk?version=4.0';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {normalizeBaseUrl} from './quota.js';
import {lookupKey, storeKey} from './secrets.js';

export default class QuotaPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window.set_default_size(620, 540);
        const page = new Adw.PreferencesPage({title: 'CLIProxy Quota', icon_name: 'utilities-system-monitor-symbolic'});
        const group = new Adw.PreferencesGroup({title: 'CLIProxyAPI bağlantısı',
            description: 'CLIProxyAPI v8 gerekir. Proxy istemci anahtarı değil, yönetim anahtarını girin.'});
        const server = new Adw.EntryRow({title: 'Sunucu adresi', text: settings.get_string('base-url')});
        const key = new Adw.PasswordEntryRow({title: 'Yönetim anahtarı (değiştirmek için girin)'});
        const interval = new Adw.SpinRow({title: 'Otomatik yenileme (dakika)',
            subtitle: 'Sık kota sorgularını önlemek için varsayılan 20 dakika.',
            adjustment: new Gtk.Adjustment({lower: 5, upper: 60, step_increment: 5, page_increment: 10,
                value: settings.get_int('refresh-minutes')})});
        group.add(server);
        group.add(key);
        group.add(interval);
        const security = new Adw.PreferencesGroup({title: 'Gizlilik ve güvenlik',
            description: 'Anahtar GNOME Keyring’de saklanır. Boş bırakırsanız bu sunucunun kayıtlı anahtarı korunur. '
                + 'OAuth dosyaları indirilmez; kullanım kuyruğu okunmaz. Uzak sunucular için HTTPS zorunludur.'});
        const status = new Adw.ActionRow({title: 'Ayarları kaydettikten sonra kotalar sorgulanır.',
            subtitle: 'Hesap adları yalnızca panel menüsünde gösterilir.'});
        const save = new Gtk.Button({label: 'Kaydet', css_classes: ['suggested-action'], valign: Gtk.Align.CENTER});
        status.add_suffix(save);
        security.add(status);
        save.connect('clicked', async () => {
            save.sensitive = false;
            try {
                const baseUrl = normalizeBaseUrl(server.text);
                const password = key.text.trim();
                if (password) {
                    if (!await storeKey(baseUrl, password))
                        throw new Error('Yönetim anahtarı kaydedilemedi.');
                } else if (!await lookupKey(baseUrl)) {
                    throw new Error('Bu sunucu için bir yönetim anahtarı girin.');
                }
                settings.delay();
                settings.set_string('base-url', baseUrl);
                settings.set_int('refresh-minutes', interval.value);
                settings.set_int('key-revision', (settings.get_int('key-revision') + 1) % 2147483647);
                settings.apply();
                key.text = '';
                server.text = baseUrl;
                status.title = 'Kaydedildi. Panel bağlantıyı kontrol ediyor.';
            } catch (error) {
                status.title = error.message;
            } finally {
                save.sensitive = true;
            }
        });
        page.add(group);
        page.add(security);
        window.add(page);
    }
}
