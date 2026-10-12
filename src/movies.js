import { config } from './config.js';
import { audit } from './audit.js';
import { requireOwner } from './auth.js';

// The home movie player's allowlist (who's let past its Ward sign-in). Owner only, both ways: reading the
// list and changing it. The player itself is the source of truth; this just calls its /internal/allowlist.
const enabled = () => Boolean(config.movies.url && config.movies.key);

async function call(method, qs) {
  if (!enabled()) { const e = new Error('Set MOVIES_URL and MOVIES_ADMIN_KEY to manage the movies allowlist'); e.statusCode = 503; throw e; }
  const response = await fetch(`${config.movies.url}/internal/allowlist${qs || ''}`, {
    method,
    headers: { Authorization: `Bearer ${config.movies.key}`, Accept: 'application/json' },
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) { const e = new Error(`Movies: HTTP ${response.status}`); e.statusCode = response.status >= 500 ? 502 : response.status; throw e; }
  return data;
}

export async function moviesRoutes(app) {
  app.get('/api/movies', async () => ({ enabled: enabled() }));

  app.get('/api/movies/allowlist', async request => {
    requireOwner(request);
    return { emails: await call('GET') };
  });

  app.post('/api/movies/allowlist', async request => {
    requireOwner(request);
    const email = String(request.body?.email || '').trim().toLowerCase();
    if (!email || !email.includes('@') || email.length > 200) { const e = new Error('Give a valid email'); e.statusCode = 400; throw e; }
    const response = await fetch(`${config.movies.url}/internal/allowlist`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.movies.key}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ email }),
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) { const e = new Error(data?.error || `Movies: HTTP ${response.status}`); e.statusCode = response.status >= 500 ? 502 : response.status; throw e; }
    audit(request, 'movies.allowlist_add', { email });
    return { emails: data };
  });

  app.delete('/api/movies/allowlist', async request => {
    requireOwner(request);
    const email = String(request.query?.email || '').trim().toLowerCase();
    if (!email) { const e = new Error('Give an email'); e.statusCode = 400; throw e; }
    const emails = await call('DELETE', `?email=${encodeURIComponent(email)}`);
    audit(request, 'movies.allowlist_remove', { email });
    return { emails };
  });
}
