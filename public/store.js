// Store: shared files at store.deltavdevs.com. Look at every upload, change who can open it or how long it stays,
// delete one (owners). Uploading happens on store itself; downloads are charted in Analytics.

const TABS = [['uploads', 'Uploads', '#/store/uploads'], ['log', 'Log', '#/store/log']];
const bytes = n => {
  const x = Number(n || 0);
  return x < 1024 ** 2 ? `${Math.round(x / 1024)} KB` : x < 1024 ** 3 ? `${(x / 1024 ** 2).toFixed(1)} MB` : `${(x / 1024 ** 3).toFixed(2)} GB`;
};

export function register({ route, api, h, mount, head, toast, fail, confirmBox, ago, me }) {
  const show = (...nodes) => mount(...nodes.filter(Boolean));
  const tabs = active => h('div', { class: 'tabs' }, TABS.map(([id, text, href]) => h('button', { class: active === id ? 'active' : '', onclick: () => { location.hash = href; } }, text)));
  const refresh = () => window.dispatchEvent(new HashChangeEvent('hashchange'));
  const isOwner = () => me()?.level === 'owner';
  const table = (rows, cols, empty) => (rows.length
    ? h('div', { class: 'table-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, cols.map(([name]) => h('th', {}, name)))), h('tbody', {}, rows.map(r => h('tr', {}, cols.map(([name, fn]) => h('td', { class: name === '' ? 'actions' : null }, fn(r))))))))
    : h('p', { class: 'empty' }, empty));
  const act = (fn, done) => async () => { try { await fn(); if (done) toast(done); refresh(); } catch (e) { fail(e); } };
  const rule = b => `${b.access === 'public' ? 'public' : `guarded · ${b.mode}`} · ${b.view === 'ui' ? 'with UI' : 'raw'}`;

  async function ready(title) {
    const s = await api('GET', '/api/store');
    if (!s.enabled) { show(head('store', title), h('div', { class: 'notice warn' }, 'Set STORE_URL and STORE_ADMIN_KEY on telescreen to run store from here.')); return false; }
    return true;
  }

  async function extend(b) {
    const value = prompt(`How long should “${b.title}” stay? Use never, a number of days like 30d, or a date like 2026-12-31.`, b.expires_at ? b.expires_at.slice(0, 10) : 'never');
    if (!value) return;
    act(() => api('POST', `/api/store/bundles/${b.id}`, { expires: value.trim() }), 'Saved')();
  }
  async function remove(b) {
    if (!await confirmBox(`Delete “${b.title}” and every file in it? The link stops working and the files are removed.`, { typed: b.id })) return;
    act(() => api('DELETE', `/api/store/bundles/${b.id}`), 'Deleted')();
  }

  route(/^\/store(?:\/uploads)?(?:\?.*)?$/, async () => {
    if (!await ready('Uploads')) return;
    const q = new URLSearchParams(location.hash.split('?')[1] || '').get('q') || '';
    const [o, list] = await Promise.all([api('GET', '/api/store/overview'), api('GET', `/api/store/bundles${q ? `?q=${encodeURIComponent(q)}` : ''}`)]);
    const search = h('input', { placeholder: 'Search titles, ids or uploader', value: q });
    search.addEventListener('keydown', e => { if (e.key === 'Enter') location.hash = `#/store/uploads?q=${encodeURIComponent(search.value.trim())}`; });
    show(
      head('store', 'Uploads',
        h('a', { href: 'https://store.deltavdevs.com/new', target: '_blank', rel: 'noopener', class: 'button-link' }, h('button', { class: 'cta small', type: 'button' }, 'New upload')),
        h('a', { href: 'https://analytics.deltavdevs.com/#/store', target: '_blank', rel: 'noopener', class: 'button-link' }, h('button', { class: 'outline small', type: 'button' }, 'Downloads in Analytics'))),
      tabs('uploads'),
      h('p', { class: 'caption' }, `${o.bundles} live uploads, ${o.files} files · ${bytes(o.used)} of ${bytes(o.budget)} budget · ${o.downloads} downloads${o.trash ? ` · ${o.trash} files waiting to be deleted from storage` : ''}${o.pending_files ? ` · ${o.pending_files} unfinished uploads` : ''}${o.analytics ? '' : ' · analytics reporting is off'}`),
      h('div', { class: 'row' }, search),
      table(list.bundles, [
        ['Upload', b => h('span', {}, b.state === 'ready' ? h('a', { href: `${list.url}${b.id}`, target: '_blank', rel: 'noopener' }, b.title) : b.title, ' ', h('span', { class: 'caption' }, b.state === 'ready' ? '' : b.state), h('br'), h('span', { class: 'caption mono' }, b.id))],
        ['Sharing', b => rule(b)],
        ['Size', b => `${b.file_count} files, ${bytes(b.bytes)}`],
        ['Until', b => (b.expires_at ? b.expires_at.slice(0, 10) : 'permanent')],
        ['Downloads', b => String(b.downloads)],
        ['By', b => `${b.created_by}, ${ago(`${b.created_at.replace(' ', 'T')}Z`)}`],
        ['', b => (b.state === 'expired' ? '' : h('span', {},
          h('button', { class: 'ghost', onclick: () => extend(b) }, 'expiry'), ' ',
          h('button', { class: 'ghost', onclick: act(() => api('POST', `/api/store/bundles/${b.id}`, b.access === 'public' ? { access: 'guarded', mode: 'whitelist' } : { access: 'public' }), b.access === 'public' ? 'Now guarded (whitelist)' : 'Now public') }, b.access === 'public' ? 'guard it' : 'make public'), ' ',
          h('button', { class: 'ghost', onclick: act(() => api('POST', `/api/store/bundles/${b.id}`, { view: b.view === 'ui' ? 'raw' : 'ui' }), 'Saved') }, b.view === 'ui' ? 'show raw' : 'show UI'), ' ',
          h('button', { class: 'ghost danger-text', disabled: !isOwner(), onclick: () => remove(b) }, 'delete')))],
      ], q ? 'Nothing matches.' : 'Nothing uploaded yet.'),
      list.more ? h('p', { class: 'caption' }, 'Showing the newest 50. Search to narrow it down.') : null,
    );
  });

  route(/^\/store\/log$/, async () => {
    if (!await ready('Log')) return;
    const { audit } = await api('GET', '/api/store/audit');
    show(head('store', 'Log'), tabs('log'),
      table(audit, [['When', e => ago(`${e.at.replace(' ', 'T')}Z`)], ['Who', e => e.actor], ['What', e => e.action], ['Detail', e => h('span', { class: 'mono caption' }, e.detail || '')]], 'Nothing logged yet.'));
  });
}
