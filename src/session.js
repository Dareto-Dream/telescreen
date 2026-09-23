import { createHmac, randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { config } from './config.js';

// Sessions are stateless HMAC-signed cookies on purpose: telescreen has to keep
// working when the Redis or Postgres it administers is down. Rotating
// SESSION_SECRET (or removing an email from ADMIN_EMAILS) revokes everyone.
export const SESSION_COOKIE = config.production ? '__Host-telescreen' : 'telescreen';
export const OAUTH_COOKIE = config.production ? '__Host-telescreen-oauth' : 'telescreen-oauth';
export const cookieOptions = { httpOnly: true, secure: config.production, sameSite: 'lax', path: '/' };

export const token = () => randomBytes(32).toString('base64url');
export const challenge = verifier => createHash('sha256').update(verifier).digest('base64url');

export function equal(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

const sign = (purpose, body) => createHmac('sha256', config.sessionSecret).update(`${purpose}.${body}`).digest('base64url');

export function seal(purpose, payload, ttlSeconds) {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Date.now() + ttlSeconds * 1000 })).toString('base64url');
  return `${body}.${sign(purpose, body)}`;
}

export function unseal(purpose, value) {
  if (typeof value !== 'string' || value.length > 4096) return null;
  const [body, mac, extra] = value.split('.');
  if (!body || !mac || extra !== undefined || !equal(mac, sign(purpose, body))) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return typeof payload.exp === 'number' && payload.exp > Date.now() ? payload : null;
  } catch {
    return null;
  }
}

export const isAdmin = email => typeof email === 'string' && config.adminEmails.includes(email.toLowerCase());

export function readSession(request) {
  const session = unseal('session', request.cookies[SESSION_COOKIE]);
  // Re-check the allowlist every request so dropping an email takes effect on restart.
  return session && isAdmin(session.email) ? session : null;
}
