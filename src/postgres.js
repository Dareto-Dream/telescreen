import pg from 'pg';
import { requireOwner } from './auth.js';
import { z } from 'zod';
import { config } from './config.js';
import { audit } from './audit.js';

const MAX_ROWS = 1000;
const TIMEOUT_MS = 30_000;
const pools = new Map();

function connection(name) {
  const entry = config.postgres.find(c => c.name === name);
  if (!entry) { const e = new Error('Unknown Postgres connection'); e.statusCode = 404; throw e; }
  if (!pools.has(name)) {
    const pool = new pg.Pool({ connectionString: entry.url, max: 3, connectionTimeoutMillis: 5000, idleTimeoutMillis: 30_000, statement_timeout: TIMEOUT_MS, application_name: 'telescreen' });
    pool.on('error', () => {}); // idle client errors shouldn't take the process down
    pools.set(name, pool);
  }
  return { entry, pool: pools.get(name) };
}

const ident = value => `"${String(value).replace(/"/g, '""')}"`;

// JSON can't carry bytea or bigint cleanly, so flatten everything to something printable.
function cell(value) {
  if (value === null || value === undefined) return null;
  if (Buffer.isBuffer(value)) return `\\x${value.toString('hex')}`;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'bigint') return value.toString();
  return value;
}
const shape = result => ({
  command: result.command,
  rowCount: result.rowCount,
  fields: (result.fields || []).map(f => f.name),
  rows: (result.rows || []).slice(0, MAX_ROWS).map(row => row.map(cell)),
  truncated: (result.rows || []).length > MAX_ROWS,
});

// Look the relation up in the catalog instead of trusting names from the URL.
async function relation(pool, schema, name) {
  const found = (await pool.query(
    `SELECT n.nspname AS schema, c.relname AS name, c.relkind AS kind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind IN ('r','p','v','m','f')`,
    [schema, name],
  )).rows[0];
  if (!found) { const e = new Error('Table not found'); e.statusCode = 404; throw e; }
  const columns = (await pool.query(
    `SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type, NOT a.attnotnull AS nullable, pg_get_expr(d.adbin, d.adrelid) AS default,
            COALESCE(a.attnum = ANY(i.indkey), false) AS pk
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
       LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
       LEFT JOIN pg_index i ON i.indrelid = c.oid AND i.indisprimary
      WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped
      ORDER BY a.attnum`,
    [schema, name],
  )).rows;
  return { ...found, columns, table: `${ident(found.schema)}.${ident(found.name)}` };
}

// Primary key values must cover every pk column, and only pk columns.
function wherePk(rel, pk, offset) {
  const keys = rel.columns.filter(c => c.pk).map(c => c.name);
  if (!keys.length) { const e = new Error('This table has no primary key; use the SQL console.'); e.statusCode = 400; throw e; }
  if (Object.keys(pk).length !== keys.length || !keys.every(k => k in pk)) { const e = new Error('Primary key values are incomplete.'); e.statusCode = 400; throw e; }
  return { sql: keys.map((k, i) => `${ident(k)} IS NOT DISTINCT FROM $${offset + i + 1}`).join(' AND '), values: keys.map(k => pk[k]) };
}
function pickColumns(rel, values) {
  const known = new Set(rel.columns.map(c => c.name));
  const entries = Object.entries(values);
  if (!entries.length || entries.some(([k]) => !known.has(k))) { const e = new Error('Unknown column.'); e.statusCode = 400; throw e; }
  return entries;
}

const scalar = z.union([z.string().max(1_000_000), z.number(), z.boolean(), z.null()]);
const tableQuery = z.object({ schema: z.string().min(1).max(128), name: z.string().min(1).max(128) });
const rowBody = tableQuery.extend({ pk: z.record(z.string(), scalar).optional(), values: z.record(z.string(), scalar).optional() });

