import { config } from './config.js';
import { audit } from './audit.js';
import { actorOf } from './session.js';
import { requireOwner } from './auth.js';

// Journeyman (the Minecraft season server). Two upstreams:
//  - DeltaVDevs Forms holds the applications and the application bans, over its /internal API (FORMS_INTERNAL_SECRET).
//  - Harbor on the server's machine runs console commands on the minecraft service over RCON (HARBOR_TOKEN, admin
//    scope). That is how accepting someone whitelists them and how in-game bans and unbans happen.
// Every command sent to the server is built here from validated pieces; nothing typed in the UI is passed through raw.
const j = config.journeyman;
const formsOn = () => Boolean(j.formsUrl && j.formsSecret);
const serverOn = () => Boolean(j.harborUrl && j.harborToken);
const siteOn = () => Boolean(j.siteUrl && j.siteKey);

// Java names are 3-16 of [A-Za-z0-9_]; Floodgate shows Bedrock players with a leading dot.
const PLAYER = /^\.?[A-Za-z0-9_]{1,16}$/;
const DURATION = /^(\d{1,4}(s|m|h|d|w|mo|y)|perm)$/;
const oneLine = (s, max) => String(s ?? '').replace(/[\r\n\0]/g, ' ').trim().slice(0, max);

function upstreamError(where, response, data) {
  const e = new Error(`${where}: ${data?.error || `HTTP ${response.status}`}`);
  e.statusCode = response.status === 401 || response.status >= 500 ? 502 : response.status;
  return e;
}

