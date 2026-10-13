import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

// A fake go, a fake store and a fake Ward. Deleting is owners only; everything forwarded carries the right key and the
// signed-in admin as X-Admin-Actor; only the listed routes exist.
const seen = [];
const ADMIN = '88888888-8888-4888-8888-888888888888';
const OWNER = '99999999-9999-4999-8999-999999999999';
const upstream = http.createServer((req, res) => {
  let b = ''; req.on('data', c => b += c); req.on('end', () => {
    seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, actor: req.headers['x-admin-actor'], body: b });
    res.setHeader('Content-Type', 'application/json');
    if (req.url === `/admin/v1/users/${ADMIN}`) return res.end(JSON.stringify({ user: { admin_level: 'admin', suspended_at: null } }));
    if (req.url === `/admin/v1/users/${OWNER}`) return res.end(JSON.stringify({ user: { admin_level: 'owner', suspended_at: null } }));
    res.end('{"ok":true}');
  });
});
await new Promise(r => upstream.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${upstream.address().port}`;
process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'b'.repeat(48);
process.env.PUBLIC_URL = 'http://localhost:3993';
process.env.WARD_URL = base;
process.env.WARD_ADMIN_KEY = 'ward-admin-key';
process.env.WARD_CLIENT_ID = 'telescreen-app';
process.env.WARD_CLIENT_SECRET = 'app-secret';
process.env.GO_URL = base;
process.env.GO_ADMIN_KEY = 'go-key-0123456789012345678901234567890';
process.env.STORE_URL = base;
process.env.STORE_ADMIN_KEY = 'store-key-0123456789012345678901234567';

const { buildApp } = await import('../src/server.js');
const { seal, SESSION_COOKIE } = await import('../src/session.js');
let app;
before(async () => { app = await buildApp({ logger: false }); });
after(async () => { await app.close(); upstream.close(); });
const as = (sub, level, email) => ({ cookie: `${SESSION_COOKIE}=${seal('session', { via: 'ward', sub, level, email, csrf: 'c' }, 3600)}`, 'x-telescreen-csrf': 'c', origin: 'http://localhost:3993' });
const admin = as(ADMIN, 'admin', 'helper@example.com'), owner = as(OWNER, 'owner', 'boss@example.com');
const forwarded = () => seen.filter(s => s.url.startsWith('/admin/v1/') && !s.url.startsWith('/admin/v1/users/'));
const BUNDLE = 'abcdefghjk';

test('go: admins can look, change and switch links; only owners delete', async () => {
  seen.length = 0;
  assert.equal((await app.inject({ method: 'DELETE', url: '/api/go/links/discord', headers: admin })).statusCode, 403);
  assert.equal(forwarded().length, 0, 'nothing reached go');
  for (const url of ['/api/go/overview', '/api/go/links', '/api/go/links?q=disc', '/api/go/links/discord', '/api/go/audit']) {
    assert.equal((await app.inject({ method: 'GET', url, headers: admin })).statusCode, 200, url);
  }
  assert.equal((await app.inject({ method: 'POST', url: '/api/go/links/discord', headers: admin, payload: { destination: 'https://discord.gg/y' } })).statusCode, 200);
  assert.equal((await app.inject({ method: 'POST', url: '/api/go/links/discord/disable', headers: admin, payload: {} })).statusCode, 200);
  seen.length = 0;
  assert.equal((await app.inject({ method: 'DELETE', url: '/api/go/links/discord', headers: owner })).statusCode, 200);
  const [call] = forwarded();
  assert.equal(`${call.method} ${call.url}`, 'DELETE /admin/v1/links/discord');
  assert.equal(call.auth, 'Bearer go-key-0123456789012345678901234567890');
  assert.equal(call.actor, 'boss@example.com');
});

test('store: admins can look and change sharing; only owners delete; nothing can upload or read a file', async () => {
  seen.length = 0;
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/store/bundles/${BUNDLE}`, headers: admin })).statusCode, 403);
  for (const url of ['/api/store/overview', '/api/store/bundles', `/api/store/bundles/${BUNDLE}`, '/api/store/audit']) {
    assert.equal((await app.inject({ method: 'GET', url, headers: admin })).statusCode, 200, url);
  }
  const change = await app.inject({ method: 'POST', url: `/api/store/bundles/${BUNDLE}`, headers: admin, payload: { access: 'guarded', mode: 'blacklist', list: ['zed'] } });
  assert.equal(change.statusCode, 200);
  const f = forwarded();
  assert.ok(f.every(x => x.auth === 'Bearer store-key-0123456789012345678901234567' && x.actor === 'helper@example.com'));
  assert.deepEqual(JSON.parse(f.at(-1).body), { access: 'guarded', mode: 'blacklist', list: ['zed'] });
  seen.length = 0;
  for (const [method, url] of [['POST', '/api/store/bundles'], ['POST', '/api/store/files'], ['GET', `/api/store/bundles/${BUNDLE}/files/x`], ['GET', '/api/store/../../admin/v1/users'], ['GET', '/api/store/bundles/short']]) {
    assert.notEqual((await app.inject({ method, url, headers: owner, payload: method === 'POST' ? {} : undefined })).statusCode, 200, `${method} ${url}`);
  }
  assert.equal(forwarded().length, 0);
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/store/bundles/${BUNDLE}`, headers: owner })).statusCode, 200);
});

test('keys never leave telescreen, and the signed-out get nothing', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/go/overview', headers: admin });
  assert.ok(!res.body.includes('go-key'));
  assert.equal((await app.inject({ method: 'GET', url: '/api/go/overview' })).statusCode, 401);
  assert.equal((await app.inject({ method: 'GET', url: '/api/store/overview' })).statusCode, 401);
  const page = await app.inject({ method: 'GET', url: '/go.js' });
  assert.equal(page.statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url: '/store.js' })).statusCode, 200);
});
