// Pure data helpers, shared by the Shell UI, preferences and fixture tests.
export function normalizeBaseUrl(value) {
    const url = String(value).trim().replace(/\/+$/, '').replace(/\/v8\/management$/, '');
    const match = url.match(/^(https?):\/\/(\[[\da-f:]+\]|[a-z\d.-]+)(?::(\d+))?(\/[^\s?#@]*)?$/i);
    if (!match || (match[3] && (Number(match[3]) < 1 || Number(match[3]) > 65535)))
        throw new Error('Geçerli bir sunucu adresi girin; kullanıcı adı, sorgu veya parola eklemeyin.');
    if (match[1].toLowerCase() === 'http' &&
        !['localhost', '127.0.0.1', '[::1]'].includes(match[2].toLowerCase()))
        throw new Error('Uzak sunucular için HTTPS kullanın veya yerel SSH tüneli açın.');
    if (/\/v0\/management$/.test(url))
        throw new Error('Bu eklenti CLIProxyAPI v8 gerektirir; sunucunun kök adresini girin.');
    return url;
}

function number(value) {
    if (!['number', 'string'].includes(typeof value) || (typeof value === 'string' && !value.trim()))
        return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
}

function percent(value) {
    const parsed = number(value);
    return parsed === null ? null : Math.min(100, Math.max(0, parsed));
}

function resetTime(value) {
    if (value === null || value === undefined || value === '')
        return null;
    const numeric = number(value);
    const parsed = numeric === null ? Date.parse(value) : numeric * 1000;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function accountId(file) {
    for (const source of [file, file.metadata, file.attributes]) {
        const direct = source?.chatgpt_account_id ?? source?.chatgptAccountId;
        if (typeof direct === 'string' && direct.trim())
            return direct.trim();
        // The credentials list may expose decoded ID-token metadata, not a token string.
        const token = source?.id_token;
        const id = token?.['https://api.openai.com/auth']?.chatgpt_account_id ?? token?.chatgpt_account_id;
        if (typeof id === 'string' && id.trim())
            return id.trim();
    }
    return null;
}

export function parseCredentials(payload) {
    if (!Array.isArray(payload?.files))
        throw new Error('Sunucu geçerli bir v8 hesap listesi döndürmedi.');
    const accounts = new Map();
    for (const file of payload.files) {
        if (!file || typeof file !== 'object')
            continue;
        const provider = String(file.provider ?? file.type ?? '').toLowerCase();
        if (!['claude', 'codex'].includes(provider) ||
            [true, 1, 'true', '1'].includes(file.disabled))
            continue;
        const index = file.auth_index ?? file.authIndex;
        if (index === undefined || index === null || String(index).trim() === '')
            continue;
        const id = String(index);
        accounts.set(id, {
            id,
            provider,
            label: String(file.label || file.email || file.name || provider),
            accountId: provider === 'codex' ? accountId(file) : null,
        });
    }
    return [...accounts.values()].sort((a, b) =>
        a.provider.localeCompare(b.provider) || a.label.localeCompare(b.label));
}

export function quotaRequest(account) {
    const claude = account.provider === 'claude';
    const header = {Authorization: 'Bearer $TOKEN$', Accept: 'application/json'};
    if (claude)
        header['anthropic-beta'] = 'oauth-2025-04-20';
    if (!claude && account.accountId)
        header['Chatgpt-Account-Id'] = account.accountId;
    return {
        auth_index: account.id,
        method: 'GET',
        url: claude
            ? 'https://api.anthropic.com/api/oauth/usage'
            : 'https://chatgpt.com/backend-api/wham/usage',
        header,
    };
}

export function parseQuota(provider, raw, now = Date.now()) {
    let payload;
    try {
        payload = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch {
        throw new Error('Sağlayıcı geçerli JSON döndürmedi.');
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload))
        throw new Error('Sağlayıcının kota yanıtı okunamadı.');
    const windows = [];
    if (provider === 'claude') {
        for (const [key, label] of [
            ['five_hour', '5 saatlik'], ['seven_day', 'Haftalık'],
            ['seven_day_opus', 'Opus · haftalık'], ['seven_day_sonnet', 'Sonnet · haftalık'],
            ['seven_day_oauth_apps', 'OAuth · haftalık'],
        ]) {
            const window = payload[key];
            if (!window || typeof window !== 'object')
                continue;
            windows.push({id: key, label, used: percent(window.utilization), resetAt: resetTime(window.resets_at)});
        }
    } else {
        const limit = payload.rate_limit;
        for (const [key, fallback] of [['primary_window', 'Birincil'], ['secondary_window', 'İkincil']]) {
            const window = limit?.[key];
            if (!window || typeof window !== 'object')
                continue;
            const seconds = number(window.limit_window_seconds);
            const label = seconds === 18000 ? '5 saatlik' : seconds === 604800 ? 'Haftalık'
                : seconds !== null && seconds >= 2419200 && seconds <= 2678400 ? 'Aylık' : fallback;
            const after = number(window.reset_after_seconds);
            windows.push({
                id: key, label, used: percent(window.used_percent),
                resetAt: resetTime(window.reset_at) ?? (after !== null && after >= 0 ? now + after * 1000 : null),
            });
        }
    }
    if (!windows.length)
        throw new Error('Bu hesap için desteklenen kota penceresi dönmedi.');
    return windows;
}

export function remaining(window) {
    return window.used === null ? null : Math.max(0, 100 - window.used);
}

export function panelSummary(accounts, now = Date.now()) {
    return [['claude', 'C'], ['codex', 'O']].flatMap(([provider, label]) => {
        const matching = accounts.filter(account => account.provider === provider);
        if (!matching.length)
            return [];
        const values = matching.flatMap(account => (account.windows ?? []).map(remaining)).filter(v => v !== null);
        const uncertain = matching.some(account => account.error || !account.windows?.length ||
            account.windows.some(window => remaining(window) === null || (window.resetAt !== null && window.resetAt <= now)));
        return [`${label} ${values.length ? `%${Math.floor(Math.min(...values))}` : '?'}${uncertain && values.length ? ' !' : ''}`];
    }).join(' · ') || 'AI';
}

export function resetLabel(resetAt, now = Date.now()) {
    if (resetAt === null)
        return 'Yenilenme zamanı bilinmiyor';
    const minutes = Math.ceil((resetAt - now) / 60000);
    if (minutes <= 0)
        return 'Yenilenme zamanı geçti; tekrar sorgulanmalı';
    if (minutes < 60)
        return `${minutes} dakika sonra yenilenir`;
    if (minutes < 1440)
        return `${Math.floor(minutes / 60)} saat ${minutes % 60} dakika sonra yenilenir`;
    return `${Math.floor(minutes / 1440)} gün ${Math.floor(minutes % 1440 / 60)} saat sonra yenilenir`;
}
