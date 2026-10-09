import { config } from './config.js';
import { audit } from './audit.js';
import { actorOf } from './session.js';
import { requireOwner } from './auth.js';

// Logger (team logs at logger.deltavdevs.com) is run through its /admin/v1 with LOGGER_ADMIN_KEY. The signed-in
// admin goes along as X-Admin-Actor so Logger's own audit log says who. Only the routes below are forwarded.
const enabled = () => Boolean(config.logger.url && config.logger.key);
const UUID = '[0-9a-f-]{36}';

// [method, pattern, owner only]. Deleting a workspace, moving it, or stopping someone creating one: owners only.
const ROUTES = [
  ['GET', /^overview$/, false],
  ['GET', /^workspaces$/, false],
  ['GET', new RegExp(`^workspaces/${UUID}$`), false],
  ['GET', new RegExp(`^workspaces/${UUID}/export$`), false],
  ['POST', new RegExp(`^workspaces/${UUID}/(suspend|unsuspend)$`), false],
  ['POST', new RegExp(`^workspaces/${UUID}/transfer$`), true],
  ['DELETE', new RegExp(`^workspaces/${UUID}$`), true],
  ['DELETE', new RegExp(`^workspaces/${UUID}/logs/${UUID}$`), false],
  ['GET', /^users$/, false],
  ['POST', new RegExp(`^users/${UUID}/creation$`), true],
  ['GET', /^audit$/, false],
];

export async function loggerRoutes(app) {
  app.get('/api/logger', async () => ({ enabled: enabled(), url: config.logger.url }));
  app.route({
    method: ['GET', 'POST', 'DELETE'],
    url: '/api/logger/*',
    handler: async (request, reply) => {
      if (!enabled()) return reply.code(503).send({ error: 'Set LOGGER_URL and LOGGER_ADMIN_KEY to run Logger from here' });
      const path = request.params['*'];
      const entry = ROUTES.find(([method, re]) => method === request.method && re.test(path));
      if (!entry) return reply.code(404).send({ error: 'Unknown Logger route' });
      if (entry[2]) requireOwner(request);
      const url = new URL(`/admin/v1/${path}`, config.logger.url);
      for (const [k, v] of Object.entries(request.query || {})) if (typeof v === 'string' && v !== '') url.searchParams.set(k, v);
      const hasBody = ['POST', 'DELETE'].includes(request.method) && request.body !== undefined;
      const response = await fetch(url, {
        method: request.method,
        headers: { Authorization: `Bearer ${config.logger.key}`, 'X-Admin-Actor': actorOf(request.session) || 'telescreen', Accept: 'application/json', ...(hasBody ? { 'Content-Type': 'application/json' } : {}) },
        body: hasBody ? JSON.stringify(request.body) : undefined,
        redirect: 'error',
        signal: AbortSignal.timeout(60_000),
      });
      const data = await response.json().catch(() => ({}));
      if (request.method !== 'GET' || path.endsWith('/export')) audit(request, `logger.${request.method.toLowerCase()}`, { path });
      if (!response.ok) return reply.code(response.status === 401 || response.status >= 500 ? 502 : response.status).send({ error: `Logger: ${data.error || `HTTP ${response.status}`}` });
      return data;
    },
  });
}
