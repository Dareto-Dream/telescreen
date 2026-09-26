import { config, wardSignIn, googleSignIn } from './config.js';
import { SESSION_COOKIE, OAUTH_COOKIE, cookieOptions, seal, unseal, token, challenge, equal, isAdmin, readSession, CONSOLE_LEVELS } from './session.js';
import { audit } from './audit.js';

const GOOGLE_AUTHORIZE = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO = 'https://openidconnect.googleapis.com/v1/userinfo';
const callbackUrl = () => `${config.publicUrl}/auth/google/callback`;

// Tiny in-memory limiter; one instance, one admin, no need for Redis here.
const hits = new Map();
function limited(key, max, windowMs) {
  const now = Date.now();
  const entry = hits.get(key);
  if (!entry || entry.reset < now) { hits.set(key, { count: 1, reset: now + windowMs }); return false; }
  entry.count += 1;
  return entry.count > max;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (v.reset < now) hits.delete(k); }, 60_000).unref();

async function fetchJSON(url, options) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(10_000) });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${new URL(url).host} responded ${response.status}`);
  return body;
}

const startSession = (reply, payload) => {
  reply.clearCookie(OAUTH_COOKIE, cookieOptions);
  reply.setCookie(SESSION_COOKIE, seal('session', { ...payload, csrf: token() }, config.sessionHours * 3600), {
    ...cookieOptions,
    sameSite: 'strict',
    maxAge: config.sessionHours * 3600,
  });
};

const bounce = (reply, message) => {
  reply.clearCookie(OAUTH_COOKIE, cookieOptions);
  return reply.redirect(`/?error=${encodeURIComponent(message)}`);
};

export async function authRoutes(app) {
  // ---------- Ward (the normal way in) ----------
  const wardCallback = () => `${config.publicUrl}/auth/ward/callback`;
  app.get('/auth/ward/start', async (request, reply) => {
    if (!wardSignIn()) return bounce(reply, 'Ward sign-in is not set up here.');
    if (limited(`start:${request.ip}`, 30, 15 * 60_000)) return bounce(reply, 'Too many sign-in attempts. Wait a few minutes.');
    const state = token(), verifier = token(), nonce = token();
    reply.setCookie(OAUTH_COOKIE, seal('oauth', { state, verifier, nonce, via: 'ward' }, 600), { ...cookieOptions, maxAge: 600 });
    const url = new URL('/oauth/authorize', config.ward.url);
    url.search = new URLSearchParams({
      client_id: config.ward.clientId, redirect_uri: wardCallback(), response_type: 'code',
      scope: 'openid profile email admin', state, nonce, code_challenge: challenge(verifier), code_challenge_method: 'S256',
    }).toString();
    return reply.redirect(url.toString());
  });

  app.get('/auth/ward/callback', async (request, reply) => {
    if (limited(`callback:${request.ip}`, 30, 15 * 60_000)) return bounce(reply, 'Too many sign-in attempts. Wait a few minutes.');
    const pending = unseal('oauth', request.cookies[OAUTH_COOKIE]);
    const { state, code, error, iss } = request.query || {};
    if (error) return bounce(reply, 'Ward sign-in was cancelled.');
    // RFC 9207: only accept a response that names our Ward as the issuer.
    if (!wardSignIn() || !pending || pending.via !== 'ward' || typeof state !== 'string' || typeof code !== 'string' || code.length > 2000
      || !equal(state, pending.state) || iss !== config.ward.url) {
      return bounce(reply, 'Sign-in expired or could not be verified. Try again.');
    }
    let profile;
    try {
      const exchange = await fetchJSON(new URL('/oauth/token', config.ward.url), {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: pending.verifier, redirect_uri: wardCallback(),
          client_id: config.ward.clientId, client_secret: config.ward.clientSecret }),
      });
      if (!exchange.access_token || !String(exchange.scope || '').split(' ').includes('admin')) throw new Error('No admin scope');
      // Straight to Ward over TLS with the token we just exchanged, so its claims are trusted.
      profile = await fetchJSON(new URL('/oauth/userinfo', config.ward.url), { headers: { Authorization: `Bearer ${exchange.access_token}`, Accept: 'application/json' } });
    } catch (err) {
      request.log.warn({ err: err.message }, 'ward exchange failed');
      return bounce(reply, 'Ward sign-in failed. Try again.');
    }
    if (typeof profile.sub !== 'string' || !CONSOLE_LEVELS.includes(profile.admin_level)) {
      audit(request, 'auth.denied', { sub: profile.sub || null, level: profile.admin_level ?? null, via: 'ward' });
      return bounce(reply, 'That Ward account is not a telescreen admin.');
    }
    const email = typeof profile.email === 'string' ? profile.email.toLowerCase() : null;
    startSession(reply, { via: 'ward', sub: profile.sub, level: profile.admin_level, email,
      name: String(profile.name || profile.preferred_username || 'Admin').slice(0, 80), picture: typeof profile.picture === 'string' ? profile.picture : null });
    levels.set(profile.sub, { level: profile.admin_level, at: Date.now() });
    audit(request, 'auth.login', { sub: profile.sub, email, level: profile.admin_level, via: 'ward' });
    return reply.redirect('/');
  });

  // ---------- Google (backup while Ward sign-in is new) ----------
  app.get('/auth/google/start', async (request, reply) => {
    if (!googleSignIn()) return bounce(reply, 'Google sign-in is turned off. Use Ward.');
    if (limited(`start:${request.ip}`, 30, 15 * 60_000)) return bounce(reply, 'Too many sign-in attempts. Wait a few minutes.');
    const state = token(), verifier = token(), nonce = token();
    reply.setCookie(OAUTH_COOKIE, seal('oauth', { state, verifier, nonce }, 600), { ...cookieOptions, maxAge: 600 });
    const url = new URL(GOOGLE_AUTHORIZE);
    url.search = new URLSearchParams({
      client_id: config.google.id,
      redirect_uri: callbackUrl(),
      response_type: 'code',
      scope: 'openid email profile',
      state,
      nonce,
      code_challenge: challenge(verifier),
      code_challenge_method: 'S256',
      prompt: 'select_account',
    }).toString();
    return reply.redirect(url.toString());
  });

  app.get('/auth/google/callback', async (request, reply) => {
    if (!googleSignIn()) return bounce(reply, 'Google sign-in is turned off. Use Ward.');
    if (limited(`callback:${request.ip}`, 30, 15 * 60_000)) return bounce(reply, 'Too many sign-in attempts. Wait a few minutes.');
    const pending = unseal('oauth', request.cookies[OAUTH_COOKIE]);
    const { state, code, error } = request.query || {};
    if (error) return bounce(reply, 'Google sign-in was cancelled.');
    if (!pending || typeof state !== 'string' || typeof code !== 'string' || code.length > 2000 || !equal(state, pending.state)) {
      return bounce(reply, 'Sign-in expired or could not be verified. Try again.');
    }
    let profile;
    try {
      const exchange = await fetchJSON(GOOGLE_TOKEN, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams({
          client_id: config.google.id,
          client_secret: config.google.secret,
          grant_type: 'authorization_code',
          code,
          code_verifier: pending.verifier,
          redirect_uri: callbackUrl(),
        }),
      });
      if (!exchange.access_token) throw new Error('No access token');
      // The userinfo call goes straight to Google over TLS with the token we just
      // exchanged server-side, so its claims are trusted without JWT verification.
      profile = await fetchJSON(GOOGLE_USERINFO, { headers: { Authorization: `Bearer ${exchange.access_token}` } });
    } catch (err) {
      request.log.warn({ err: err.message }, 'google exchange failed');
      return bounce(reply, 'Google sign-in failed. Try again.');
    }
    const email = typeof profile.email === 'string' ? profile.email.toLowerCase() : '';
    if (profile.email_verified !== true || !isAdmin(email)) {
      audit(request, 'auth.denied', { email: email || null });
      return bounce(reply, 'That Google account is not allowed on the telescreen.');
    }
    startSession(reply, { via: 'google', email, name: String(profile.name || email).slice(0, 80), picture: typeof profile.picture === 'string' ? profile.picture : null });
    audit(request, 'auth.login', { email, via: 'google' });
    return reply.redirect('/');
  });

  app.post('/auth/logout', async (request, reply) => {
    const session = readSession(request);
    if (session) { request.session = session; audit(request, 'auth.logout', {}); }
    reply.clearCookie(SESSION_COOKIE, { ...cookieOptions, sameSite: 'strict' });
    return { ok: true };
  });
}

// A Ward session's level is re-checked with Ward (cached a minute), so a demotion
// or suspension ends it quickly. If Ward itself is unreachable we keep going on
// the session's level: telescreen has to work during outages.
const levels = new Map();
const LEVEL_TTL = 60_000;
async function liveLevel(request, session) {
  if (session.via !== 'ward') return session.level;
  const cached = levels.get(session.sub);
  if (cached && Date.now() - cached.at < LEVEL_TTL) return cached.level;
  let level = session.level;
  try {
    const response = await fetch(new URL(`/admin/v1/users/${encodeURIComponent(session.sub)}`, config.ward.url), {
      headers: { Authorization: `Bearer ${config.ward.key}`, Accept: 'application/json' }, signal: AbortSignal.timeout(5_000), redirect: 'error' });
    if (response.status === 404) level = null;
    else if (response.ok) { const { user } = await response.json(); level = user?.suspended_at ? null : user?.admin_level ?? null; }
    else throw new Error(`HTTP ${response.status}`);
  } catch (err) {
    request.log.warn({ err: err.message }, 'ward level check failed; using the session level');
    return session.level;
  }
  levels.set(session.sub, { level, at: Date.now() });
  return level;
}

export function requireOwner(request) {
  if (request.level !== 'owner') throw Object.assign(new Error('Only owners can do that.'), { statusCode: 403 });
}

// Every /api route needs a session. Anything that changes state also needs the
// per-session CSRF token and a same-origin request.
export async function guard(request, reply) {
  const session = readSession(request);
  if (!session) return reply.code(401).send({ error: 'Sign in to continue.' });
  const level = await liveLevel(request, session);
  if (!CONSOLE_LEVELS.includes(level)) {
    reply.clearCookie(SESSION_COOKIE, { ...cookieOptions, sameSite: 'strict' });
    return reply.code(401).send({ error: 'Your admin access has changed. Sign in again.' });
  }
  request.session = session;
  request.level = level;
  if (!['GET', 'HEAD'].includes(request.method)) {
    const origin = request.headers.origin;
    if (origin && origin !== config.origin) return reply.code(403).send({ error: 'Origin not allowed.' });
    if (!equal(request.headers['x-telescreen-csrf'], session.csrf)) return reply.code(403).send({ error: 'Reload the page and try again.' });
  }
}
