import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

// A fake Bouncer and a fake Ward. Approving or leaving a server is owners only; everything forwarded carries the
// admin key and the signed-in admin as X-Admin-Actor; unknown paths never reach Bouncer.
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
process.env.PUBLIC_URL = 'http://localhost:3994';
process.env.WARD_URL = base;
process.env.WARD_ADMIN_KEY = 'ward-admin-key';
process.env.WARD_CLIENT_ID = 'telescreen-app';
process.env.WARD_CLIENT_SECRET = 'app-secret';
process.env.BOUNCER_URL = base;
process.env.BOUNCER_ADMIN_KEY = 'bouncer-key-0123456789';

const { buildApp } = await import('../src/server.js');
const { seal, SESSION_COOKIE } = await import('../src/session.js');
let app;
before(async () => { app = await buildApp({ logger: false }); });
after(async () => { await app.close(); upstream.close(); });
const as = (sub, level, email) => ({ cookie: `${SESSION_COOKIE}=${seal('session', { via: 'ward', sub, level, email, csrf: 'c' }, 3600)}`, 'x-telescreen-csrf': 'c', origin: 'http://localhost:3994' });
const admin = as(ADMIN, 'admin', 'helper@example.com'), owner = as(OWNER, 'owner', 'boss@example.com');
const forwarded = () => seen.filter(s => s.url.startsWith('/admin/v1/') && !s.url.startsWith('/admin/v1/users/'));

test('approving and leaving servers are owners only; the rest is open to admins', async () => {
  seen.length = 0;
  let res = await app.inject({ method: 'POST', url: '/api/bouncer/guilds/123456789012345678/allow', headers: admin, payload: {} });
  assert.equal(res.statusCode, 403);
  res = await app.inject({ method: 'POST', url: '/api/bouncer/guilds/123456789012345678/allow', headers: owner, payload: {} });
  assert.equal(res.statusCode, 200);
  res = await app.inject({ method: 'PUT', url: '/api/bouncer/bots/123456789012345678', headers: admin, payload: { name: 'X' } });
  assert.equal(res.statusCode, 200);
  const f = forwarded();
  assert.deepEqual(f.map(x => `${x.method} ${x.url}`), ['POST /admin/v1/guilds/123456789012345678/allow', 'PUT /admin/v1/bots/123456789012345678']);
  assert.ok(f.every(x => x.auth === 'Bearer bouncer-key-0123456789'));
  assert.deepEqual(f.map(x => x.actor), ['boss@example.com', 'helper@example.com']);
});

test('paths outside the list never reach Bouncer', async () => {
  seen.length = 0;
  for (const url of ['/api/bouncer/guilds/abc/allow', '/api/bouncer/../../admin/v1/users', '/api/bouncer/links/1/../x', '/api/bouncer/everything']) {
    const res = await app.inject({ method: 'GET', url, headers: owner });
    assert.notEqual(res.statusCode, 200, url);
  }
  assert.equal(forwarded().length, 0);
  const res = await app.inject({ method: 'GET', url: '/api/bouncer/overview', headers: admin });
  assert.ok(!res.body.includes('bouncer-key'));
});

test('moderation routes are forwarded; ids and actions outside the list are not', async () => {
  seen.length = 0;
  for (const [method, url, payload] of [
    ['POST', '/api/bouncer/network-bans', { ids: '123456789012345678', reason: 'raid' }],
    ['POST', '/api/bouncer/network-bans/123456789012345678/lift', {}],
    ['POST', '/api/bouncer/guilds/123456789012345678/members/223456789012345678/kick', {}],
    ['POST', '/api/bouncer/appeals/0a1b2c3d-0000-4000-8000-000000000000/decide', { approve: true }],
    ['GET', '/api/bouncer/users/123456789012345678'],
  ]) {
    const res = await app.inject({ method, url, headers: admin, payload });
    assert.equal(res.statusCode, 200, url);
  }
  for (const url of ['/api/bouncer/guilds/123456789012345678/members/223456789012345678/nuke', '/api/bouncer/network-bans/abc/lift', '/api/bouncer/appeals/x/decide']) {
    const res = await app.inject({ method: 'POST', url, headers: admin, payload: {} });
    assert.equal(res.statusCode, 404, url);
  }
  // The fake Ward and fake Bouncer share one server, so the lookup's /admin/v1/users/<id> is counted separately.
  assert.equal(forwarded().length, 4);
  assert.ok(seen.some(x => x.url === '/admin/v1/users/123456789012345678' && x.auth === 'Bearer bouncer-key-0123456789'));
  assert.deepEqual(JSON.parse(forwarded()[0].body), { ids: '123456789012345678', reason: 'raid' });
});
