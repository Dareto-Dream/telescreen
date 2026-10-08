// Journeyman: Season applications and bans. Applications and application bans are stored by DeltaVDevs Forms;
// whitelisting and in-game bans run on the server through Harbor's console. The server side builds every
// command from validated fields, so nothing typed here reaches the console as-is.

const TABS = [['applicants', 'Applicants', '#/journeyman/applicants'], ['season', 'Season', '#/journeyman/season'], ['server', 'Server', '#/journeyman/server'], ['bans', 'Bans', '#/journeyman/bans']];
const KIND = { season_start: 'Season start', border: 'Border expansion', pregen: 'Pregenerate', announce: 'Announcement' };
const EVENT_STATUS = { pending: ['scheduled', 'yellow'], running: ['running', 'yellow'], done: ['done', 'green'], failed: ['failed', 'red'], cancelled: ['cancelled', 'muted'] };
const FILTERS = [['pending', 'Waiting'], ['approved', 'Accepted'], ['rejected', 'Not accepted'], ['all', 'All']];
const STATUS = { pending: ['Waiting', 'yellow'], approved: ['Accepted', 'green'], rejected: ['Not accepted', 'muted'] };

export function register({ route, api, h, mount, head, toast, fail, confirmBox, ago, me }) {
  const tabs = active => h('div', { class: 'tabs' }, TABS.map(([id, text, href]) => h('button', { class: active === id ? 'active' : '', onclick: () => { location.hash = href; } }, text)));
  const refresh = () => window.dispatchEvent(new HashChangeEvent('hashchange'));
  const utc = sqlite => `${String(sqlite).replace(' ', 'T')}Z`;
  const pill = status => { const [text, color] = STATUS[status] || [status, 'muted']; return h('span', { class: `pill ${color}` }, text); };
  const field = (label, el, hint) => h('label', {}, h('span', {}, label, hint ? h('span', { class: 'hint' }, ` ${hint}`) : null), el);
  // A console result rides along with a saved decision; show it, but a failure there doesn't undo the decision.
  const report = (what, result) => {
    if (!result) return;
    if (result.error) toast(`${what}: ${result.error}`, true);
    else toast(`${what}: ${result.output || result.command}`);
  };

  async function status(title) {
    const s = await api('GET', '/api/journeyman');
    if (!s.forms) { mount(head('journeyman', title), h('div', { class: 'notice warn' }, 'Set FORMS_API_URL and FORMS_INTERNAL_SECRET on telescreen to manage Journeyman from here.')); return null; }
    return s;
  }
  const serverLine = s => {
    if (!s.server) return h('div', { class: 'notice warn ward-gap-below' }, 'HARBOR_TOKEN is not set, so accepting does not whitelist and in-game bans are off.');
    if (s.serverError) return h('div', { class: 'notice error ward-gap-below' }, `Server: ${s.serverError}`);
    return h('p', { class: 'caption ward-sub' }, `Server ${s.service?.state || 'unknown'}${s.players ? ` · ${s.players}` : ''}`);
  };

  // ---------------- applicants ----------------
  route(/^\/journeyman(?:\/applicants)?(?:\?filter=(\w+))?$/, async filter => {
    const s = await status('Applicants'); if (!s) return;
    const active = FILTERS.some(([f]) => f === filter) ? filter : 'pending';
    const { applicants } = await api('GET', '/api/journeyman/applicants');
    const count = f => (f === 'all' ? applicants.length : applicants.filter(a => a.status === f).length);
    // Oldest first: the same order as each applicant's place in line on their dashboard.
    const rows = active === 'all' ? applicants : applicants.filter(a => a.status === active);

    const decide = async (a, next) => {
      try {
        const r = await api('POST', `/api/journeyman/applicants/${encodeURIComponent(a.id)}/decision`, { status: next });
        toast(`${a.answers.username}: ${STATUS[next][0].toLowerCase()}`);
        report('Whitelist', r.whitelist);
        refresh();
      } catch (e) { fail(e); }
    };

    const ban = a => {
      const reason = h('input', { placeholder: 'reason (shown in game and kept with the ban)', maxlength: '200' });
      const inGame = h('input', { type: 'checkbox', checked: true });
      const duration = h('input', { placeholder: 'perm, 7d, 12h…', value: 'perm' });
      const go = h('button', { class: 'danger', type: 'button' }, 'Ban');
      const dialog = h('dialog', {},
        h('p', { class: 'eyebrow' }, 'ban applicant'),
        h('p', { class: 'subheadline' }, `${a.answers.username}${a.ward_email ? ` (${a.ward_email})` : ''}`),
        h('p', { class: 'caption' }, 'Their Ward account and Minecraft name can no longer apply, and the application is marked not accepted. If they were whitelisted, they are taken off.'),
        h('div', { class: 'stack' }, field('Reason', reason), h('label', { class: 'check' }, inGame, h('span', {}, 'Also ban in game')), field('In-game length', duration)),
        h('div', { class: 'row end spaced' }, h('button', { class: 'outline', type: 'button', onclick: () => dialog.close() }, 'Cancel'), go));
      go.addEventListener('click', async () => {
        go.disabled = true;
        try {
          const r = await api('POST', `/api/journeyman/applicants/${encodeURIComponent(a.id)}/ban`, { reason: reason.value, inGame: inGame.checked, duration: duration.value.trim() === 'perm' ? '' : duration.value.trim() });
          toast(`${a.answers.username} banned from applying`);
          report('Whitelist', r.whitelist); report('In-game ban', r.inGame);
          dialog.close(); refresh();
        } catch (e) { go.disabled = false; fail(e); }
      });
      dialog.addEventListener('close', () => dialog.remove());
      document.body.append(dialog);
      dialog.showModal();
      reason.focus();
    };

    const card = a => {
      const late = a.season !== a.currentSeason;
      const answers = Object.entries(a.answers).filter(([k]) => !['username', 'edition', 'rules'].includes(k) && a.answers[k] !== '' && a.answers[k] !== false);
      return h('div', { class: 'card tight' },
        h('div', { class: 'row spaced' },
          h('h3', {}, a.answers.username || '(no name)', ' ', h('span', { class: 'caption' }, a.answers.edition === 'bedrock' ? 'Bedrock' : 'Java')),
          h('div', { class: 'row' }, a.banned ? h('span', { class: 'pill red' }, 'banned') : null, h('span', { class: 'pill muted' }, `Season ${a.season}`), pill(a.status))),
        h('dl', { class: 'stat' },
          h('dt', {}, 'Ward'), h('dd', {}, a.ward_sub ? `${a.ward_name || ''}${a.ward_email ? ` · ${a.ward_email}` : ''}` : 'not linked (sent before Ward was required)'),
          h('dt', {}, 'Applied'), h('dd', { title: new Date(utc(a.created_at)).toLocaleString() }, ago(utc(a.created_at)))),
        answers.length ? h('details', { class: 'ward-gap' }, h('summary', {}, 'Answers'), h('dl', { class: 'stat' }, answers.flatMap(([k, v]) => [h('dt', {}, k), h('dd', { class: 'wrap' }, String(v))]))) : null,
        late && a.status === 'pending' ? h('p', { class: 'caption ward-gap' }, `Applied after the Season ${a.currentSeason} window. Accepting does not whitelist them now.`) : null,
        h('div', { class: 'row ward-gap-above' },
          a.status !== 'approved' ? h('button', { class: 'cta small', onclick: () => decide(a, 'approved') }, late ? `Accept for Season ${a.season}` : 'Accept + whitelist') : null,
          a.status !== 'rejected' ? h('button', { class: 'outline small', onclick: async () => { if (await confirmBox(`Mark ${a.answers.username} as not accepted?${a.status === 'approved' ? ' They come off the whitelist.' : ''}`)) decide(a, 'rejected'); } }, 'Not accepted') : null,
          a.status !== 'pending' ? h('button', { class: 'ghost small', onclick: () => decide(a, 'pending') }, 'Back to waiting') : null,
          h('button', { class: 'ghost small danger-text', onclick: () => ban(a) }, 'Ban')));
    };

    mount(
      head('journeyman', 'Applicants', h('button', { class: 'outline small', onclick: refresh }, 'Refresh')),
      serverLine(s),
      tabs('applicants'),
      h('div', { class: 'row ward-gap-below' }, FILTERS.map(([f, label]) => h('button', { class: f === active ? 'cta small' : 'outline small', onclick: () => { location.hash = `#/journeyman/applicants?filter=${f}`; } }, `${label} (${count(f)})`))),
      rows.length ? h('div', { class: 'stack' }, rows.map(card)) : h('p', { class: 'empty' }, 'Nobody here.'),
    );
  });

  // ---------------- bans ----------------
  route(/^\/journeyman\/bans$/, async () => {
    const s = await status('Bans'); if (!s) return;
    const [appBans, serverBans] = await Promise.all([
      api('GET', '/api/journeyman/bans/applications').then(r => r.bans),
      api('GET', '/api/journeyman/bans/server').catch(e => ({ error: e.message })),
    ]);

    // In game
    const player = h('input', { placeholder: 'player name (.name for Bedrock)', maxlength: '17', autocomplete: 'off' });
    const duration = h('input', { placeholder: 'perm, 7d, 12h…', value: 'perm' });
    const reason = h('input', { placeholder: 'reason', maxlength: '200' });
    const banForm = h('form', { class: 'card form' },
      field('Player', player), field('Length', duration), h('div', { class: 'wide' }, field('Reason', reason)),
      h('div', { class: 'wide row end' }, h('button', { class: 'danger', type: 'submit', disabled: !s.server }, 'Ban in game')));
    banForm.addEventListener('submit', async e => {
      e.preventDefault();
      if (!player.value.trim()) return player.focus();
      try {
        const r = await api('POST', '/api/journeyman/bans/server', { player: player.value.trim(), duration: duration.value.trim() === 'perm' ? '' : duration.value.trim(), reason: reason.value });
        toast(r.output || `Sent: ${r.command}`); refresh();
      } catch (err) { fail(err); }
    });
    const lift = async name => {
      try { const r = await api('DELETE', `/api/journeyman/bans/server/${encodeURIComponent(name)}`); toast(r.output || `Sent: unban ${name}`); refresh(); } catch (err) { fail(err); }
    };
    const unbanName = h('input', { placeholder: 'any player name', maxlength: '17', autocomplete: 'off' });
    const unban = h('form', { class: 'row' }, unbanName, h('button', { class: 'outline', type: 'submit', disabled: !s.server }, 'Unban'));
    unban.addEventListener('submit', e => {
      e.preventDefault();
      if (!unbanName.value.trim()) return unbanName.focus();
      lift(unbanName.value.trim());
    });
    const records = serverBans?.bans || [];
    const serverTable = serverBans?.error ? h('div', { class: 'notice error' }, serverBans.error)
      : records.length ? h('div', { class: 'table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, ['Player', 'Length', 'Reason', 'By', 'When', ''].map(c => h('th', {}, c)))),
        h('tbody', {}, records.map(b => h('tr', {},
          h('td', { class: 'mono' }, b.player), h('td', {}, b.duration || 'perm'), h('td', {}, b.reason || '—'), h('td', {}, b.created_by || '—'),
          h('td', {}, ago(utc(b.created_at))),
          h('td', { class: 'actions' }, b.lifted_at ? h('span', { class: 'pill muted', title: `by ${b.lifted_by || '—'}` }, `lifted ${ago(utc(b.lifted_at))}`)
            : h('button', { class: 'ghost', disabled: !s.server, onclick: async () => { if (await confirmBox(`Unban ${b.player}?`, { danger: false })) lift(b.player); } }, 'unban')))))))
        : h('p', { class: 'empty' }, 'No bans issued from here yet.');

    // Applications
    const kind = h('select', {}, h('option', { value: 'username' }, 'Minecraft username'), h('option', { value: 'ward' }, 'Ward account id'));
    const value = h('input', { placeholder: 'name or Ward id', maxlength: '200', autocomplete: 'off' });
    const appReason = h('input', { placeholder: 'reason (staff only)', maxlength: '500' });
    const appForm = h('form', { class: 'card form' },
      field('Block', kind), field('Value', value), h('div', { class: 'wide' }, field('Reason', appReason)),
      h('div', { class: 'wide row end' }, h('button', { class: 'danger', type: 'submit' }, 'Block from applying')));
    appForm.addEventListener('submit', async e => {
      e.preventDefault();
      if (!value.value.trim()) return value.focus();
      try { await api('POST', '/api/journeyman/bans/applications', { kind: kind.value, value: value.value.trim(), reason: appReason.value }); toast('Blocked'); refresh(); } catch (err) { fail(err); }
    });
    const appTable = appBans.length
      ? h('div', { class: 'table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, ['Kind', 'Value', 'Reason', 'By', 'When', ''].map(c => h('th', {}, c)))),
        h('tbody', {}, appBans.map(b => h('tr', {},
          h('td', {}, b.kind === 'ward' ? 'Ward account' : 'Username'), h('td', { class: 'mono' }, b.value), h('td', {}, b.reason || '—'), h('td', {}, b.created_by || '—'),
          h('td', {}, ago(utc(b.created_at))),
          h('td', { class: 'actions' }, h('button', { class: 'ghost', onclick: async () => {
            if (!await confirmBox(`Let ${b.value} apply again?`, { danger: false })) return;
            try { await api('DELETE', `/api/journeyman/bans/applications/${encodeURIComponent(b.id)}`); toast('Unblocked'); refresh(); } catch (err) { fail(err); }
          } }, 'remove')))))))
      : h('p', { class: 'empty' }, 'Nobody is blocked from applying.');

    mount(
      head('journeyman', 'Bans', h('button', { class: 'outline small', onclick: refresh }, 'Refresh')),
      serverLine(s),
      tabs('bans'),
      h('h2', { class: 'subheadline' }, 'In game'),
      h('p', { class: 'caption' }, 'Runs LibertyBans on the server. Bans by name; Bedrock players are .name.'),
      banForm,
      h('div', { class: 'stack ward-gap-above' },
        h('p', { class: 'caption' }, 'Bans issued from Telescreen. Bans made in game or from Discord are not listed; unban those by name.'),
        serverTable, unban),
      h('h2', { class: 'subheadline ward-gap-above' }, 'Applications'),
      h('p', { class: 'caption' }, 'Blocked Ward accounts and Minecraft names get "You can not submit this form." on the Season form.'),
      appForm,
      h('div', { class: 'ward-gap-above' }, appTable),
    );
  });

  // mount() hands its arguments straight to replaceChildren, so leave out the empty (null) slots.
  const show = (...nodes) => mount(...nodes.filter(Boolean));

  // ---------------- season ----------------
  // Times are entered in this browser's timezone and stored as UTC; Hawaii time is shown alongside because
  // that is how the season is announced.
  const hst = iso => new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'Pacific/Honolulu' }).format(new Date(iso)) + ' HST';
  const localInput = iso => { const d = new Date(iso); return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16); };
  const fromInput = v => new Date(v).toISOString();
  const until = iso => {
    const s = Math.round((Date.parse(iso) - Date.now()) / 1000);
    if (s <= 0) return 'now';
    const d = Math.floor(s / 86400), hr = Math.floor(s / 3600) % 24, m = Math.floor(s / 60) % 60;
    return d ? `in ${d}d ${hr}h` : hr ? `in ${hr}h ${m}m` : `in ${m}m`;
  };
  const num = n => (n === null || n === undefined ? '—' : Number(n).toLocaleString('en-US', { maximumFractionDigits: 1 }));

  function eventDialog(existing, onSave) {
    const kind = h('select', {}, Object.entries(KIND).map(([k, label]) => h('option', { value: k }, label)));
    kind.value = existing?.kind || 'border';
    const at = h('input', { type: 'datetime-local', value: existing ? localInput(existing.at) : localInput(new Date(Date.now() + 3_600_000).toISOString()) });
    const radius = h('input', { type: 'number', min: '16', step: '500', value: existing?.radius ?? '' , placeholder: 'blocks from spawn' });
    const message = h('textarea', { maxlength: '1800', placeholder: 'Leave empty to use the standard text for season starts and border expansions.' }, existing?.message || '');
    const ping = h('input', { type: 'checkbox', checked: Boolean(existing?.ping) });
    const save = h('button', { class: 'cta', type: 'button' }, existing ? 'Save' : 'Add to schedule');
    const dialog = h('dialog', {},
      h('p', { class: 'eyebrow' }, existing ? 'edit event' : 'new event'),
      h('div', { class: 'stack' },
        field('What', kind), field('When', at, `(your time; ${Intl.DateTimeFormat().resolvedOptions().timeZone})`),
        field('Border', radius, '(blocks from spawn; not used by announcements)'),
        field('Message', message, '(posted to Discord and said in game)'),
        h('label', { class: 'check' }, ping, h('span', {}, 'Ping @everyone'))),
      h('div', { class: 'row end spaced' }, h('button', { class: 'outline', type: 'button', onclick: () => dialog.close() }, 'Cancel'), save));
    save.addEventListener('click', async () => {
      if (!at.value) return at.focus();
      const body = { kind: kind.value, at: fromInput(at.value), message: message.value.trim(), ping: ping.checked };
      if (radius.value !== '') body.radius = Number(radius.value);
      if (existing?.status && existing.status !== 'pending') body.requeue = true;
      save.disabled = true;
      try { await onSave(body); dialog.close(); } catch (e) { save.disabled = false; fail(e); }
    });
    dialog.addEventListener('close', () => dialog.remove());
    document.body.append(dialog);
    dialog.showModal();
  }

  route(/^\/journeyman\/season$/, async () => {
    const s = await status('Season'); if (!s) return;
    if (!s.site) { mount(head('journeyman', 'Season'), tabs('season'), h('div', { class: 'notice warn' }, 'Set JOURNEYMAN_ADMIN_KEY on telescreen to manage the season from here.')); return; }
    const v = await api('GET', '/api/journeyman/season');
    const st = v.settings;

    const launch = h('input', { type: 'datetime-local', value: localInput(st.launchAt) });
    const seasonNo = h('input', { type: 'number', min: '1', value: st.season });
    const windowDays = h('input', { type: 'number', min: '0', max: '180', value: st.windowDays });
    const startRadius = h('input', { type: 'number', min: '16', step: '500', value: st.startRadius });
    const growSeconds = h('input', { type: 'number', min: '0', max: '86400', value: st.growSeconds });
    const shift = h('input', { type: 'checkbox', checked: true });
    const settingsForm = h('form', { class: 'card form' },
      field('Launch', launch, `(your time · ${hst(st.launchAt)})`), field('Season number', seasonNo),
      field('Onboarding window (days)', windowDays, `(closes ${hst(v.cutoff)})`), field('Starting border', startRadius, '(blocks from spawn)'),
      field('Border grows over (seconds)', growSeconds),
      h('label', { class: 'check wide' }, shift, h('span', {}, 'Move every scheduled event by the same amount when the launch moves')),
      h('div', { class: 'wide row end' }, h('button', { class: 'cta', type: 'submit' }, 'Save season settings')));
    settingsForm.addEventListener('submit', async e => {
      e.preventDefault();
      const body = { launchAt: fromInput(launch.value), season: Number(seasonNo.value), windowDays: Number(windowDays.value), startRadius: Number(startRadius.value), growSeconds: Number(growSeconds.value), shiftSchedule: shift.checked };
      if (body.launchAt !== new Date(st.launchAt).toISOString() && !await confirmBox(`Move the launch to ${hst(body.launchAt)}? The site countdown changes right away.`, { danger: false })) return;
      try { await api('PUT', '/api/journeyman/season/settings', body); toast('Season settings saved'); refresh(); } catch (err) { fail(err); }
    });

    const act = (label, fn) => async () => { try { await fn(); refresh(); } catch (err) { fail(err); } };
    const rows = v.events.map(e => {
      const [text, color] = EVENT_STATUS[e.status] || [e.status, 'muted'];
      return h('tr', {},
        h('td', { title: new Date(e.at).toLocaleString() }, hst(e.at), h('br'), h('span', { class: 'caption' }, e.status === 'pending' ? until(e.at) : e.ran_at ? `ran ${ago(e.ran_at)}` : '')),
        h('td', {}, KIND[e.kind] || e.kind, e.ping ? h('span', { class: 'caption' }, ' · @everyone') : null),
        h('td', { class: 'mono' }, e.radius ? num(e.radius) : '—'),
        h('td', { class: 'wrap' }, e.message || h('span', { class: 'caption' }, e.kind === 'pregen' ? 'no announcement' : 'standard text')),
        h('td', {}, h('span', { class: `pill ${color}`, title: e.result || '' }, text), e.result && e.status !== 'pending' ? h('div', { class: 'caption wrap' }, e.result) : null),
        h('td', { class: 'actions' },
          h('button', { class: 'ghost', onclick: async () => { if (await confirmBox(`Run "${KIND[e.kind]}" now? It does everything it would at its scheduled time.`)) act('', async () => { await api('POST', `/api/journeyman/season/events/${e.id}/run`); toast('Ran it'); })(); } }, 'run now'),
          h('button', { class: 'ghost', onclick: () => eventDialog(e, async body => { await api('PATCH', `/api/journeyman/season/events/${e.id}`, body); toast('Saved'); refresh(); }) }, 'edit'),
          e.status === 'pending' ? h('button', { class: 'ghost', onclick: act('', () => api('PATCH', `/api/journeyman/season/events/${e.id}`, { cancel: true })) }, 'cancel') : null,
          h('button', { class: 'ghost', onclick: async () => { if (await confirmBox('Delete this event?')) act('', () => api('DELETE', `/api/journeyman/season/events/${e.id}`))(); } }, 'delete')));
    });

    const annText = h('textarea', { maxlength: '1800', placeholder: 'Posted to the announcements channel and said in game' });
    const annPing = h('input', { type: 'checkbox' });
    const annForm = h('form', { class: 'card form' }, h('div', { class: 'wide' }, field('Announce now', annText)),
      h('label', { class: 'check' }, annPing, h('span', {}, 'Ping @everyone')),
      h('div', { class: 'row end' }, h('button', { class: 'outline', type: 'submit', disabled: !v.webhookConfigured }, 'Post')));
    annForm.addEventListener('submit', async e => {
      e.preventDefault();
      if (!annText.value.trim()) return annText.focus();
      try { await api('POST', '/api/journeyman/announce', { message: annText.value.trim(), ping: annPing.checked }); toast('Posted'); annText.value = ''; } catch (err) { fail(err); }
    });

    show(
      head('journeyman', 'Season', h('button', { class: 'cta small', onclick: () => eventDialog(null, async body => { await api('POST', '/api/journeyman/season/events', body); toast('Added'); refresh(); }) }, 'Add event'), h('button', { class: 'outline small', onclick: refresh }, 'Refresh')),
      h('p', { class: 'caption ward-sub' }, `Season ${st.season} launches ${hst(st.launchAt)} (${until(st.launchAt)}) · border ${v.border ? `${num(v.border)} blocks` : 'not set yet'}${v.nextBorder ? ` · next expansion to ${num(v.nextBorder.radius)} ${until(v.nextBorder.at)}` : ''}`),
      tabs('season'),
      !v.serverConfigured ? h('div', { class: 'notice warn ward-gap-below' }, 'The Journeyman site has no HARBOR_TOKEN, so scheduled events cannot reach the server.') : null,
      !v.webhookConfigured ? h('div', { class: 'notice warn ward-gap-below' }, 'The Journeyman site has no DISCORD_ANNOUNCE_WEBHOOK, so nothing is posted to Discord.') : null,
      settingsForm,
      h('h2', { class: 'subheadline ward-gap-above' }, 'Schedule'),
      h('p', { class: 'caption' }, 'Checked every 30 seconds. A season start starts the server if needed, sets the border and turns the whitelist on. A border expansion grows the border. Pregenerate runs Chunky out to that radius so the new land is ready.'),
      rows.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'events' }, h('thead', {}, h('tr', {}, ['When', 'What', 'Border', 'Message', 'Status', ''].map(c => h('th', {}, c)))), h('tbody', {}, rows))) : h('p', { class: 'empty' }, 'Nothing scheduled.'),
      h('div', { class: 'ward-gap-above' }, annForm),
    );
  });

  // ---------------- server ----------------
  // One small SVG line per series; sizes go through attributes because the CSP blocks inline styles.
  function chart(points, key, label, max) {
    const W = 600, H = 90, vals = points.map(p => p[key]);
    const real = vals.filter(v => v !== null && v !== undefined);
    const top = max ?? Math.max(1, ...real);
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`); svg.setAttribute('class', 'spark'); svg.setAttribute('preserveAspectRatio', 'none');
    let d = '', pen = false;
    vals.forEach((v, i) => {
      if (v === null || v === undefined) { pen = false; return; }
      const x = points.length > 1 ? (i / (points.length - 1)) * W : W / 2, y = H - 4 - (Math.min(v, top) / top) * (H - 8);
      d += `${pen ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)} `; pen = true;
    });
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', d.trim() || 'M0,0'); path.setAttribute('fill', 'none'); path.setAttribute('stroke', 'currentColor'); path.setAttribute('stroke-width', '2'); path.setAttribute('vector-effect', 'non-scaling-stroke');
    svg.append(path);
    const last = real.length ? real[real.length - 1] : null;
    return h('div', { class: 'card tight' }, h('h3', {}, label), h('p', { class: 'caption' }, real.length ? `now ${num(last)} · high ${num(Math.max(...real))}` : 'no data yet'), svg);
  }

  route(/^\/journeyman\/server(?:\?hours=(\d+))?$/, async hoursParam => {
    const s = await status('Server'); if (!s) return;
    const hours = Number(hoursParam) || 24;
    const stats = s.site ? await api('GET', `/api/journeyman/stats?hours=${hours}`).catch(e => ({ error: e.message })) : null;
    const c = stats?.current || {};
    const state = s.service?.state || c.state || 'unknown';
    const action = (name, confirmText) => h('button', { class: name === 'start' ? 'cta' : 'outline', disabled: !s.server, onclick: async e => {
      if (confirmText && !await confirmBox(confirmText)) return;
      e.currentTarget.disabled = true;
      toast(name === 'start' ? 'Starting…' : 'Waiting for the server to save and exit…');
      try { await api('POST', `/api/journeyman/server/${name}`); toast(`Server ${name === 'stop' ? 'stopped' : name === 'start' ? 'started' : 'restarted'}`); setTimeout(refresh, 1500); } catch (err) { fail(err); refresh(); }
    } }, name[0].toUpperCase() + name.slice(1));

    const isOwner = me()?.level === 'owner';
    const cmd = h('input', { placeholder: 'any server command, e.g. list', class: 'mono', autocomplete: 'off', maxlength: '1000' });
    const out = h('pre', { class: 'log', hidden: true });
    const consoleForm = h('form', { class: 'row' }, cmd, h('button', { class: 'outline', type: 'submit' }, 'Run'));
    consoleForm.addEventListener('submit', async e => {
      e.preventDefault();
      if (!cmd.value.trim()) return cmd.focus();
      try { const r = await api('POST', '/api/journeyman/console', { command: cmd.value.trim() }); out.textContent = `> ${cmd.value.trim()}\n${r.output || '(no reply; some plugins answer in game only)'}`; out.hidden = false; cmd.value = ''; } catch (err) { fail(err); }
    });

    const points = stats?.samples || [];
    show(
      head('journeyman', 'Server', h('button', { class: 'outline small', onclick: refresh }, 'Refresh')),
      serverLine(s),
      tabs('server'),
      h('div', { class: 'row ward-gap-below' }, state === 'running' ? null : action('start'), action('restart', 'Restart the server? Players are disconnected while it saves and comes back.'), state === 'running' ? action('stop', 'Stop the server? It saves first. Nobody can play until it is started again.') : null),
      stats?.error ? h('div', { class: 'notice error' }, stats.error) : null,
      h('div', { class: 'grid' },
        h('div', { class: 'card tight' }, h('h3', {}, 'Now'), h('dl', { class: 'stat' },
          h('dt', {}, 'state'), h('dd', {}, state),
          h('dt', {}, 'uptime'), h('dd', {}, s.service?.uptime_s ? `${Math.floor(s.service.uptime_s / 3600)}h ${Math.floor(s.service.uptime_s / 60) % 60}m` : '—'),
          h('dt', {}, 'players'), h('dd', {}, c.players !== null && c.players !== undefined ? `${c.players} / ${c.max_players}` : '—'),
          h('dt', {}, 'TPS'), h('dd', {}, c.tps !== null && c.tps !== undefined ? c.tps.toFixed(1) : '—'),
          h('dt', {}, 'CPU'), h('dd', {}, c.cpu !== null && c.cpu !== undefined ? `${c.cpu.toFixed(1)}%` : '—'),
          h('dt', {}, 'memory'), h('dd', {}, c.mem_mb ? `${(c.mem_mb / 1024).toFixed(1)} GB` : '—'))),
        chart(points, 'players', 'Players', null),
        chart(points, 'tps', 'TPS', 20),
        chart(points, 'cpu', 'CPU %', 100)),
      h('div', { class: 'row ward-gap-above' }, [[24, 'Last day'], [168, 'Last week'], [720, 'Last 30 days']].map(([n, label]) => h('button', { class: n === hours ? 'cta small' : 'outline small', onclick: () => { location.hash = `#/journeyman/server?hours=${n}`; } }, label))),
      h('p', { class: 'caption' }, 'Sampled every 5 minutes by the Journeyman site.'),
      isOwner ? h('div', { class: 'stack ward-gap-above' }, h('h2', { class: 'subheadline' }, 'Console'), h('p', { class: 'caption' }, 'Owners only. Every command is written to the audit log here and in Harbor.'), consoleForm, out) : null,
    );
  });
}
