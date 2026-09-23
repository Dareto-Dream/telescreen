import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

// A fake upstream standing in for the main backend, CDN WebDAV and DeltaTime,
// so we can check what telescreen actually sends and that secrets stay server-side.
const seen = [];
const upstream = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body, headers: req.headers });
    res.setHeader('Content-Type', 'application/json');
    if (req.url.startsWith('/api/admin/v1/check')) return res.end(JSON.stringify({ valid: true, creator: { id: 1, username: 'boss', admin_level: 'ultraadmin' } }));
    if (req.url.startsWith('/api/admin/v1/user/convict')) return res.end(JSON.stringify({ success: true, message: 'gotcha' }));
    if (req.method === 'PROPFIND') {
      res.statusCode = 207; res.setHeader('Content-Type', 'application/xml');
      return res.end(`<?xml version="1.0"?><D:multistatus xmlns:D="DAV:">
        <D:response><D:href>/music/</D:href><D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop></D:propstat></D:response>
        <D:response><D:href>/music/a%20b.mp3</D:href><D:propstat><D:prop><D:resourcetype/><D:getcontentlength>42</D:getcontentlength><D:getcontenttype>audio/mpeg</D:getcontenttype></D:prop></D:propstat></D:response>
        <D:response><D:href>/music/sub/</D:href><D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop></D:propstat></D:response>
      </D:multistatus>`);
    }
    res.end(JSON.stringify(req.url.startsWith('/api/admin/') ? [{ id: 1, title: 'p' }] : {}));
  });
});
await new Promise(r => upstream.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${upstream.address().port}`;

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'y'.repeat(48);
process.env.ADMIN_EMAILS = 'boss@example.com';
process.env.GOOGLE_CLIENT_ID = 'id';
process.env.GOOGLE_CLIENT_SECRET = 'secret';
process.env.PUBLIC_URL = 'http://localhost:3998';
process.env.MAIN_API_URL = base;
process.env.MAIN_ADMIN_TOKEN = 'main-admin-token';
process.env.CDN_WEBDAV_URL = `${base}/webdav/`;
process.env.CDN_WEBDAV_USER = 'dav';
process.env.CDN_WEBDAV_PASSWORD = 'davpass';
process.env.DELTATIME_URL = base;
process.env.DELTATIME_ADMIN_KEY = 'dt-admin-key';

const { buildApp } = await import('../src/server.js');
const { seal, SESSION_COOKIE } = await import('../src/session.js');
let app;
before(async () => { app = await buildApp({ logger: false }); });
after(async () => { await app.close(); upstream.close(); });
const headers = { cookie: `${SESSION_COOKIE}=${seal('session', { email: 'boss@example.com', csrf: 'c' }, 3600)}`, 'x-telescreen-csrf': 'c' };

test('content proxy injects the backend admin token and never returns it', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/content/projects', headers });
  assert.equal(res.statusCode, 200);
  assert.equal(seen.at(-1).url, '/api/admin/');
  assert.equal(seen.at(-1).auth, 'Bearer main-admin-token');
  assert.doesNotMatch(res.body, /main-admin-token/);
  const me = await app.inject({ method: 'GET', url: '/api/me', headers });
  assert.doesNotMatch(me.body, /main-admin-token|davpass|dt-admin-key/);
});

test('content patch strips id and hits the right record', async () => {
  const res = await app.inject({ method: 'PATCH', url: '/api/content/songs/7', headers, payload: { id: 99, title: 'x' } });
  assert.equal(res.statusCode, 200);
  assert.equal(seen.at(-1).url, '/api/admin/songs/7');
  assert.deepEqual(JSON.parse(seen.at(-1).body), { title: 'x' });
  assert.equal((await app.inject({ method: 'GET', url: '/api/content/users', headers })).statusCode, 404);
});

test('webdav listing parses Caddy output with or without the /webdav prefix', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/files?path=music', headers });
  assert.equal(res.statusCode, 200);
  assert.equal(seen.at(-1).auth, `Basic ${Buffer.from('dav:davpass').toString('base64')}`);
  assert.deepEqual(res.json().items.map(i => [i.path, i.dir]), [['music/sub', true], ['music/a b.mp3', false]]);
});

test('deltatime verdicts go through the admin API with a reason', async () => {
  let res = await app.inject({ method: 'POST', url: '/api/deltatime/user/5/trust', headers, payload: { trust_level: 'red' } });
  assert.equal(res.statusCode, 400);
  res = await app.inject({ method: 'POST', url: '/api/deltatime/user/5/trust', headers, payload: { trust_level: 'purple', reason: 'nope' } });
  assert.equal(res.statusCode, 400);
  res = await app.inject({ method: 'POST', url: '/api/deltatime/user/5/trust', headers, payload: { trust_level: 'red', reason: 'heartbeat spoofing' } });
  assert.equal(res.statusCode, 200);
  assert.equal(seen.at(-1).url, '/api/admin/v1/user/convict');
  assert.equal(seen.at(-1).auth, 'Bearer dt-admin-key');
  assert.deepEqual(JSON.parse(seen.at(-1).body), { id: 5, trust_level: 'red', reason: 'heartbeat spoofing' });
});

test('deltatime status reports the acting admin', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/deltatime', headers });
  assert.equal(res.json().check.creator.username, 'boss');
  assert.equal(res.json().db, false);
});
