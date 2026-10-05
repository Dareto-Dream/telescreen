import { config } from './config.js';
import { audit } from './audit.js';
import { actorOf } from './session.js';
import { requireOwner } from './auth.js';

// Spectralis (spectralis-api.deltavdevs.com) hosts its own warnings, changelog, community list and verified
// creators. This section edits them through the backend's /spectralis/v1/admin routes with SPECTRALIS_ADMIN_TOKEN,
// so the backend does the validation and nothing here can write anything it wouldn't accept. The signed-in
// admin's email goes along as X-Admin-Actor. Only the routes below are forwarded; anything else 404s here.
const enabled = () => Boolean(config.spectralis.url && config.spectralis.key);

const FEEDS = 'warnings|changelog|community';
const FINGERPRINT = '[0-9a-f]{64}';
const SLUG = '[a-z0-9-]{1,40}';
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
const MAX_IMAGE = 2 * 1024 * 1024;

// [method, pattern, upstream path builder, owner only, image upload]
const ROUTES = [
  ['GET', new RegExp(`^(${FEEDS})$`), m => `/spectralis/v1/${m[1]}`, false],
  ['GET', /^creators$/, () => '/spectralis/v1/admin/creators', false],
  ['PUT', new RegExp(`^(${FEEDS})$`), m => `/spectralis/v1/admin/${m[1]}`, false],
  ['PUT', new RegExp(`^community/avatars/(${SLUG})$`), m => `/spectralis/v1/admin/community/avatars/${m[1]}`, false, true],
  // Capsule permissions are a security decision, so creators are owner-only.
  ['PUT', new RegExp(`^creators/(${FINGERPRINT})$`), m => `/spectralis/v1/admin/creators/${m[1]}`, true],
  ['DELETE', new RegExp(`^creators/(${FINGERPRINT})$`), m => `/spectralis/v1/admin/creators/${m[1]}`, true],
  ['PUT', new RegExp(`^creators/(${FINGERPRINT})/avatar$`), m => `/spectralis/v1/admin/creators/${m[1]}/avatar`, true, true],
];

async function forward(request, path, upstreamPath) {
  if (!enabled()) { const e = new Error('Set SPECTRALIS_URL and SPECTRALIS_ADMIN_TOKEN to run Spectralis from here'); e.statusCode = 503; throw e; }
  const isImage = Buffer.isBuffer(request.body);
  const hasBody = !['GET', 'HEAD', 'DELETE'].includes(request.method) && request.body !== undefined;
  const response = await fetch(new URL(upstreamPath, config.spectralis.url), {
    method: request.method,
    headers: {
      Authorization: `Bearer ${config.spectralis.key}`,
      'X-Admin-Actor': actorOf(request.session) || 'telescreen',
      Accept: 'application/json',
      ...(hasBody ? { 'Content-Type': isImage ? request.headers['content-type'] : 'application/json' } : {}),
    },
    body: hasBody ? (isImage ? request.body : JSON.stringify(request.body)) : undefined,
    redirect: 'error',
    signal: AbortSignal.timeout(20_000),
  });
  const data = response.status === 204 ? {} : await response.json().catch(() => ({}));
  if (!response.ok) {
    const e = new Error(`Spectralis: ${data.error?.message || data.error || `HTTP ${response.status}`}`);
    // A 401/503 from upstream means telescreen's own token is wrong, which is not the admin's fault to retry.
    e.statusCode = response.status === 401 || response.status >= 500 ? 502 : response.status;
    throw e;
  }
  return { status: response.status, data };
}

export async function spectralisRoutes(app) {
  // Avatars arrive as raw image bytes; Fastify only knows JSON and text out of the box.
  app.addContentTypeParser(IMAGE_TYPES, { parseAs: 'buffer', bodyLimit: MAX_IMAGE + 1024 }, (_request, body, done) => done(null, body));

  app.get('/api/spectralis', async () => {
    if (!enabled()) return { enabled: false };
    const base = { enabled: true, url: config.spectralis.url };
    try {
      const [warnings, changelog, community] = await Promise.all(['warnings', 'changelog', 'community'].map(async feed => (await forward({ method: 'GET', headers: {} }, feed, `/spectralis/v1/${feed}`)).data));
      return { ...base, counts: { warnings: warnings.length, changelog: changelog.length, community: community.length } };
    } catch (err) { return { ...base, error: err.message }; }
  });

  app.route({
    method: ['GET', 'PUT', 'DELETE'],
    url: '/api/spectralis/*',
    handler: async (request, reply) => {
      const path = request.params['*'];
      let match = null;
      const entry = ROUTES.find(([method, re]) => method === request.method && (match = re.exec(path)));
      if (!entry) return reply.code(404).send({ error: 'Unknown Spectralis route' });
      const [, , build, ownerOnly, imageUpload] = entry;
      if (ownerOnly) requireOwner(request);
      // An avatar route takes image bytes and nothing else, so text or JSON is never passed along as one.
      if (imageUpload && !Buffer.isBuffer(request.body)) return reply.code(415).send({ error: 'Send a PNG, JPEG or WebP image.' });
      if (Buffer.isBuffer(request.body) && request.body.length > MAX_IMAGE) return reply.code(413).send({ error: 'Avatars can be at most 2 MB.' });
      if (request.method !== 'GET') audit(request, `spectralis.${request.method.toLowerCase()}`, { path });
      const { status, data } = await forward(request, path, build(match));
      return status === 204 ? reply.code(204).send() : reply.code(status).send(data);
    },
  });
}
