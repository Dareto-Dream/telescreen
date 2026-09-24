import { config } from './config.js';
import { audit } from './audit.js';

// Ward account management goes through Ward's own /admin/v1 with
// WARD_ADMIN_KEY, so Ward does the validation and keeps the audit trail.
// We pass the signed-in admin's email as X-Ward-Actor so its log says who.
// Only the routes below are forwarded; anything else 404s here.
const enabled = () => Boolean(config.ward.url && config.ward.key);

const ALLOWED = [
  ['GET', /^stats$/],
  ['GET', /^users$/],
  ['GET', /^users\/[0-9a-f-]{36}$/],
  ['PATCH', /^users\/[0-9a-f-]{36}$/],
  ['DELETE', /^users\/[0-9a-f-]{36}$/],
  ['POST', /^users\/[0-9a-f-]{36}\/(suspend|unsuspend|logout|reset-mfa|password-reset)$/],
  ['DELETE', /^users\/[0-9a-f-]{36}\/sessions\/\d{1,18}$/],
  ['DELETE', /^users\/[0-9a-f-]{36}\/identities\/(google|github|discord)$/],
  ['DELETE', /^users\/[0-9a-f-]{36}\/grants\/[\w.-]{1,100}$/],
  ['GET', /^clients$/],
  ['POST', /^clients$/],
  ['PATCH', /^clients\/[\w.-]{1,100}$/],
  ['DELETE', /^clients\/[\w.-]{1,100}$/],
  ['POST', /^clients\/[\w.-]{1,100}\/rotate-secret$/],
  ['GET', /^audit$/],
];

async function ward(request, path) {
  if (!enabled()) { const e = new Error('Set WARD_URL and WARD_ADMIN_KEY to manage Ward accounts'); e.statusCode = 503; throw e; }
  const url = new URL(`/admin/v1/${path}`, config.ward.url);
  for (const [k, v] of Object.entries(request.query || {})) if (typeof v === 'string' && v !== '') url.searchParams.set(k, v);
  const hasBody = !['GET', 'HEAD'].includes(request.method) && request.body !== undefined;
  const response = await fetch(url, {
    method: request.method,
    headers: { Authorization: `Bearer ${config.ward.key}`, 'X-Ward-Actor': request.session.email, Accept: 'application/json', ...(hasBody ? { 'Content-Type': 'application/json' } : {}) },
    body: hasBody ? JSON.stringify(request.body) : undefined,
    redirect: 'error',
    signal: AbortSignal.timeout(20_000),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const e = new Error(`Ward: ${data.error || `HTTP ${response.status}`}`);
    e.statusCode = response.status === 401 ? 502 : response.status >= 500 ? 502 : response.status;
    throw e;
  }
  return { status: response.status, data };
}

export async function wardRoutes(app) {
  app.get('/api/ward', async request => ({ enabled: enabled(), url: config.ward.url || null, ...(enabled() ? { stats: (await ward(request, 'stats')).data } : {}) }));

  app.route({
    method: ['GET', 'POST', 'PATCH', 'DELETE'],
    url: '/api/ward/*',
    handler: async (request, reply) => {
      const path = request.params['*'];
      if (!ALLOWED.some(([m, re]) => m === request.method && re.test(path))) return reply.code(404).send({ error: 'Unknown Ward route' });
      if (request.method !== 'GET') audit(request, `ward.${request.method.toLowerCase()}`, { path });
      const { status, data } = await ward(request, path);
      return reply.code(status).send(data);
    },
  });
}
