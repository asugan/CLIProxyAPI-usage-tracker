import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import http from 'node:http';
import {fileURLToPath} from 'node:url';
import test from 'node:test';

test('actual GJS/Soup client handles OAuth probes, HTTP/upstream errors, redirects and cancellation', {timeout: 20000}, async () => {
    const calls = [];
    const errors = [];
    const server = http.createServer(async (request, response) => {
        calls.push(request.url);
        let text = '';
        for await (const chunk of request)
            text += chunk;
        try {
            assert.equal(request.headers.authorization, 'Bearer test-management-key');
            assert.ok(!/usage-queue|config|download|refresh|reset/.test(request.url));
            const mode = request.url.split('/')[1];
            const status = {unauthorized: 401, forbidden: 403, redirect: 302, missing: 404, limited: 429}[mode];
            if (status) {
                response.writeHead(status, {'Retry-After': '120', Location: '/redirect-target'});
                response.end('{}');
                return;
            }
            response.setHeader('Content-Type', 'application/json');
            if (mode === 'malformed') {
                response.end('not json');
            } else if (mode === 'missing-status') {
                response.end(JSON.stringify({body: '{}'}));
            } else if (mode.startsWith('upstream-')) {
                response.end(JSON.stringify({status_code: Number(mode.slice(9)), header: {'Retry-After': ['120']}, body: '{}'}));
            } else if (request.url.endsWith('/credentials')) {
                assert.equal(request.method, 'GET');
                response.end(JSON.stringify({files: [
                    {provider: 'claude', auth_index: 'c', email: 'claude@example.test'},
                    {provider: 'codex', auth_index: 'o', chatgpt_account_id: 'team-1'},
                ]}));
            } else {
                assert.equal(request.url, '/v8/management/requests/api-call');
                assert.equal(request.method, 'POST');
                const payload = JSON.parse(text);
                assert.equal(payload.header.Authorization, 'Bearer $TOKEN$');
                assert.equal(payload.method, 'GET');
                if (payload.auth_index === 'c') {
                    assert.equal(payload.url, 'https://api.anthropic.com/api/oauth/usage');
                    response.end(JSON.stringify({status_code: 200, body: JSON.stringify({five_hour: {utilization: 32}})}));
                } else {
                    assert.equal(payload.header['Chatgpt-Account-Id'], 'team-1');
                    assert.equal(payload.url, 'https://chatgpt.com/backend-api/wham/usage');
                    response.end(JSON.stringify({status_code: 200, body: {rate_limit: {primary_window: {used_percent: 58}}}}));
                }
            }
        } catch (error) {
            errors.push(error.message);
            response.writeHead(500);
            response.end('{}');
        }
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    let child;
    try {
        const base = `http://127.0.0.1:${server.address().port}`;
        child = spawn('gjs', ['-m', fileURLToPath(new URL('./api-runner.js', import.meta.url)), base]);
        let output = '';
        child.stdout.on('data', chunk => output += chunk);
        child.stderr.on('data', chunk => output += chunk);
        const [code] = await once(child, 'exit');
        assert.equal(code, 0, output);
        assert.match(output, /integration passed/);
        assert.deepEqual(errors, []);
        assert.ok(!calls.includes('/redirect-target'), 'Management redirect must not be followed');
    } finally {
        if (child && child.exitCode === null)
            child.kill();
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
    }
});
