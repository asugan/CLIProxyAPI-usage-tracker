// Run inside GJS, not Node: proves the actual Soup transport and cancellation.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import System from 'system';
import {QuotaClient, retryAt} from '../api.js';

function assert(value, message) {
    if (!value)
        throw new Error(message);
}

async function rejects(action, status) {
    try {
        await action();
    } catch (error) {
        assert(error.status === status, `Expected HTTP ${status}, got ${error.status}`);
        return error;
    }
    throw new Error(`Expected HTTP ${status}`);
}

async function run(base) {
    const client = new QuotaClient(base, 'test-management-key');
    try {
        const accounts = await client.accounts(null);
        assert(accounts.length === 2, 'Expected two OAuth accounts');
        const claude = await client.quota(accounts[0], null);
        const codex = await client.quota(accounts[1], null);
        assert(claude[0].used === 32 && codex[0].used === 58, 'Quota parse failed');
    } finally {
        client.destroy();
    }
    for (const [path, status] of [['unauthorized', 401], ['forbidden', 403], ['redirect', 302], ['missing', 404], ['limited', 429]]) {
        const other = new QuotaClient(`${base}/${path}`, 'test-management-key');
        try {
            const error = await rejects(() => other.accounts(null), status);
            if (status === 429)
                assert(error.retryAt > Date.now(), 'HTTP Retry-After not preserved');
        } finally {
            other.destroy();
        }
    }
    for (const status of [401, 429]) {
        const other = new QuotaClient(`${base}/upstream-${status}`, 'test-management-key');
        try {
            const error = await rejects(() => other.quota({id: 'c', provider: 'claude'}, null), status);
            if (status === 429)
                assert(error.retryAt > Date.now(), 'Upstream Retry-After not preserved');
        } finally {
            other.destroy();
        }
    }
    for (const path of ['malformed', 'missing-status']) {
        const other = new QuotaClient(`${base}/${path}`, 'test-management-key');
        let failed = false;
        try {
            if (path === 'malformed')
                await other.accounts(null);
            else
                await other.quota({id: 'c', provider: 'claude'}, null);
        } catch {
            failed = true;
        } finally {
            other.destroy();
        }
        assert(failed, `${path} must not produce fabricated quota data`);
    }
    const cancelled = new Gio.Cancellable();
    cancelled.cancel();
    const other = new QuotaClient(base, 'test-management-key');
    let cancellationWorked = false;
    try {
        await other.accounts(cancelled);
    } catch (error) {
        cancellationWorked = error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED);
    } finally {
        other.destroy();
    }
    assert(cancellationWorked, 'Cancellation was lost');
    assert(retryAt({}, 1000) === 901000, 'Default backoff must be 15 minutes');
    assert(retryAt({'Retry-After': ['120']}, 1000) === 121000, 'Numeric retry header failed');
    const date = 'Sun, 18 Oct 2026 13:00:00 GMT';
    assert(retryAt({'retry-after': date}, Date.parse(date) - 120000) === Date.parse(date), 'Date retry header failed');
    print('GJS/Soup integration passed');
}

const loop = new GLib.MainLoop(null, false);
let failed = false;
run(ARGV[0]).catch(error => {
    failed = true;
    printerr(error.stack);
}).finally(() => loop.quit());
loop.run();
if (failed)
    System.exit(1);
