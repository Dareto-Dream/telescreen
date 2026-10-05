// The release CDN (a Cloudflare R2 bucket): how full it is against the storage cap, what is in it, and, for an
// owner, uploads to the visualizers folder and deleting objects. Releases go up with tools/r2/sync.mjs, which
// plans around the cap; this page never writes outside visualizers/.

const KIND_LABEL = { package: 'package', feed: 'feed', installer: 'installer', content: 'content', unknown: 'other' };
const KIND_PILL = { package: 'muted', feed: 'yellow', installer: 'muted', content: 'green', unknown: 'red' };

export function register({ route, api, h, mount: baseMount, head, toast, fail, confirmBox, ago, me }) {
  const mount = (...nodes) => baseMount(...nodes.filter(Boolean));
  const isOwner = () => me()?.level === 'owner';
  const refresh = () => window.dispatchEvent(new HashChangeEvent('hashchange'));
  const size = n => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : n < 1e9 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1e9).toFixed(2)} GB`);
  const gb = n => `${(n / 1e9).toFixed(2)} GB`;
  const encodePath = path => path.split('/').map(encodeURIComponent).join('/');
  // Widths go through the CSSOM: the CSP has no 'unsafe-inline', so a style attribute would be ignored.
  const meter = (value, max) => {
    const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
    const fill = h('div');
    fill.style.width = `${pct.toFixed(1)}%`;
    return h('div', { class: `meter${pct >= 100 ? ' full' : pct >= 85 ? ' warn' : ''}`, title: `${pct.toFixed(1)}%` }, fill);
  };
  const go = prefix => { location.hash = prefix ? `#/r2?prefix=${encodeURIComponent(prefix)}` : '#/r2'; };

  route(/^\/r2(?:\?prefix=([^&]*))?$/, async (prefix = '') => {
    const status = await api('GET', '/api/r2');
    if (!status.enabled) { mount(head('release cdn', 'Release CDN'), h('div', { class: 'notice warn' }, 'Set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY on telescreen to manage the release CDN from here.')); return; }
    if (status.error) { mount(head('release cdn', 'Release CDN'), h('div', { class: 'notice error' }, status.error)); return; }

    const u = status.usage;
    const listing = await api('GET', `/api/r2/objects?prefix=${encodeURIComponent(prefix)}`);
    const objects = [...listing.objects];
    const rows = h('tbody');
    const table = h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, ['name', 'kind', 'size', 'changed', ''].map(t => h('th', {}, t)))), rows));

    const row = o => h('tr', {},
      h('td', {}, h('a', { href: `${listing.publicUrl}/${encodePath(o.key)}`, target: '_blank', rel: 'noopener noreferrer' }, o.key.slice(prefix.length))),
      h('td', {}, h('span', { class: `pill ${KIND_PILL[o.kind] || 'muted'}` }, KIND_LABEL[o.kind] || o.kind)),
      h('td', {}, size(o.size)), h('td', {}, o.modified ? ago(o.modified) : ''),
      h('td', { class: 'actions' }, isOwner() ? h('button', { class: 'ghost', onclick: async () => {
        const warn = o.kind === 'feed' || o.kind === 'installer' ? ' Deleting a feed or installer breaks updates or downloads until it is re-uploaded.' : '';
        if (!await confirmBox(`Delete ${o.key} from the release CDN?${warn}`, { typed: o.key.split('/').pop() })) return;
        try { await api('DELETE', `/api/r2/objects/${encodePath(o.key)}`); toast(`Deleted ${o.key}`); refresh(); } catch (e) { fail(e); }
      } }, 'delete') : ''));
    objects.forEach(o => rows.append(row(o)));

    const more = h('button', { class: 'outline small', hidden: !listing.next, onclick: async () => {
      const page = await api('GET', `/api/r2/objects?prefix=${encodeURIComponent(prefix)}&cursor=${encodeURIComponent(more.dataset.next)}`).catch(fail);
      if (!page) return;
      page.objects.forEach(o => rows.append(row(o)));
      more.dataset.next = page.next || '';
      more.hidden = !page.next;
    } }, 'Load more');
    more.dataset.next = listing.next || '';

    const crumbs = [['bucket', '']];
    prefix.split('/').filter(Boolean).reduce((acc, part) => { const next = `${acc}${part}/`; crumbs.push([part, next]); return next; }, '');

    const upload = () => {
      const base = prefix.startsWith('visualizers/') ? prefix : 'visualizers/';
      const file = h('input', { type: 'file' });
      const path = h('input', { value: base, placeholder: 'visualizers/folder/file.png', autocomplete: 'off' });
      file.addEventListener('change', () => { if (file.files[0] && path.value.endsWith('/')) path.value = `${path.value}${file.files[0].name}`; });
      return h('div', { class: 'card stack' },
        h('h3', {}, 'Upload to visualizers/'),
        h('p', { class: 'caption' }, 'Files up to 8 MB. An upload is refused if it would take the bucket past its budget. Releases go up with tools/r2/sync.mjs.'),
        h('div', { class: 'form' }, h('label', { class: 'wide' }, h('span', {}, 'File'), file), h('label', { class: 'wide' }, h('span', {}, 'Path in the bucket'), path)),
        h('div', { class: 'row' }, h('button', { class: 'cta', onclick: async () => {
          const f = file.files[0];
          if (!f) return toast('Choose a file first.', true);
          try {
            await api('PUT', `/api/r2/objects/${encodePath(path.value.trim())}`, f, { raw: true, headers: { 'Content-Type': f.type || 'application/octet-stream' } });
            toast(`Uploaded ${path.value.trim()}`); refresh();
          } catch (e) { fail(e); }
        } }, 'Upload')));
    };

    mount(
      head('release cdn', 'Release CDN', h('button', { class: 'outline small', onclick: refresh }, 'Refresh')),
      h('div', { class: 'card stack' },
        h('div', { class: 'row' }, h('h3', { class: 'grow', style: null }, `${gb(u.totalBytes)} of ${gb(u.budgetBytes)} budget`), h('span', { class: 'caption' }, `${u.objects} objects in ${status.bucket}`)),
        meter(u.totalBytes, u.budgetBytes),
        h('div', { class: 'row' }, Object.entries(u.byKind).map(([k, v]) => h('span', { class: `pill ${KIND_PILL[k] || 'muted'}` }, `${KIND_LABEL[k] || k} ${size(v)}`))),
        h('p', { class: 'caption' }, `R2 has no hard cap of its own and bills past ${gb(u.freeTierBytes)}. The upload tool refuses anything over the budget, never above ${gb(u.hardMaxBytes)}, and a janitor Worker removes junk if the bucket ever passes ${gb(u.hardMaxBytes)}.`)),
      h('div', { class: 'row' }, crumbs.map(([label, p], i) => [i ? h('span', { class: 'caption' }, '/') : null, h('button', { class: i === crumbs.length - 1 ? 'cta small' : 'outline small', onclick: () => go(p) }, label)])),
      listing.folders.length ? h('div', { class: 'row' }, listing.folders.map(f => h('button', { class: 'outline small', onclick: () => go(f) }, `${f.slice(prefix.length)}`))) : null,
      objects.length ? table : h('p', { class: 'empty' }, listing.folders.length ? 'Nothing at this level, only folders.' : 'Nothing here.'),
      more,
      isOwner() ? upload() : h('div', { class: 'notice warn' }, 'Only owners can upload or delete.'),
    );
  });
}