export async function postgresRoutes(app) {
  app.get('/api/pg', async () => Promise.all(config.postgres.map(async ({ name }) => {
    try {
      const { pool } = connection(name);
      const info = (await pool.query(`SELECT current_database() AS database, current_user AS "user", split_part(version(), ' ', 2) AS version,
        pg_size_pretty(pg_database_size(current_database())) AS size,
        (SELECT count(*)::int FROM pg_stat_activity WHERE datname = current_database()) AS connections`)).rows[0];
      return { name, ok: true, ...info };
    } catch (err) {
      return { name, ok: false, error: err.message };
    }
  })));

  app.get('/api/pg/:conn/tables', async request => {
    const { pool } = connection(request.params.conn);
    return (await pool.query(`SELECT n.nspname AS schema, c.relname AS name, c.relkind AS kind, GREATEST(c.reltuples, 0)::bigint::text AS estimate,
        pg_size_pretty(pg_total_relation_size(c.oid)) AS size
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('r','p','v','m','f') AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%'
      ORDER BY n.nspname, c.relname`)).rows;
  });

  app.get('/api/pg/:conn/table', async request => {
    const q = tableQuery.extend({ limit: z.coerce.number().int().min(1).max(500).default(100), offset: z.coerce.number().int().min(0).default(0) }).parse(request.query);
    const { pool } = connection(request.params.conn);
    const rel = await relation(pool, q.schema, q.name);
    const order = rel.columns.filter(c => c.pk).map(c => ident(c.name)).join(', ');
    const result = await pool.query({ text: `SELECT * FROM ${rel.table}${order ? ` ORDER BY ${order}` : ''} LIMIT $1 OFFSET $2`, values: [q.limit, q.offset], rowMode: 'array' });
    return { schema: rel.schema, name: rel.name, kind: rel.kind, columns: rel.columns, ...shape(result), limit: q.limit, offset: q.offset };
  });

  app.post('/api/pg/:conn/row', async request => {
    const body = rowBody.parse(request.body);
    const { pool } = connection(request.params.conn);
    const rel = await relation(pool, body.schema, body.name);
    const cols = pickColumns(rel, body.values || {});
    const sql = `INSERT INTO ${rel.table} (${cols.map(([k]) => ident(k)).join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`;
    audit(request, 'pg.insert', { conn: request.params.conn, table: `${rel.schema}.${rel.name}`, columns: cols.map(([k]) => k) });
    return shape(await pool.query({ text: sql, values: cols.map(([, v]) => v), rowMode: 'array' }));
  });

  app.patch('/api/pg/:conn/row', async request => {
    const body = rowBody.parse(request.body);
    const { pool } = connection(request.params.conn);
    const rel = await relation(pool, body.schema, body.name);
    const cols = pickColumns(rel, body.values || {});
    const where = wherePk(rel, body.pk || {}, cols.length);
    const sql = `UPDATE ${rel.table} SET ${cols.map(([k], i) => `${ident(k)} = $${i + 1}`).join(', ')} WHERE ${where.sql} RETURNING *`;
    audit(request, 'pg.update', { conn: request.params.conn, table: `${rel.schema}.${rel.name}`, pk: body.pk, columns: cols.map(([k]) => k) });
    return withinOneRow(pool, sql, [...cols.map(([, v]) => v), ...where.values]);
  });

  app.delete('/api/pg/:conn/row', async request => {
    const body = rowBody.parse(request.body);
    const { pool } = connection(request.params.conn);
    const rel = await relation(pool, body.schema, body.name);
    const where = wherePk(rel, body.pk || {}, 0);
    audit(request, 'pg.delete', { conn: request.params.conn, table: `${rel.schema}.${rel.name}`, pk: body.pk });
    return withinOneRow(pool, `DELETE FROM ${rel.table} WHERE ${where.sql} RETURNING *`, where.values);
  });

  // Raw SQL. Read-only mode is a seatbelt, not a sandbox: the session defaults to
  // read-only and the batch runs inside a READ ONLY transaction that is always
  // rolled back, so a stray COMMIT still can't write. Write mode runs autocommit
  // (VACUUM, CREATE DATABASE etc. work) on a throwaway connection so a dangling
  // BEGIN or SET can never leak into the browsing pool.
  app.post('/api/pg/:conn/query', async request => {
    const body = z.object({ sql: z.string().min(1).max(200_000), write: z.boolean().default(false) }).parse(request.body);
    if (body.write) requireOwner(request); // read-only SQL is fine for any admin
    const { entry } = connection(request.params.conn);
    audit(request, body.write ? 'pg.sql.write' : 'pg.sql.read', { conn: entry.name, sql: body.sql });
    const client = new pg.Client({ connectionString: entry.url, connectionTimeoutMillis: 5000, statement_timeout: TIMEOUT_MS, application_name: 'telescreen-console' });
    client.on('error', () => {});
    const started = performance.now();
    try {
      await client.connect();
    } catch (err) {
      const e = new Error(`Could not connect: ${err.message}`); e.statusCode = 502; throw e;
    }
    try {
      if (!body.write) await client.query('SET default_transaction_read_only = on; BEGIN READ ONLY');
      let results;
      try {
        results = await client.query({ text: body.sql, rowMode: 'array' });
      } finally {
        if (!body.write) await client.query('ROLLBACK').catch(() => {});
      }
      results = (Array.isArray(results) ? results : [results]).map(shape);
      return { results, ms: Math.round(performance.now() - started) };
    } catch (err) {
      const e = new Error(err.message); e.statusCode = 400;
      e.detail = { position: err.position, hint: err.hint, code: err.code };
      throw e;
    } finally {
      await client.end().catch(() => {});
    }
  });
}

// Row-level edits must hit exactly one row, otherwise nothing changes.
async function withinOneRow(pool, text, values) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query({ text, values, rowMode: 'array' });
    if (result.rowCount !== 1) {
      await client.query('ROLLBACK');
      const e = new Error(`Expected to change 1 row, would have changed ${result.rowCount}. Rolled back.`); e.statusCode = 409; throw e;
    }
    await client.query('COMMIT');
    return shape(result);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function closePostgres() {
  await Promise.all([...pools.values()].map(p => p.end().catch(() => {})));
}
