import { config } from './config.js';
import { audit } from './audit.js';
import { actorOf } from './session.js';
import { requireOwner } from './auth.js';

// Git hosting (git.deltavdevs.com) is run through its own /admin/v1 with GIT_ADMIN_KEY. It owns the approval list and
// the repos; we send the signed-in admin's email as X-Admin-Actor so its audit log says who. Only the routes below
// are forwarded; anything else 404s here.
const enabled = () => Boolean(config.git.url && config.git.key);

const SUB = '[\\w.:-]{1,128}';
const NAME = '[\\w.-]{1,64}';
const ALLOWED = [
  ['GET', /^status$/],
  ['GET', /^users$/],
  ['POST', new RegExp(`^users/${SUB}/(approve|deny|revoke)$`)],
  ['GET', /^repos$/],
  ['DELETE', new RegExp(`^repos/${NAME}$`)],
];
// Owners only: deleting someone's repo is not undoable.
const OWNER_ONLY = [
  ['DELETE', new RegExp(`^repos/${NAME}$`)],
];

async function git(request, path) {
  if (!enabled()) { const e = new Error('Set GIT_URL and GIT_ADMIN_KEY to run git hosting from here'); e.statusCode = 503; throw e; }
  const url = new URL(`/admin/v1/${path}`, config.git.url);
  for (const [k, v] of Object.entries(request.query || {})) if (typeof v === 'string' && v !== '') url.searchParams.set(k, v);
  const response = await fetch(url, {
    method: request.method,
    headers: { Authorization: `Bearer ${config.git.key}`, 'X-Admin-Actor': actorOf(request.session) || 'telescreen', Accept: 'application/json' },
    redirect: 'error',
    signal: AbortSignal.timeout(20_000),
  });
  const data = response.status === 204 ? {} : await response.json().catch(() => ({}));
  if (!response.ok) {
    const e = new Error(`Git: ${data.error?.message || data.error || `HTTP ${response.status}`}`);
    e.statusCode = response.status === 401 || response.status >= 500 ? 502 : response.status;
    throw e;
  }
  return { status: response.status, data };
}

export async function gitRoutes(app) {
  app.get('/api/git', async request => {
    if (!enabled()) return { enabled: false };
    try { return { enabled: true, url: config.git.url, status: (await git({ ...request, query: {}, method: 'GET' }, 'status')).data }; }
    catch (err) { return { enabled: true, url: config.git.url, error: err.message }; }
  });

  app.route({
    method: ['GET', 'POST', 'DELETE'],
    url: '/api/git/*',
    handler: async (request, reply) => {
      const path = request.params['*'];
      if (!ALLOWED.some(([m, re]) => m === request.method && re.test(path))) return reply.code(404).send({ error: 'Unknown git route' });
      if (OWNER_ONLY.some(([m, re]) => m === request.method && re.test(path))) requireOwner(request);
      if (request.method !== 'GET') audit(request, `git.${request.method.toLowerCase()}`, { path });
      const { status, data } = await git(request, path);
      return status === 204 ? reply.code(204).send() : reply.code(status).send(data);
    },
  });
}
