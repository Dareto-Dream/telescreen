import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import staticFiles from '@fastify/static';
import { fileURLToPath } from 'node:url';
import { ZodError } from 'zod';
import { config, assertConfig } from './config.js';
import { authRoutes, guard } from './auth.js';
import { readSession } from './session.js';
import { postgresRoutes, closePostgres } from './postgres.js';
import { redisRoutes, closeRedis } from './redis.js';
import { railwayRoutes } from './railway.js';
import { httpRoutes } from './http.js';
import { contentRoutes } from './content.js';
import { fileRoutes } from './files.js';
import { deltatimeRoutes, closeDeltatime } from './deltatime.js';

const THEME = 'https://css.deltavdevs.com';

export async function buildApp(options = {}) {
  assertConfig();
  const app = Fastify({ logger: options.logger ?? { level: 'info' }, trustProxy: true, bodyLimit: 12 * 1024 * 1024 });

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", THEME, 'https://fonts.googleapis.com'],
        fontSrc: [THEME, 'https://fonts.gstatic.com'],
        imgSrc: ["'self'", 'data:', 'https://lh3.googleusercontent.com', config.files.publicUrl],
        connectSrc: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        upgradeInsecureRequests: config.production ? [] : null,
      },
    },
    referrerPolicy: { policy: 'no-referrer' },
    crossOriginEmbedderPolicy: false,
  });
  await app.register(cookie);
  app.addHook('onSend', async (_request, reply) => { reply.header('X-Robots-Tag', 'noindex, nofollow'); reply.header('Cache-Control', 'no-store'); });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) return reply.code(400).send({ error: error.issues.map(i => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ') });
    const status = error.statusCode && error.statusCode >= 400 ? error.statusCode : 500;
    if (status >= 500) request.log.error(error);
    // Only the allowlisted admin can reach anything that throws here, so real messages are fine.
    return reply.code(status).send({ error: error.message || 'Something broke.', ...(error.detail ? { detail: error.detail } : {}) });
  });

  app.get('/health', async () => ({ ok: true }));
  await app.register(authRoutes);

  await app.register(async api => {
    api.addHook('onRequest', guard);
    api.get('/api/me', async request => ({
      email: request.session.email, name: request.session.name, picture: request.session.picture, csrf: request.session.csrf,
      counts: { postgres: config.postgres.length, redis: config.redis.length, http: config.http.length, railway: Boolean(config.railway.projectToken || config.railway.apiToken) },
      content: Boolean(config.content.apiUrl && config.content.token),
      files: Boolean(config.files.url && config.files.user && config.files.password),
    }));
    await api.register(contentRoutes);
    await api.register(fileRoutes);
    await api.register(deltatimeRoutes);
    await api.register(postgresRoutes);
    await api.register(redisRoutes);
    await api.register(railwayRoutes);
    await api.register(httpRoutes);
  });

  await app.register(staticFiles, { root: fileURLToPath(new URL('../public', import.meta.url)), index: ['index.html'] });
  // Tiny hint for the page so a signed-out load doesn't flash the console shell.
  app.get('/auth/state', async request => ({ signedIn: Boolean(readSession(request)) }));

  app.addHook('onClose', async () => { await closePostgres(); await closeRedis(); await closeDeltatime(); });
  return app;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const app = await buildApp();
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => app.close().then(() => process.exit(0)));
  await app.listen({ port: config.port, host: '0.0.0.0' });
}
