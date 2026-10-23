// Git hosting admin. Who may make repos on git.deltavdevs.com, and the repos themselves. Every write goes through
// the git service's /admin/v1 (server side, with its own key), which records it in its audit log under your email.

const TABS = [['requests', 'Access requests', '#/git/requests'], ['repos', 'Repos', '#/git/repos']];

export function register({ route, api, h, mount, head, toast, fail, confirmBox, ago, me }) {
  const tabs = active => h('div', { class: 'tabs' }, TABS.map(([id, text, href]) => h('button', { class: active === id ? 'active' : '', onclick: () => { location.hash = href; } }, text)));
  const refresh = () => window.dispatchEvent(new HashChangeEvent('hashchange'));
  const when = ts => (ts ? h('span', { title: new Date(ts * 1000).toLocaleString() }, ago(new Date(ts * 1000).toISOString())) : '—');
  const isOwner = () => me()?.level === 'owner';
  const table = (rows, cols, empty = 'Nothing here.') => (rows.length
    ? h('div', { class: 'table-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, cols.map(([name]) => h('th', {}, name)))), h('tbody', {}, rows.map(r => h('tr', {}, cols.map(([name, fn]) => h('td', { class: name === '' ? 'actions' : null }, fn(r))))))))
    : h('p', { class: 'empty' }, empty));
  const statusPill = s => h('span', { class: `pill ${s === 'approved' ? 'green' : s === 'pending' ? 'yellow' : 'muted'}` }, s);

  async function status() {
    const s = await api('GET', '/api/git');
    if (!s.enabled) { mount(head('git', 'Git'), h('div', { class: 'notice warn' }, 'Set GIT_URL and GIT_ADMIN_KEY on telescreen to run git hosting from here.')); return null; }
    if (s.error) { mount(head('git', 'Git'), tabs('requests'), h('div', { class: 'notice error' }, s.error)); return null; }
    return s;
  }

  const decide = async (u, action, verb) => {
    try { await api('POST', `/api/git/users/${encodeURIComponent(u.sub)}/${action}`, {}); toast(`${u.username} ${verb}`); refresh(); } catch (e) { fail(e); }
  };

  // ---------------- access requests ----------------
  route(/^\/git(?:\/requests)?$/, async () => {
    const s = await status(); if (!s) return;
    const { users } = await api('GET', '/api/git/users');
    const pending = users.filter(u => u.status === 'pending');
    const rest = users.filter(u => u.status !== 'pending');
    const actions = u => [
      u.status !== 'approved' ? h('button', { class: 'cta small', onclick: () => decide(u, 'approve', 'approved') }, 'Approve') : null,
      u.status === 'pending' ? h('button', { class: 'outline small', onclick: () => decide(u, 'deny', 'denied') }, 'Deny') : null,
      u.status === 'approved' ? h('button', { class: 'outline small', onclick: async () => { if (await confirmBox(`Take away ${u.username}'s access? They keep their repos but can no longer push or make new ones.`, { danger: true })) decide(u, 'revoke', 'revoked'); } }, 'Revoke') : null,
    ];
    const cols = [['user', u => h('strong', {}, u.username)], ['status', u => statusPill(u.status)], ['repos', u => String(u.repos)], ['asked', u => when(u.requested_at)], ['decided', u => (u.decided_by ? h('span', {}, `${u.decided_by} `, when(u.decided_at)) : '—')], ['', actions]];
    const st = s.status.users;
    mount(
      head('git', 'Git hosting', h('button', { class: 'outline small', onclick: refresh }, 'Refresh')),
      h('p', { class: 'caption' }, `${s.url} · ${s.status.repos} repos · ${st.approved} approved · each approved account can own ${s.status.max_repos_per_user} repos, ${s.status.max_push_mb} MB per push`),
      tabs('requests'),
      h('div', { class: 'stack' },
        h('p', { class: 'eyebrow' }, `waiting for approval (${pending.length})`),
        table(pending, cols, 'Nobody is waiting. People show up here after they sign in with Ward and try to push to a new repo.'),
        h('p', { class: 'eyebrow ward-gap-above' }, 'everyone else'),
        table(rest, cols, 'No other accounts yet.')),
    );
  });

  // ---------------- repos ----------------
  route(/^\/git\/repos$/, async () => {
    const s = await status(); if (!s) return;
    const { repos } = await api('GET', '/api/git/repos');
    const remove = r => h('button', {
      class: 'outline small',
      disabled: !isOwner(),
      title: isOwner() ? '' : 'owners only',
      onclick: async () => {
        if (!await confirmBox(`Delete ${r.name} and every commit in it? This cannot be undone.`, { danger: true })) return;
        try { await api('DELETE', `/api/git/repos/${encodeURIComponent(r.name)}`); toast(`${r.name} deleted`); refresh(); } catch (e) { fail(e); }
      },
    }, 'Delete');
    mount(
      head('git', 'Repos', h('button', { class: 'outline small', onclick: refresh }, 'Refresh')),
      tabs('repos'),
      table(repos, [
        ['repo', r => h('a', { href: `${s.url}/${r.name}.git`, target: '_blank', rel: 'noopener noreferrer' }, r.name)],
        ['owner', r => r.owner_name || 'admin'],
        ['created', r => when(r.created_at)],
        ['', remove],
      ], 'No repos yet.'),
    );
  });
}
