import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'x'.repeat(48);
process.env.ADMIN_EMAILS = 'boss@example.com';
process.env.GOOGLE_CLIENT_ID = 'client-id';
process.env.GOOGLE_CLIENT_SECRET = 'client-secret';
process.env.PUBLIC_URL = 'http://localhost:3999';
process.env.CDN_WEBDAV_URL = 'http://127.0.0.1:9/webdav/';
process.env.CDN_WEBDAV_USER = 'u';
process.env.CDN_WEBDAV_PASSWORD = 'p';
if (process.env.TEST_PG_URL) process.env.TELESCREEN_PG_TEST = process.env.TEST_PG_URL;

const { buildApp } = await import('../src/server.js');
const { seal, SESSION_COOKIE, OAUTH_COOKIE } = await import('../src/session.js');

let app;
before(async () => { app = await buildApp({ logger: false }); });
after(async () => { await app.close(); });

const session = (email = 'boss@example.com', csrf = 'csrf-token') => `${SESSION_COOKIE}=${seal('session', { email, name: 'Boss', csrf }, 3600)}`;

test('api refuses anonymous requests', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/me' });
  assert.equal(res.statusCode, 401);
});

test('api refuses forged and tampered cookies', async () => {
  const good = seal('session', { email: 'boss@example.com', csrf: 'c' }, 3600);
  const [body, mac] = good.split('.');
  const tampered = Buffer.from(JSON.stringify({ email: 'boss@example.com', csrf: 'c', exp: Date.now() + 1e9 })).toString('base64url');
  for (const cookie of [`${tampered}.${mac}`, `${body}.AAAA`, 'garbage', `${body}.${mac}.extra`]) {
    const res = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie: `${SESSION_COOKIE}=${cookie}` } });
    assert.equal(res.statusCode, 401, cookie);
  }
});

test('a session sealed for another purpose is not a session', async () => {
  const oauth = seal('oauth', { email: 'boss@example.com', csrf: 'c' }, 3600);
  const res = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie: `${SESSION_COOKIE}=${oauth}` } });
  assert.equal(res.statusCode, 401);
});

test('expired sessions are rejected', async () => {
  const expired = seal('session', { email: 'boss@example.com', csrf: 'c' }, -10);
  const res = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie: `${SESSION_COOKIE}=${expired}` } });
  assert.equal(res.statusCode, 401);
});

test('validly signed sessions for non-allowlisted emails are rejected', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie: session('someone@example.com') } });
  assert.equal(res.statusCode, 401);
});

test('allowlisted session can read', async () => {
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

test('google start uses PKCE, state and a signed oauth cookie', async () => {
  const res = await app.inject({ method: 'GET', url: '/auth/google/start' });
  assert.equal(res.statusCode, 302);
  const location = new URL(res.headers.location);
  assert.equal(location.origin, 'https://accounts.google.com');
  assert.equal(location.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(location.searchParams.get('redirect_uri'), 'http://localhost:3999/auth/google/callback');
  assert.ok(location.searchParams.get('state'));
  assert.match(String(res.headers['set-cookie']), new RegExp(`${OAUTH_COOKIE}=`));
});

test('google callback rejects a state that does not match the cookie', async () => {
  const cookie = `${OAUTH_COOKIE}=${seal('oauth', { state: 'right', verifier: 'v', nonce: 'n' }, 600)}`;
  const res = await app.inject({ method: 'GET', url: '/auth/google/callback?state=wrong&code=abc', headers: { cookie } });
  assert.equal(res.statusCode, 302);
  assert.match(res.headers.location, /^\/\?error=/);
  assert.doesNotMatch(String(res.headers['set-cookie'] || ''), new RegExp(`${SESSION_COOKIE}=[^;]`));
});

test('google callback without an oauth cookie is rejected', async () => {
  const res = await app.inject({ method: 'GET', url: '/auth/google/callback?state=x&code=abc' });
  assert.match(res.headers.location, /^\/\?error=/);
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
