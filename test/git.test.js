import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

// A fake git service and a fake Ward, so we can check what telescreen forwards (key, actor),
// what it refuses, who may delete repos, and that the key never reaches the browser.
const seen = [];
const OWNER = '44444444-4444-4444-8444-444444444444';
const ADMIN = '55555555-5555-4555-8555-555555555555';
const upstream = http.createServer((req, res) => {
  seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, actor: req.headers['x-admin-actor'] });
  res.setHeader('Content-Type', 'application/json');
  if (req.url === `/admin/v1/users/${OWNER}`) return res.end(JSON.stringify({ user: { admin_level: 'owner', suspended_at: null } }));
  if (req.url === `/admin/v1/users/${ADMIN}`) return res.end(JSON.stringify({ user: { admin_level: 'admin', suspended_at: null } }));
  if (req.url === '/admin/v1/status') return res.end(JSON.stringify({ repos: 2, users: { pending: 1, approved: 0, denied: 0, revoked: 0 } }));
  if (req.url === '/admin/v1/users') return res.end(JSON.stringify({ users: [{ sub: 'u-1', username: 'alice', status: 'pending' }] }));
  if (req.method === 'DELETE') { res.statusCode = 204; return res.end(); }
  res.end(JSON.stringify({ ok: true }));
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
process.env.GIT_URL = base;
process.env.GIT_ADMIN_KEY = 'git-admin-key-git-admin-key-git-admin';

const { buildApp } = await import('../src/server.js');
const { seal, SESSION_COOKIE } = await import('../src/session.js');
let app;
before(async () => { app = await buildApp({ logger: false }); });
after(async () => { await app.close(); upstream.close(); });
const as = (sub, level, email) => ({ cookie: `${SESSION_COOKIE}=${seal('session', { via: 'ward', sub, level, email, csrf: 'c' }, 3600)}`, 'x-telescreen-csrf': 'c', origin: 'http://localhost:3997' });
const owner = as(OWNER, 'owner', 'boss@example.com');
const admin = as(ADMIN, 'admin', 'helper@example.com');

test('status and users go through with the key and the signed-in actor, and the key stays server-side', async () => {
  seen.length = 0;
  const res = await app.inject({ method: 'GET', url: '/api/git', headers: admin });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().status.users.pending, 1);
  const hit = seen.find(s => s.url === '/admin/v1/status');
  assert.equal(hit.auth, 'Bearer git-admin-key-git-admin-key-git-admin');
  assert.equal(hit.actor, 'helper@example.com');
  assert.ok(!res.body.includes('git-admin-key'));
  const users = await app.inject({ method: 'GET', url: '/api/git/users', headers: admin });
  assert.equal(users.json().users[0].username, 'alice');
  const me = await app.inject({ method: 'GET', url: '/api/me', headers: admin });
  assert.equal(me.json().git, true);
  assert.ok(!me.body.includes('git-admin-key'));
});

test('an admin can approve, deny and revoke, and the actor is recorded', async () => {
  for (const action of ['approve', 'deny', 'revoke']) {
    seen.length = 0;
    const res = await app.inject({ method: 'POST', url: `/api/git/users/u-1/${action}`, headers: admin, payload: {} });
    assert.equal(res.statusCode, 200, action);
    assert.equal(seen.find(s => s.url === `/admin/v1/users/u-1/${action}`).actor, 'helper@example.com');
  }
});

test('only an owner can delete a repo', async () => {
  seen.length = 0;
  const denied = await app.inject({ method: 'DELETE', url: '/api/git/repos/stickman-dance', headers: admin });
  assert.equal(denied.statusCode, 403);
  assert.equal(seen.filter(s => s.method === 'DELETE').length, 0);
  const ok = await app.inject({ method: 'DELETE', url: '/api/git/repos/stickman-dance', headers: owner });
  assert.equal(ok.statusCode, 204);
});

test('unknown routes and odd sub values are refused before reaching the service', async () => {
  seen.length = 0;
  for (const [method, url] of [['GET', '/api/git/secrets'], ['POST', '/api/git/users/u-1/promote'], ['POST', '/api/git/users/..%2F..%2Fstatus/approve'], ['DELETE', '/api/git/users/u-1']]) {
    const res = await app.inject({ method, url, headers: owner, payload: method === 'POST' ? {} : undefined });
    assert.equal(res.statusCode, 404, `${method} ${url}`);
  }
  assert.equal(seen.filter(s => s.url.startsWith('/admin/v1/') && !s.url.startsWith('/admin/v1/users/4') && !s.url.startsWith('/admin/v1/users/5')).length, 0);
});

test('signed-out requests are rejected', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/git' });
  assert.equal(res.statusCode, 401);
});
