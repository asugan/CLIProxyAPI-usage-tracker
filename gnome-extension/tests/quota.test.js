import assert from 'node:assert/strict';
import test from 'node:test';
import {accountId, normalizeBaseUrl, panelSummary, parseCredentials, parseQuota, quotaRequest, remaining, resetLabel} from '../quota.js';

const now = Date.parse('2026-10-18T12:00:00Z');

test('normalizes server URLs without exposing a secret to remote HTTP', () => {
    assert.equal(normalizeBaseUrl(' http://127.0.0.1:8317/v8/management/ '), 'http://127.0.0.1:8317');
    assert.equal(normalizeBaseUrl('https://example.com/proxy/'), 'https://example.com/proxy');
    assert.equal(normalizeBaseUrl('http://[::1]:8317'), 'http://[::1]:8317');
    for (const url of ['http://example.com', 'file:///etc/passwd', 'https://user:secret@example.com',
        'https://example.com?key=secret', 'https://example.com/#secret', 'https://example.com:65536',
        'http://127.0.0.1.evil.test', 'http://127.0.0.1:8317/v0/management', ''])
        assert.throws(() => normalizeBaseUrl(url));
});

test('lists only supported enabled OAuth accounts, preserving cooldown accounts', () => {
    const accounts = parseCredentials({files: [
        {provider: 'claude', auth_index: 'c', email: 'c@example.test', unavailable: true},
        {type: 'codex', authIndex: 'o', label: 'Work', metadata: {chatgpt_account_id: 'team-1'}},
        {provider: 'codex', auth_index: 'o', label: 'Work', metadata: {chatgpt_account_id: 'team-1'}},
        {provider: 'claude', auth_index: 'disabled', disabled: 'true'},
        {provider: 'claude', auth_index: 'disabled2', disabled: 1},
        {provider: 'antigravity', auth_index: 'g'},
        {provider: 'claude'}, null,
    ]});
    assert.deepEqual(accounts.map(a => a.id), ['c', 'o']);
    assert.equal(accounts[1].accountId, 'team-1');
    assert.throws(() => parseCredentials({error: 'no list'}));
    assert.deepEqual(parseCredentials({files: []}), []);
});

test('resolves Codex ID from metadata without decoding or downloading credential files', () => {
    assert.equal(accountId({id_token: {'https://api.openai.com/auth': {chatgpt_account_id: 'a'}}}), 'a');
    assert.equal(accountId({attributes: {chatgptAccountId: ' b '}}), 'b');
    assert.equal(accountId({}), null);
});

test('quota probes use selected credential and only the two fixed usage endpoints', () => {
    const request = quotaRequest({provider: 'claude', id: 'c'});
    assert.equal(request.method, 'GET');
    assert.equal(request.auth_index, 'c');
    assert.equal(request.header.Authorization, 'Bearer $TOKEN$');
    assert.equal(request.header['anthropic-beta'], 'oauth-2025-04-20');
    assert.equal(request.url, 'https://api.anthropic.com/api/oauth/usage');
    const codex = quotaRequest({provider: 'codex', id: 'o', accountId: 'team-1'});
    assert.equal(codex.header['Chatgpt-Account-Id'], 'team-1');
    assert.equal(codex.url, 'https://chatgpt.com/backend-api/wham/usage');
});

test('Claude converts used utilization to remaining without assuming null is zero', () => {
    const windows = parseQuota('claude', JSON.stringify({
        five_hour: {utilization: 32, resets_at: '2026-10-18T14:00:00Z'},
        seven_day: {utilization: '59', resets_at: null},
        seven_day_opus: {utilization: null}, seven_day_sonnet: null,
        extra_usage: {used_credits: 100},
    }));
    assert.deepEqual(windows.map(remaining), [68, 41, null]);
    assert.equal(windows[0].resetAt, now + 7200000);
    assert.equal(windows[1].resetAt, null);
    assert.equal(windows.length, 3);
});

test('invalid utilization remains unknown and percentages stay bounded', () => {
    for (const value of [null, undefined, '', ' ', true, [], {}, 'invalid'])
        assert.equal(parseQuota('claude', {five_hour: {utilization: value}})[0].used, null);
    assert.equal(remaining(parseQuota('claude', {five_hour: {utilization: 105}})[0]), 0);
    assert.equal(remaining(parseQuota('claude', {five_hour: {utilization: -5}})[0]), 100);
});

test('Codex classifies windows by duration rather than assuming primary means five hours', () => {
    const windows = parseQuota('codex', {rate_limit: {
        primary_window: {used_percent: 17, limit_window_seconds: 604800, reset_at: 1792332000},
        secondary_window: {used_percent: 58, limit_window_seconds: 18000, reset_after_seconds: 5400},
    }}, now);
    assert.equal(windows[0].label, 'Haftalık');
    assert.equal(windows[1].label, '5 saatlik');
    assert.equal(windows[0].resetAt, 1792332000000);
    assert.equal(windows[1].resetAt, now + 5400000);
    assert.deepEqual(windows.map(remaining), [83, 42]);
});

test('Codex null percentages and missing durations do not invent a quota', () => {
    const [window] = parseQuota('codex', {rate_limit: {allowed: false, primary_window: {used_percent: null}}});
    assert.equal(window.used, null);
    assert.equal(window.label, 'Birincil');
    assert.equal(window.resetAt, null);
    const [monthly] = parseQuota('codex', {rate_limit: {primary_window: {used_percent: 10, limit_window_seconds: 2592000}}});
    assert.equal(monthly.label, 'Aylık');
});

test('empty, malformed and unsupported responses surface an error', () => {
    for (const value of [null, 'not json', '{}', [], {rate_limit: null}])
        assert.throws(() => parseQuota('codex', value));
    assert.throws(() => parseQuota('claude', {five_hour: null, seven_day: null}));
});

test('summary uses minimum remaining, never sums or averages accounts', () => {
    const accounts = [
        {provider: 'claude', windows: [{used: 32, resetAt: null}, {used: 59, resetAt: null}]},
        {provider: 'claude', windows: [{used: 80, resetAt: null}]},
        {provider: 'codex', windows: [{used: 58, resetAt: null}]},
    ];
    assert.equal(panelSummary(accounts, now), 'C %20 · O %42');
    accounts[0].error = 'offline';
    assert.equal(panelSummary(accounts, now), 'C %20 ! · O %42');
    assert.equal(panelSummary([{provider: 'codex', error: 'offline'}], now), 'O ?');
    assert.equal(panelSummary([], now), 'AI');
});

test('expired quota windows are marked stale and never auto-reset to 100%', () => {
    assert.equal(panelSummary([{provider: 'claude', windows: [{used: 90, resetAt: now - 1}]}], now), 'C %10 !');
    assert.match(resetLabel(now - 1, now), /tekrar sorgulanmalı/);
});

test('reset labels handle unknown and future times', () => {
    assert.match(resetLabel(null, now), /bilinmiyor/);
    assert.equal(resetLabel(now + 90000, now), '2 dakika sonra yenilenir');
    assert.equal(resetLabel(now + 8100000, now), '2 saat 15 dakika sonra yenilenir');
    assert.equal(resetLabel(now + 90000000, now), '1 gün 1 saat sonra yenilenir');
});
