import { z } from 'zod';
import { config } from './config.js';
import { audit } from './audit.js';

// Replaces the old /balls admin suite. The main backend's ADMIN_TOKEN lives only
// in this server's env; the browser only ever talks to telescreen.
const COLLECTIONS = {
  projects: { base: '/api/admin', list: '/api/admin/', create: '/api/admin/new' },
  songs: { base: '/api/admin/songs', list: '/api/admin/songs', create: '/api/admin/songs/new' },
  albums: { base: '/api/admin/albums', list: '/api/admin/albums', create: '/api/admin/albums/new' },
  staff: { base: '/api/admin/staff', list: '/api/admin/staff', create: '/api/admin/staff/new' },
};

async function backend(method, path, body) {
  if (!config.content.apiUrl || !config.content.token) { const e = new Error('Set MAIN_API_URL and MAIN_ADMIN_TOKEN to manage site content'); e.statusCode = 503; throw e; }
  const response = await fetch(`${config.content.apiUrl}${path}`, {
    method,
    headers: { Authorization: `Bearer ${config.content.token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) { const e = new Error(`Backend: ${data.error || `HTTP ${response.status}`}`); e.statusCode = response.status >= 500 ? 502 : response.status; throw e; }
  return data;
}

const collection = name => {
  const found = COLLECTIONS[name];
  if (!found) { const e = new Error('Unknown collection'); e.statusCode = 404; throw e; }
  return found;
};
const id = z.coerce.number().int().min(0);
const record = z.record(z.string(), z.unknown());

export async function contentRoutes(app) {
  app.get('/api/content/:collection', async request => backend('GET', collection(request.params.collection).list));

  app.post('/api/content/:collection', async request => {
    const c = collection(request.params.collection);
    const body = record.parse(request.body);
    delete body.id;
    audit(request, 'content.create', { collection: request.params.collection, title: body.title || body.name || null });
    return backend('POST', c.create, body);
  });

  app.patch('/api/content/:collection/:id', async request => {
    const c = collection(request.params.collection);
    const recordId = id.parse(request.params.id);
    const body = record.parse(request.body);
    delete body.id; delete body.slug;
    audit(request, 'content.update', { collection: request.params.collection, id: recordId, fields: Object.keys(body) });
    return backend('PATCH', `${c.base}/${recordId}`, body);
  });

  app.delete('/api/content/:collection/:id', async request => {
    const c = collection(request.params.collection);
    const recordId = id.parse(request.params.id);
    audit(request, 'content.delete', { collection: request.params.collection, id: recordId });
    return backend('DELETE', `${c.base}/${recordId}`);
  });

  app.post('/api/content/:collection/reorder', async request => {
    const c = collection(request.params.collection);
    const ids = z.array(id).min(1).max(10_000).parse(request.body);
    audit(request, 'content.reorder', { collection: request.params.collection, count: ids.length });
    return backend('POST', `${c.base}/reorder`, ids);
  });
}
