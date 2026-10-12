import { config } from './config.js';
import { audit } from './audit.js';
import { actorOf } from './session.js';
import { requireOwner } from './auth.js';

// Mail (staff mailboxes at mail.deltavdevs.com) is run through its /admin/v1 with MAIL_ADMIN_KEY. The signed-in
// admin goes along as X-Admin-Actor so Mail's own audit log says who. Only the routes below are forwarded, and
// none of them can read a message: admins decide who is in a mailbox, they read mail by being in it.
const enabled = () => Boolean(config.mail.url && config.mail.key);
const UUID = '[0-9a-f-]{36}';

// [method, pattern, owner only]. Creating or deleting a mailbox and changing who can read one: owners only.
const ROUTES = [
  ['GET', /^overview$/, false],
  ['GET', /^mailboxes$/, false],
  ['POST', /^mailboxes$/, true],
  ['GET', new RegExp(`^mailboxes/${UUID}$`), false],
  ['PATCH', new RegExp(`^mailboxes/${UUID}$`), true],
  ['DELETE', new RegExp(`^mailboxes/${UUID}$`), true],
  ['PUT', new RegExp(`^mailboxes/${UUID}/members/[0-9a-f-]{36}$`), true],
  ['DELETE', new RegExp(`^mailboxes/${UUID}/members/[0-9a-f-]{36}$`), true],
  ['POST', new RegExp(`^mailboxes/${UUID}/aliases$`), true],
  ['DELETE', new RegExp(`^mailboxes/${UUID}/aliases/[a-z0-9._+-]{1,64}@[a-z0-9.-]{1,100}$`), true],
  ['GET', new RegExp(`^mailboxes/${UUID}/activity$`), false],
  ['GET', /^users$/, false],
  ['GET', /^ingest-log$/, false],
  ['GET', /^audit$/, false],
];

export async function mailRoutes(app) {
  app.get('/api/mail', async () => ({ enabled: enabled(), url: config.mail.url }));
  app.route({
    method: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    url: '/api/mail/*',
    handler: async (request, reply) => {
      if (!enabled()) return reply.code(503).send({ error: 'Set MAIL_URL and MAIL_ADMIN_KEY to run Mail from here' });
      const path = request.params['*'];
      const entry = ROUTES.find(([method, re]) => method === request.method && re.test(path));
      if (!entry) return reply.code(404).send({ error: 'Unknown Mail route' });
      if (entry[2]) requireOwner(request);
      const url = new URL(`/admin/v1/${path}`, config.mail.url);
      for (const [k, v] of Object.entries(request.query || {})) if (typeof v === 'string' && v !== '') url.searchParams.set(k, v);
      const hasBody = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method) && request.body !== undefined;
      const response = await fetch(url, {
        method: request.method,
        headers: { Authorization: `Bearer ${config.mail.key}`, 'X-Admin-Actor': actorOf(request.session) || 'telescreen', Accept: 'application/json', ...(hasBody ? { 'Content-Type': 'application/json' } : {}) },
        body: hasBody ? JSON.stringify(request.body) : undefined,
        redirect: 'error',
        signal: AbortSignal.timeout(30_000),
      });
      const data = await response.json().catch(() => ({}));
      if (request.method !== 'GET') audit(request, `mail.${request.method.toLowerCase()}`, { path });
      if (!response.ok) return reply.code(response.status === 401 || response.status >= 500 ? 502 : response.status).send({ error: `Mail: ${data.error || `HTTP ${response.status}`}` });
      return data;
    },
  });
}