async function forms(method, path, body) {
  if (!formsOn()) { const e = new Error('Set FORMS_API_URL and FORMS_INTERNAL_SECRET on telescreen'); e.statusCode = 503; throw e; }
  const response = await fetch(`${j.formsUrl}${path}`, {
    method,
    headers: { Authorization: `Bearer ${j.formsSecret}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw upstreamError('Forms', response, data);
  return data;
}

async function site(method, path, body) {
  if (!siteOn()) { const e = new Error('Set JOURNEYMAN_ADMIN_KEY on telescreen'); e.statusCode = 503; throw e; }
  const response = await fetch(`${j.siteUrl}/admin/v1${path}`, {
    method,
    headers: { Authorization: `Bearer ${j.siteKey}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'error',
    signal: AbortSignal.timeout(240_000),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw upstreamError('Journeyman', response, data);
  return data;
}

// Season number and onboarding cutoff, from the site (cached for a minute). Falls back to Season 1's plan.
let seasonCache = { at: 0, value: null };
async function seasonInfo() {
  if (seasonCache.value && Date.now() - seasonCache.at < 60_000) return seasonCache.value;
  let value = { season: 1, cutoff: '2027-01-22 20:00:00' };
  if (siteOn()) {
    try {
      const s = await site('GET', '/season');
      value = { season: s.settings.season, cutoff: new Date(s.cutoff).toISOString().slice(0, 19).replace('T', ' ') };
    } catch { /* keep the fallback */ }
  }
  seasonCache = { at: Date.now(), value };
  return value;
}

async function harbor(method, path, body) {
  if (!serverOn()) { const e = new Error('Set HARBOR_URL and HARBOR_TOKEN on telescreen'); e.statusCode = 503; throw e; }
  const response = await fetch(`${j.harborUrl}/api/v1${path}`, {
    method,
    headers: { Authorization: `Bearer ${j.harborToken}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'error',
    // A stop or restart waits for the server to save and exit (up to 90s on Harbor's side).
    signal: AbortSignal.timeout(150_000),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw upstreamError('Harbor', response, data);
  return data;
}

const run = async command => (await harbor('POST', `/services/${encodeURIComponent(j.harborService)}/console`, { command })).output;

// Applications sent after the onboarding window count toward the next season (same rule as the Journeyman site).
async function submissions() {
  const [{ submissions: rows }, s] = await Promise.all([forms('GET', `/internal/forms/${j.formSlug}/submissions`), seasonInfo()]);
  return rows.map(r => ({ ...r, season: r.created_at >= s.cutoff ? s.season + 1 : s.season, currentSeason: s.season }));
}

const banCommand = (player, duration, reason) => ['ban', player, duration && duration !== 'perm' ? duration : '', reason].filter(Boolean).join(' ');
// LibertyBans replies asynchronously, so its ban list never comes back over RCON. Forms keeps the record of
// bans issued from here instead.
const recordBan = (player, duration, reason, by) => forms('POST', `/internal/forms/${j.formSlug}/server-bans`, { player, duration: duration || 'perm', reason, created_by: by });

// Floodgate keeps its own whitelist for Bedrock players.
function whitelistCommand(edition, username, add) {
  const name = String(username || '').replace(/^\./, '');
  if (!PLAYER.test(name)) return null;
  return edition === 'bedrock' ? `fwhitelist ${add ? 'add' : 'remove'} ${name}` : `whitelist ${add ? 'add' : 'remove'} ${name}`;
}

// Runs a command and reports instead of throwing, so a decision saved in Forms is never lost to a console hiccup.
async function tryRun(command) {
  if (!command) return { error: 'The username has characters that cannot go in a command. Do this one by hand.' };
  try { return { command, output: await run(command) }; } catch (err) { return { command, error: err.message }; }
}

export async function journeymanRoutes(app) {
  app.get('/api/journeyman', async () => {
    const out = { forms: formsOn(), server: serverOn(), site: siteOn(), formSlug: j.formSlug, ...(await seasonInfo()) };
    if (serverOn()) {
      try {
        const svc = await harbor('GET', `/services/${encodeURIComponent(j.harborService)}`);
        out.service = { state: svc.status?.state, uptime_s: svc.status?.uptime_s, console: svc.console };
        if (svc.status?.state === 'running' && svc.console === 'minecraft-rcon') out.players = await run('list');
      } catch (err) { out.serverError = err.message; }
    }
    return out;
  });

  app.get('/api/journeyman/applicants', async () => ({ applicants: await submissions(), ...(await seasonInfo()) }));

  // ---------- season (launch, schedule, announcements) ----------
  const fresh = data => { seasonCache = { at: 0, value: null }; return data; };
  app.get('/api/journeyman/season', async () => site('GET', '/season'));
  app.put('/api/journeyman/season/settings', async request => {
    const data = fresh(await site('PUT', '/season/settings', request.body || {}));
    audit(request, 'journeyman.season_settings', { changes: Object.keys(request.body || {}) });
    return data;
  });
  app.post('/api/journeyman/season/events', async request => {
    const data = await site('POST', '/season/events', request.body || {});
    audit(request, 'journeyman.event_add', { kind: request.body?.kind, at: request.body?.at });
    return data;
  });
  app.patch('/api/journeyman/season/events/:id', async request => {
    const data = await site('PATCH', `/season/events/${encodeURIComponent(request.params.id)}`, request.body || {});
    audit(request, 'journeyman.event_edit', { id: request.params.id, changes: Object.keys(request.body || {}) });
    return data;
  });
  app.delete('/api/journeyman/season/events/:id', async request => {
    const data = await site('DELETE', `/season/events/${encodeURIComponent(request.params.id)}`);
    audit(request, 'journeyman.event_delete', { id: request.params.id });
    return data;
  });
  app.post('/api/journeyman/season/events/:id/run', async request => {
    const data = await site('POST', `/season/events/${encodeURIComponent(request.params.id)}/run`);
    audit(request, 'journeyman.event_run', { id: request.params.id });
    return data;
  });
  app.post('/api/journeyman/announce', async request => {
    const data = await site('POST', '/announce', { message: request.body?.message, ping: Boolean(request.body?.ping) });
    audit(request, 'journeyman.announce', { ping: Boolean(request.body?.ping) });
    return data;
  });

  // ---------- server ----------
  app.get('/api/journeyman/stats', async request => site('GET', `/stats?hours=${Math.min(Math.max(Number(request.query?.hours) || 24, 1), 720)}`));
  app.post('/api/journeyman/server/:action', async request => {
    const { action } = request.params;
    if (!['start', 'stop', 'restart'].includes(action)) { const e = new Error('Unknown action'); e.statusCode = 404; throw e; }
    await harbor('POST', `/services/${encodeURIComponent(j.harborService)}/${action}`);
    audit(request, `journeyman.server_${action}`, {});
    return { ok: true };
  });
  // Raw console: owners only. Everything else in this file builds its own commands.
  app.post('/api/journeyman/console', async request => {
    requireOwner(request);
    const command = oneLine(request.body?.command, 1000);
    if (!command) { const e = new Error('Type a command'); e.statusCode = 400; throw e; }
    const output = await run(command);
    audit(request, 'journeyman.console', { command: command.slice(0, 200) });
    return { output };
  });

  // Accept / reject / back to pending. Accepting a Season 1 applicant whitelists them; moving an accepted one off
  // "approved" takes them back off the whitelist. Season 2 applicants are only whitelisted when that season opens.
  app.post('/api/journeyman/applicants/:id/decision', async request => {
    const id = String(request.params.id);
    const status = request.body?.status;
    if (!['approved', 'rejected', 'pending'].includes(status)) { const e = new Error('status must be approved, rejected or pending'); e.statusCode = 400; throw e; }
    const row = (await submissions()).find(r => r.id === id);
    if (!row) { const e = new Error('No such application'); e.statusCode = 404; throw e; }
    await forms('PATCH', `/internal/submissions/${encodeURIComponent(id)}`, { status });
    let whitelist = null;
    if (status === 'approved' && row.season === row.currentSeason) whitelist = await tryRun(whitelistCommand(row.answers.edition, row.answers.username, true));
    else if (status !== 'approved' && row.status === 'approved') whitelist = await tryRun(whitelistCommand(row.answers.edition, row.answers.username, false));
    audit(request, 'journeyman.decision', { id, status, username: row.answers.username, whitelist: whitelist?.command || null, whitelistError: whitelist?.error || null });
    return { status, whitelist };
  });

  // Ban an applicant: blocks their Ward account and Minecraft name from applying, rejects the application
  // (unwhitelisting them if they were accepted) and, if asked, bans them in game too.
  app.post('/api/journeyman/applicants/:id/ban', async request => {
    const id = String(request.params.id);
    const reason = oneLine(request.body?.reason, 200);
    const duration = request.body?.duration ? String(request.body.duration) : '';
    if (duration && !DURATION.test(duration)) { const e = new Error('duration looks like 7d, 12h, 2w or perm'); e.statusCode = 400; throw e; }
    const row = (await submissions()).find(r => r.id === id);
    if (!row) { const e = new Error('No such application'); e.statusCode = 404; throw e; }
    const by = actorOf(request.session) || 'telescreen';
    if (row.ward_sub) await forms('POST', `/internal/forms/${j.formSlug}/bans`, { kind: 'ward', value: row.ward_sub, reason, created_by: by });
    if (row.answers.username) await forms('POST', `/internal/forms/${j.formSlug}/bans`, { kind: 'username', value: row.answers.username, reason, created_by: by });
    await forms('PATCH', `/internal/submissions/${encodeURIComponent(id)}`, { status: 'rejected' });
    const whitelist = row.status === 'approved' ? await tryRun(whitelistCommand(row.answers.edition, row.answers.username, false)) : null;
    let inGame = null;
    if (request.body?.inGame) {
      const name = row.answers.edition === 'bedrock' ? `.${String(row.answers.username).replace(/^\./, '')}` : row.answers.username;
      inGame = await tryRun(PLAYER.test(name) ? banCommand(name, duration, reason) : null);
      if (!inGame.error) await recordBan(name, duration, reason, by);
    }
    audit(request, 'journeyman.applicant_ban', { id, username: row.answers.username, inGame: Boolean(request.body?.inGame), reason });
    return { ok: true, whitelist, inGame };
  });

  // ---------- application bans ----------
  app.get('/api/journeyman/bans/applications', async () => forms('GET', `/internal/forms/${j.formSlug}/bans`));
  app.post('/api/journeyman/bans/applications', async request => {
    const kind = request.body?.kind;
    const value = oneLine(request.body?.value, 200);
    if (!['ward', 'username'].includes(kind) || !value) { const e = new Error('Give a kind (ward or username) and a value'); e.statusCode = 400; throw e; }
    const data = await forms('POST', `/internal/forms/${j.formSlug}/bans`, { kind, value, reason: oneLine(request.body?.reason, 500), created_by: actorOf(request.session) || 'telescreen' });
    audit(request, 'journeyman.application_ban', { kind, value });
    return data;
  });
  app.delete('/api/journeyman/bans/applications/:id', async request => {
    const id = String(request.params.id);
    const data = await forms('DELETE', `/internal/forms/${j.formSlug}/bans/${encodeURIComponent(id)}`);
    audit(request, 'journeyman.application_unban', { id });
    return data;
  });

  // ---------- in-game bans (LibertyBans) ----------
  app.get('/api/journeyman/bans/server', async () => forms('GET', `/internal/forms/${j.formSlug}/server-bans`));
  app.post('/api/journeyman/bans/server', async request => {
    const player = String(request.body?.player || '').trim();
    const duration = request.body?.duration ? String(request.body.duration) : '';
    const reason = oneLine(request.body?.reason, 200);
    if (!PLAYER.test(player)) { const e = new Error('Player names are 1-16 letters, digits or _ (Bedrock players start with a dot)'); e.statusCode = 400; throw e; }
    if (duration && !DURATION.test(duration)) { const e = new Error('duration looks like 7d, 12h, 2w or perm'); e.statusCode = 400; throw e; }
    const command = banCommand(player, duration, reason);
    const output = await run(command);
    await recordBan(player, duration, reason, actorOf(request.session) || 'telescreen');
    audit(request, 'journeyman.server_ban', { player, duration: duration || 'perm', reason });
    return { command, output };
  });
  app.delete('/api/journeyman/bans/server/:player', async request => {
    const player = String(request.params.player || '').trim();
    if (!PLAYER.test(player)) { const e = new Error('Not a player name'); e.statusCode = 400; throw e; }
    const output = await run(`unban ${player}`);
    const { lifted } = await forms('POST', `/internal/forms/${j.formSlug}/server-bans/lift`, { player, lifted_by: actorOf(request.session) || 'telescreen' });
    audit(request, 'journeyman.server_unban', { player });
    return { output, lifted };
  });
}
