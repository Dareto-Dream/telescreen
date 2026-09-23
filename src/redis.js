import Redis from 'ioredis';
import { z } from 'zod';
import { config } from './config.js';
import { audit } from './audit.js';

const clients = new Map();
const PREVIEW = 500;
// These either hijack the connection (pub/sub, MONITOR) or hang it; the console can't render them anyway.
const REFUSED = new Set(['subscribe', 'psubscribe', 'ssubscribe', 'unsubscribe', 'punsubscribe', 'sunsubscribe', 'monitor', 'sync', 'psync', 'quit', 'reset', 'blpop', 'brpop', 'brpoplpush', 'blmove', 'blmpop', 'bzpopmin', 'bzpopmax', 'bzmpop']);

const options = { lazyConnect: true, connectTimeout: 4000, commandTimeout: 10_000, maxRetriesPerRequest: 1, enableOfflineQueue: true, retryStrategy: times => Math.min(times * 500, 5000), family: 0 };

function connection(name) {
  const entry = config.redis.find(c => c.name === name);
  if (!entry) { const e = new Error('Unknown Redis connection'); e.statusCode = 404; throw e; }
  if (!clients.has(name)) {
    const client = new Redis(entry.url, options);
    client.on('error', () => {});
    clients.set(name, client);
  }
  return { entry, client: clients.get(name) };
}

function parseInfo(text) {
  const out = {};
  for (const line of String(text).split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i > 0 && !line.startsWith('#')) out[line.slice(0, i)] = line.slice(i + 1);
  }
  return out;
}

const keyQuery = z.object({ key: z.string().min(1).max(4096) });

