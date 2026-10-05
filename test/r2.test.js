import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';

// A fake R2 (S3 API) and a fake Ward. The fake checks what a real one would: that a request is signed with our
// access key for the "auto" region, and that the payload hash we signed is the hash of the bytes we sent.
const OWNER = '44444444-4444-4444-8444-444444444444';
const ADMIN = '55555555-5555-4555-8555-555555555555';
const store = new Map(); // key -> { size, bytes?, modified }
const seen = [];
const ACCESS = 'AKIAFAKEACCESSKEY0001';
const SECRET = 'fake-secret-key-that-must-never-reach-a-browser';

function seed(entries) {
  store.clear();
  for (const [key, size] of entries) store.set(key, { size, modified: '2026-10-04T12:00:00.000Z' });
}

const upstream = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    const url = new URL(req.url, 'http://x');
    const authorization = req.headers.authorization || '';
    seen.push({ method: req.method, path: url.pathname, query: url.search, authorization, body });
    if (url.pathname.startsWith('/admin/v1/users/')) {
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ user: { admin_level: url.pathname.includes(OWNER) ? 'owner' : 'admin', suspended_at: null } }));
    }
    const fail = (status, message) => { res.statusCode = status; res.setHeader('Content-Type', 'application/xml'); res.end(`<Error><Message>${message}</Message></Error>`); };
    if (!authorization.startsWith(`AWS4-HMAC-SHA256 Credential=${ACCESS}/`) || !authorization.includes('/auto/s3/aws4_request') || !/Signature=[0-9a-f]{64}$/.test(authorization)) return fail(403, 'bad signature');
    if (req.headers['x-amz-content-sha256'] !== createHash('sha256').update(body).digest('hex')) return fail(400, 'payload hash does not match the body');
    if (!/^\d{8}T\d{6}Z$/.test(req.headers['x-amz-date'] || '')) return fail(400, 'missing date');

    const m = url.pathname.match(/^\/spectralis-cdn(?:\/(.+))?$/);
    if (!m) return fail(404, 'no such bucket');
    const key = m[1] ? decodeURIComponent(m[1]) : '';
    if (req.method === 'GET' && !key) {
      const prefix = url.searchParams.get('prefix') || '';
      const delimiter = url.searchParams.get('delimiter');
      const objects = [], prefixes = new Set();
      for (const [k, v] of [...store].sort()) {
        if (!k.startsWith(prefix)) continue;
        const rest = k.slice(prefix.length);
        if (delimiter && rest.includes(delimiter)) { prefixes.add(prefix + rest.slice(0, rest.indexOf(delimiter) + 1)); continue; }
        objects.push(`<Contents><Key>${k.replace(/&/g, '&amp;')}</Key><Size>${v.size}</Size><LastModified>${v.modified}</LastModified></Contents>`);
      }
      res.setHeader('Content-Type', 'application/xml');
      return res.end(`<ListBucketResult><IsTruncated>false</IsTruncated>${objects.join('')}${[...prefixes].map(p => `<CommonPrefixes><Prefix>${p}</Prefix></CommonPrefixes>`).join('')}</ListBucketResult>`);
    }
    if (req.method === 'PUT') { store.set(key, { size: body.length, bytes: body, modified: new Date().toISOString() }); res.statusCode = 200; return res.end(); }
    if (req.method === 'DELETE') { store.delete(key); res.statusCode = 204; return res.end(); }
    return fail(405, 'not supported');
  });
});
await new Promise(r => upstream.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${upstream.address().port}`;

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'r'.repeat(48);
process.env.PUBLIC_URL = 'http://localhost:3994';
process.env.WARD_URL = base;
process.env.WARD_ADMIN_KEY = 'ward-admin-key';
process.env.WARD_CLIENT_ID = 'telescreen-app';
process.env.WARD_CLIENT_SECRET = 'app-secret';
process.env.R2_ACCOUNT_ID = 'acct';
process.env.R2_ACCESS_KEY_ID = ACCESS;
process.env.R2_SECRET_ACCESS_KEY = SECRET;
process.env.R2_ENDPOINT = base;
process.env.R2_BUDGET_GB = '0.2'; // 200 MB, so the budget is easy to reach in a test

const { buildApp } = await import('../src/server.js');
const { seal, SESSION_COOKIE } = await import('../src/session.js');
const { signV4, EMPTY_HASH, kindOf, cleanKey, parseList } = await import('../src/r2.js');
let app;
before(async () => { app = await buildApp({ logger: false }); });
after(async () => { await app.close(); upstream.close(); });
const as = (sub, level, email) => ({ cookie: `${SESSION_COOKIE}=${seal('session', { via: 'ward', sub, level, email, csrf: 'c' }, 3600)}`, 'x-telescreen-csrf': 'c', origin: 'http://localhost:3994' });
const owner = as(OWNER, 'owner', 'boss@example.com');
const admin = as(ADMIN, 'admin', 'helper@example.com');
const s3calls = () => seen.filter(s => s.path.startsWith('/spectralis-cdn'));

test('request signing matches the example AWS publishes for GET Object', () => {
  const { signature, headers } = signV4({
    method: 'GET', host: 'examplebucket.s3.amazonaws.com', path: '/test.txt', headers: { range: 'bytes=0-9' },
    payloadHash: EMPTY_HASH, accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    region: 'us-east-1', now: new Date('2013-05-24T00:00:00Z'),
  });
  assert.equal(signature, 'f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
  assert.match(headers.authorization, /SignedHeaders=host;range;x-amz-content-sha256;x-amz-date/);
});

test('keys are classified like the upload tool does, and unsafe keys are refused', () => {
  assert.equal(kindOf('Spectralis-7.0.0-win-x64-full.nupkg'), 'package');
  assert.equal(kindOf('releases.win-x64.json'), 'feed');
  assert.equal(kindOf('Spectralis-win-x64-Setup.exe'), 'installer');
  assert.equal(kindOf('visualizers/zero/clip.mp4'), 'content');
  assert.equal(kindOf('notes.txt'), 'unknown');
  for (const bad of ['', '/abs', 'a/../b', 'a//b', 'a/', '..', 'a\\b', 'x'.repeat(600)]) assert.equal(cleanKey(bad), null, JSON.stringify(bad));
  assert.equal(cleanKey('visualizers/a b/c.png'), 'visualizers/a b/c.png');
});

test('a bucket listing is parsed, including escaped keys and folders', () => {
  const page = parseList('<ListBucketResult><IsTruncated>true</IsTruncated><NextContinuationToken>tok</NextContinuationToken><Contents><Key>a&amp;b.txt</Key><Size>12</Size><LastModified>2026-01-01T00:00:00Z</LastModified></Contents><CommonPrefixes><Prefix>visualizers/</Prefix></CommonPrefixes></ListBucketResult>');
  assert.deepEqual(page.objects, [{ key: 'a&b.txt', size: 12, modified: '2026-01-01T00:00:00Z' }]);
  assert.deepEqual(page.prefixes, ['visualizers/']);
  assert.equal(page.truncated, true);
  assert.equal(page.next, 'tok');
});

test('the overview totals the bucket by kind against the budget, signed with our key, and no secret leaves the server', async () => {
  seed([['Spectralis-7.0.0-win-x64-full.nupkg', 100_000_000], ['releases.win-x64.json', 9_000], ['visualizers/manifest.json', 3_000], ['visualizers/a.png', 7_000], ['notes.txt', 50]]);
  seen.length = 0;
  const res = await app.inject({ method: 'GET', url: '/api/r2', headers: admin });
  assert.equal(res.statusCode, 200);
  const { usage } = res.json();
  assert.equal(usage.totalBytes, 100_019_050);
  assert.equal(usage.objects, 5);
  assert.deepEqual(usage.byKind, { package: 100_000_000, feed: 9_000, content: 10_000, unknown: 50 });
  assert.equal(usage.budgetBytes, 200_000_000);
  assert.equal(usage.hardMaxBytes, 8_000_000_000);
  assert.ok(s3calls().length >= 1 && s3calls().every(c => c.authorization.includes(`Credential=${ACCESS}/`)));
  const me = await app.inject({ method: 'GET', url: '/api/me', headers: admin });
  assert.equal(me.json().r2, true);
  for (const body of [res.body, me.body]) assert.ok(!body.includes(SECRET) && !body.includes(ACCESS));
});

test('the budget can never be configured above the hard maximum', async () => {
  const { budgetBytes, HARD_MAX_BYTES } = await import('../src/r2.js');
  const { config } = await import('../src/config.js');
  const saved = config.r2.budgetGb;
  config.r2.budgetGb = 500;
  assert.equal(budgetBytes(), HARD_MAX_BYTES);
  config.r2.budgetGb = saved;
});

test('browsing a folder lists its files and sub-folders', async () => {
  seed([['visualizers/manifest.json', 3_000], ['visualizers/zero/clip.mp4', 30_000_000], ['visualizers/808/808.webp', 400_000], ['releases.win-x64.json', 9_000]]);
  const root = (await app.inject({ method: 'GET', url: '/api/r2/objects', headers: admin })).json();
  assert.deepEqual(root.folders, ['visualizers/']);
  assert.deepEqual(root.objects.map(o => o.key), ['releases.win-x64.json']);
  assert.equal(root.objects[0].kind, 'feed');
  const inside = (await app.inject({ method: 'GET', url: '/api/r2/objects?prefix=visualizers%2F', headers: admin })).json();
  assert.deepEqual(inside.folders.sort(), ['visualizers/808/', 'visualizers/zero/']);
  assert.deepEqual(inside.objects.map(o => o.key), ['visualizers/manifest.json']);
  assert.equal((await app.inject({ method: 'GET', url: '/api/r2/objects?prefix=..%2Fx', headers: admin })).statusCode, 400);
});

test('uploads are owner-only and nothing leaves telescreen for an admin', async () => {
  seed([]);
  seen.length = 0;
  const res = await app.inject({ method: 'PUT', url: '/api/r2/objects/visualizers/a.png', headers: { ...admin, 'content-type': 'image/png' }, payload: Buffer.from('png-bytes') });
  assert.equal(res.statusCode, 403);
  assert.equal(s3calls().length, 0);
});

test('an owner upload sends the exact bytes, signed, and shows up in the bucket', async () => {
  seed([]);
  seen.length = 0;
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5]);
  const res = await app.inject({ method: 'PUT', url: '/api/r2/objects/visualizers/new/clip.png', headers: { ...owner, 'content-type': 'image/png' }, payload: bytes });
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(res.json(), { ok: true, key: 'visualizers/new/clip.png', bytes: 9 });
  assert.ok(store.get('visualizers/new/clip.png').bytes.equals(bytes), 'bytes arrive unchanged (the fake also checked the signed hash)');
});

test('uploads outside the visualizers folder, bad paths and empty files are refused before anything is sent', async () => {
  seed([]);
  seen.length = 0;
  const put = (url, payload, type = 'application/octet-stream') => app.inject({ method: 'PUT', url, headers: { ...owner, 'content-type': type }, payload });
  assert.equal((await put('/api/r2/objects/Spectralis-9.9.9-win-x64-full.nupkg', Buffer.from('x'))).statusCode, 400, 'releases go through the sync tool');
  assert.equal((await put('/api/r2/objects/releases.win-x64.json', Buffer.from('{}'))).statusCode, 400, 'never overwrite a feed from here');
  assert.equal((await put('/api/r2/objects/visualizers/..%2F..%2Fx', Buffer.from('x'))).statusCode, 400);
  assert.equal((await put('/api/r2/objects/visualizers/empty.bin', Buffer.alloc(0))).statusCode, 400);
  assert.equal(s3calls().length, 0, 'nothing reached the bucket');
});

test('an upload that would pass the budget is refused, and one that fits is not', async () => {
  seed([['Spectralis-7.0.0-win-x64-full.nupkg', 199_000_000]]);
  const tooBig = await app.inject({ method: 'PUT', url: '/api/r2/objects/visualizers/big.bin', headers: { ...owner, 'content-type': 'application/octet-stream' }, payload: Buffer.alloc(2_000_000) });
  assert.equal(tooBig.statusCode, 409);
  assert.match(tooBig.json().error, /past its 0\.2 GB budget/);
  assert.ok(!store.has('visualizers/big.bin'));
  const fits = await app.inject({ method: 'PUT', url: '/api/r2/objects/visualizers/small.bin', headers: { ...owner, 'content-type': 'application/octet-stream' }, payload: Buffer.alloc(500_000) });
  assert.equal(fits.statusCode, 200);
});

test('uploads over 8 MB are refused', async () => {
  seed([]);
  const res = await app.inject({ method: 'PUT', url: '/api/r2/objects/visualizers/huge.bin', headers: { ...owner, 'content-type': 'application/octet-stream' }, payload: Buffer.alloc(9 * 1024 * 1024) });
  assert.ok([400, 413].includes(res.statusCode), String(res.statusCode));
  assert.ok(!store.has('visualizers/huge.bin'));
});

test('deleting is owner-only, and an owner delete removes exactly that object', async () => {
  seed([['visualizers/a.png', 10], ['visualizers/b.png', 10]]);
  seen.length = 0;
  assert.equal((await app.inject({ method: 'DELETE', url: '/api/r2/objects/visualizers/a.png', headers: admin })).statusCode, 403);
  assert.equal(s3calls().length, 0);
  const ok = await app.inject({ method: 'DELETE', url: '/api/r2/objects/visualizers/a.png', headers: owner });
  assert.equal(ok.statusCode, 200);
  assert.deepEqual([...store.keys()], ['visualizers/b.png']);
});

test('sessions and CSRF are still required', async () => {
  assert.equal((await app.inject({ method: 'GET', url: '/api/r2' })).statusCode, 401);
  assert.equal((await app.inject({ method: 'DELETE', url: '/api/r2/objects/visualizers/a.png', headers: { ...owner, 'x-telescreen-csrf': 'wrong' } })).statusCode, 403);
});
