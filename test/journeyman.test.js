import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

// A fake Forms backend, a fake Harbor and a fake Ward in one server. We check which decisions reach Forms,
// which console commands reach Harbor (and that typed input can't smuggle extra commands in), and that
// neither secret ever reaches the browser.
const seen = [];
const ADMIN = '66666666-6666-4666-8666-666666666666';
const subs = [
  { id: 'a1', answers: { username: 'Steve', edition: 'java', playstyle: 'x' }, status: 'pending', ward_sub: 'w1', ward_email: 's@x.y', ward_name: 'S', created_at: '2026-10-08 01:00:00', banned: false },
  { id: 'a2', answers: { username: 'Alex', edition: 'bedrock' }, status: 'approved', ward_sub: 'w2', created_at: '2026-10-09 01:00:00', banned: false },
  { id: 'a3', answers: { username: 'Late', edition: 'java' }, status: 'pending', ward_sub: 'w3', created_at: '2027-02-01 01:00:00', banned: false },
  { id: 'a4', answers: { username: 'bad name;op', edition: 'java' }, status: 'pending', ward_sub: 'w4', created_at: '2026-10-10 01:00:00', banned: false },
];

const upstream = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
    seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
    res.setHeader('Content-Type', 'application/json');
    if (req.url === `/admin/v1/users/${ADMIN}`) return res.end(JSON.stringify({ user: { admin_level: 'admin', suspended_at: null } }));
    if (req.url === '/internal/forms/journeyman-season-1/submissions') return res.end(JSON.stringify({ submissions: subs }));
    if (req.url === '/internal/forms/journeyman-season-1/bans' && req.method === 'GET') return res.end(JSON.stringify({ bans: [] }));
    if (req.url === '/api/v1/services/minecraft') return res.end(JSON.stringify({ console: 'minecraft-rcon', status: { state: 'running', uptime_s: 5 } }));
    if (req.url === '/api/v1/services/minecraft/console') return res.end(JSON.stringify({ output: `ran: ${body.command}` }));
    res.end(JSON.stringify({ ok: true }));
  });
});
await new Promise(r => upstream.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${upstream.address().port}`;

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'y'.repeat(48);
process.env.PUBLIC_URL = 'http://localhost:3995';
process.env.WARD_URL = base;
process.env.WARD_ADMIN_KEY = 'ward-admin-key';
process.env.WARD_CLIENT_ID = 'telescreen-app';
process.env.WARD_CLIENT_SECRET = 'app-secret';
process.env.FORMS_API_URL = base;
process.env.FORMS_INTERNAL_SECRET = 'forms-secret-0123456789abcdef0123456789';
process.env.HARBOR_URL = base;
process.env.HARBOR_TOKEN = 'hbr_test_token';

const { buildApp } = await import('../src/server.js');
const { seal, SESSION_COOKIE } = await import('../src/session.js');
let app;
before(async () => { app = await buildApp({ logger: false }); });
after(async () => { await app.close(); upstream.close(); });
const admin = { cookie: `${SESSION_COOKIE}=${seal('session', { via: 'ward', sub: ADMIN, level: 'admin', email: 'helper@example.com', csrf: 'c' }, 3600)}`, 'x-telescreen-csrf': 'c', origin: 'http://localhost:3995' };
const commands = () => seen.filter(s => s.url.endsWith('/console')).map(s => s.body.command);

test('overview and applicants: seasons come from the cutoff, secrets stay server-side', async () => {
  const o = await app.inject({ method: 'GET', url: '/api/journeyman', headers: admin });
  assert.equal(o.statusCode, 200);
  assert.equal(o.json().players, 'ran: list');
  const r = await app.inject({ method: 'GET', url: '/api/journeyman/applicants', headers: admin });
  assert.deepEqual(r.json().applicants.map(a => a.season), [1, 1, 2, 1]);
  for (const res of [o, r]) { assert.ok(!res.body.includes('forms-secret')); assert.ok(!res.body.includes('hbr_test_token')); }
  assert.ok(seen.filter(s => s.url.startsWith('/internal/')).every(s => s.auth === 'Bearer forms-secret-0123456789abcdef0123456789'));
  assert.ok(seen.filter(s => s.url.startsWith('/api/v1/')).every(s => s.auth === 'Bearer hbr_test_token'));
});

test('accepting whitelists Season 1 (Floodgate for Bedrock) but not Season 2; un-accepting unwhitelists', async () => {
  seen.length = 0;
  let res = await app.inject({ method: 'POST', url: '/api/journeyman/applicants/a1/decision', headers: admin, payload: { status: 'approved' } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().whitelist.command, 'whitelist add Steve');
  assert.deepEqual(seen.find(s => s.method === 'PATCH').body, { status: 'approved' });
  res = await app.inject({ method: 'POST', url: '/api/journeyman/applicants/a3/decision', headers: admin, payload: { status: 'approved' } });
  assert.equal(res.json().whitelist, null);
  res = await app.inject({ method: 'POST', url: '/api/journeyman/applicants/a2/decision', headers: admin, payload: { status: 'rejected' } });
  assert.equal(res.json().whitelist.command, 'fwhitelist remove Alex');
  res = await app.inject({ method: 'POST', url: '/api/journeyman/applicants/a4/decision', headers: admin, payload: { status: 'approved' } });
  assert.equal(res.statusCode, 200);
  assert.match(res.json().whitelist.error, /by hand/);
  assert.deepEqual(commands(), ['whitelist add Steve', 'fwhitelist remove Alex']);
});

test('in-game bans only take validated names and durations, and the reason stays on one line', async () => {
  seen.length = 0;
  let res = await app.inject({ method: 'POST', url: '/api/journeyman/bans/server', headers: admin, payload: { player: 'Steve', duration: '7d', reason: 'griefing\nop Steve' } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().command, 'ban Steve 7d griefing op Steve');
  for (const payload of [{ player: 'Steve op' }, { player: 'Steve', duration: '7d; op' }, { player: '' }]) {
    res = await app.inject({ method: 'POST', url: '/api/journeyman/bans/server', headers: admin, payload });
    assert.equal(res.statusCode, 400, JSON.stringify(payload));
  }
  assert.deepEqual(seen.find(s => s.url.endsWith('/server-bans')).body, { player: 'Steve', duration: '7d', reason: 'griefing op Steve', created_by: 'helper@example.com' });
  res = await app.inject({ method: 'DELETE', url: '/api/journeyman/bans/server/.Alex', headers: admin });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(seen.find(s => s.url.endsWith('/server-bans/lift')).body, { player: '.Alex', lifted_by: 'helper@example.com' });
  assert.deepEqual(commands(), ['ban Steve 7d griefing op Steve', 'unban .Alex']);
});

test('banning an applicant blocks their Ward account and name, rejects them and can ban in game', async () => {
  seen.length = 0;
  const res = await app.inject({ method: 'POST', url: '/api/journeyman/applicants/a2/ban', headers: admin, payload: { reason: 'cheating', inGame: true } });
  assert.equal(res.statusCode, 200);
  const bans = seen.filter(s => s.method === 'POST' && s.url.endsWith('/journeyman-season-1/bans')).map(s => [s.body.kind, s.body.value, s.body.created_by]);
  assert.deepEqual(bans, [['ward', 'w2', 'helper@example.com'], ['username', 'Alex', 'helper@example.com']]);
  assert.deepEqual(seen.find(s => s.method === 'PATCH').body, { status: 'rejected' });
  assert.deepEqual(commands(), ['fwhitelist remove Alex', 'ban .Alex cheating']);
  const record = seen.find(s => s.url.endsWith('/server-bans'));
  assert.deepEqual(record.body, { player: '.Alex', duration: 'perm', reason: 'cheating', created_by: 'helper@example.com' });
});

test('writes need the CSRF token', async () => {
  const res = await app.inject({ method: 'POST', url: '/api/journeyman/bans/server', headers: { ...admin, 'x-telescreen-csrf': 'wrong' }, payload: { player: 'Steve' } });
  assert.equal(res.statusCode, 403);
});