export async function redisRoutes(app) {
  app.get('/api/redis', async () => Promise.all(config.redis.map(async ({ name }) => {
    try {
      const { client } = connection(name);
      const info = parseInfo(await client.info());
      return {
        name, ok: true,
        version: info.redis_version, memory: info.used_memory_human, peak: info.used_memory_peak_human,
        clients: Number(info.connected_clients), uptimeDays: Number(info.uptime_in_days),
        keys: Number(await client.dbsize()), hits: Number(info.keyspace_hits), misses: Number(info.keyspace_misses),
        evicted: Number(info.evicted_keys), maxmemoryPolicy: info.maxmemory_policy,
      };
    } catch (err) {
      return { name, ok: false, error: err.message };
    }
  })));

  app.get('/api/redis/:conn/keys', async request => {
    const q = z.object({ match: z.string().max(1000).default('*'), cursor: z.string().regex(/^\d+$/).default('0'), count: z.coerce.number().int().min(10).max(5000).default(500) }).parse(request.query);
    const { client } = connection(request.params.conn);
    // SCAN may return fewer than COUNT; keep going a few rounds so a sparse match still shows something.
    let cursor = q.cursor, keys = [];
    for (let round = 0; round < 10 && keys.length < q.count; round++) {
      const [next, batch] = await client.scan(cursor, 'MATCH', q.match, 'COUNT', 1000);
      keys.push(...batch); cursor = next;
      if (cursor === '0') break;
    }
    keys = [...new Set(keys)].slice(0, q.count).sort();
    const pipe = client.pipeline();
    for (const key of keys) { pipe.type(key); pipe.pttl(key); }
    const meta = keys.length ? await pipe.exec() : [];
    return {
      cursor,
      keys: keys.map((key, i) => ({ key, type: meta[i * 2]?.[1] ?? '?', ttl: meta[i * 2 + 1]?.[1] ?? null })),
    };
  });

  app.get('/api/redis/:conn/key', async request => {
    const { key } = keyQuery.parse(request.query);
    const { client } = connection(request.params.conn);
    const [type, ttl] = await Promise.all([client.type(key), client.pttl(key)]);
    let value = null, length = null;
    switch (type) {
      case 'string': value = await client.getrange(key, 0, 256 * 1024); length = await client.strlen(key); break;
      case 'hash': { length = await client.hlen(key); const [, flat] = await client.hscan(key, '0', 'COUNT', PREVIEW); value = Object.fromEntries(pairs(flat)); break; }
      case 'list': length = await client.llen(key); value = await client.lrange(key, 0, PREVIEW - 1); break;
      case 'set': { length = await client.scard(key); const [, members] = await client.sscan(key, '0', 'COUNT', PREVIEW); value = members; break; }
      case 'zset': length = await client.zcard(key); value = pairs(await client.zrange(key, 0, PREVIEW - 1, 'WITHSCORES')).map(([member, score]) => ({ member, score })); break;
      case 'stream': length = await client.xlen(key); value = (await client.xrevrange(key, '+', '-', 'COUNT', 100)).map(([id, fields]) => ({ id, fields: Object.fromEntries(pairs(fields)) })); break;
      case 'none': { const e = new Error('Key not found'); e.statusCode = 404; throw e; }
      default: value = `(${type} — use the console)`;
    }
    return { key, type, ttl, length, value };
  });

  app.put('/api/redis/:conn/key', async request => {
    const body = keyQuery.extend({ value: z.string().max(10_000_000), ttl: z.number().int().min(-1).max(10 * 365 * 86400).nullable().default(null) }).parse(request.body);
    const { client } = connection(request.params.conn);
    audit(request, 'redis.set', { conn: request.params.conn, key: body.key, ttl: body.ttl });
    // null ttl = keep whatever TTL is there, -1 = persist, n = expire in n seconds
    if (body.ttl === null) await client.set(body.key, body.value, 'KEEPTTL');
    else if (body.ttl === -1) await client.set(body.key, body.value);
    else await client.set(body.key, body.value, 'EX', body.ttl);
    return { ok: true };
  });

  app.post('/api/redis/:conn/expire', async request => {
    const body = keyQuery.extend({ ttl: z.number().int().min(-1).max(10 * 365 * 86400) }).parse(request.body);
    const { client } = connection(request.params.conn);
    audit(request, 'redis.expire', { conn: request.params.conn, key: body.key, ttl: body.ttl });
    const changed = body.ttl === -1 ? await client.persist(body.key) : await client.expire(body.key, body.ttl);
    return { ok: true, changed };
  });

  app.post('/api/redis/:conn/rename', async request => {
    const body = keyQuery.extend({ to: z.string().min(1).max(4096) }).parse(request.body);
    const { client } = connection(request.params.conn);
    audit(request, 'redis.rename', { conn: request.params.conn, key: body.key, to: body.to });
    const ok = await client.renamenx(body.key, body.to);
    if (!ok) { const e = new Error('Target key already exists'); e.statusCode = 409; throw e; }
    return { ok: true };
  });

  app.delete('/api/redis/:conn/key', async request => {
    const body = z.object({ keys: z.array(z.string().min(1).max(4096)).min(1).max(1000) }).parse(request.body);
    const { client } = connection(request.params.conn);
    audit(request, 'redis.del', { conn: request.params.conn, keys: body.keys });
    return { deleted: await client.unlink(...body.keys) };
  });

  // Raw command console on a throwaway connection so SELECT / CLIENT SETNAME etc.
  // never bleed into the shared browsing client.
  app.post('/api/redis/:conn/command', async request => {
    const body = z.object({ args: z.array(z.string().max(1_000_000)).min(1).max(10_000) }).parse(request.body);
    const { entry } = connection(request.params.conn);
    const [command, ...rest] = body.args;
    if (REFUSED.has(command.toLowerCase())) { const e = new Error(`${command.toUpperCase()} blocks or hijacks the connection; not supported here.`); e.statusCode = 400; throw e; }
    audit(request, 'redis.command', { conn: entry.name, args: body.args.map(a => a.slice(0, 200)) });
    const client = new Redis(entry.url, { ...options, retryStrategy: () => null, maxRetriesPerRequest: 0 });
    client.on('error', () => {});
    const started = performance.now();
    try {
      await client.connect();
      const result = await client.call(command, ...rest);
      return { result, ms: Math.round(performance.now() - started) };
    } catch (err) {
      const e = new Error(err.message); e.statusCode = 400; throw e;
    } finally {
      client.disconnect();
    }
  });
}

function pairs(flat) {
  const out = [];
  for (let i = 0; i < flat.length; i += 2) out.push([flat[i], flat[i + 1]]);
  return out;
}

export async function closeRedis() {
  for (const client of clients.values()) client.disconnect();
}
