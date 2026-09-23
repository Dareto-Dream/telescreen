import { config } from './config.js';
import { SESSION_COOKIE, OAUTH_COOKIE, cookieOptions, seal, unseal, token, challenge, equal, isAdmin, readSession } from './session.js';
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
  if (!response.ok) throw new Error(`Google responded ${response.status}`);
  return body;
}

const bounce = (reply, message) => {
  reply.clearCookie(OAUTH_COOKIE, cookieOptions);
  return reply.redirect(`/?error=${encodeURIComponent(message)}`);
};

export async function authRoutes(app) {
  app.get('/auth/google/start', async (request, reply) => {
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
    const csrf = token();
    reply.clearCookie(OAUTH_COOKIE, cookieOptions);
    reply.setCookie(SESSION_COOKIE, seal('session', { email, name: String(profile.name || email).slice(0, 80), picture: typeof profile.picture === 'string' ? profile.picture : null, csrf }, config.sessionHours * 3600), {
      ...cookieOptions,
      sameSite: 'strict',
      maxAge: config.sessionHours * 3600,
    });
    audit(request, 'auth.login', { email });
    return reply.redirect('/');
  });

  app.post('/auth/logout', async (request, reply) => {
    const session = readSession(request);
    if (session) audit(request, 'auth.logout', { email: session.email });
    reply.clearCookie(SESSION_COOKIE, { ...cookieOptions, sameSite: 'strict' });
    return { ok: true };
  });
}

// Every /api route needs a session. Anything that changes state also needs the
// per-session CSRF token and a same-origin request.
export async function guard(request, reply) {
  const session = readSession(request);
  if (!session) return reply.code(401).send({ error: 'Sign in to continue.' });
  request.session = session;
  if (!['GET', 'HEAD'].includes(request.method)) {
    const origin = request.headers.origin;
    if (origin && origin !== config.origin) return reply.code(403).send({ error: 'Origin not allowed.' });
    if (!equal(request.headers['x-telescreen-csrf'], session.csrf)) return reply.code(403).send({ error: 'Reload the page and try again.' });
  }
}
