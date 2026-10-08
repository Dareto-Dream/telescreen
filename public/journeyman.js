// Journeyman: Season applications and bans. Applications and application bans are stored by DeltaVDevs Forms;
// whitelisting and in-game bans run on the server through Harbor's console. The server side builds every
// command from validated fields, so nothing typed here reaches the console as-is.

const TABS = [['applicants', 'Applicants', '#/journeyman/applicants'], ['bans', 'Bans', '#/journeyman/bans']];
const FILTERS = [['pending', 'Waiting'], ['approved', 'Accepted'], ['rejected', 'Not accepted'], ['all', 'All']];
const STATUS = { pending: ['Waiting', 'yellow'], approved: ['Accepted', 'green'], rejected: ['Not accepted', 'muted'] };

export function register({ route, api, h, mount, head, toast, fail, confirmBox, ago }) {
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
        h('div', { class: 'stack' }, field('Reason', reason), h('label', { class: 'row' }, inGame, h('span', {}, 'Also ban in game')), field('In-game length', duration)),
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
      const late = a.season === 2;
      const answers = Object.entries(a.answers).filter(([k]) => !['username', 'edition', 'rules'].includes(k) && a.answers[k] !== '' && a.answers[k] !== false);
      return h('div', { class: 'card tight' },
        h('div', { class: 'row spaced' },
          h('h3', {}, a.answers.username || '(no name)', ' ', h('span', { class: 'caption' }, a.answers.edition === 'bedrock' ? 'Bedrock' : 'Java')),
          h('div', { class: 'row' }, a.banned ? h('span', { class: 'pill red' }, 'banned') : null, h('span', { class: 'pill muted' }, `Season ${a.season}`), pill(a.status))),
        h('dl', { class: 'stat' },
          h('dt', {}, 'Ward'), h('dd', {}, a.ward_sub ? `${a.ward_name || ''}${a.ward_email ? ` · ${a.ward_email}` : ''}` : 'not linked (sent before Ward was required)'),
          h('dt', {}, 'Applied'), h('dd', { title: new Date(utc(a.created_at)).toLocaleString() }, ago(utc(a.created_at)))),
        answers.length ? h('details', { class: 'ward-gap' }, h('summary', {}, 'Answers'), h('dl', { class: 'stat' }, answers.flatMap(([k, v]) => [h('dt', {}, k), h('dd', { class: 'wrap' }, String(v))]))) : null,
        late && a.status === 'pending' ? h('p', { class: 'caption ward-gap' }, 'Applied after the Season 1 window. Accepting does not whitelist them now.') : null,
        h('div', { class: 'row ward-gap-above' },
          a.status !== 'approved' ? h('button', { class: 'cta small', onclick: () => decide(a, 'approved') }, late ? 'Accept for Season 2' : 'Accept + whitelist') : null,
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
}
