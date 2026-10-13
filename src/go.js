import { config } from './config.js';
import { audit } from './audit.js';
import { actorOf } from './session.js';
import { requireOwner } from './auth.js';

// go (short links at go.deltavdevs.com) is run through its /admin/v1 with GO_ADMIN_KEY. The signed-in admin goes along
// as X-Admin-Actor so go's own audit log says who. Only the routes below are forwarded.
const enabled = () => Boolean(config.go.url && config.go.key);
const SLUG = '[a-z0-9][a-z0-9_-]{0,47}';

// [method, pattern, owner only]. Deleting a link: owners only.
const ROUTES = [
  ['GET', /^overview$/, false],
  ['GET', /^links$/, false],
  ['GET', new RegExp(`^links/${SLUG}$`), false],
  ['POST', new RegExp(`^links/${SLUG}$`), false],
  ['POST', new RegExp(`^links/${SLUG}/(enable|disable)$`), false],
  ['DELETE', new RegExp(`^links/${SLUG}$`), true],
  ['GET', /^audit$/, false],
];

export async function goRoutes(app) {
  app.get('/api/go', async () => ({ enabled: enabled(), url: config.go.url }));
  app.route({
    method: ['GET', 'POST', 'DELETE'],
    url: '/api/go/*',
    handler: async (request, reply) => {
      if (!enabled()) return reply.code(503).send({ error: 'Set GO_URL and GO_ADMIN_KEY to run go from here' });
      const path = request.params['*'];
      const entry = ROUTES.find(([method, re]) => method === request.method && re.test(path));
      if (!entry) return reply.code(404).send({ error: 'Unknown go route' });
      if (entry[2]) requireOwner(request);
      const url = new URL(`/admin/v1/${path}`, config.go.url);
      for (const [k, v] of Object.entries(request.query || {})) if (typeof v === 'string' && v !== '') url.searchParams.set(k, v);
      const hasBody = ['POST', 'DELETE'].includes(request.method) && request.body !== undefined;
      const response = await fetch(url, {
        method: request.method,
        headers: { Authorization: `Bearer ${config.go.key}`, 'X-Admin-Actor': actorOf(request.session) || 'telescreen', Accept: 'application/json', ...(hasBody ? { 'Content-Type': 'application/json' } : {}) },
        body: hasBody ? JSON.stringify(request.body) : undefined,
        redirect: 'error',
        signal: AbortSignal.timeout(30_000),
      });
      const data = await response.json().catch(() => ({}));
      if (request.method !== 'GET') audit(request, `go.${request.method.toLowerCase()}`, { path });
      if (!response.ok) return reply.code(response.status === 401 || response.status >= 500 ? 502 : response.status).send({ error: `go: ${data.error || `HTTP ${response.status}`}` });
      return data;
    },
  });
}
