import pg from 'pg';
import { z } from 'zod';
import { config } from './config.js';
import { audit } from './audit.js';

// DeltaTime fraud review goes through DeltaTime's own /api/admin/v1 with an
// admin API key, so trust changes and shadowbans run DeltaTime's permission
// checks and land in its trust_level_audit_logs, attributed to the key owner.
// The only thing read straight from its database is the "suspected" queue,
// which the admin API has no listing for.
const enabled = () => Boolean(config.deltatime.url && config.deltatime.key);

async function dt(method, path, { query, body } = {}) {
  if (!enabled()) { const e = new Error('Set DELTATIME_URL and DELTATIME_ADMIN_KEY to review DeltaTime fraud'); e.statusCode = 503; throw e; }
  const url = new URL(`/api/admin/v1/${path}`, config.deltatime.url);
  if (query) for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  const response = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${config.deltatime.key}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const e = new Error(`DeltaTime: ${data.error || data.errors?.join?.(', ') || `HTTP ${response.status}`}`);
    e.statusCode = response.status === 404 ? 404 : response.status === 403 || response.status === 401 ? 403 : response.status >= 500 ? 502 : 400;
    throw e;
  }
  return data;
}

const userId = z.coerce.number().int().positive();
const TRUST = ['blue', 'red', 'green', 'yellow'];
const TRUST_INT = { 0: 'blue', 1: 'red', 2: 'green', 3: 'yellow' };

let dbPool = null;
function deltatimeDb() {
  const entry = config.postgres.find(c => c.name === config.deltatime.dbConnection);
  if (!entry) return null;
  if (!dbPool) {
    dbPool = new pg.Pool({ connectionString: entry.url, max: 2, connectionTimeoutMillis: 5000, statement_timeout: 20_000, application_name: 'telescreen-deltatime' });
    dbPool.on('error', () => {});
  }
  return dbPool;
}

