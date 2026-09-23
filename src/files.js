import { z } from 'zod';
import { config } from './config.js';
import { audit } from './audit.js';

// CDN file manager (the old /balls WebDAV panel), proxied server-side so the
// WebDAV password never sits in browser localStorage again.
const enabled = () => Boolean(config.files.url && config.files.user && config.files.password);

// Paths are relative to the WebDAV root. Reject traversal and control characters
// outright, then encode each segment.
const pathSchema = z.string().max(2048).refine(p => !/[\u0000-\u001f]/.test(p) && !p.split('/').some(s => s === '..' || s === '.'), 'Invalid path');
const clean = p => p.split('/').filter(Boolean);
const davUrl = (p, folder = false) => {
  const segments = clean(p).map(encodeURIComponent).join('/');
  return `${config.files.url}${segments}${folder && segments ? '/' : ''}`;
};
const auth = () => ({ Authorization: `Basic ${Buffer.from(`${config.files.user}:${config.files.password}`).toString('base64')}` });

async function dav(method, url, { headers = {}, body, timeout = 30_000 } = {}) {
  if (!enabled()) { const e = new Error('Set CDN_WEBDAV_URL, CDN_WEBDAV_USER and CDN_WEBDAV_PASSWORD to manage CDN files'); e.statusCode = 503; throw e; }
  const response = await fetch(url, { method, headers: { ...auth(), ...headers }, body, duplex: body ? 'half' : undefined, redirect: 'manual', signal: AbortSignal.timeout(timeout) });
  if (response.status >= 400) {
    const e = new Error(`CDN ${method} failed: HTTP ${response.status}`); e.statusCode = response.status === 404 ? 404 : response.status === 412 ? 409 : 502; throw e;
  }
  return response;
}

// Small PROPFIND parser; Caddy's multistatus output is regular enough that a
// namespace-agnostic regex beats pulling in an XML dependency.
function parseListing(xml, basePath) {
  const tag = (block, name) => block.match(new RegExp(`<(?:[\\w-]+:)?${name}[^>]*>([\\s\\S]*?)</(?:[\\w-]+:)?${name}>`, 'i'))?.[1]?.trim();
  const decode = s => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  const base = clean(basePath).join('/');
  return [...xml.matchAll(/<(?:[\w-]+:)?response[\s>][\s\S]*?<\/(?:[\w-]+:)?response>/gi)].map(([block]) => {
    const href = decode(tag(block, 'href') || '');
    const isDir = /<(?:[\w-]+:)?collection\s*\/?>/i.test(block);
    // Caddy strips /webdav/ before its webdav handler, so hrefs may or may not carry the prefix.
    const root = new URL(config.files.url).pathname, pathname = new URL(href, config.files.url).pathname;
    const path = clean(pathname.startsWith(root) ? pathname.slice(root.length) : pathname).map(s => { try { return decodeURIComponent(s); } catch { return s; } }).join('/');
    return { path, name: path.split('/').pop() || '', dir: isDir, size: Number(tag(block, 'getcontentlength') || 0) || null, type: tag(block, 'getcontenttype') || null, modified: tag(block, 'getlastmodified') || null };
  }).filter(item => item.path !== base).sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
}

export async function fileRoutes(app) {
  app.get('/api/files', async request => {
    const { path } = z.object({ path: pathSchema.default('') }).parse(request.query);
    const response = await dav('PROPFIND', davUrl(path, true), { headers: { Depth: '1', 'Content-Type': 'application/xml' } });
    return { path: clean(path).join('/'), publicBase: config.files.publicUrl, items: parseListing(await response.text(), path) };
  });

  app.get('/api/files/raw', async (request, reply) => {
    const { path } = z.object({ path: pathSchema.min(1) }).parse(request.query);
    const response = await dav('GET', davUrl(path), { timeout: 120_000 });
    reply.header('Content-Type', response.headers.get('content-type') || 'application/octet-stream');
    reply.header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(clean(path).pop())}`);
    // Never let uploaded HTML/SVG run with telescreen's origin.
    reply.header('Content-Security-Policy', "default-src 'none'; sandbox");
    reply.header('X-Content-Type-Options', 'nosniff');
    return reply.send(Buffer.from(await response.arrayBuffer()));
  });

  // Uploads stream straight through: raw body in, raw body out to Caddy.
  app.register(async scope => {
    scope.addContentTypeParser('*', (_request, payload, done) => done(null, payload));
    scope.put('/api/files', { bodyLimit: 1024 * 1024 * 1024 }, async request => {
      const { path } = z.object({ path: pathSchema.min(1) }).parse(request.query);
      audit(request, 'files.upload', { path, bytes: Number(request.headers['content-length']) || null });
      await dav('PUT', davUrl(path), { headers: { 'Content-Type': request.headers['content-type'] || 'application/octet-stream', ...(request.headers['content-length'] ? { 'Content-Length': request.headers['content-length'] } : {}) }, body: request.body, timeout: 20 * 60_000 });
      return { ok: true, path: clean(path).join('/') };
    });
  });

  app.post('/api/files/mkdir', async request => {
    const { path } = z.object({ path: pathSchema.min(1) }).parse(request.body);
    audit(request, 'files.mkdir', { path });
    await dav('MKCOL', davUrl(path, true));
    return { ok: true };
  });

  app.post('/api/files/move', async request => {
    const body = z.object({ from: pathSchema.min(1), to: pathSchema.min(1), copy: z.boolean().default(false), dir: z.boolean().default(false) }).parse(request.body);
    audit(request, body.copy ? 'files.copy' : 'files.move', { from: body.from, to: body.to });
    await dav(body.copy ? 'COPY' : 'MOVE', davUrl(body.from, body.dir), { headers: { Destination: davUrl(body.to, body.dir), Overwrite: 'F', ...(body.dir ? { Depth: 'infinity' } : {}) }, timeout: 120_000 });
    return { ok: true };
  });

  app.delete('/api/files', async request => {
    const body = z.object({ path: pathSchema.min(1), dir: z.boolean().default(false) }).parse(request.body);
    if (!clean(body.path).length) { const e = new Error('Refusing to delete the CDN root'); e.statusCode = 400; throw e; }
    audit(request, 'files.delete', { path: body.path, dir: body.dir });
    await dav('DELETE', davUrl(body.path, body.dir));
    return { ok: true };
  });
}
