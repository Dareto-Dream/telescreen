// Go: short links at go.deltavdevs.com. Look at them, change where one points or when it expires, switch one off,
// delete one (owners). Making links happens on go itself; clicks are charted in Analytics.

const TABS = [['links', 'Links', '#/go/links'], ['log', 'Log', '#/go/log']];

export function register({ route, api, h, mount, head, toast, fail, confirmBox, ago, me }) {
  const show = (...nodes) => mount(...nodes.filter(Boolean));
  const tabs = active => h('div', { class: 'tabs' }, TABS.map(([id, text, href]) => h('button', { class: active === id ? 'active' : '', onclick: () => { location.hash = href; } }, text)));
  const refresh = () => window.dispatchEvent(new HashChangeEvent('hashchange'));
  const isOwner = () => me()?.level === 'owner';
  const table = (rows, cols, empty) => (rows.length
    ? h('div', { class: 'table-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, cols.map(([name]) => h('th', {}, name)))), h('tbody', {}, rows.map(r => h('tr', {}, cols.map(([name, fn]) => h('td', { class: name === '' ? 'actions' : null }, fn(r))))))))
    : h('p', { class: 'empty' }, empty));
  const act = (fn, done) => async () => { try { await fn(); if (done) toast(done); refresh(); } catch (e) { fail(e); } };

  async function ready(title) {
    const s = await api('GET', '/api/go');
    if (!s.enabled) { show(head('go', title), h('div', { class: 'notice warn' }, 'Set GO_URL and GO_ADMIN_KEY on telescreen to run go from here.')); return false; }
    return true;
  }

  async function edit(link) {
    const destination = prompt(`Where should /${link.slug} go?`, link.destination);
    if (!destination || destination === link.destination) return;
    act(() => api('POST', `/api/go/links/${link.slug}`, { destination }), 'Saved')();
  }
  async function remove(link) {
    if (!await confirmBox(`Delete /${link.slug}? The address stops working.`, { typed: link.slug })) return;
    act(() => api('DELETE', `/api/go/links/${link.slug}`), 'Deleted')();
  }

  route(/^\/go(?:\/links)?(?:\?.*)?$/, async () => {
    if (!await ready('Short links')) return;
    const q = new URLSearchParams(location.hash.split('?')[1] || '').get('q') || '';
    const [o, list] = await Promise.all([api('GET', '/api/go/overview'), api('GET', `/api/go/links${q ? `?q=${encodeURIComponent(q)}` : ''}`)]);
    const search = h('input', { placeholder: 'Search names, addresses or notes', value: q });
    search.addEventListener('keydown', e => { if (e.key === 'Enter') location.hash = `#/go/links?q=${encodeURIComponent(search.value.trim())}`; });
    const t = o.totals;
    show(
      head('go', 'Short links',
        h('a', { href: 'https://go.deltavdevs.com/', target: '_blank', rel: 'noopener', class: 'button-link' }, h('button', { class: 'outline small', type: 'button' }, 'Open go')),
        h('a', { href: 'https://analytics.deltavdevs.com/#/go', target: '_blank', rel: 'noopener', class: 'button-link' }, h('button', { class: 'outline small', type: 'button' }, 'Clicks in Analytics'))),
      tabs('links'),
      h('p', { class: 'caption' }, `${t.links} links (${t.active} live) · ${t.clicks} clicks counted${o.analytics ? '' : ' · analytics reporting is off'}${o.queued ? ` · ${o.queued} reports waiting for analytics` : ''}`),
      h('div', { class: 'row' }, search),
      table(list.links, [
        ['Link', l => h('span', {}, h('a', { class: 'mono', href: `https://go.deltavdevs.com/${l.slug}`, target: '_blank', rel: 'noopener' }, `/${l.slug}`), ' ', h('span', { class: 'caption' }, l.state === 'live' ? '' : l.state))],
        ['Goes to', l => h('span', { class: 'caption' }, l.destination)],
        ['Clicks', l => `${l.clicks}${l.last_click_at ? ` · ${ago(l.last_click_at)}` : ''}`],
        ['Made by', l => `${l.created_by}, ${ago(l.created_at)}`],
        ['', l => h('span', {},
          h('button', { class: 'ghost', onclick: () => edit(l) }, 'edit'), ' ',
          h('button', { class: 'ghost', onclick: act(() => api('POST', `/api/go/links/${l.slug}/${l.disabled_at ? 'enable' : 'disable'}`, {}), l.disabled_at ? 'Turned on' : 'Turned off') }, l.disabled_at ? 'turn on' : 'turn off'), ' ',
          h('button', { class: 'ghost danger-text', disabled: !isOwner(), onclick: () => remove(l) }, 'delete'))],
      ], q ? 'Nothing matches.' : 'No links yet.'),
      list.more ? h('p', { class: 'caption' }, 'Showing the newest 50. Search to narrow it down.') : null,
    );
  });

  route(/^\/go\/log$/, async () => {
    if (!await ready('Log')) return;
    const { audit } = await api('GET', '/api/go/audit');
    show(head('go', 'Log'), tabs('log'),
      table(audit, [['When', e => ago(`${e.at.replace(' ', 'T')}Z`)], ['Who', e => e.actor], ['What', e => e.action], ['Detail', e => h('span', { class: 'mono caption' }, e.detail || '')]], 'Nothing logged yet.'));
  });
}
