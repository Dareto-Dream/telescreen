import { createHash, createHmac } from 'node:crypto';
import { config } from './config.js';
import { audit } from './audit.js';
import { requireOwner } from './auth.js';

// The Spectralis release CDN is a Cloudflare R2 bucket, spoken to over its S3 API with a signed request (SigV4).
// Telescreen lists it, shows how close it is to the storage cap, and lets an owner upload small content files and
// delete objects. Releases themselves go up with tools/r2/sync.mjs, which plans around the cap; here an upload is
// refused if it would not fit in the budget and writes are limited to the visualizers folder.
//
// R2 has no hard storage limit of its own. Past the 10 GB free tier it bills, so the same limits as the upload
// tool apply: a 5 GB budget by default, never more than 8 GB whatever R2_BUDGET_GB says.

const GB = 1_000_000_000;
export const HARD_MAX_BYTES = 8 * GB;
const enabled = () => Boolean(config.r2.accountId && config.r2.accessKeyId && config.r2.secretAccessKey);
export const budgetBytes = () => Math.min(Math.max(config.r2.budgetGb, 0.1), 8) * GB;

const MAX_UPLOAD = 8 * 1024 * 1024; // the console's request limit is 12 MB; stay well under it
const WRITE_PREFIX = 'visualizers/';

// ---------- SigV4 ----------

const sha256 = data => createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => createHmac('sha256', key).update(data).digest();
const enc = s => encodeURIComponent(s).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
export const EMPTY_HASH = sha256('');

/** Signs one S3 request. Pure; `now` is injectable so the AWS published examples can pin it. */
export function signV4({ method, host, path, query = {}, headers = {}, payloadHash, accessKeyId, secretAccessKey, region = 'auto', service = 's3', now = new Date() }) {
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const date = amzDate.slice(0, 8);
  const all = { host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate };
  for (const [k, v] of Object.entries(headers)) all[k.toLowerCase()] = v;
  const names = Object.keys(all).sort();
  const canonicalHeaders = names.map(n => `${n}:${String(all[n]).trim().replace(/\s+/g, ' ')}\n`).join('');
  const signedHeaders = names.join(';');
  const canonicalQuery = Object.keys(query).sort().map(k => `${enc(k)}=${enc(query[k])}`).join('&');
  const canonicalPath = path.split('/').map(enc).join('/');
  const canonicalRequest = [method, canonicalPath, canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${date}/${region}/${service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonicalRequest)].join('\n');
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, date), region), service), 'aws4_request');
  const signature = createHmac('sha256', signingKey).update(toSign).digest('hex');
  return {
    signature,
    canonicalRequest,
    headers: { ...all, authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}` },
  };
}

// ---------- classification (same rules as tools/r2/budget.mjs) ----------

const PACKAGE = /^[A-Za-z0-9_.]+?-\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?-[a-z0-9]+-[a-z0-9]+-(?:full|delta)\.nupkg$/;
const FEED = /^(?:releases\.[A-Za-z0-9_-]+\.json|RELEASES(?:-[A-Za-z0-9_-]+)?)$/;
const INSTALLER = /\.(?:exe|msi|appimage|pkg|dmg)$/i;
export function kindOf(key) {
  if (key.startsWith(WRITE_PREFIX)) return 'content';
  const name = key.split('/').pop() ?? key;
  if (PACKAGE.test(name)) return 'package';
  if (FEED.test(name)) return 'feed';
  if (INSTALLER.test(name)) return 'installer';
  return 'unknown';
}

// ---------- the bucket ----------

const decode = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const tag = (xml, name) => { const m = xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`)); return m ? decode(m[1]) : null; };

export function parseList(xml) {
  return {
    objects: [...xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)].map(m => ({ key: tag(m[1], 'Key'), size: Number(tag(m[1], 'Size') || 0), modified: tag(m[1], 'LastModified') })),
    prefixes: [...xml.matchAll(/<CommonPrefixes>\s*<Prefix>([\s\S]*?)<\/Prefix>/g)].map(m => decode(m[1])),
    truncated: tag(xml, 'IsTruncated') === 'true',
    next: tag(xml, 'NextContinuationToken'),
  };
}

function endpoint() {
  return new URL(config.r2.endpoint || `https://${config.r2.accountId}.r2.cloudflarestorage.com`);
}