export async function deltatimeRoutes(app) {
  app.get('/api/deltatime', async () => ({ enabled: enabled(), db: Boolean(deltatimeDb()), url: config.deltatime.url || null, ...(enabled() ? { check: await dt('GET', 'check') } : {}) }));

  app.get('/api/deltatime/search', async request => {
    const { q } = z.object({ q: z.string().trim().min(1).max(200) }).parse(request.query);
    if (/^\d+$/.test(q)) return { users: [{ id: Number(q), username: `user #${q}` }] };
    if (q.includes('@')) {
      const found = await dt('POST', 'user/get_user_by_email', { body: { email: q } }).catch(() => null);
      if (found?.user_id) return { users: [{ id: found.user_id, email: q }] };
    }
    return dt('POST', 'user/search_fuzzy', { body: { query: q } });
  });

  app.get('/api/deltatime/user/:id', async request => {
    const id = userId.parse(request.params.id);
    const [info, logs, projects] = await Promise.all([
      dt('GET', 'user/info', { query: { id } }),
      dt('GET', 'user/trust_logs', { query: { id } }).catch(() => ({ trust_logs: [] })),
      dt('GET', 'user/projects', { query: { id } }).catch(() => ({ projects: [] })),
    ]);
    return { ...info, trust_logs: logs.trust_logs, projects: projects.projects };
  });

  app.get('/api/deltatime/user/:id/heartbeats', async request => {
    const id = userId.parse(request.params.id);
    const q = z.object({
      start_date: z.string().max(40).optional(), end_date: z.string().max(40).optional(),
      limit: z.coerce.number().int().min(1).max(5000).default(500), offset: z.coerce.number().int().min(0).default(0),
      project: z.string().max(300).optional(), machine: z.string().max(300).optional(), editor: z.string().max(300).optional(),
    }).parse(request.query);
    return dt('GET', 'user/heartbeats', { query: { id, ...q } });
  });

  app.get('/api/deltatime/user/:id/values', async request => {
    const id = userId.parse(request.params.id);
    const { field } = z.object({ field: z.enum(['projects', 'languages', 'editors', 'machines', 'user_agents', 'ips']) }).parse(request.query);
    return dt('GET', 'user/heartbeat_values', { query: { id, field, limit: 500 } });
  });

  app.get('/api/deltatime/lookup', async request => {
    const q = z.object({ ip: z.string().max(100).optional(), machine: z.string().max(300).optional() }).refine(v => v.ip || v.machine, 'ip or machine required').parse(request.query);
    return q.ip ? dt('GET', 'user/get_users_by_ip', { query: { ip: q.ip } }) : dt('GET', 'user/get_users_by_machine', { query: { machine: q.machine } });
  });

  app.get('/api/deltatime/alts', async request => {
    const { lookback_days } = z.object({ lookback_days: z.coerce.number().int().min(1).max(365).default(30) }).parse(request.query);
    const { candidates } = await dt('GET', 'alts/candidates', { query: { lookback_days } });
    // Collapse machine/ip rows into user pairs so the same alt shows up once.
    const pairs = new Map();
    for (const c of candidates) {
      const key = `${c.user_a_id}:${c.user_b_id}`;
      const p = pairs.get(key) || { user_a_id: c.user_a_id, user_b_id: c.user_b_id, machines: new Set(), ips: new Set(), last_seen: 0 };
      p.machines.add(c.machine); p.ips.add(c.ip_address);
      p.last_seen = Math.max(p.last_seen, Number(c.user_a_last_seen_on_combo) || 0, Number(c.user_b_last_seen_on_combo) || 0);
      pairs.set(key, p);
    }
    const list = [...pairs.values()].map(p => ({ ...p, machines: [...p.machines], ips: [...p.ips] })).sort((a, b) => b.machines.length + b.ips.length - (a.machines.length + a.ips.length) || b.last_seen - a.last_seen);
    const ids = [...new Set(list.flatMap(p => [p.user_a_id, p.user_b_id]))].slice(0, 2000);
    const users = ids.length ? (await dt('GET', 'user/info_batch', { query: { ids: ids.join(',') } })).users : [];
    return { pairs: list.slice(0, 500), users: Object.fromEntries(users.map(u => [u.id, u])), truncated: candidates.length >= 5000 };
  });

  app.get('/api/deltatime/queue', async () => {
    const [banned, shadowbans] = await Promise.all([
      dt('GET', 'banned_users', { query: { limit: 200 } }),
      dt('GET', 'leaderboard_shadowbans').catch(() => ({ leaderboard_shadowbans: [] })),
    ]);
    const db = deltatimeDb();
    const suspected = db ? (await db.query(`SELECT u.id, u.username, u.github_username, u.updated_at, u.trust_level,
        (SELECT min(e.email) FROM email_addresses e WHERE e.user_id = u.id) AS email,
        (SELECT l.reason FROM trust_level_audit_logs l WHERE l.user_id = u.id ORDER BY l.created_at DESC LIMIT 1) AS reason
       FROM users u WHERE u.trust_level = 3 ORDER BY u.updated_at DESC LIMIT 200`)).rows.map(r => ({ ...r, trust_level: TRUST_INT[r.trust_level] })) : null;
    return { suspected, banned: banned.banned_users, shadowbanned: shadowbans.leaderboard_shadowbans };
  });

  app.get('/api/deltatime/audit', async request => {
    const q = z.object({ user_id: userId.optional(), trust_level_filter: z.string().max(20).optional(), page: z.coerce.number().int().min(1).max(1000).optional() }).parse(request.query);
    return dt('GET', 'trust_level_audit_logs', { query: q });
  });

  app.post('/api/deltatime/user/:id/trust', async request => {
    const id = userId.parse(request.params.id);
    const body = z.object({ trust_level: z.enum(TRUST), reason: z.string().trim().min(3).max(1000), notes: z.string().max(5000).optional() }).parse(request.body);
    audit(request, 'deltatime.trust', { user: id, trust_level: body.trust_level, reason: body.reason });
    return dt('POST', 'user/convict', { body: { id, ...body } });
  });

  app.post('/api/deltatime/user/:id/shadowban', async request => {
    const id = userId.parse(request.params.id);
    const body = z.object({ reason: z.string().trim().min(3).max(1000), expires_at: z.string().max(40).optional() }).parse(request.body);
    audit(request, 'deltatime.shadowban', { user: id, reason: body.reason, expires_at: body.expires_at || null });
    return dt('POST', 'leaderboard_shadowbans', { body: { user_id: id, reason: body.reason, leaderboard_shadowban_expires_at: body.expires_at || null } });
  });

  app.delete('/api/deltatime/user/:id/shadowban', async request => {
    const id = userId.parse(request.params.id);
    audit(request, 'deltatime.unshadowban', { user: id });
    return dt('DELETE', `leaderboard_shadowbans/${id}`);
  });
}

export async function closeDeltatime() { await dbPool?.end().catch(() => {}); }
