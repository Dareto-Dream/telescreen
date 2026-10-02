import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

// A fake search service and a fake Ward, so we can check exactly what telescreen forwards
// (key, actor, body), what it refuses, and that the key never reaches the browser.
const seen = [];
const OWNER = '44444444-4444-4444-8444-444444444444';
const ADMIN = '55555555-5555-4555-8555-555555555555';
const upstream = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, actor: req.headers['x-admin-actor'], body });
    res.setHeader('Content-Type', 'application/json');
    if (req.url === `/admin/v1/users/${OWNER}`) return res.end(JSON.stringify({ user: { admin_level: 'owner', suspended_at: null } }));
    if (req.url === `/admin/v1/users/${ADMIN}`) return res.end(JSON.stringify({ user: { admin_level: 'admin', suspended_at: null } }));
    if (req.url === '/admin/v1/status') return res.end(JSON.stringify({ paused: false, crawler: { ts: 1, budget: { pages_used: 5, pages_max: 10 } }, index: { live_docs: 3 }, pending: { optouts: 0 } }));
    if (req.url === '/admin/v1/crawl/jobs' && req.method === 'POST') { res.statusCode = 201; return res.end(JSON.stringify({ job: { id: 7, status: 'queued' } })); }
    if (req.url === '/admin/v1/crawl/jobs' && req.method === 'GET') return res.end(JSON.stringify({ jobs: [], limits: { max_pages: 50000 } }));
    if (req.url.startsWith('/admin/v1/seeds') && req.method === 'DELETE') { res.statusCode = 204; return res.end(); }
    if (req.url === '/admin/v1/crawl/jobs' || req.url.startsWith('/admin/v1/crawl/jobs/999')) { res.statusCode = 400; return res.end(JSON.stringify({ error: { code: 'invalid_parameter', message: '`max_pages` must be between 1 and 50000' } })); }
    res.end(JSON.stringify({ ok: true }));
  });
});
await new Promise(r => upstream.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${upstream.address().port}`;

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'y'.repeat(48);
process.env.PUBLIC_URL = 'http://localhost:3997';
process.env.WARD_URL = base;
process.env.WARD_ADMIN_KEY = 'ward-admin-key';
process.env.WARD_CLIENT_ID = 'telescreen-app';
process.env.WARD_CLIENT_SECRET = 'app-secret';
process.env.SEARCH_URL = base;
process.env.SEARCH_ADMIN_KEY = 'search-admin-key-search-admin-key';

const { buildApp } = await import('../src/server.js');
const { seal, SESSION_COOKIE } = await import('../src/session.js');
let app;
before(async () => { app = await buildApp({ logger: false }); });
after(async () => { await app.close(); upstream.close(); });
const as = (sub, level, email) => ({ cookie: `${SESSION_COOKIE}=${seal('session', { via: 'ward', sub, level, email, csrf: 'c' }, 3600)}`, 'x-telescreen-csrf': 'c', origin: 'http://localhost:3997' });
const owner = as(OWNER, 'owner', 'boss@example.com');
const admin = as(ADMIN, 'admin', 'helper@example.com');

test('status goes through with the key and the signed-in actor, and the key stays server-side', async () => {
  seen.length = 0;
  const res = await app.inject({ method: 'GET', url: '/api/search', headers: owner });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().enabled, true);
  assert.equal(res.json().status.index.live_docs, 3);
  const hit = seen.find(s => s.url === '/admin/v1/status');
  assert.equal(hit.auth, 'Bearer search-admin-key-search-admin-key');
  assert.equal(hit.actor, 'boss@example.com');
  assert.ok(!res.body.includes('search-admin-key'));
  const me = await app.inject({ method: 'GET', url: '/api/me', headers: owner });
  assert.equal(me.json().search, true);
  assert.ok(!me.body.includes('search-admin-key'));
});

test('an admin can start and list crawls; the body is forwarded untouched and errors keep the search message', async () => {
  seen.length = 0;
  const payload = { name: 'docs', seeds: ['https://a.example/'], max_pages: 300, max_depth: 2 };
  const ok = await app.inject({ method: 'POST', url: '/api/search/crawl/jobs', headers: admin, payload });
  assert.equal(ok.statusCode, 201);
  const hit = seen.find(s => s.url === '/admin/v1/crawl/jobs' && s.method === 'POST');
  assert.deepEqual(JSON.parse(hit.body), payload);
  assert.equal(hit.actor, 'helper@example.com');
  assert.equal((await app.inject({ method: 'GET', url: '/api/search/crawl/jobs', headers: admin })).json().limits.max_pages, 50000);
});

test('upstream validation errors reach the console with their message', async () => {
  // the fake answers 400 for this exact path
  const res = await app.inject({ method: 'GET', url: '/api/search/crawl/jobs/999', headers: admin });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().error, /max_pages/);
});

test('owner-only routes refuse admins before anything leaves telescreen', async () => {
  seen.length = 0;
  for (const [method, url, payload] of [
    ['POST', '/api/search/purge', { domain: 'example.com' }],
    ['POST', '/api/search/index/rebuild', {}],
    ['POST', '/api/search/optouts/opt_1/approve', {}],
    ['POST', '/api/search/keys', { owner: 'user:x' }],
    ['DELETE', '/api/search/keys/key_1?owner=user:x', undefined],
  ]) {
    const res = await app.inject({ method, url, headers: admin, payload });
    assert.equal(res.statusCode, 403, `${method} ${url}`);
  }
  assert.equal(seen.filter(s => s.url.startsWith('/admin/v1/')).length, 0, 'nothing was forwarded');
  const ok = await app.inject({ method: 'POST', url: '/api/search/purge', headers: owner, payload: { domain: 'example.com' } });
  assert.equal(ok.statusCode, 200);
  assert.equal(seen.at(-1).url, '/admin/v1/purge');
});

test('deletes come back as 204 with no body, and query strings are passed on', async () => {
  seen.length = 0;
  const res = await app.inject({ method: 'DELETE', url: '/api/search/seeds?url=https%3A%2F%2Fa.example%2F', headers: admin });
  assert.equal(res.statusCode, 204);
  assert.equal(res.body, '');
  assert.equal(seen.at(-1).url, '/admin/v1/seeds?url=https%3A%2F%2Fa.example%2F');
});

test('anything outside the allowlist never reaches the search service, and sessions are required', async () => {
  seen.length = 0;
  for (const [method, url] of [['GET', '/api/search/metrics'], ['POST', '/api/search/crawl/jobs/abc/cancel'], ['DELETE', '/api/search/crawl/jobs'], ['GET', '/api/search/keys/key_1'], ['POST', '/api/search/optouts/a%2Fb/approve']]) {
    const res = await app.inject({ method, url, headers: owner, payload: method === 'POST' ? {} : undefined });
    assert.notEqual(res.statusCode, 200, url);
  }
  assert.equal(seen.filter(s => s.url.startsWith('/admin/v1/')).length, 0);
  assert.equal((await app.inject({ method: 'GET', url: '/api/search' })).statusCode, 401);
  assert.equal((await app.inject({ method: 'POST', url: '/api/search/crawl/pause', headers: { ...owner, 'x-telescreen-csrf': 'wrong' }, payload: {} })).statusCode, 403, 'CSRF still applies');
});
