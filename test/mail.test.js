import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

// A fake Mail and a fake Ward. Creating mailboxes and changing who is in them is owners only; everything forwarded
// carries the admin key and the signed-in admin as X-Admin-Actor; no route can read a message.
const seen = [];
const ADMIN = '88888888-8888-4888-8888-888888888888';
const OWNER = '99999999-9999-4999-8999-999999999999';
const BOX = '11111111-1111-4111-8111-111111111111';
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
process.env.MAIL_URL = base;
process.env.MAIL_ADMIN_KEY = 'mail-key-0123456789012345678901234567';

const { buildApp } = await import('../src/server.js');
const { seal, SESSION_COOKIE } = await import('../src/session.js');
let app;
before(async () => { app = await buildApp({ logger: false }); });
after(async () => { await app.close(); upstream.close(); });
const as = (sub, level, email) => ({ cookie: `${SESSION_COOKIE}=${seal('session', { via: 'ward', sub, level, email, csrf: 'c' }, 3600)}`, 'x-telescreen-csrf': 'c', origin: 'http://localhost:3993' });
const admin = as(ADMIN, 'admin', 'helper@example.com'), owner = as(OWNER, 'owner', 'boss@example.com');
const forwarded = () => seen.filter(s => s.url.startsWith('/admin/v1/') && !s.url.startsWith('/admin/v1/users/'));

test('admins can look; only owners can create, delete or change who is in a mailbox', async () => {
  seen.length = 0;
  for (const [method, url, payload] of [
    ['POST', '/api/mail/mailboxes', { address: 'x@deltavdevs.com', name: 'X' }],
    ['PATCH', `/api/mail/mailboxes/${BOX}`, { name: 'Y' }],
    ['DELETE', `/api/mail/mailboxes/${BOX}`, { confirm: 'x@deltavdevs.com' }],
    ['PUT', `/api/mail/mailboxes/${BOX}/members/${ADMIN}`, { role: 'member' }],
    ['DELETE', `/api/mail/mailboxes/${BOX}/members/${ADMIN}`],
    ['POST', `/api/mail/mailboxes/${BOX}/aliases`, { address: 'a@deltavdevs.com' }],
    ['DELETE', `/api/mail/mailboxes/${BOX}/aliases/a%40deltavdevs.com`],
  ]) {
    assert.equal((await app.inject({ method, url, headers: admin, payload })).statusCode, 403, `${method} ${url}`);
  }
  assert.equal(forwarded().length, 0, 'nothing reached Mail');
  for (const url of ['/api/mail/overview', '/api/mail/mailboxes', `/api/mail/mailboxes/${BOX}`, `/api/mail/mailboxes/${BOX}/activity`, '/api/mail/ingest-log', '/api/mail/audit', '/api/mail/users?q=a']) {
    assert.equal((await app.inject({ method: 'GET', url, headers: admin })).statusCode, 200, url);
  }
});

test('owner changes go through with the key and the actor, aliases included', async () => {
  seen.length = 0;
  await app.inject({ method: 'POST', url: '/api/mail/mailboxes', headers: owner, payload: { address: 'support@deltavdevs.com', name: 'Support', kind: 'shared' } });
  await app.inject({ method: 'PUT', url: `/api/mail/mailboxes/${BOX}/members/${ADMIN}`, headers: owner, payload: { role: 'manager' } });
  await app.inject({ method: 'DELETE', url: `/api/mail/mailboxes/${BOX}/aliases/help%40deltavdevs.com`, headers: owner });
  const f = forwarded();
  assert.deepEqual(f.map(x => `${x.method} ${x.url}`), ['POST /admin/v1/mailboxes', `PUT /admin/v1/mailboxes/${BOX}/members/${ADMIN}`, `DELETE /admin/v1/mailboxes/${BOX}/aliases/help@deltavdevs.com`]);
  assert.ok(f.every(x => x.auth === 'Bearer mail-key-0123456789012345678901234567' && x.actor === 'boss@example.com'));
  assert.deepEqual(JSON.parse(f[0].body), { address: 'support@deltavdevs.com', name: 'Support', kind: 'shared' });
});

test('there is no route to a message, and odd paths never reach Mail', async () => {
  seen.length = 0;
  for (const url of ['/api/mail/messages', `/api/mail/mailboxes/${BOX}/messages`, `/api/mail/mailboxes/${BOX}/messages/${BOX}`, '/api/mail/../../admin/v1/users', '/api/mail/mailboxes/abc', '/api/mail/everything']) {
    assert.notEqual((await app.inject({ method: 'GET', url, headers: owner })).statusCode, 200, url);
  }
  assert.equal(forwarded().length, 0);
  const res = await app.inject({ method: 'GET', url: '/api/mail/overview', headers: admin });
  assert.ok(!res.body.includes('mail-key'));
  assert.equal((await app.inject({ method: 'GET', url: '/api/mail/overview' })).statusCode, 401);
});
