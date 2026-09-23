import { config } from './config.js';

// Plain uptime pings for whatever TELESCREEN_HTTP_* points at (usually /health endpoints).
export async function httpRoutes(app) {
  app.get('/api/http', async () => Promise.all(config.http.map(async ({ name, url }) => {
    const started = performance.now();
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(6000), redirect: 'manual', headers: { 'User-Agent': 'DeltaVDevs-Telescreen' } });
      const text = (await response.text()).slice(0, 500);
      return { name, url, ok: response.ok, status: response.status, ms: Math.round(performance.now() - started), body: text };
    } catch (err) {
      return { name, url, ok: false, status: null, ms: Math.round(performance.now() - started), body: err.cause?.code || err.message };
    }
  })));
}
