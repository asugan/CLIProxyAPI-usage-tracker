import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

import {normalizeBaseUrl, parseCredentials, parseQuota, quotaRequest} from './quota.js';

export class RequestError extends Error {
    constructor(status, retryAt = 0) {
        const message = status === 401 ? 'Yetkilendirme reddedildi; yönetim anahtarını veya OAuth oturumunu kontrol edin.'
            : status === 403 ? 'Erişim reddedildi; hesap veya sunucu erişim kısıtını kontrol edin.'
                : status === 404 ? 'Uç nokta bulunamadı; CLIProxyAPI v8 ve yönetim erişimi gerekiyor.'
                    : status === 429 ? 'Sorgu sınırına ulaşıldı; otomatik olarak bekleniyor.'
                        : `İstek başarısız (HTTP ${status}).`;
        super(message);
        this.status = status;
        this.retryAt = retryAt;
    }
}

export function retryAt(headers, now = Date.now()) {
    const entry = Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === 'retry-after');
    const value = Array.isArray(entry?.[1]) ? entry[1][0] : entry?.[1];
    if (!value)
        return now + 15 * 60000;
    const seconds = Number(value);
    const time = Number.isFinite(seconds) ? now + seconds * 1000 : Date.parse(value);
    return Math.max(now + 60000, Number.isFinite(time) ? time : now + 15 * 60000);
}

export class QuotaClient {
    constructor(baseUrl, key) {
        this._url = `${normalizeBaseUrl(baseUrl)}/v8/management`;
        this._key = key;
        this._session = new Soup.Session({timeout: 15});
    }

    async _request(path, cancellable, body = null) {
        const message = Soup.Message.new(body === null ? 'GET' : 'POST', `${this._url}${path}`);
        // Never forward a management key to a redirect target.
        message.set_flags(Soup.MessageFlags.NO_REDIRECT);
        message.request_headers.append('Authorization', `Bearer ${this._key}`);
        if (body !== null)
            message.set_request_body_from_bytes('application/json', new GLib.Bytes(new TextEncoder().encode(JSON.stringify(body))));
        let bytes;
        try {
            bytes = await new Promise((resolve, reject) => {
                this._session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, cancellable, (session, result) => {
                    try {
                        resolve(session.send_and_read_finish(result));
                    } catch (error) {
                        reject(error);
                    }
                });
            });
        } catch (error) {
            if (error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                throw error;
            throw new Error('CLIProxyAPI bağlantısı kurulamadı veya zaman aşımına uğradı.');
        }
        if (message.status_code < 200 || message.status_code >= 300) {
            const retry = message.response_headers.get_one('Retry-After');
            throw new RequestError(message.status_code, message.status_code === 429 ? retryAt({'Retry-After': retry}) : 0);
        }
        try {
            return JSON.parse(new TextDecoder().decode(bytes.get_data()));
        } catch {
            throw new Error('CLIProxyAPI geçerli JSON döndürmedi.');
        }
    }

    async accounts(cancellable) {
        return parseCredentials(await this._request('/credentials', cancellable));
    }

    async quota(account, cancellable) {
        const response = await this._request('/requests/api-call', cancellable, quotaRequest(account));
        const status = Number(response?.status_code);
        if (!Number.isInteger(status) || status < 100)
            throw new Error('CLIProxyAPI kota sorgusunun durum kodu eksik.');
        if (status < 200 || status >= 300)
            throw new RequestError(status, status === 429 ? retryAt(response.header) : 0);
        return parseQuota(account.provider, response.body);
    }

    destroy() {
        this._session.abort();
        this._key = '';
    }
}
