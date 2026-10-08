// Bouncer: the DeltaVDevs Discord bot. Servers it may work in, the bot marketplace mods see with /marketplace,
// Discord accounts linked to Ward, and Bouncer's own log. Everything goes through Bouncer's /admin/v1.

const TABS = [['servers', 'Servers', '#/bouncer/servers'], ['marketplace', 'Marketplace', '#/bouncer/marketplace'], ['links', 'Linked accounts', '#/bouncer/links'], ['log', 'Log', '#/bouncer/log']];

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
        ['Server', g => h('span', {}, g.name || '(unknown)', h('br'), h('span', { class: 'caption mono' }, g.id))],
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
}
