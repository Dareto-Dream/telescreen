// Everything telescreen can touch is declared through the environment.
// Connections are discovered by prefix so Railway reference variables drop straight in:
//   TELESCREEN_PG_MAIN=${{Postgres.DATABASE_URL}}
//   TELESCREEN_REDIS_CACHE=${{Redis.REDIS_URL}}
//   TELESCREEN_HTTP_BACKEND=https://.../health
const env = process.env;
const production = env.NODE_ENV === 'production';

function collect(prefix) {
  return Object.keys(env)
    .filter(key => key.startsWith(prefix) && env[key])
    .map(key => ({ name: key.slice(prefix.length).toLowerCase(), url: env[key] }))
    .filter(entry => /^[a-z0-9_]{1,40}$/.test(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name));
}

const publicUrl = (env.PUBLIC_URL || `http://localhost:${env.PORT || 3000}`).replace(/\/+$/, '');

export const config = {
  production,
  port: Number(env.PORT || 3000),
  publicUrl,
  origin: new URL(publicUrl).origin,
  sessionSecret: env.SESSION_SECRET || '',
  sessionHours: Math.min(Math.max(Number(env.SESSION_HOURS || 12), 1), 72),
  postgres: collect('TELESCREEN_PG_'),
  redis: collect('TELESCREEN_REDIS_'),
  http: collect('TELESCREEN_HTTP_'),
  content: {
    apiUrl: (env.MAIN_API_URL || '').replace(/\/+$/, ''),
    token: env.MAIN_ADMIN_TOKEN || '',
  },
  files: {
    url: env.CDN_WEBDAV_URL ? env.CDN_WEBDAV_URL.replace(/\/*$/, '/') : '',
    user: env.CDN_WEBDAV_USER || '',
    password: env.CDN_WEBDAV_PASSWORD || '',
    publicUrl: (env.CDN_PUBLIC_URL || 'https://cdn.deltavdevs.com').replace(/\/+$/, ''),
  },
  deltatime: {
    url: (env.DELTATIME_URL || '').replace(/\/+$/, ''),
    key: env.DELTATIME_ADMIN_KEY || '',
    // Optional read-only view of DeltaTime's own Postgres for the suspected queue.
    dbConnection: (env.DELTATIME_PG_CONNECTION || 'deltatime').toLowerCase(),
  },
  // Ward (accounts for every DeltaVDevs site), managed over its /admin/v1.
  ward: {
    url: (env.WARD_URL || '').replace(/\/+$/, ''),
    key: env.WARD_ADMIN_KEY || '',
    // Telescreen's own Ward app, for signing in ("Continue with Ward").
    clientId: env.WARD_CLIENT_ID || '',
    clientSecret: env.WARD_CLIENT_SECRET || '',
  },
  railway: {
    projectToken: env.RAILWAY_PROJECT_TOKEN || '',
    apiToken: env.RAILWAY_API_TOKEN || '',
    // Railway injects these into every service, so on Railway they point at our own project.
    projectId: env.TELESCREEN_RAILWAY_PROJECT_ID || env.RAILWAY_PROJECT_ID || '',
    environmentId: env.TELESCREEN_RAILWAY_ENVIRONMENT_ID || env.RAILWAY_ENVIRONMENT_ID || '',
  },
};

export const wardSignIn = () => Boolean(config.ward.url && config.ward.clientId && config.ward.clientSecret && config.ward.key);

// Fail closed: an admin console with no way to check who's an admin, or a weak signing key, must not boot.
export function assertConfig() {
  const problems = [];
  if (config.sessionSecret.length < 32) problems.push('SESSION_SECRET must be at least 32 characters');
  if (!wardSignIn()) problems.push('set WARD_URL, WARD_ADMIN_KEY, WARD_CLIENT_ID and WARD_CLIENT_SECRET (sign-in and admin levels come from Ward)');
  if (config.production && !config.publicUrl.startsWith('https://')) problems.push('PUBLIC_URL must be https in production');
  if (problems.length) throw new Error(`telescreen refuses to start:\n - ${problems.join('\n - ')}`);
}
