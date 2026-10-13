import { config } from './config.js';
import { audit } from './audit.js';
import { actorOf } from './session.js';
import { requireOwner } from './auth.js';

// store (file sharing at store.deltavdevs.com) is run through its /admin/v1 with STORE_ADMIN_KEY. The signed-in admin
// goes along as X-Admin-Actor so store's own audit log says who. Uploading needs a browser session on store itself,
// so it isn't forwarded; everything else about an upload (who can open it, how long it lives, deleting it) is.
const enabled = () => Boolean(config.store.url && config.store.key);
const ID = '[a-z2-9]{10}';

// [method, pattern, owner only]. Deleting an upload: owners only.
const ROUTES = [
  ['GET', /^overview$/, false],
  ['GET', /^bundles$/, false],
  ['GET', new RegExp(`^bundles/${ID}$`), false],
  ['POST', new RegExp(`^bundles/${ID}$`), false],
  ['DELETE', new RegExp(`^bundles/${ID}$`), true],
  ['GET', /^audit$/, false],
];

export async function storeRoutes(app) {
  app.get('/api/store', async () => ({ enabled: enabled(), url: config.store.url }));
  app.route({
    method: ['GET', 'POST', 'DELETE'],
    url: '/api/store/*',
    handler: async (request, reply) => {
      if (!enabled()) return reply.code(503).send({ error: 'Set STORE_URL and STORE_ADMIN_KEY to run store from here' });
      const path = request.params['*'];
      const entry = ROUTES.find(([method, re]) => method === request.method && re.test(path));
      if (!entry) return reply.code(404).send({ error: 'Unknown store route' });
      if (entry[2]) requireOwner(request);
      const url = new URL(`/admin/v1/${path}`, config.store.url);
      for (const [k, v] of Object.entries(request.query || {})) if (typeof v === 'string' && v !== '') url.searchParams.set(k, v);
      const hasBody = ['POST', 'DELETE'].includes(request.method) && request.body !== undefined;
      const response = await fetch(url, {
        method: request.method,
        headers: { Authorization: `Bearer ${config.store.key}`, 'X-Admin-Actor': actorOf(request.session) || 'telescreen', Accept: 'application/json', ...(hasBody ? { 'Content-Type': 'application/json' } : {}) },
        body: hasBody ? JSON.stringify(request.body) : undefined,
        redirect: 'error',
        signal: AbortSignal.timeout(30_000),
      });
      const data = await response.json().catch(() => ({}));
      if (request.method !== 'GET') audit(request, `store.${request.method.toLowerCase()}`, { path });
      if (!response.ok) return reply.code(response.status === 401 || response.status >= 500 ? 502 : response.status).send({ error: `store: ${data.error || `HTTP ${response.status}`}` });
      return data;
    },
  });
}
