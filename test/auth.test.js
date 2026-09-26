import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'x'.repeat(48);
process.env.WARD_URL = 'https://ward.test';
process.env.WARD_ADMIN_KEY = 'admin-key';
process.env.WARD_CLIENT_ID = 'telescreen-app';
process.env.WARD_CLIENT_SECRET = 'app-secret';
process.env.PUBLIC_URL = 'http://localhost:3999';
process.env.CDN_WEBDAV_URL = 'http://127.0.0.1:9/webdav/';
process.env.CDN_WEBDAV_USER = 'u';
process.env.CDN_WEBDAV_PASSWORD = 'p';
if (process.env.TEST_PG_URL) process.env.TELESCREEN_PG_TEST = process.env.TEST_PG_URL;

// Stand-in Ward: every account is an owner. Other hosts go to the real fetch (test stubs).
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(String(input));
  if (url.origin === 'https://ward.test' && url.pathname.startsWith('/admin/v1/users/')) {
    return new Response(JSON.stringify({ user: { admin_level: 'owner', suspended_at: null } }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return realFetch(input, init);
};

const { buildApp } = await import('../src/server.js');
const { seal, SESSION_COOKIE, OAUTH_COOKIE } = await import('../src/session.js');

let app;
before(async () => { app = await buildApp({ logger: false }); });
after(async () => { await app.close(); });

const SUB = '33333333-3333-4333-8333-333333333333';
const session = (level = 'owner', csrf = 'csrf-token') => `${SESSION_COOKIE}=${seal('session', { via: 'ward', sub: SUB, level, email: 'boss@example.com', name: 'Boss', csrf }, 3600)}`;

test('api refuses anonymous requests', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/me' });
  assert.equal(res.statusCode, 401);
});

test('api refuses forged and tampered cookies', async () => {
  const good = seal('session', { via: 'ward', sub: SUB, level: 'owner', csrf: 'c' }, 3600);
  const [body, mac] = good.split('.');
  const tampered = Buffer.from(JSON.stringify({ via: 'ward', sub: SUB, level: 'owner', csrf: 'c', exp: Date.now() + 1e9 })).toString('base64url');
  for (const cookie of [`${tampered}.${mac}`, `${body}.AAAA`, 'garbage', `${body}.${mac}.extra`]) {
    const res = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie: `${SESSION_COOKIE}=${cookie}` } });
    assert.equal(res.statusCode, 401, cookie);
  }
});

test('a session sealed for another purpose is not a session', async () => {
  const oauth = seal('oauth', { via: 'ward', sub: SUB, level: 'owner', csrf: 'c' }, 3600);
  const res = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie: `${SESSION_COOKIE}=${oauth}` } });
  assert.equal(res.statusCode, 401);
});

test('expired sessions are rejected', async () => {
  const expired = seal('session', { via: 'ward', sub: SUB, level: 'owner', csrf: 'c' }, -10);
  const res = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie: `${SESSION_COOKIE}=${expired}` } });
  assert.equal(res.statusCode, 401);
});

test('validly signed sessions without a console level are rejected, and old Google sessions too', async () => {
  assert.equal((await app.inject({ method: 'GET', url: '/api/me', headers: { cookie: session('viewer') } })).statusCode, 401);
  const google = `${SESSION_COOKIE}=${seal('session', { email: 'boss@example.com', name: 'Boss', csrf: 'c' }, 3600)}`;
  assert.equal((await app.inject({ method: 'GET', url: '/api/me', headers: { cookie: google } })).statusCode, 401);
});

test('google sign-in is gone', async () => {
  assert.equal((await app.inject({ method: 'GET', url: '/auth/google/start' })).statusCode, 404);
  assert.equal((await app.inject({ method: 'GET', url: '/auth/google/callback?state=x&code=y' })).statusCode, 404);
});

test('a ward session can read', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie: session() } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().email, 'boss@example.com');
});

test('writes need the csrf header and same origin', async () => {
  const url = '/api/redis/none/expire';
  const payload = { key: 'k', ttl: 5 };
  let res = await app.inject({ method: 'POST', url, payload, headers: { cookie: session() } });
  assert.equal(res.statusCode, 403);
  res = await app.inject({ method: 'POST', url, payload, headers: { cookie: session(), 'x-telescreen-csrf': 'wrong' } });
  assert.equal(res.statusCode, 403);
  res = await app.inject({ method: 'POST', url, payload, headers: { cookie: session(), 'x-telescreen-csrf': 'csrf-token', origin: 'https://evil.example' } });
  assert.equal(res.statusCode, 403);
  res = await app.inject({ method: 'POST', url, payload, headers: { cookie: session(), 'x-telescreen-csrf': 'csrf-token', origin: 'http://localhost:3999' } });
  assert.equal(res.statusCode, 404); // passes the guard, then: unknown connection
});

test('file paths cannot traverse', async () => {
  for (const path of ['../etc', 'a/../../b', './x', 'a/./b']) {
    const res = await app.inject({ method: 'GET', url: `/api/files?path=${encodeURIComponent(path)}`, headers: { cookie: session() } });
    assert.equal(res.statusCode, 400, path);
  }
});

test('static shell and health are public, api is not', async () => {
  assert.equal((await app.inject({ method: 'GET', url: '/health' })).statusCode, 200);
  const page = await app.inject({ method: 'GET', url: '/' });
  assert.equal(page.statusCode, 200);
  assert.match(page.headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.match(page.body, /css\.deltavdevs\.com\/theme\.css/);
});

test('read-only SQL console cannot write, even with a stray COMMIT', { skip: !process.env.TEST_PG_URL && 'set TEST_PG_URL to run' }, async () => {
  const headers = { cookie: session(), 'x-telescreen-csrf': 'csrf-token' };
  const run = (sql, write = false) => app.inject({ method: 'POST', url: '/api/pg/test/query', headers, payload: { sql, write } });
  await run('DROP TABLE IF EXISTS telescreen_probe; CREATE TABLE telescreen_probe (id int primary key, v text)', true);
  assert.equal((await run('INSERT INTO telescreen_probe VALUES (1, \'x\')')).statusCode, 400);
  assert.equal((await run('COMMIT; INSERT INTO telescreen_probe VALUES (2, \'y\')')).statusCode, 400);
  const count = (await run('SELECT count(*)::int AS n FROM telescreen_probe')).json();
  assert.equal(count.results[0].rows[0][0], 0);
  // row editing refuses to touch anything but exactly one row
  await run('INSERT INTO telescreen_probe VALUES (1, \'a\'), (2, \'b\')', true);
  const patch = await app.inject({ method: 'PATCH', url: '/api/pg/test/row', headers, payload: { schema: 'public', name: 'telescreen_probe', pk: { id: '1' }, values: { v: 'changed' } } });
  assert.equal(patch.statusCode, 200);
  const partial = await app.inject({ method: 'PATCH', url: '/api/pg/test/row', headers, payload: { schema: 'public', name: 'telescreen_probe', pk: {}, values: { v: 'all' } } });
  assert.equal(partial.statusCode, 400);
  const injected = await app.inject({ method: 'PATCH', url: '/api/pg/test/row', headers, payload: { schema: 'public', name: 'telescreen_probe', pk: { id: '1' }, values: { 'v" = \'x\' --': 'boom' } } });
  assert.equal(injected.statusCode, 400);
  await run('DROP TABLE telescreen_probe', true);
});
