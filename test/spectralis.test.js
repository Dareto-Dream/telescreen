import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

// A fake Spectralis backend and a fake Ward: we check exactly what telescreen forwards (token, actor, body,
// raw image bytes), what it refuses, and that the admin token never reaches the browser.
const seen = [];
const OWNER = '44444444-4444-4444-8444-444444444444';
const ADMIN = '55555555-5555-4555-8555-555555555555';
const FP = '6961405f930dad8a49271cfa49936d161e2c8943645be3d355598f0f76c48d60';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

const upstream = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, actor: req.headers['x-admin-actor'], type: req.headers['content-type'], body });
    res.setHeader('Content-Type', 'application/json');
    if (req.url === `/admin/v1/users/${OWNER}`) return res.end(JSON.stringify({ user: { admin_level: 'owner', suspended_at: null } }));
    if (req.url === `/admin/v1/users/${ADMIN}`) return res.end(JSON.stringify({ user: { admin_level: 'admin', suspended_at: null } }));
    if (req.method === 'GET' && req.url === '/spectralis/v1/warnings') return res.end(JSON.stringify([{ id: 'a' }, { id: 'b' }]));
    if (req.method === 'GET' && req.url === '/spectralis/v1/changelog') return res.end(JSON.stringify([{ version: '7.0.0' }]));
    if (req.method === 'GET' && req.url === '/spectralis/v1/community') return res.end(JSON.stringify([]));
    if (req.method === 'GET' && req.url === '/spectralis/v1/admin/creators') return res.end(JSON.stringify([{ fingerprint: FP, displayName: 'DeltaWave' }]));
    if (req.url === '/spectralis/v1/admin/warnings' && body.includes('BADWARN')) { res.statusCode = 400; return res.end(JSON.stringify({ error: '"severity" must be info, warning or critical.', status: 400 })); }
    if (req.url === '/spectralis/v1/admin/changelog' && body.includes('EXPIRED')) { res.statusCode = 401; return res.end(JSON.stringify({ error: 'Admin token required.', status: 401 })); }
    res.end(JSON.stringify({ ok: true }));
  });
});
await new Promise(r => upstream.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${upstream.address().port}`;

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'z'.repeat(48);
process.env.PUBLIC_URL = 'http://localhost:3996';
process.env.WARD_URL = base;
process.env.WARD_ADMIN_KEY = 'ward-admin-key';
process.env.WARD_CLIENT_ID = 'telescreen-app';
process.env.WARD_CLIENT_SECRET = 'app-secret';
process.env.SPECTRALIS_URL = base;
process.env.SPECTRALIS_ADMIN_TOKEN = 'spectralis-admin-token-0123456789abcdef';

const { buildApp } = await import('../src/server.js');
const { seal, SESSION_COOKIE } = await import('../src/session.js');
let app;
before(async () => { app = await buildApp({ logger: false }); });
after(async () => { await app.close(); upstream.close(); });
const as = (sub, level, email) => ({ cookie: `${SESSION_COOKIE}=${seal('session', { via: 'ward', sub, level, email, csrf: 'c' }, 3600)}`, 'x-telescreen-csrf': 'c', origin: 'http://localhost:3996' });
const owner = as(OWNER, 'owner', 'boss@example.com');
const admin = as(ADMIN, 'admin', 'helper@example.com');
const forwarded = () => seen.filter(s => s.url.startsWith('/spectralis/'));

test('the overview counts each feed, sends the token and actor, and the token stays server-side', async () => {
  seen.length = 0;
  const res = await app.inject({ method: 'GET', url: '/api/spectralis', headers: admin });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json().counts, { warnings: 2, changelog: 1, community: 0 });
  const me = await app.inject({ method: 'GET', url: '/api/me', headers: admin });
  assert.equal(me.json().spectralis, true);
  assert.ok(!res.body.includes('spectralis-admin-token') && !me.body.includes('spectralis-admin-token'));
});

test('an admin can edit the three feeds and the body is forwarded untouched with the token and their email', async () => {
  seen.length = 0;
  for (const feed of ['warnings', 'changelog', 'community']) {
    const payload = [{ id: feed, note: 'kept exactly' }];
    const res = await app.inject({ method: 'PUT', url: `/api/spectralis/${feed}`, headers: admin, payload });
    assert.equal(res.statusCode, 200, feed);
    const hit = forwarded().find(s => s.method === 'PUT' && s.url === `/spectralis/v1/admin/${feed}`);
    assert.deepEqual(JSON.parse(hit.body.toString()), payload);
    assert.equal(hit.auth, 'Bearer spectralis-admin-token-0123456789abcdef');
    assert.equal(hit.actor, 'helper@example.com');
  }
});

test('reads of the public feeds and the creator list go through', async () => {
  const list = await app.inject({ method: 'GET', url: '/api/spectralis/creators', headers: admin });
  assert.equal(list.json()[0].displayName, 'DeltaWave');
  const feed = await app.inject({ method: 'GET', url: '/api/spectralis/changelog', headers: admin });
  assert.equal(feed.json()[0].version, '7.0.0');
});

test("the backend's validation message reaches the console, and a bad token is not blamed on the admin", async () => {
  const bad = await app.inject({ method: 'PUT', url: '/api/spectralis/warnings', headers: admin, payload: [{ id: 'x', severity: 'BADWARN' }] });
  assert.equal(bad.statusCode, 400);
  assert.match(bad.json().error, /severity/);
  const expired = await app.inject({ method: 'PUT', url: '/api/spectralis/changelog', headers: admin, payload: [{ version: 'EXPIRED' }] });
  assert.equal(expired.statusCode, 502, "telescreen's own token problem, not a 401 for the person using it");
});

test('creator changes are owner-only and nothing leaves telescreen when an admin tries', async () => {
  seen.length = 0;
  const attempts = [
    ['PUT', `/api/spectralis/creators/${FP}`, { displayName: 'X', allowedCapabilities: ['webview.networkAccess'] }],
    ['DELETE', `/api/spectralis/creators/${FP}`, undefined],
  ];
  for (const [method, url, payload] of attempts) {
    assert.equal((await app.inject({ method, url, headers: admin, payload })).statusCode, 403, `${method} ${url}`);
  }
  const avatar = await app.inject({ method: 'PUT', url: `/api/spectralis/creators/${FP}/avatar`, headers: { ...admin, 'content-type': 'image/png' }, payload: PNG });
  assert.equal(avatar.statusCode, 403);
  assert.equal(forwarded().length, 0, 'nothing was forwarded');

  const ok = await app.inject({ method: 'PUT', url: `/api/spectralis/creators/${FP}`, headers: owner, payload: { displayName: 'DeltaWave', status: 'active' } });
  assert.equal(ok.statusCode, 200);
  assert.equal(forwarded().at(-1).url, `/spectralis/v1/admin/creators/${FP}`);
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/spectralis/creators/${FP}`, headers: owner })).statusCode, 200);
});

