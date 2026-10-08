// Bouncer: the DeltaVDevs Discord bot. Servers it may work in, the bot marketplace mods see with /marketplace,
// Discord accounts linked to Ward, and Bouncer's own log. Everything goes through Bouncer's /admin/v1.

const TABS = [['servers', 'Servers', '#/bouncer/servers'], ['bans', 'Network bans', '#/bouncer/bans'], ['appeals', 'Appeals', '#/bouncer/appeals'], ['lookup', 'User lookup', '#/bouncer/users'],
  ['marketplace', 'Marketplace', '#/bouncer/marketplace'], ['links', 'Linked accounts', '#/bouncer/links'], ['log', 'Log', '#/bouncer/log']];

export function register({ route, api, h, mount, head, toast, fail, confirmBox, ago, me }) {
  const show = (...nodes) => mount(...nodes.filter(Boolean));
  const tabs = active => h('div', { class: 'tabs' }, TABS.map(([id, text, href]) => h('button', { class: active === id ? 'active' : '', onclick: () => { location.hash = href; } }, text)));
  const refresh = () => window.dispatchEvent(new HashChangeEvent('hashchange'));
  const isOwner = () => me()?.level === 'owner';
  const field = (label, el, hint) => h('label', {}, h('span', {}, label, hint ? h('span', { class: 'hint' }, ` ${hint}`) : null), el);
  const table = (rows, cols, empty) => (rows.length
    ? h('div', { class: 'table-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, cols.map(([name]) => h('th', {}, name)))), h('tbody', {}, rows.map(r => h('tr', {}, cols.map(([name, fn]) => h('td', { class: name === '' ? 'actions' : null }, fn(r))))))))
    : h('p', { class: 'empty' }, empty));
  const act = (fn, done) => async () => { try { await fn(); if (done) toast(done); refresh(); } catch (e) { fail(e); } };

  async function overview(title, tab) {
    const s = await api('GET', '/api/bouncer');
    if (!s.enabled) { show(head('bouncer', title), h('div', { class: 'notice warn' }, 'Set BOUNCER_URL and BOUNCER_ADMIN_KEY on telescreen to run Bouncer from here.')); return null; }
    const o = await api('GET', '/api/bouncer/overview').catch(e => ({ error: e.message }));
    if (o.error) { show(head('bouncer', title), tabs(tab), h('div', { class: 'notice error' }, o.error)); return null; }
    return o;
  }
  const status = o => [
    !o.discord ? h('div', { class: 'notice warn ward-gap-below' }, 'Bouncer is not connected to Discord. Set DISCORD_TOKEN and DISCORD_CLIENT_ID on the bouncer service.') : h('p', { class: 'caption ward-sub' }, `Online as ${o.botUser.tag} · ${o.links} linked account${o.links === 1 ? '' : 's'}`),
    !o.wardLevels ? h('div', { class: 'notice warn ward-gap-below' }, 'WARD_ADMIN_KEY is not set on bouncer, so Ward staff levels can not be read.') : null,
  ];

  // ---------------- servers ----------------
  route(/^\/bouncer(?:\/servers)?$/, async () => {
    const o = await overview('Servers', 'servers'); if (!o) return;
    const invite = o.clientId ? `https://discord.com/oauth2/authorize?client_id=${o.clientId}&scope=bot+applications.commands&permissions=8` : null;
    const owner = isOwner();
    show(
      head('bouncer', 'Servers', h('button', { class: 'outline small', onclick: act(() => api('POST', '/api/bouncer/sync', {}), 'Ward roles re-checked everywhere') }, 'Sync Ward roles'), h('button', { class: 'outline small', onclick: refresh }, 'Refresh')),
      ...status(o),
      tabs('servers'),
      h('p', { class: 'caption' }, 'Bouncer only works in approved servers. Anywhere else it answers "not approved". Approving or leaving is owners only.'),
      invite ? h('p', { class: 'caption' }, 'Invite link: ', h('a', { href: invite, target: '_blank', rel: 'noopener' }, 'add Bouncer to a server'), ' (asks for Administrator; templates need it to create roles).') : null,
      table(o.guilds, [
        ['Server', g => h('span', {}, g.allowed && g.present ? h('a', { href: `#/bouncer/servers/${g.id}` }, g.name || '(unknown)') : (g.name || '(unknown)'), h('br'), h('span', { class: 'caption mono' }, g.id))],
        ['Members', g => g.member_count ?? '—'],
        ['Status', g => h('span', { class: `pill ${!g.present ? 'muted' : g.allowed ? 'green' : 'yellow'}` }, !g.present ? 'left' : g.allowed ? 'approved' : 'waiting')],
        ['Settings', g => h('span', { class: 'caption' }, `log ${g.settings.logChannel ? 'on' : 'off'} · ward roles ${Object.values(g.settings.wardRoles || {}).filter(Boolean).length}/3 · mod roles ${(g.settings.modRoles || []).length}`)],
        ['', g => [
          g.present && !g.allowed ? h('button', { class: 'cta small', disabled: !owner, onclick: act(() => api('POST', `/api/bouncer/guilds/${g.id}/allow`, {}), 'Approved') }, 'Approve') : null,
          g.allowed ? h('button', { class: 'ghost', disabled: !owner, onclick: async () => { if (await confirmBox(`Stop Bouncer working in ${g.name}? It stays in the server but answers "not approved".`)) act(() => api('POST', `/api/bouncer/guilds/${g.id}/disallow`, {}), 'Unapproved')(); } }, 'unapprove') : null,
          g.allowed && g.present ? h('button', { class: 'ghost', onclick: act(() => api('POST', `/api/bouncer/guilds/${g.id}/sync`, {}), 'Synced') }, 'sync') : null,
          g.present ? h('button', { class: 'ghost danger-text', disabled: !owner, onclick: async () => { if (await confirmBox(`Make Bouncer leave ${g.name}?`, { typed: 'leave' })) act(() => api('POST', `/api/bouncer/guilds/${g.id}/leave`, {}), 'Left')(); } }, 'leave') : null,
        ]],
      ], o.discord ? 'Bouncer is not in any servers yet. Use the invite link above.' : 'No servers yet.'),
      h('h2', { class: 'subheadline ward-gap-above' }, 'Templates'),
      h('p', { class: 'caption' }, 'Saved in Discord with /template save. Built-in ones can not be deleted.'),
      table(o.templates, [
        ['Name', t => h('span', { class: 'mono' }, t.name)],
        ['From', t => (t.builtin ? 'built in' : `${t.created_by || '—'} · ${ago(t.created_at)}`)],
        ['', t => (t.builtin ? '' : h('button', { class: 'ghost', onclick: async () => { if (await confirmBox(`Delete template ${t.name}?`)) act(() => api('DELETE', `/api/bouncer/templates/${t.name}`), 'Deleted')(); } }, 'delete'))],
      ], 'No templates.'),
    );
  });

  // ---------------- marketplace ----------------
  route(/^\/bouncer\/marketplace$/, async () => {
    const o = await overview('Marketplace', 'marketplace'); if (!o) return;
    const clientId = h('input', { placeholder: 'application (client) id', inputmode: 'numeric', autocomplete: 'off' });
    const name = h('input', { placeholder: 'Spectralis', maxlength: '80' });
    const description = h('input', { placeholder: 'one line mods will see', maxlength: '300' });
    const permissions = h('input', { placeholder: '0', value: '0', inputmode: 'numeric' });
    const form = h('form', { class: 'card form' }, field('Client id', clientId), field('Name', name), h('div', { class: 'wide' }, field('Description', description)), field('Permissions', permissions, '(the integer from the Developer Portal\'s URL generator)'),
      h('div', { class: 'row end' }, h('button', { class: 'cta', type: 'submit' }, 'Save bot')));
    form.addEventListener('submit', async e => {
      e.preventDefault();
      if (!/^\d{15,22}$/.test(clientId.value.trim())) return clientId.focus();
      try { await api('PUT', `/api/bouncer/bots/${clientId.value.trim()}`, { name: name.value.trim(), description: description.value.trim(), permissions: permissions.value.trim() || '0' }); toast('Saved'); refresh(); } catch (err) { fail(err); }
    });
    const edit = b => { clientId.value = b.client_id; name.value = b.name; description.value = b.description; permissions.value = b.permissions; name.focus(); };
    show(
      head('bouncer', 'Marketplace', h('button', { class: 'outline small', onclick: refresh }, 'Refresh')),
      ...status(o),
      tabs('marketplace'),
      h('p', { class: 'caption' }, 'DeltaVDevs bots mods can add or remove with /marketplace. Adding sends them to Discord\'s authorization page for their server; removing kicks the bot.'),
      table(o.bots, [
        ['Bot', b => h('span', {}, b.name, h('br'), h('span', { class: 'caption mono' }, b.client_id))],
        ['Description', b => b.description || '—'],
        ['Permissions', b => h('span', { class: 'mono' }, b.permissions)],
        ['', b => [h('button', { class: 'ghost', onclick: () => edit(b) }, 'edit'), h('button', { class: 'ghost', onclick: async () => { if (await confirmBox(`Take ${b.name} out of the marketplace? Servers that have it keep it.`)) act(() => api('DELETE', `/api/bouncer/bots/${b.client_id}`), 'Removed')(); } }, 'remove')]],
      ], 'The marketplace is empty.'),
      h('div', { class: 'ward-gap-above' }, form),
    );
  });

  // ---------------- linked accounts ----------------
  route(/^\/bouncer\/links$/, async () => {
    const o = await overview('Linked accounts', 'links'); if (!o) return;
    const { links } = await api('GET', '/api/bouncer/links');
    show(
      head('bouncer', 'Linked accounts', h('button', { class: 'outline small', onclick: refresh }, 'Refresh')),
      ...status(o),
      tabs('links'),
      h('p', { class: 'caption' }, 'Discord accounts linked to Ward with /link. Ward staff levels decide the Ward roles in every approved server. Unlinking removes those roles.'),
      table(links, [
        ['Discord', l => h('span', { class: 'mono' }, l.discord_id)],
        ['Ward', l => `${l.ward_name || '—'}${l.ward_email ? ` · ${l.ward_email}` : ''}`],
        ['Level', l => (l.ward_level ? h('span', { class: 'pill green' }, l.ward_level) : h('span', { class: 'caption' }, 'none'))],
        ['Linked', l => ago(l.linked_at)],
        ['Checked', l => ago(l.checked_at)],
        ['', l => h('button', { class: 'ghost', onclick: async () => { if (await confirmBox('Unlink this account? Their Ward roles are removed.')) act(() => api('DELETE', `/api/bouncer/links/${l.discord_id}`), 'Unlinked')(); } }, 'unlink')],
      ], 'Nobody has linked yet.'),
    );
  });

  // ---------------- log ----------------
  route(/^\/bouncer\/log$/, async () => {
    const o = await overview('Log', 'log'); if (!o) return;
    const { audit } = await api('GET', '/api/bouncer/audit?limit=300');
    const names = Object.fromEntries(o.guilds.map(g => [g.id, g.name]));
    show(
      head('bouncer', 'Log', h('button', { class: 'outline small', onclick: refresh }, 'Refresh')),
      ...status(o),
      tabs('log'),
      table(audit, [
        ['When', a => ago(a.at)],
        ['Server', a => (a.guild_id ? names[a.guild_id] || a.guild_id : '—')],
        ['Who', a => h('span', { class: 'mono' }, a.actor)],
        ['What', a => a.action.replace(/_/g, ' ')],
        ['Detail', a => h('span', { class: 'wrap' }, a.detail || '')],
      ], 'Nothing yet.'),
    );
  });

  // ---------------- shared bits ----------------
  const fmtResults = (results, names) => Object.entries(results || {}).map(([id, r]) => `${names[id] || id}: ${r}`).join(' · ');
  const guildNames = o => Object.fromEntries(o.guilds.map(g => [g.id, g.name]));
  const DURATIONS = [['', 'Permanent'], ['60', '1 hour'], ['1440', '1 day'], ['10080', '1 week'], ['43200', '30 days']];
  const DELETE_WINDOWS = [['0', "Don't delete messages"], ['3600', 'Last hour'], ['86400', 'Last day'], ['604800', 'Last 7 days']];
  const select = (pairs, value) => { const el = h('select', {}, pairs.map(([v, t]) => h('option', { value: v }, t))); el.value = value; return el; };

  // Opens the network-ban dialog for one or more ids (also used from a server's member list and ban list).
  function networkBanDialog(ids, names, after) {
    const reason = h('input', { placeholder: 'reason (sent to them and kept with the ban)', maxlength: '400' });
    const length = select(DURATIONS, '');
    const del = select(DELETE_WINDOWS, '0');
    const dm = h('input', { type: 'checkbox', checked: true });
    const go = h('button', { class: 'danger', type: 'button' }, ids.length > 1 ? `Ban ${ids.length} people everywhere` : 'Ban everywhere');
    const dialog = h('dialog', {},
      h('p', { class: 'eyebrow' }, 'network ban'),
      h('p', { class: 'subheadline' }, ids.length > 1 ? `${ids.length} people` : ids[0]),
      h('p', { class: 'caption' }, 'Bans them in every approved server, and again if they ever join one.'),
      h('div', { class: 'stack' }, field('Reason', reason), field('Length', length), field('Delete their messages', del),
        h('label', { class: 'check' }, dm, h('span', {}, 'Message them first, with an Appeal button'))),
      h('div', { class: 'row end spaced' }, h('button', { class: 'outline', type: 'button', onclick: () => dialog.close() }, 'Cancel'), go));
    go.addEventListener('click', async () => {
      go.disabled = true; go.textContent = 'Banning…';
      try {
        const r = await api('POST', '/api/bouncer/network-bans', { ids: ids.join(' '), reason: reason.value.trim(), minutes: length.value ? Number(length.value) : null, deleteMessageSeconds: Number(del.value), dm: dm.checked });
        const failed = r.results.filter(x => x.error || Object.values(x.results || {}).some(v => v.startsWith('failed')));
        toast(`Banned ${r.results.length - failed.length} of ${r.results.length}${failed.length ? ` · problems: ${failed.map(x => x.error || fmtResults(x.results, names)).join('; ')}` : ''}`, failed.length > 0);
        dialog.close(); after?.();
      } catch (e) { go.disabled = false; go.textContent = 'Ban everywhere'; fail(e); }
    });
    dialog.addEventListener('close', () => dialog.remove());
    document.body.append(dialog);
    dialog.showModal();
    reason.focus();
  }

  // ---------------- one server ----------------
  route(/^\/bouncer\/servers\/(\d{15,22})(?:\?q=(.*))?$/, async (id, q) => {
    const o = await overview('Server', 'servers'); if (!o) return;
    const names = guildNames(o);
    const [d, m, b] = await Promise.all([
      api('GET', `/api/bouncer/guilds/${id}/detail`),
      api('GET', `/api/bouncer/guilds/${id}/members?${new URLSearchParams({ q: q || '' })}`),
      api('GET', `/api/bouncer/guilds/${id}/bans`).catch(e => ({ error: e.message })),
    ]);
    const roles = d.roles.filter(r => !r.managed);
    const memberAct = (userId, action, body = {}) => act(() => api('POST', `/api/bouncer/guilds/${id}/members/${userId}/${action}`, body), 'Done');

    const search = h('input', { placeholder: 'name, nickname or user id', value: q || '', autocomplete: 'off' });
    const searchForm = h('form', { class: 'row' }, search, h('button', { class: 'outline', type: 'submit' }, 'Search'));
    searchForm.addEventListener('submit', e => { e.preventDefault(); location.hash = `#/bouncer/servers/${id}${search.value.trim() ? `?q=${encodeURIComponent(search.value.trim())}` : ''}`; });

    const memberActions = mem => {
      const rolePick = select([['', 'role…'], ...roles.filter(r => r.editable).map(r => [r.id, r.name])], '');
      return [
        h('button', { class: 'ghost', onclick: async () => { const mins = prompt('Time out for how many minutes? (1 to 40320)', '60'); if (mins) memberAct(mem.id, 'timeout', { minutes: Number(mins) })(); } }, mem.timeoutUntil ? 'extend timeout' : 'timeout'),
        mem.timeoutUntil ? h('button', { class: 'ghost', onclick: memberAct(mem.id, 'untimeout') }, 'end timeout') : null,
        h('button', { class: 'ghost', onclick: async () => { if (await confirmBox(`Kick ${mem.tag}?`)) memberAct(mem.id, 'kick')(); } }, 'kick'),
        h('button', { class: 'ghost danger-text', onclick: async () => { if (await confirmBox(`Ban ${mem.tag} from ${d.name} only?`)) memberAct(mem.id, 'ban')(); } }, 'ban here'),
        h('button', { class: 'ghost danger-text', onclick: () => networkBanDialog([mem.id], names, refresh) }, 'ban everywhere'),
        h('span', { class: 'row' }, rolePick,
          h('button', { class: 'ghost', onclick: () => rolePick.value && memberAct(mem.id, 'role-add', { roleId: rolePick.value })() }, '+'),
          h('button', { class: 'ghost', onclick: () => rolePick.value && memberAct(mem.id, 'role-remove', { roleId: rolePick.value })() }, '−')),
      ];
    };

    const channel = select(d.channels.map(c => [c.id, `${c.parent ? `${c.parent} / ` : ''}#${c.name}`]), d.channels[0]?.id || '');
    const message = h('textarea', { maxlength: '2000', placeholder: 'Posted by Bouncer. Mentions are not pinged.' });
    const msgForm = h('form', { class: 'card form' }, field('Channel', channel), h('div', { class: 'wide' }, field('Message', message)), h('div', { class: 'row end' }, h('button', { class: 'outline', type: 'submit' }, 'Post')));
    msgForm.addEventListener('submit', async e => {
      e.preventDefault();
      if (!message.value.trim()) return message.focus();
      try { await api('POST', `/api/bouncer/guilds/${id}/message`, { channelId: channel.value, content: message.value.trim() }); toast('Posted'); message.value = ''; } catch (err) { fail(err); }
    });

    show(
      head('bouncer', d.name, h('button', { class: 'outline small', onclick: () => { location.hash = '#/bouncer/servers'; } }, 'All servers'), h('button', { class: 'outline small', onclick: refresh }, 'Refresh')),
      h('p', { class: 'caption ward-sub' }, `${d.memberCount} members · Bouncer's top role: ${d.bouncer.topRole || '—'}${d.bouncer.admin ? ' (administrator)' : ''}`),
      tabs('servers'),
      !d.bouncer.admin ? h('div', { class: 'notice warn ward-gap-below' }, 'Bouncer is not an administrator here, so some actions will be refused.') : null,
      h('h2', { class: 'subheadline' }, 'Members'),
      searchForm,
      h('p', { class: 'caption' }, q ? `${m.members.length} match${m.members.length === 1 ? '' : 'es'}` : 'Newest 100 members. Search to find anyone else.'),
      h('div', { class: 'wrap-actions' }, table(m.members, [
        ['Member', x => h('span', {}, h('a', { href: `#/bouncer/users/${x.id}` }, x.displayName), x.bot ? h('span', { class: 'pill muted' }, 'bot') : null, h('br'), h('span', { class: 'caption mono' }, `${x.tag} · ${x.id}`))],
        ['Roles', x => h('span', { class: 'caption wrap' }, x.roles.map(r => r.name).join(', ') || '—')],
        ['Ward', x => (x.link ? `${x.link.name}${x.link.level ? ` (${x.link.level})` : ''}` : '—')],
        ['Joined', x => ago(x.joinedAt)],
        ['', x => (x.id === d.ownerId ? h('span', { class: 'caption' }, 'owner') : memberActions(x))],
      ], 'Nobody found.')),
      h('h2', { class: 'subheadline ward-gap-above' }, 'Bans in this server'),
      b.error ? h('div', { class: 'notice error' }, b.error) : table(b.bans, [
        ['User', x => h('span', {}, h('a', { href: `#/bouncer/users/${x.id}` }, x.tag), h('br'), h('span', { class: 'caption mono' }, x.id))],
        ['Reason', x => h('span', { class: 'wrap' }, x.reason || '—')],
        ['', x => [x.network ? h('span', { class: 'pill red' }, 'network ban') : h('button', { class: 'ghost', onclick: () => networkBanDialog([x.id], names, refresh) }, 'ban everywhere'),
          !x.network ? h('button', { class: 'ghost', onclick: async () => { if (await confirmBox(`Unban ${x.tag} here?`, { danger: false })) memberAct(x.id, 'unban')(); } }, 'unban') : null]],
      ], 'Nobody is banned here.'),
      h('h2', { class: 'subheadline ward-gap-above' }, 'Roles'),
      table(d.roles, [['Role', r => r.name], ['Members', r => r.members], ['', r => (r.managed ? h('span', { class: 'caption' }, 'managed by an integration') : !r.editable ? h('span', { class: 'caption' }, "above Bouncer's role") : '')]], 'No roles.'),
      h('h2', { class: 'subheadline ward-gap-above' }, 'Post as Bouncer'),
      msgForm,
    );
  });

  // ---------------- network bans ----------------
  route(/^\/bouncer\/bans$/, async () => {
    const o = await overview('Network bans', 'bans'); if (!o) return;
    const names = guildNames(o);
    const { bans } = await api('GET', '/api/bouncer/network-bans');
    const ids = h('textarea', { class: 'code', placeholder: 'Discord user ids or @mentions, any separator. Up to 100 at once.' });
    const start = h('button', { class: 'danger', type: 'button', disabled: !o.discord, onclick: () => {
      const list = [...new Set(ids.value.match(/\d{15,22}/g) || [])];
      if (!list.length) return ids.focus();
      networkBanDialog(list, names, () => { ids.value = ''; refresh(); });
    } }, 'Ban everywhere…');
    const lift = x => async () => {
      if (!await confirmBox(`Lift the network ban on ${x.tag || x.user_id}? They are unbanned in every approved server.`, { danger: false })) return;
      try { const r = await api('POST', `/api/bouncer/network-bans/${x.user_id}/lift`, { dm: true }); toast(`Lifted · ${fmtResults(r.results, names)}`); refresh(); } catch (e) { fail(e); }
    };
    const active = bans.filter(x => x.active), past = bans.filter(x => !x.active);
    const cols = [
      ['User', x => h('span', {}, h('a', { href: `#/bouncer/users/${x.user_id}` }, x.tag || x.user_id), h('br'), h('span', { class: 'caption mono' }, x.user_id))],
      ['Reason', x => h('span', { class: 'wrap' }, x.reason || '—')],
      ['By', x => x.created_by],
      ['When', x => ago(x.created_at)],
      ['Until', x => (x.lifted_at ? `lifted ${ago(x.lifted_at)}${x.lift_reason ? ` (${x.lift_reason})` : ''}` : x.expires_at ? new Date(x.expires_at).toLocaleString() : 'permanent')],
      ['', x => (x.active ? h('button', { class: 'ghost', disabled: !o.discord, onclick: lift(x) }, 'lift') : '')],
    ];
    show(
      head('bouncer', 'Network bans', h('button', { class: 'outline small', onclick: refresh }, 'Refresh')),
      ...status(o),
      tabs('bans'),
      h('div', { class: 'card stack' }, h('h3', {}, 'Ban people from every server'), ids, h('div', { class: 'row end' }, start)),
      h('h2', { class: 'subheadline ward-gap-above' }, `Active (${active.length})`),
      table(active, cols, 'Nobody is network-banned.'),
      past.length ? h('h2', { class: 'subheadline ward-gap-above' }, 'Lifted or expired') : null,
      past.length ? table(past, cols, '') : null,
    );
  });

  // ---------------- appeals ----------------
  route(/^\/bouncer\/appeals(?:\?status=(\w+))?$/, async st => {
    const o = await overview('Appeals', 'appeals'); if (!o) return;
    const status_ = ['pending', 'approved', 'denied'].includes(st) ? st : 'pending';
    const { appeals } = await api('GET', `/api/bouncer/appeals?status=${status_}`);
    const decide = (a, approve) => async () => {
      const note = prompt(approve ? 'Note for them (optional)' : 'Why it was denied (sent to them; optional)', '');
      if (note === null) return;
      try { await api('POST', `/api/bouncer/appeals/${a.id}/decide`, { approve, note }); toast(approve ? 'Approved and unbanned everywhere' : 'Denied'); refresh(); } catch (e) { fail(e); }
    };
    show(
      head('bouncer', 'Appeals', h('button', { class: 'outline small', onclick: refresh }, 'Refresh')),
      ...status(o),
      tabs('appeals'),
      h('div', { class: 'row ward-gap-below' }, [['pending', 'Waiting'], ['approved', 'Approved'], ['denied', 'Denied']].map(([v, t]) => h('button', { class: v === status_ ? 'cta small' : 'outline small', onclick: () => { location.hash = `#/bouncer/appeals?status=${v}`; } }, t))),
      appeals.length ? h('div', { class: 'stack' }, appeals.map(a => h('div', { class: 'card tight' },
        h('div', { class: 'row spaced' }, h('h3', {}, h('a', { href: `#/bouncer/users/${a.user_id}` }, a.tag || a.user_id)), h('span', { class: 'caption' }, `${ago(a.created_at)} · via ${a.via}`)),
        h('p', { class: 'wrap' }, a.text),
        a.status === 'pending'
          ? h('div', { class: 'row ward-gap-above' }, h('button', { class: 'cta small', disabled: !o.discord, onclick: decide(a, true) }, 'Approve and unban'), h('button', { class: 'outline small', disabled: !o.discord, onclick: decide(a, false) }, 'Deny'))
          : h('p', { class: 'caption' }, `${a.status} by ${a.decided_by} ${ago(a.decided_at)}${a.note ? ` · ${a.note}` : ''}`)))) : h('p', { class: 'empty' }, 'Nothing here.'),
    );
  });

  // ---------------- user lookup ----------------
  route(/^\/bouncer\/users(?:\/(\d{15,22}))?$/, async userId => {
    const o = await overview('User lookup', 'lookup'); if (!o) return;
    const names = guildNames(o);
    const input = h('input', { placeholder: 'Discord user id', value: userId || '', inputmode: 'numeric', autocomplete: 'off' });
    const form = h('form', { class: 'row' }, input, h('button', { class: 'outline', type: 'submit' }, 'Look up'));
    form.addEventListener('submit', e => { e.preventDefault(); const id = (input.value.match(/\d{15,22}/) || [])[0]; if (id) location.hash = `#/bouncer/users/${id}`; else input.focus(); });
    if (!userId) return show(head('bouncer', 'User lookup'), ...status(o), tabs('lookup'), form);
    const u = await api('GET', `/api/bouncer/users/${userId}`);
    const nb = u.networkBan;
    show(
      head('bouncer', u.user?.tag || userId, h('button', { class: 'outline small', onclick: refresh }, 'Refresh')),
      h('p', { class: 'caption ward-sub mono' }, `${userId}${u.user ? ` · account made ${ago(u.user.createdAt)}${u.user.bot ? ' · bot' : ''}` : ' · Discord does not know this id'}`),
      tabs('lookup'),
      form,
      h('div', { class: 'grid ward-gap-above' },
        h('div', { class: 'card tight' }, h('h3', {}, 'Network ban'),
          nb?.active ? [h('p', {}, h('span', { class: 'pill red' }, 'banned'), ` ${nb.reason || ''}`), h('p', { class: 'caption' }, `by ${nb.created_by} ${ago(nb.created_at)}${nb.expires_at ? ` · until ${new Date(nb.expires_at).toLocaleString()}` : ''}`),
            h('button', { class: 'outline small', onclick: async () => { if (await confirmBox('Lift this network ban?', { danger: false })) act(() => api('POST', `/api/bouncer/network-bans/${userId}/lift`, { dm: true }), 'Lifted')(); } }, 'Lift')]
            : [h('p', { class: 'caption' }, nb ? `Was banned; lifted ${ago(nb.lifted_at)}` : 'Not banned.'), h('button', { class: 'danger small', disabled: !o.discord, onclick: () => networkBanDialog([userId], names, refresh) }, 'Ban everywhere')]),
        h('div', { class: 'card tight' }, h('h3', {}, 'Ward'), u.link ? h('dl', { class: 'stat' }, h('dt', {}, 'account'), h('dd', {}, u.link.ward_name || '—'), h('dt', {}, 'email'), h('dd', {}, u.link.ward_email || '—'), h('dt', {}, 'staff level'), h('dd', {}, u.link.ward_level || 'none')) : h('p', { class: 'caption' }, 'Not linked.'))),
      h('h2', { class: 'subheadline ward-gap-above' }, 'Servers'),
      table(u.servers, [
        ['Server', x => h('a', { href: `#/bouncer/servers/${x.id}?q=${userId}` }, x.name)],
        ['Here as', x => (x.member ? `${x.member.displayName} · joined ${ago(x.member.joinedAt)}` : '—')],
        ['Roles', x => h('span', { class: 'caption wrap' }, x.member ? x.member.roles.map(r => r.name).join(', ') || '—' : '')],
        ['Status', x => (x.banned ? h('span', { class: 'pill red', title: x.banned }, 'banned') : x.member?.timeoutUntil ? h('span', { class: 'pill yellow' }, 'timed out') : h('span', { class: 'pill green' }, 'member'))],
      ], 'Not in any approved server.'),
      h('h2', { class: 'subheadline ward-gap-above' }, 'Appeals'),
      table(u.appeals, [['When', a => ago(a.created_at)], ['Status', a => a.status], ['Appeal', a => h('span', { class: 'wrap' }, a.text)], ['Note', a => a.note || '—']], 'No appeals.'),
      h('h2', { class: 'subheadline ward-gap-above' }, 'History'),
      table(u.log, [['When', a => ago(a.at)], ['Server', a => (a.guild_id ? names[a.guild_id] || a.guild_id : '—')], ['Who', a => a.actor], ['What', a => a.action.replace(/_/g, ' ')], ['Detail', a => h('span', { class: 'wrap' }, a.detail)]], 'Nothing logged.'),
    );
  });
}