async function s3(method, key, { query = {}, body } = {}) {
  if (!enabled()) { const e = new Error('Set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY to manage the release CDN from here'); e.statusCode = 503; throw e; }
  const base = endpoint();
  const path = `/${config.r2.bucket}${key ? `/${key}` : ''}`;
  const signed = signV4({
    method, host: base.host, path, query,
    headers: body ? { 'content-type': 'application/octet-stream' } : {},
    payloadHash: body ? sha256(body) : EMPTY_HASH,
    accessKeyId: config.r2.accessKeyId, secretAccessKey: config.r2.secretAccessKey,
  });
  const url = new URL(path.split('/').map(enc).join('/'), base);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const { host: _host, ...headers } = signed.headers;
  const response = await fetch(url, { method, headers, body, redirect: 'error', signal: AbortSignal.timeout(30_000) });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    const e = new Error(`R2: ${tag(text, 'Message') || `HTTP ${response.status}`}`);
    e.statusCode = response.status === 401 || response.status === 403 || response.status >= 500 ? 502 : response.status;
    throw e;
  }
  return response;
}

async function listPage({ prefix = '', cursor = '', delimiter = '/' } = {}) {
  const query = { 'list-type': '2', 'max-keys': '500' };
  if (prefix) query.prefix = prefix;
  if (delimiter) query.delimiter = delimiter;
  if (cursor) query['continuation-token'] = cursor;
  return parseList(await (await s3('GET', '', { query })).text());
}

/** Everything in the bucket, summed, and what the budget leaves. */
export async function usage() {
  let total = 0, count = 0, cursor = '';
  const byKind = {};
  do {
    const page = await listPage({ cursor, delimiter: '' });
    for (const o of page.objects) {
      total += o.size; count += 1;
      const kind = kindOf(o.key);
      byKind[kind] = (byKind[kind] || 0) + o.size;
    }
    cursor = page.truncated ? page.next : '';
  } while (cursor);
  return { totalBytes: total, objects: count, byKind, budgetBytes: budgetBytes(), hardMaxBytes: HARD_MAX_BYTES, freeTierBytes: 10 * GB };
}

/** A key is plain printable text with no way out of the bucket. */
export function cleanKey(raw) {
  const key = String(raw ?? '');
  if (!key || key.length > 512 || key.startsWith('/') || key.endsWith('/') || /[\u0000-\u001f\\]/.test(key) || key.split('/').some(p => p === '' || p === '.' || p === '..')) return null;
  return key;
}

export async function r2Routes(app) {
  app.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: MAX_UPLOAD + 1024 }, (_request, body, done) => done(null, body));

  app.get('/api/r2', async () => {
    if (!enabled()) return { enabled: false };
    const base = { enabled: true, bucket: config.r2.bucket, publicUrl: config.r2.publicUrl };
    try { return { ...base, usage: await usage() }; } catch (err) { return { ...base, error: err.message }; }
  });

  app.get('/api/r2/objects', async request => {
    const prefix = String(request.query?.prefix ?? '');
    if (prefix.length > 512 || /\.\./.test(prefix) || prefix.startsWith('/')) { const e = new Error('Not a folder in the bucket.'); e.statusCode = 400; throw e; }
    const page = await listPage({ prefix, cursor: String(request.query?.cursor ?? '') });
    return { prefix, folders: page.prefixes, objects: page.objects.map(o => ({ ...o, kind: kindOf(o.key) })), next: page.truncated ? page.next : null, publicUrl: config.r2.publicUrl };
  });

  app.put('/api/r2/objects/*', async (request, reply) => {
    requireOwner(request);
    const key = cleanKey(request.params['*']);
    if (!key) return reply.code(400).send({ error: 'That is not a usable file path.' });
    if (!key.startsWith(WRITE_PREFIX)) return reply.code(400).send({ error: `Uploads here go in ${WRITE_PREFIX}. Releases go up with tools/r2/sync.mjs, which plans around the storage cap.` });
    if (!Buffer.isBuffer(request.body) || request.body.length === 0) return reply.code(400).send({ error: 'Choose a file to upload.' });
    if (request.body.length > MAX_UPLOAD) return reply.code(413).send({ error: 'Uploads here are limited to 8 MB.' });

    const now = await usage();
    // Replacing a file keeps the old one until the new one lands, so count the whole upload on top of what is stored.
    if (now.totalBytes + request.body.length > now.budgetBytes) {
      return reply.code(409).send({ error: `That would take the bucket past its ${(now.budgetBytes / GB).toFixed(1)} GB budget. Nothing was uploaded.` });
    }
    audit(request, 'r2.put', { key, bytes: request.body.length });
    await s3('PUT', key, { body: request.body });
    return { ok: true, key, bytes: request.body.length };
  });

  app.delete('/api/r2/objects/*', async (request, reply) => {
    requireOwner(request);
    const key = cleanKey(request.params['*']);
    if (!key) return reply.code(400).send({ error: 'That is not a usable file path.' });
    audit(request, 'r2.delete', { key, kind: kindOf(key) });
    await s3('DELETE', key);
    return { ok: true, key };
  });
}
