import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Ward sign-in, with a fake Ward behind fetch. Google backup is off here.
process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'y'.repeat(48);
process.env.PUBLIC_URL = 'http://localhost:3998';
process.env.WARD_URL = 'https://ward.test';
process.env.WARD_ADMIN_KEY = 'admin-key';
process.env.WARD_CLIENT_ID = 'telescreen-app';
process.env.WARD_CLIENT_SECRET = 'app-secret';
delete process.env.ADMIN_EMAILS; delete process.env.GOOGLE_CLIENT_ID; delete process.env.GOOGLE_CLIENT_SECRET;

// Fake Ward: token exchange, userinfo, and the admin API's user lookup.
const ward = { level: 'admin', live: 'admin', down: false, suspended: false, calls: [] };
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  if (url.origin !== 'https://ward.test') return realFetch(input, init);
  ward.calls.push(url.pathname);
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  if (ward.down) throw new Error('connect ECONNREFUSED');
  if (url.pathname === '/oauth/token') {
    const body = new URLSearchParams(init.body);
    if (body.get('client_secret') !== 'app-secret' || body.get('code') !== 'good-code') return json(400, { error: 'invalid_grant' });
    return json(200, { access_token: 'wat_x', scope: 'openid profile email admin' });
  }
  if (url.pathname === '/oauth/userinfo') return json(200, { sub: '11111111-1111-4111-8111-111111111111', name: 'Delta', email: 'delta@example.com', admin_level: ward.level });
  if (url.pathname.startsWith('/admin/v1/users/')) {
    if (init.headers?.Authorization !== 'Bearer admin-key') return json(401, { error: 'unauthorized' });
    if (url.pathname.endsWith('/admin-level')) return json(200, { user: { admin_level: 'viewer' } });
    return json(200, { user: { admin_level: ward.live, suspended_at: ward.suspended ? '2026-01-01' : null } });
  }
  return json(404, { error: 'not found' });
};

const { buildApp } = await import('../src/server.js');
const { seal, SESSION_COOKIE, OAUTH_COOKIE } = await import('../src/session.js');
let app;
before(async () => { app = await buildApp({ logger: false }); });
after(async () => { await app.close(); globalThis.fetch = realFetch; });

const SUB = '11111111-1111-4111-8111-111111111111';
const wardSession = (level = 'admin', sub = SUB) => `${SESSION_COOKIE}=${seal('session', { via: 'ward', sub, level, name: 'Delta', email: 'delta@example.com', csrf: 'c' }, 3600)}`;
const write = cookie => ({ cookie, 'x-telescreen-csrf': 'c', origin: 'http://localhost:3998' });
let n = 0;
// Each test uses its own account id so the one-minute level cache doesn't leak between tests.
const fresh = () => `22222222-2222-4222-8222-${String(++n).padStart(12, '0')}`;
beforeEach(() => { Object.assign(ward, { level: 'admin', live: 'admin', down: false, suspended: false, calls: [] }); });

test('the sign-in page offers Ward only when Google is off', async () => {
  assert.deepEqual((await app.inject({ method: 'GET', url: '/auth/state' })).json(), { signedIn: false, ward: true, google: false });
  const google = await app.inject({ method: 'GET', url: '/auth/google/start' });
  assert.match(google.headers.location, /^\/\?error=/);
});

