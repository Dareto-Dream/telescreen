import { config } from './config.js';
import { audit } from './audit.js';
import { actorOf } from './session.js';
import { requireOwner } from './auth.js';

// The search engine (search.deltavdevs.com) is run through its own /admin/v1 with SEARCH_ADMIN_KEY, so it does
// the validation (crawl limits, URL checks) and keeps its own audit log. We send the signed-in admin's email
// as X-Admin-Actor so that log says who. Only the routes below are forwarded; anything else 404s here.
const enabled = () => Boolean(config.search.url && config.search.key);

const ID = '[\\w-]{1,64}';
const ALLOWED = [
  ['GET', /^status$/],
  ['POST', /^crawl\/(pause|resume|recrawl)$/],
  ['GET', /^crawl\/jobs$/],
  ['POST', /^crawl\/jobs$/],
  ['GET', /^crawl\/jobs\/\d{1,9}$/],
  ['POST', /^crawl\/jobs\/\d{1,9}\/cancel$/],
  ['POST', /^index\/rebuild$/],
  ['POST', /^purge$/],
  ['GET', /^seeds$/],
  ['POST', /^seeds$/],
  ['DELETE', /^seeds$/],
  ['GET', /^blocklist$/],
  ['POST', /^blocklist$/],
  ['DELETE', /^blocklist$/],
  ['GET', /^optouts$/],
  ['POST', new RegExp(`^optouts/${ID}/(approve|reject)$`)],
  ['GET', /^keys$/],
  ['POST', /^keys$/],
  ['DELETE', new RegExp(`^keys/${ID}$`)],
];
// Owners only: anything that deletes stored data, rebuilds the index, or hands out credentials.
const OWNER_ONLY = [
  ['POST', /^index\/rebuild$/],
  ['POST', /^purge$/],
  ['POST', new RegExp(`^optouts/${ID}/approve$`)],
  ['POST', /^keys$/],
  ['DELETE', new RegExp(`^keys/${ID}$`)],
];

async function search(request, path) {
  if (!enabled()) { const e = new Error('Set SEARCH_URL and SEARCH_ADMIN_KEY to run the search engine from here'); e.statusCode = 503; throw e; }
  const url = new URL(`/admin/v1/${path}`, config.search.url);
  for (const [k, v] of Object.entries(request.query || {})) if (typeof v === 'string' && v !== '') url.searchParams.set(k, v);
  const hasBody = !['GET', 'HEAD', 'DELETE'].includes(request.method) && request.body !== undefined;
  const response = await fetch(url, {
    method: request.method,
    headers: { Authorization: `Bearer ${config.search.key}`, 'X-Admin-Actor': actorOf(request.session) || 'telescreen', Accept: 'application/json', ...(hasBody ? { 'Content-Type': 'application/json' } : {}) },
    body: hasBody ? JSON.stringify(request.body) : undefined,
    redirect: 'error',
    signal: AbortSignal.timeout(20_000),
  });
  const data = response.status === 204 ? {} : await response.json().catch(() => ({}));
  if (!response.ok) {
    const e = new Error(`Search: ${data.error?.message || data.error || `HTTP ${response.status}`}`);
    e.statusCode = response.status === 401 || response.status >= 500 ? 502 : response.status;
    throw e;
  }
  return { status: response.status, data };
}

export async function searchRoutes(app) {
  app.get('/api/search', async request => {
    if (!enabled()) return { enabled: false };
    try { return { enabled: true, url: config.search.url, status: (await search({ ...request, query: {}, method: 'GET' }, 'status')).data }; }
    catch (err) { return { enabled: true, url: config.search.url, error: err.message }; }
  });

  app.route({
    method: ['GET', 'POST', 'DELETE'],
    url: '/api/search/*',
    handler: async (request, reply) => {
      const path = request.params['*'];
      if (!ALLOWED.some(([m, re]) => m === request.method && re.test(path))) return reply.code(404).send({ error: 'Unknown search route' });
      if (OWNER_ONLY.some(([m, re]) => m === request.method && re.test(path))) requireOwner(request);
      if (request.method !== 'GET') audit(request, `search.${request.method.toLowerCase()}`, { path });
      const { status, data } = await search(request, path);
      return status === 204 ? reply.code(204).send() : reply.code(status).send(data);
    },
  });
}
