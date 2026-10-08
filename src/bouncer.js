import { config } from './config.js';
import { audit } from './audit.js';
import { actorOf } from './session.js';
import { requireOwner } from './auth.js';

// Bouncer (the DeltaVDevs Discord bot) is run through its /admin/v1 with BOUNCER_ADMIN_KEY. The signed-in admin's
// email goes along as X-Admin-Actor so Bouncer's own log says who. Only the routes below are forwarded.
const enabled = () => Boolean(config.bouncer.url && config.bouncer.key);
const SNOWFLAKE = '\\d{15,22}';

// [method, pattern, owner only]. Approving or leaving a server decides where the bot works, so owners only.
const ROUTES = [
  ['GET', /^overview$/, false],
  ['POST', new RegExp(`^guilds/${SNOWFLAKE}/(allow|disallow|leave)$`), true],
  ['POST', new RegExp(`^guilds/${SNOWFLAKE}/sync$`), false],
  ['GET', /^bots$/, false],
  ['PUT', new RegExp(`^bots/${SNOWFLAKE}$`), false],
  ['DELETE', new RegExp(`^bots/${SNOWFLAKE}$`), false],
  ['GET', /^links$/, false],
  ['DELETE', new RegExp(`^links/${SNOWFLAKE}$`), false],
  ['POST', /^sync$/, false],
  ['DELETE', /^templates\/[a-z0-9][a-z0-9-]{0,39}$/, false],
  ['GET', /^audit$/, false],
];

export async function bouncerRoutes(app) {
  app.get('/api/bouncer', async () => ({ enabled: enabled(), url: config.bouncer.url }));
  app.route({
    method: ['GET', 'POST', 'PUT', 'DELETE'],
    url: '/api/bouncer/*',
    handler: async (request, reply) => {
      if (!enabled()) return reply.code(503).send({ error: 'Set BOUNCER_URL and BOUNCER_ADMIN_KEY to run Bouncer from here' });
      const path = request.params['*'];
      const entry = ROUTES.find(([method, re]) => method === request.method && re.test(path));
      if (!entry) return reply.code(404).send({ error: 'Unknown Bouncer route' });
      if (entry[2]) requireOwner(request);
      const url = new URL(`/admin/v1/${path}`, config.bouncer.url);
      for (const [k, v] of Object.entries(request.query || {})) if (typeof v === 'string' && v !== '') url.searchParams.set(k, v);
      const hasBody = ['POST', 'PUT'].includes(request.method) && request.body !== undefined;
      const response = await fetch(url, {
        method: request.method,
        headers: { Authorization: `Bearer ${config.bouncer.key}`, 'X-Admin-Actor': actorOf(request.session) || 'telescreen', Accept: 'application/json', ...(hasBody ? { 'Content-Type': 'application/json' } : {}) },
        body: hasBody ? JSON.stringify(request.body) : undefined,
        redirect: 'error',
        signal: AbortSignal.timeout(60_000),
      });
      const data = await response.json().catch(() => ({}));
      if (request.method !== 'GET') audit(request, `bouncer.${request.method.toLowerCase()}`, { path });
      if (!response.ok) return reply.code(response.status === 401 || response.status >= 500 ? 502 : response.status).send({ error: `Bouncer: ${data.error || `HTTP ${response.status}`}` });
      return data;
    },
  });
}
