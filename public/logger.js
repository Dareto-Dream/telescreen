// Logger: team workspaces at logger.deltavdevs.com. Suspend, export, transfer or delete a workspace, remove a log,
// and stop an account from creating workspaces. Everything goes through Logger's /admin/v1.

const TABS = [['workspaces', 'Workspaces', '#/logger/workspaces'], ['users', 'Users', '#/logger/users'], ['log', 'Log', '#/logger/log']];
const mb = n => `${(Number(n) / 1024 / 1024).toFixed(1)} MB`;
const gb = n => `${(Number(n) / 1e9).toFixed(2)} GB`;

export function register({ route, api, h, mount, head, toast, fail, confirmBox, ago, me }) {
  const show = (...nodes) => mount(...nodes.filter(Boolean));
  const tabs = active => h('div', { class: 'tabs' }, TABS.map(([id, text, href]) => h('button', { class: active === id ? 'active' : '', onclick: () => { location.hash = href; } }, text)));
  const refresh = () => window.dispatchEvent(new HashChangeEvent('hashchange'));
  const isOwner = () => me()?.level === 'owner';
  const table = (rows, cols, empty) => (rows.length
    ? h('div', { class: 'table-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, cols.map(([name]) => h('th', {}, name)))), h('tbody', {}, rows.map(r => h('tr', {}, cols.map(([name, fn]) => h('td', { class: name === '' ? 'actions' : null }, fn(r))))))))
    : h('p', { class: 'empty' }, empty));
  const act = (fn, done) => async () => { try { await fn(); if (done) toast(done); refresh(); } catch (e) { fail(e); } };
  const site = slug => `https://${slug}.logger.deltavdevs.com/`;

  async function ready(title, tab) {
    const s = await api('GET', '/api/logger');
    if (!s.enabled) { show(head('logger', title), h('div', { class: 'notice warn' }, 'Set LOGGER_URL and LOGGER_ADMIN_KEY on telescreen to run Logger from here.')); return false; }
    return true;
  }

  async function exportJson(ws) {
    try {
      const data = await api('GET', `/api/logger/workspaces/${ws.id}/export`);
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
      const a = h('a', { href: url, download: `logger-${ws.slug}.json` });
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      toast('Exported');
    } catch (e) { fail(e); }
  }

  async function suspend(ws) {
    const reason = prompt(`Why is ${ws.name} being suspended? The owner sees this.`);
    if (!reason) return;
    act(() => api('POST', `/api/logger/workspaces/${ws.id}/suspend`, { reason }), 'Suspended')();
  }

  async function remove(ws, after) {
    if (!await confirmBox(`Delete ${ws.name} with every log, item and image? This can't be undone.`, { typed: ws.slug })) return;
    try { await api('DELETE', `/api/logger/workspaces/${ws.id}`, { confirm: ws.slug }); toast('Deleted'); after ? after() : refresh(); } catch (e) { fail(e); }
  }

  // ---------------- workspaces ----------------
  route(/^\/logger(?:\/workspaces)?(?:\?.*)?$/, async () => {
    if (!await ready('Workspaces', 'workspaces')) return;
    const q = new URLSearchParams(location.hash.split('?')[1] || '').get('q') || '';
    const [o, list] = await Promise.all([api('GET', '/api/logger/overview'), api('GET', `/api/logger/workspaces${q ? `?q=${encodeURIComponent(q)}` : ''}`)]);
    const search = h('input', { placeholder: 'Search slug, name, owner or email', value: q });
    search.addEventListener('keydown', e => { if (e.key === 'Enter') location.hash = `#/logger/workspaces?q=${encodeURIComponent(search.value.trim())}`; });
    const c = o.counts;
    show(
      head('logger', 'Workspaces', h('a', { href: 'https://logger.deltavdevs.com/', target: '_blank', rel: 'noopener', class: 'button-link' }, h('button', { class: 'outline small', type: 'button' }, 'Open Logger'))),
      tabs('workspaces'),
      h('p', { class: 'caption' }, `${c.workspaces} workspaces (${c.public} public, ${c.suspended} suspended) · ${c.users} users · ${c.logs} logs, ${c.logs_week} this week · images ${gb(o.storage.used)} of ${gb(o.storage.budget)}${c.trash ? ` · ${c.trash} files waiting to be deleted` : ''}`),
      h('div', { class: 'row' }, search),
      table(list.workspaces, [
        ['Workspace', w => h('span', {}, h('a', { href: `#/logger/workspaces/${w.id}` }, w.name), h('br'), h('a', { class: 'caption mono', href: site(w.slug), target: '_blank', rel: 'noopener' }, `${w.slug}.logger.deltavdevs.com`))],
        ['Owner', w => h('span', {}, w.owner_name, h('br'), h('span', { class: 'caption' }, w.owner_email || ''))],
        ['', w => h('span', { class: 'caption' }, `${w.visibility}${w.suspended_at ? ' · suspended' : ''}`)],
        ['Members', w => String(w.members)],
        ['Logs', w => `${w.logs}${w.last_log ? ` · ${ago(w.last_log)}` : ''}`],
        ['Images', w => mb(w.storage_bytes)],
        ['Created', w => ago(w.created_at)],
      ], q ? 'Nothing matches.' : 'No workspaces yet.'),
      list.more ? h('p', { class: 'caption' }, 'Showing the newest 50. Search to narrow it down.') : null,
    );
  });

  route(/^\/logger\/workspaces\/([0-9a-f-]{36})$/, async id => {
    if (!await ready('Workspace', 'workspaces')) return;
    const d = await api('GET', `/api/logger/workspaces/${id}`);
    const w = d.workspace;
    const owner = isOwner();
    const transferTo = h('select', {}, h('option', { value: '' }, 'Choose a member'), d.members.filter(m => m.id !== w.owner_id).map(m => h('option', { value: m.id }, `${m.name}${m.email ? ` (${m.email})` : ''}`)));
    show(
      head('logger', w.name,
        h('button', { class: 'outline small', onclick: () => exportJson(w) }, 'Export JSON'),
        w.suspended_at
          ? h('button', { class: 'cta small', onclick: act(() => api('POST', `/api/logger/workspaces/${w.id}/unsuspend`, {}), 'Unsuspended') }, 'Unsuspend')
          : h('button', { class: 'outline small', onclick: () => suspend(w) }, 'Suspend'),
        h('button', { class: 'danger small', disabled: !owner, onclick: () => remove(w, () => { location.hash = '#/logger/workspaces'; }) }, 'Delete')),
      tabs('workspaces'),
      h('p', { class: 'caption' }, h('a', { href: site(w.slug), target: '_blank', rel: 'noopener' }, `${w.slug}.logger.deltavdevs.com`),
        ` · ${w.visibility}${w.visibility === 'public' ? (w.public_preview ? ', preview on' : ', preview off') : ''} · template ${w.template} · created ${ago(w.created_at)} · images ${mb(w.storage_bytes)}`),
      w.suspended_at ? h('div', { class: 'notice warn' }, `Suspended ${ago(w.suspended_at)}: ${w.suspended_reason}`) : null,
      w.description ? h('p', {}, w.description) : null,
      h('h2', { class: 'subheadline' }, 'Owner'),
      h('p', {}, `${w.owner_name}${w.owner_email ? ` · ${w.owner_email}` : ''}`),
      h('div', { class: 'row' }, transferTo, h('button', { class: 'outline small', disabled: !owner, onclick: async () => {
        if (!transferTo.value) return;
        if (!await confirmBox('Make this member the owner? The current owner keeps the top role.')) return;
        act(() => api('POST', `/api/logger/workspaces/${w.id}/transfer`, { user_id: transferTo.value }), 'Transferred')();
      } }, 'Transfer ownership')),
      h('h2', { class: 'subheadline' }, `Members (${d.members.length})`),
      table(d.members, [['Name', m => m.name], ['Email', m => m.email || ''], ['Role', m => (m.id === w.owner_id ? 'Owner' : m.role || 'No role')], ['Joined', m => ago(m.joined_at)]], 'Nobody.'),
      h('h2', { class: 'subheadline' }, 'Recent logs'),
      table(d.recent, [
        ['Author', l => l.author || 'former member'],
        ['Log', l => h('span', { class: 'caption' }, `${l.kind !== 'update' ? `[${l.kind}] ` : ''}${l.body}${l.images ? ` (${l.images} image${l.images === 1 ? '' : 's'})` : ''}`)],
        ['When', l => ago(l.created_at)],
        ['', l => h('button', { class: 'ghost danger-text', onclick: async () => { if (await confirmBox('Delete this log and its images?')) act(() => api('DELETE', `/api/logger/workspaces/${w.id}/logs/${l.id}`), 'Log deleted')(); } }, 'delete')],
      ], 'No logs yet.'),
      h('h2', { class: 'subheadline' }, 'Activity'),
      table(d.events, [['When', e => ago(e.at)], ['Who', e => e.actor || ''], ['What', e => h('span', { class: 'mono caption' }, `${e.kind} ${Object.keys(e.data || {}).length ? JSON.stringify(e.data) : ''}`)]], 'Nothing yet.'),
    );
  });

  // ---------------- users ----------------
  route(/^\/logger\/users(?:\?.*)?$/, async () => {
    if (!await ready('Users', 'users')) return;
    const q = new URLSearchParams(location.hash.split('?')[1] || '').get('q') || '';
    const { users } = await api('GET', `/api/logger/users${q ? `?q=${encodeURIComponent(q)}` : ''}`);
    const search = h('input', { placeholder: 'Search name, username, email or Ward id', value: q });
    search.addEventListener('keydown', e => { if (e.key === 'Enter') location.hash = `#/logger/users?q=${encodeURIComponent(search.value.trim())}`; });
    show(
      head('logger', 'Users'), tabs('users'),
      h('p', { class: 'caption' }, 'Everyone who has signed in to Logger. Blocking creation stops an account making a workspace; it can still join them. Owners only.'),
      h('div', { class: 'row' }, search),
      table(users, [
        ['Name', u => h('span', {}, u.name, u.username ? h('span', { class: 'caption' }, ` @${u.username}`) : null, h('br'), h('span', { class: 'caption' }, u.email || ''))],
        ['Owns', u => (u.owns ? h('a', { href: site(u.owns), target: '_blank', rel: 'noopener' }, u.owns) : '')],
        ['Member of', u => String(u.memberships)],
        ['Last seen', u => ago(u.last_seen_at)],
        ['', u => h('button', { class: u.can_create ? 'ghost danger-text' : 'ghost', disabled: !isOwner(), onclick: act(() => api('POST', `/api/logger/users/${u.id}/creation`, { allowed: !u.can_create }), u.can_create ? 'Creation blocked' : 'Creation allowed') }, u.can_create ? 'block creating' : 'allow creating')],
      ], q ? 'Nobody matches.' : 'Nobody has signed in yet.'),
    );
  });

  // ---------------- log ----------------
  route(/^\/logger\/log$/, async () => {
    if (!await ready('Log', 'log')) return;
    const { entries } = await api('GET', '/api/logger/audit');
    show(head('logger', 'Log'), tabs('log'),
      table(entries, [['When', e => ago(e.at)], ['Who', e => e.actor || ''], ['What', e => e.action], ['Detail', e => h('span', { class: 'mono caption' }, JSON.stringify(e.data))]], 'Nothing logged yet.'));
  });
}
