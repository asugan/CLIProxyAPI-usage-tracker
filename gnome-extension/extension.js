import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {QuotaClient} from './api.js';
import {normalizeBaseUrl, panelSummary, remaining, resetLabel} from './quota.js';
import {lookupKey} from './secrets.js';

export default class CliProxyQuota extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._generation ??= 0;
        this._accounts = [];
        this._button = new PanelMenu.Button(0.0, 'CLIProxy Quota · kalan kotalar');
        const box = new St.BoxLayout({style_class: 'panel-status-menu-box'});
        box.add_child(new St.Icon({icon_name: 'utilities-system-monitor-symbolic', style_class: 'system-status-icon'}));
        this._label = new St.Label({text: 'AI', y_align: Clutter.ActorAlign.CENTER});
        box.add_child(this._label);
        this._button.add_child(box);
        Main.panel.addToStatusArea(this.uuid, this._button);
        this._button.menu.connect('open-state-changed', (_menu, open) => {
            if (open) {
                this._render();
                if (Date.now() - this._lastAttempt >= this._interval())
                    void this._refresh();
            }
        });
        this._settingsSignal = this._settings.connect('changed', () => {
            if (!this._configureSource) {
                this._configureSource = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                    this._configureSource = 0;
                    this._configure();
                    return GLib.SOURCE_REMOVE;
                });
            }
        });
        this._configure();
    }

    _interval() {
        return this._settings.get_int('refresh-minutes') * 60000;
    }

    _configure() {
        this._generation++;
        this._cancellable?.cancel();
        this._client?.destroy();
        this._client = null;
        this._cancellable = new Gio.Cancellable();
        this._accounts = [];
        this._backoff = new Map();
        this._authBlocked = false;
        this._retryAt = 0;
        this._lastAttempt = 0;
        this._busy = false;
        this._error = '';
        if (this._timer)
            GLib.Source.remove(this._timer);
        this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 60, () => {
            if (Date.now() - this._lastAttempt >= this._interval())
                void this._refresh();
            if (this._button.menu.isOpen)
                this._render();
            return GLib.SOURCE_CONTINUE;
        });
        void this._refresh();
    }

    async _refresh() {
        const now = Date.now();
        if (this._busy || this._authBlocked || now < this._retryAt || now - this._lastAttempt < 60000)
            return;
        const generation = this._generation;
        const cancellable = this._cancellable;
        this._lastAttempt = now;
        this._busy = true;
        this._error = '';
        this._render();
        try {
            if (!this._client) {
                const server = normalizeBaseUrl(this._settings.get_string('base-url'));
                const key = await lookupKey(server, cancellable);
                if (generation !== this._generation)
                    return;
                if (!key)
                    throw new Error('Ayarlar’dan CLIProxyAPI yönetim anahtarını kaydedin.');
                this._client = new QuotaClient(server, key);
            }
            let accounts;
            try {
                accounts = await this._client.accounts(cancellable);
            } catch (error) {
                // Stop auth retries until settings change; CPA bans repeated invalid management keys.
                if (generation === this._generation) {
                    this._authBlocked = error.status === 401 || error.status === 403;
                    this._retryAt = error.retryAt || 0;
                }
                throw error;
            }
            if (generation !== this._generation)
                return;
            const previous = new Map(this._accounts.map(account => [account.id, account]));
            const results = [];
            for (const account of accounts) {
                if (cancellable.is_cancelled())
                    return;
                const old = previous.get(account.id);
                if (now < (this._backoff.get(account.id) || 0)) {
                    results.push({...account, windows: old?.windows, updatedAt: old?.updatedAt,
                        error: 'Sorgu sınırı nedeniyle bekleniyor; gösterilen veri güncel olmayabilir.'});
                    continue;
                }
                try {
                    const windows = await this._client.quota(account, cancellable);
                    if (generation !== this._generation)
                        return;
                    this._backoff.delete(account.id);
                    results.push({...account, windows, updatedAt: Date.now()});
                } catch (error) {
                    if (generation !== this._generation)
                        return;
                    if (error.retryAt)
                        this._backoff.set(account.id, error.retryAt);
                    results.push({...account, windows: old?.windows, updatedAt: old?.updatedAt, error: error.message});
                }
            }
            if (generation === this._generation)
                this._accounts = results;
        } catch (error) {
            if (generation === this._generation)
                this._error = error.message;
        } finally {
            if (generation === this._generation) {
                this._busy = false;
                this._render();
            }
        }
    }

    _text(parent, text, style = 'cpa-muted') {
        const label = new St.Label({text, style_class: style, x_expand: true});
        label.clutter_text.line_wrap = true;
        label.clutter_text.ellipsize = 0;
        parent.add_child(label);
    }

    _render() {
        if (!this._button)
            return;
        this._label.text = panelSummary(this._accounts) + (this._error ? ' !' : '');
        const menu = this._button.menu;
        menu.removeAll();
        const title = new PopupMenu.PopupMenuItem('AI Kullanım Limitleri', {reactive: false});
        title.label.add_style_class_name('cpa-heading');
        menu.addMenuItem(title);
        const section = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        const scroll = new St.ScrollView({style_class: 'cpa-scroll', overlay_scrollbars: true, x_expand: true});
        scroll.set_policy(St.PolicyType.NEVER, St.PolicyType.AUTOMATIC);
        const content = new St.BoxLayout({vertical: true, style_class: 'cpa-content', x_expand: true});
        scroll.set_child(content);
        section.add_child(scroll);
        menu.addMenuItem(section);
        this._text(content, 'Üst panel: hesaplar ve bilinen pencereler arasındaki en düşük kalan yüzde.');
        if (this._error)
            this._text(content, `${this._error}${this._accounts.length ? ' Son bilinen veriler gösteriliyor.' : ''}`, 'cpa-error');
        if (this._busy)
            this._text(content, 'Kotalar sorgulanıyor…');
        if (!this._busy && !this._error && !this._accounts.length)
            this._text(content, 'Etkin Claude veya Codex OAuth hesabı bulunamadı.');
        for (const account of this._accounts) {
            const card = new St.BoxLayout({vertical: true, style_class: 'cpa-card', x_expand: true});
            this._text(card, account.provider === 'claude' ? 'Claude' : 'OpenAI / Codex', 'cpa-provider');
            this._text(card, account.label, 'cpa-account');
            if (account.error)
                this._text(card, account.error, 'cpa-error');
            for (const window of account.windows ?? []) {
                const value = remaining(window);
                const expired = window.resetAt !== null && window.resetAt <= Date.now();
                this._text(card, `${window.label}  ·  ${value === null ? 'Kota bilinmiyor' : `%${Math.floor(value)} kalan`}`,
                    account.error || this._error || expired ? 'cpa-muted' : 'cpa-quota');
                const track = new St.BoxLayout({style_class: 'cpa-track'});
                if (value !== null) {
                    const color = account.error || this._error || expired ? 'cpa-stale' : value <= 20 ? 'cpa-critical'
                        : value <= 40 ? 'cpa-low' : 'cpa-good';
                    track.add_child(new St.Widget({style_class: `cpa-fill ${color}`, width: 280 * value / 100}));
                }
                card.add_child(track);
                this._text(card, resetLabel(window.resetAt));
            }
            if (account.updatedAt) {
                const age = Math.max(0, Math.floor((Date.now() - account.updatedAt) / 60000));
                this._text(card, `Son başarılı sorgu: ${age ? `${age} dakika önce` : 'az önce'}`);
            }
            content.add_child(card);
        }
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        const waiting = Date.now() < this._retryAt;
        const refresh = menu.addAction(this._busy ? 'Yenileniyor…' : waiting ? 'Sorgu sınırı: bekleniyor' : 'Şimdi yenile',
            () => void this._refresh(), 'view-refresh-symbolic');
        refresh.sensitive = !this._busy && !this._authBlocked && !waiting && Date.now() - this._lastAttempt >= 60000;
        menu.addAction('Ayarlar', () => this.openPreferences(), 'emblem-system-symbolic');
    }

    disable() {
        this._generation++;
        this._cancellable?.cancel();
        this._client?.destroy();
        this._client = null;
        for (const source of [this._timer, this._configureSource]) {
            if (source)
                GLib.Source.remove(source);
        }
        this._timer = 0;
        this._configureSource = 0;
        this._settings.disconnect(this._settingsSignal);
        this._settings = null;
        this._button.destroy();
        this._button = null;
        this._label = null;
        this._accounts = [];
        this._backoff.clear();
        this._cancellable = null;
    }
}