test('ward start asks for the admin scope with PKCE', async () => {
  const res = await app.inject({ method: 'GET', url: '/auth/ward/start' });
  const location = new URL(res.headers.location);
  assert.equal(location.origin + location.pathname, 'https://ward.test/oauth/authorize');
  assert.equal(location.searchParams.get('scope'), 'openid profile email admin');
  assert.equal(location.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(location.searchParams.get('redirect_uri'), 'http://localhost:3998/auth/ward/callback');
});

const callback = (query, extra = {}) => {
  const cookie = `${OAUTH_COOKIE}=${seal('oauth', { state: 'st', verifier: 'v', nonce: 'n', via: 'ward', ...extra }, 600)}`;
  return app.inject({ method: 'GET', url: `/auth/ward/callback?${new URLSearchParams(query)}`, headers: { cookie } });
};
const sessionSet = res => new RegExp(`${SESSION_COOKIE}=[^;]`).test(String(res.headers['set-cookie'] || ''));

test('callback refuses a wrong issuer, a wrong state, a Google cookie, and viewers', async () => {
  assert.equal(sessionSet(await callback({ state: 'st', code: 'good-code', iss: 'https://evil.test' })), false);
  assert.equal(sessionSet(await callback({ state: 'nope', code: 'good-code', iss: 'https://ward.test' })), false);
  assert.equal(sessionSet(await callback({ state: 'st', code: 'good-code', iss: 'https://ward.test' }, { via: 'google' })), false);
  ward.level = 'viewer';
  const viewer = await callback({ state: 'st', code: 'good-code', iss: 'https://ward.test' });
  assert.equal(sessionSet(viewer), false);
  assert.match(decodeURIComponent(viewer.headers.location), /not a telescreen admin/);
  ward.level = null;
  assert.equal(sessionSet(await callback({ state: 'st', code: 'good-code', iss: 'https://ward.test' })), false);
});

test('an admin signs in, and /api/me says who and what level', async () => {
  const res = await callback({ state: 'st', code: 'good-code', iss: 'https://ward.test' });
  assert.equal(res.headers.location, '/');
  assert.ok(sessionSet(res));
  const cookie = String(res.headers['set-cookie']).match(new RegExp(`${SESSION_COOKIE}=[^;]+`))[0];
  const me = (await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })).json();
  assert.equal(me.level, 'admin'); assert.equal(me.via, 'ward'); assert.equal(me.email, 'delta@example.com');
});

test('a demotion or suspension in Ward ends the session', async () => {
  const sub = fresh();
  ward.live = 'viewer';
  const res = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie: wardSession('admin', sub) } });
  assert.equal(res.statusCode, 401);
  assert.match(String(res.headers['set-cookie']), new RegExp(`${SESSION_COOKIE}=;`));
  const other = fresh();
  ward.live = 'owner'; ward.suspended = true;
  assert.equal((await app.inject({ method: 'GET', url: '/api/me', headers: { cookie: wardSession('owner', other) } })).statusCode, 401);
});

test('the level check is cached and survives Ward being down', async () => {
  const sub = fresh();
  assert.equal((await app.inject({ method: 'GET', url: '/api/me', headers: { cookie: wardSession('admin', sub) } })).statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url: '/api/me', headers: { cookie: wardSession('admin', sub) } })).statusCode, 200);
  assert.equal(ward.calls.filter(p => p === `/admin/v1/users/${sub}`).length, 1, 'second request used the cache');
  ward.down = true;
  const down = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie: wardSession('admin', fresh()) } });
  assert.equal(down.statusCode, 200);
  assert.equal(down.json().level, 'admin');
});

test('a promotion in Ward applies without signing in again', async () => {
  ward.live = 'owner';
  assert.equal((await app.inject({ method: 'GET', url: '/api/me', headers: { cookie: wardSession('admin', fresh()) } })).json().level, 'owner');
});

test('owner-only actions refuse admins and let owners through', async () => {
  const admin = wardSession('admin', fresh());
  const cases = [
    ['POST', '/api/redis/none/command', { args: ['FLUSHALL'] }],
    ['POST', '/api/pg/none/query', { sql: 'DROP TABLE x', write: true }],
    ['POST', '/api/railway/deployment/restart', { id: 'abc' }],
    ['POST', `/api/ward/users/${SUB}/admin-level`, { level: 'owner' }],
    ['DELETE', `/api/ward/users/${SUB}`, { confirm: 'x' }],
    ['POST', '/api/ward/clients/some-app/rotate-secret', {}],
  ];
  for (const [method, url, payload] of cases) {
    const res = await app.inject({ method, url, payload, headers: write(admin) });
    assert.equal(res.statusCode, 403, `${method} ${url}`);
    assert.equal(res.json().error, 'Only owners can do that.');
  }
  // Read-only SQL is fine for an admin (then fails on the unknown connection).
  assert.equal((await app.inject({ method: 'POST', url: '/api/pg/none/query', payload: { sql: 'SELECT 1' }, headers: write(admin) })).statusCode, 404);
  ward.live = 'owner';
  const owner = wardSession('owner', fresh());
  const level = await app.inject({ method: 'POST', url: `/api/ward/users/${SUB}/admin-level`, payload: { level: 'viewer' }, headers: write(owner) });
  assert.equal(level.statusCode, 200, level.body);
  assert.equal((await app.inject({ method: 'POST', url: '/api/redis/none/command', payload: { args: ['PING'] }, headers: write(owner) })).statusCode, 404);
});

test('a forged session for a non-console level is refused before Ward is asked', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie: wardSession('viewer', fresh()) } });
  assert.equal(res.statusCode, 401);
  assert.equal(ward.calls.length, 0);
});