test('avatars are forwarded as the exact bytes with their image type', async () => {
  seen.length = 0;
  const res = await app.inject({ method: 'PUT', url: `/api/spectralis/creators/${FP}/avatar`, headers: { ...owner, 'content-type': 'image/png' }, payload: PNG });
  assert.equal(res.statusCode, 200);
  const hit = forwarded().at(-1);
  assert.equal(hit.url, `/spectralis/v1/admin/creators/${FP}/avatar`);
  assert.equal(hit.type, 'image/png');
  assert.ok(hit.body.equals(PNG), 'bytes arrive unchanged');

  const community = await app.inject({ method: 'PUT', url: '/api/spectralis/community/avatars/marczero', headers: { ...admin, 'content-type': 'image/png' }, payload: PNG });
  assert.equal(community.statusCode, 200, 'an admin may set community avatars');
  assert.equal(forwarded().at(-1).url, '/spectralis/v1/admin/community/avatars/marczero');
});

test('oversized and non-image uploads never reach the backend', async () => {
  seen.length = 0;
  const huge = Buffer.concat([PNG, Buffer.alloc(2 * 1024 * 1024)]);
  assert.equal((await app.inject({ method: 'PUT', url: `/api/spectralis/creators/${FP}/avatar`, headers: { ...owner, 'content-type': 'image/png' }, payload: huge })).statusCode, 413);
  const text = await app.inject({ method: 'PUT', url: `/api/spectralis/creators/${FP}/avatar`, headers: { ...owner, 'content-type': 'text/plain' }, payload: 'hello' });
  assert.equal(text.statusCode, 415, 'plain text is not an avatar');
  assert.equal(forwarded().length, 0);
});

test('anything outside the allowlist is refused, and sessions and CSRF are still required', async () => {
  seen.length = 0;
  for (const [method, url] of [
    ['GET', '/api/spectralis/metrics'],
    ['PUT', '/api/spectralis/admin/warnings'],
    ['DELETE', '/api/spectralis/warnings'],
    ['PUT', '/api/spectralis/creators/not-a-fingerprint'],
    ['PUT', `/api/spectralis/creators/${FP.toUpperCase()}`],
    ['PUT', '/api/spectralis/community/avatars/Bad%20Slug'],
    ['PUT', '/api/spectralis/../../etc/passwd'],
  ]) {
    const res = await app.inject({ method, url, headers: owner, payload: method === 'PUT' ? {} : undefined });
    assert.notEqual(res.statusCode, 200, `${method} ${url}`);
  }
  assert.equal(forwarded().length, 0);
  assert.equal((await app.inject({ method: 'GET', url: '/api/spectralis' })).statusCode, 401);
  assert.equal((await app.inject({ method: 'PUT', url: '/api/spectralis/warnings', headers: { ...owner, 'x-telescreen-csrf': 'wrong' }, payload: [] })).statusCode, 403, 'CSRF still applies');
});
