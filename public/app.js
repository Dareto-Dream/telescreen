// Telescreen client. No framework, no build step. All DOM is built with h(),
// which only ever sets textContent, so record data can't inject markup.

const $ = sel => document.querySelector(sel);
let me = null;

// ---------- tiny DOM helper ----------
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'value') el.value = v;
    else if (k === 'checked') el.checked = Boolean(v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}
const mount = (...nodes) => { $('#view').replaceChildren(...nodes); };
const head = (eyebrow, title, ...actions) => h('div', { class: 'view-head' }, h('div', {}, h('p', { class: 'eyebrow' }, eyebrow), h('h1', { class: 'headline' }, title)), h('div', { class: 'row' }, actions));
const dot = ok => h('span', { class: `dot ${ok === true ? 'ok' : ok === false ? 'bad' : 'warn'}` });

function toast(message, error = false) {
  const el = h('div', { class: `toast${error ? ' error' : ''}` }, message);
  $('#toasts').append(el);
  setTimeout(() => el.remove(), error ? 8000 : 3500);
}

function confirmBox(message, { danger = true, typed = null } = {}) {
  return new Promise(resolve => {
    const input = typed ? h('input', { placeholder: typed, autocomplete: 'off' }) : null;
    const ok = h('button', { class: danger ? 'danger' : 'cta', type: 'button' }, 'Do it');
    const dialog = h('dialog', {},
      h('p', { class: 'subheadline' }, message),
      typed ? h('label', {}, h('span', {}, 'Type ', h('code', {}, typed), ' to confirm'), input) : null,
      h('div', { class: 'row end', style: 'margin-top: 1rem' }, h('button', { class: 'outline', type: 'button', onclick: () => { dialog.close(); resolve(false); } }, 'Cancel'), ok));
    ok.addEventListener('click', () => { if (typed && input.value !== typed) return input.focus(); dialog.close(); resolve(true); });
    dialog.addEventListener('close', () => { dialog.remove(); resolve(false); });
    document.body.append(dialog);
    dialog.showModal();
    (input || ok).focus();
  });
}

// ---------- API ----------
async function api(method, path, body, { raw = false, headers = {} } = {}) {
  const init = { method, headers: { ...headers }, credentials: 'same-origin' };
  if (method !== 'GET') init.headers['X-Telescreen-CSRF'] = me?.csrf || '';
  if (body !== undefined) {
    if (raw) init.body = body;
    else { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
  }
  const response = await fetch(path, init);
  if (response.status === 401) { showLogin(); throw new Error('Signed out'); }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) { const e = new Error(data.error || `HTTP ${response.status}`); e.detail = data.detail; throw e; }
  return data;
}
const qs = params => new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '')).toString();
const fail = err => { if (err.message !== 'Signed out') toast(err.message, true); };

// ---------- formatting ----------
const ago = iso => {
  if (!iso) return '—';
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${s}s ago`; if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`; return `${Math.round(s / 86400)}d ago`;
};
const ttlText = ms => ms === null || ms === undefined ? '' : ms === -1 ? '∞' : ms === -2 ? 'gone' : ms < 60_000 ? `${Math.round(ms / 1000)}s` : ms < 3_600_000 ? `${Math.round(ms / 60_000)}m` : ms < 86_400_000 ? `${Math.round(ms / 3_600_000)}h` : `${Math.round(ms / 86_400_000)}d`;
const bytes = n => !n ? '' : n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : n < 1073741824 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1073741824).toFixed(2)} GB`;
const show = v => v === null || v === undefined ? 'NULL' : typeof v === 'object' ? JSON.stringify(v) : String(v);

// ---------- routing ----------
const routes = [];
const route = (pattern, render) => routes.push({ pattern, render });
function navigate() {
  const hash = location.hash.replace(/^#/, '') || '/overview';
  for (const a of document.querySelectorAll('#nav a')) { const path = hash.split('?')[0]; a.classList.toggle('active', path === a.dataset.path || path.startsWith(`${a.dataset.path}/`)); }
  for (const { pattern, render } of routes) {
    const m = hash.match(pattern);
    if (m) { mount(h('p', { class: 'empty' }, 'Loading…')); return render(...m.slice(1).map(value => value === undefined ? undefined : decodeURIComponent(value))).catch(err => { fail(err); mount(h('div', { class: 'notice error' }, err.message)); }); }
  }
  location.hash = '#/overview';
}
window.addEventListener('hashchange', navigate);

function buildNav(pg, redis) {
  const link = (path, label, extra) => h('a', { href: `#${path}`, 'data-path': path }, h('span', {}, label), extra);
  $('#nav').replaceChildren(
    link('/overview', 'Overview'),
    h('div', { class: 'nav-group' }, 'Publish'),
    link('/content/projects', 'Projects'),
    link('/content/songs', 'Music'),
    link('/content/albums', 'Releases'),
    link('/content/staff', 'People'),
    link('/files', 'File library'),
    h('div', { class: 'nav-group' }, 'Moderate'),
    link('/deltatime', 'Account review'),
    h('div', { class: 'nav-group' }, 'Ward'),
    link('/ward/accounts', 'Accounts'),
    link('/ward/apps', 'Apps'),
    h('div', { class: 'nav-group' }, 'Systems'),
    pg.map(c => link(`/pg/${c.name}`, `pg · ${c.name}`, dot(c.ok))),
    redis.map(c => link(`/redis/${c.name}`, `redis · ${c.name}`, dot(c.ok))),
    h('div', { class: 'nav-group' }, 'Infra'),
    link('/railway', 'Railway'),
  );
}

// ---------- boot ----------
function showLogin(state = {}) {
  me = null;
  $('#login-ward').hidden = !state.ward;
  $('#login-google').hidden = !state.google;
  $('#shell').hidden = true; $('#login').hidden = false;
  const error = new URLSearchParams(location.search).get('error');
  if (error) { $('#login-error').textContent = error; $('#login-error').hidden = false; history.replaceState(null, '', '/'); }
}

async function boot() {
  const state = await fetch('/auth/state').then(r => r.json()).catch(() => ({ signedIn: false }));
  if (!state.signedIn) return showLogin(state);
  me = await api('GET', '/api/me');
  $('#login').hidden = true; $('#shell').hidden = false;
  $('#me').replaceChildren(me.picture ? h('img', { src: me.picture, alt: '', referrerpolicy: 'no-referrer' }) : null, h('span', { title: me.email || me.name }, `${me.email || me.name} · ${me.level}`));
  $('#logout').onclick = async () => { await api('POST', '/auth/logout').catch(() => {}); location.href = '/'; };
  const [pg, redis] = await Promise.all([api('GET', '/api/pg').catch(() => []), api('GET', '/api/redis').catch(() => [])]);
  buildNav(pg, redis);
  navigate();
}

// =====================================================================
// Overview
// =====================================================================
route(/^\/overview$/, async () => {
  const [http, pg, redis, railway] = await Promise.all([
    api('GET', '/api/http').catch(e => ({ error: e.message })),
    api('GET', '/api/pg').catch(e => ({ error: e.message })),
    api('GET', '/api/redis').catch(e => ({ error: e.message })),
    api('GET', '/api/railway').catch(e => ({ error: e.message })),
  ]);
  const section = (title, body) => h('section', { class: 'stack', style: 'margin-bottom: 2rem' }, h('p', { class: 'eyebrow' }, title), body);
  const errorOr = (data, fn) => data.error ? h('div', { class: 'notice error' }, data.error) : fn(data);
  mount(
    head('telescreen', 'Operations desk', h('button', { class: 'outline small', onclick: navigate }, 'Refresh')),
    h('section', { class: 'command-deck' },
      h('a', { href: '#/content/projects/new', class: 'command-card primary-action' }, h('span', { class: 'command-icon' }, '+'), h('span', {}, h('strong', {}, 'Create a project'), h('small', {}, 'Add it, shape its details, then place it.'))),
      h('a', { href: '#/content/songs/new', class: 'command-card' }, h('span', { class: 'command-icon' }, '♫'), h('span', {}, h('strong', {}, 'Add music'), h('small', {}, 'Publish a song or update its metadata.'))),
      h('a', { href: '#/files', class: 'command-card' }, h('span', { class: 'command-icon' }, '↑'), h('span', {}, h('strong', {}, 'Upload files'), h('small', {}, 'Manage everything on the CDN.'))),
      h('a', { href: '#/deltatime', class: 'command-card' }, h('span', { class: 'command-icon' }, '!'), h('span', {}, h('strong', {}, 'Review accounts'), h('small', {}, 'Investigate fraud and apply verdicts.'))),
    ),
    section('Endpoints', errorOr(http, list => list.length ? h('div', { class: 'grid' }, list.map(c => h('div', { class: 'card tight' },
      h('h3', {}, dot(c.ok), c.name), h('dl', { class: 'stat' }, h('dt', {}, 'status'), h('dd', {}, c.status ?? c.body), h('dt', {}, 'latency'), h('dd', {}, `${c.ms}ms`), h('dt', {}, 'url'), h('dd', { title: c.url }, c.url))))) : h('p', { class: 'empty' }, 'No TELESCREEN_HTTP_* endpoints configured.'))),
    section('Postgres', errorOr(pg, list => list.length ? h('div', { class: 'grid' }, list.map(c => h('a', { href: `#/pg/${c.name}`, class: 'button-link' }, h('div', { class: 'card tight interactive' },
      h('h3', {}, dot(c.ok), c.name), c.ok ? h('dl', { class: 'stat' }, h('dt', {}, 'database'), h('dd', {}, c.database), h('dt', {}, 'size'), h('dd', {}, c.size), h('dt', {}, 'connections'), h('dd', {}, c.connections), h('dt', {}, 'version'), h('dd', {}, c.version)) : h('p', { class: 'caption' }, c.error))))) : h('p', { class: 'empty' }, 'No TELESCREEN_PG_* connections configured.'))),
    section('Redis', errorOr(redis, list => list.length ? h('div', { class: 'grid' }, list.map(c => h('a', { href: `#/redis/${c.name}`, class: 'button-link' }, h('div', { class: 'card tight interactive' },
      h('h3', {}, dot(c.ok), c.name), c.ok ? h('dl', { class: 'stat' }, h('dt', {}, 'keys'), h('dd', {}, c.keys), h('dt', {}, 'memory'), h('dd', {}, `${c.memory} (peak ${c.peak})`), h('dt', {}, 'clients'), h('dd', {}, c.clients), h('dt', {}, 'hit rate'), h('dd', {}, c.hits + c.misses ? `${Math.round((c.hits / (c.hits + c.misses)) * 100)}%` : '—')) : h('p', { class: 'caption' }, c.error))))) : h('p', { class: 'empty' }, 'No TELESCREEN_REDIS_* connections configured.'))),
    section('Railway', errorOr(railway, data => !data.enabled ? h('p', { class: 'empty' }, 'Set RAILWAY_PROJECT_TOKEN to see services.') : h('div', { class: 'grid' }, data.services.map(s => h('a', { href: '#/railway', class: 'button-link' }, h('div', { class: 'card tight interactive' },
      h('h3', {}, dot(s.deployment ? s.deployment.status === 'SUCCESS' ? true : ['FAILED', 'CRASHED'].includes(s.deployment.status) ? false : null : null), s.name),
      h('p', { class: 'caption' }, s.deployment ? `${s.deployment.status} · ${ago(s.deployment.createdAt)}` : 'no deployments'))))))),
  );
});

// =====================================================================
// Site content (replaces /balls)
// =====================================================================
const PROGRESS = ['concept', 'in_progress', 'in_testing', 'paused', 'complete', 'discontinued'];
const FIELDS = {
  projects: [
    ['title', 'text'], ['progress', 'select', PROGRESS], ['description', 'textarea', null, true], ['tags', 'tags'], ['link', 'text'],
    ['thumbnail_url', 'text'], ['blog_project_id', 'text'], ['markdown_details', 'markdown', null, true],
    ['downloads', 'json', '[{ "label": "", "url": "" }]', true], ['videos', 'json', '[{ "label": "", "url": "" }]', true], ['iframes', 'json', '[{ "label": "", "url": "" }]', true],
  ],
  songs: [
    ['title', 'text'], ['artist', 'text'], ['description', 'textarea', null, true], ['release_date', 'text'], ['album', 'text'],
    ['audio_url', 'text'], ['thumbnail_url', 'text'], ['strudel_url', 'text'], ['lyrics_file', 'text'], ['duration', 'number'], ['archive', 'bool'],
    ['tags', 'tags'], ['metadata', 'json', '{ "key": "", "genre": "", "bpm": 120 }', true], ['credits', 'json', '{ "Producer": "" }', true], ['lyrics', 'markdown', null, true],
  ],
  albums: [
    ['title', 'text'], ['artist', 'text'], ['type', 'select', ['single', 'ep', 'album']], ['release_date', 'text'], ['cover_url', 'text'], ['archive', 'bool'],
    ['description', 'textarea', null, true], ['genres', 'tags'], ['tags', 'tags'], ['track_ids', 'json', '[1, 2, 3]', true], ['credits', 'json', '{ "Mastering": "" }', true],
  ],
  staff: [['name', 'text'], ['role', 'text'], ['link', 'text'], ['link_label', 'text'], ['bio', 'textarea', null, true]],
};
const label = (c, r) => (c === 'staff' ? r.name : r.title) || `#${r.id}`;
const subLabel = (c, r) => c === 'projects' ? r.progress : c === 'songs' ? r.artist : c === 'albums' ? `${r.type || ''} · ${(r.track_ids || []).length} tracks` : r.role;
const fieldLabel = name => name.replace(/_/g, ' ').replace(/\b\w/g, letter => letter.toUpperCase());

route(/^\/content\/(projects|songs|albums|staff)(?:\/(\d+|new))?$/, async (collection, selected) => {
  let records = await api('GET', `/api/content/${collection}`);
  let order = records.map(r => r.id);
  let orderDirty = false;
  const listEl = h('div', { class: 'list' });
  const editorEl = h('div', {});
  const filter = h('input', { placeholder: `Filter ${collection}…`, oninput: () => drawList() });
  const saveOrder = h('button', { class: 'cta small', hidden: true, onclick: async () => {
    try { await api('POST', `/api/content/${collection}/reorder`, order); orderDirty = false; saveOrder.hidden = true; toast('Order saved'); } catch (e) { fail(e); }
  } }, 'Save order');

  function drawList() {
    const term = filter.value.toLowerCase();
    const byId = new Map(records.map(r => [r.id, r]));
    listEl.replaceChildren(...order.map(id => byId.get(id)).filter(r => r && (!term || JSON.stringify(r).toLowerCase().includes(term))).map(r => h('div', { class: `record-row${String(r.id) === selected ? ' selected' : ''}` },
      r.thumbnail_url || r.cover_url ? h('img', { class: 'record-art', src: r.thumbnail_url || r.cover_url, alt: '' }) : h('span', { class: 'record-initial' }, label(collection, r).slice(0, 1)),
      h('button', { class: 'record-open grow', onclick: () => { location.hash = `#/content/${collection}/${r.id}`; } },
        h('span', { class: 'label' }, label(collection, r)), h('span', { class: 'sub' }, subLabel(collection, r) || `#${r.id}`)),
      term ? null : h('div', { class: 'move-controls' },
        h('button', { class: 'ghost', title: 'Move up', 'aria-label': `Move ${label(collection, r)} up`, onclick: () => move(r.id, -1) }, '↑'),
        h('button', { class: 'ghost', title: 'Move down', 'aria-label': `Move ${label(collection, r)} down`, onclick: () => move(r.id, 1) }, '↓')))));
    if (!listEl.children.length) listEl.append(h('p', { class: 'empty' }, 'Nothing here.'));
  }
  function move(id, delta) {
    const i = order.indexOf(id), j = i + delta;
    if (j < 0 || j >= order.length) return;
    [order[i], order[j]] = [order[j], order[i]];
    orderDirty = true; saveOrder.hidden = false; drawList();
  }

  function drawEditor() {
    if (!selected) return editorEl.replaceChildren(h('div', { class: 'card sunken empty' }, `Pick a ${collection.replace(/s$/, '')} or make a new one.`));
    const isNew = selected === 'new';
    const record = isNew ? {} : records.find(r => String(r.id) === selected);
    if (!record) return editorEl.replaceChildren(h('div', { class: 'notice error' }, 'Record not found.'));
    const known = new Set(FIELDS[collection].map(f => f[0]).concat(['id', 'slug']));
    const extras = Object.fromEntries(Object.entries(record).filter(([k]) => !known.has(k)));
    const inputs = {};
    const fields = FIELDS[collection].map(([name, type, extra, wide]) => {
      const value = record[name];
      let input;
      if (type === 'select') input = h('select', {}, h('option', { value: '' }, '—'), extra.map(o => h('option', { value: o, selected: value === o }, o)));
      else if (type === 'bool') input = h('input', { type: 'checkbox', checked: Boolean(value) });
      else if (type === 'textarea' || type === 'markdown') input = h('textarea', { class: type === 'markdown' ? 'code' : null, rows: type === 'markdown' ? 14 : 3 });
      else if (type === 'json') input = h('textarea', { class: 'code', rows: 5, placeholder: extra });
      else input = h('input', { type: type === 'number' ? 'number' : 'text', step: 'any' });
      if (type === 'tags') input.value = (value || []).join(', ');
      else if (type === 'json') input.value = value === undefined || value === null ? '' : JSON.stringify(value, null, 2);
      else if (type !== 'bool' && type !== 'select') input.value = value ?? '';
      inputs[name] = { input, type };
      return h('label', { class: `${wide || type === 'bool' ? 'wide ' : ''}${type === 'bool' ? 'inline' : ''}` }, type === 'bool' ? [input, fieldLabel(name)] : [h('span', {}, fieldLabel(name), type === 'tags' ? h('span', { class: 'hint' }, ' comma separated') : type === 'json' ? h('span', { class: 'hint' }, ' JSON') : null), input]);
    });
    const extraInput = h('textarea', { class: 'code', rows: 4 });
    extraInput.value = Object.keys(extras).length ? JSON.stringify(extras, null, 2) : '';

    function collect() {
      const out = {};
      for (const [name, { input, type }] of Object.entries(inputs)) {
        if (type === 'bool') out[name] = input.checked;
        else if (type === 'tags') out[name] = input.value.split(',').map(s => s.trim()).filter(Boolean);
        else if (type === 'number') out[name] = input.value === '' ? null : Number(input.value);
        else if (type === 'json') { if (input.value.trim()) { try { out[name] = JSON.parse(input.value); } catch { throw new Error(`${name} isn't valid JSON`); } } }
        else out[name] = input.value;
      }
      if (extraInput.value.trim()) { try { Object.assign(out, JSON.parse(extraInput.value)); } catch { throw new Error('Extra fields aren\'t valid JSON'); } }
      return out;
    }
    const save = async () => {
      try {
        const body = collect();
        if (isNew) { const res = await api('POST', `/api/content/${collection}`, body); toast('Created'); location.hash = `#/content/${collection}/${res.id}`; }
        else { await api('PATCH', `/api/content/${collection}/${record.id}`, body); toast('Saved'); records = await api('GET', `/api/content/${collection}`); drawList(); }
      } catch (e) { fail(e); }
    };
    const remove = async () => {
      if (!await confirmBox(`Delete “${label(collection, record)}”? This is permanent.`, { typed: 'delete' })) return;
      try { await api('DELETE', `/api/content/${collection}/${record.id}`); toast('Deleted'); location.hash = `#/content/${collection}`; } catch (e) { fail(e); }
    };
    editorEl.replaceChildren(h('div', { class: 'card editor-card stack' },
      h('div', { class: 'editor-title' }, h('div', {}, h('p', { class: 'eyebrow' }, isNew ? 'new record' : `editing ${collection.slice(0, -1)}`), h('h2', { class: 'headline' }, isNew ? `New ${collection.replace(/s$/, '')}` : label(collection, record))), isNew ? null : h('span', { class: 'outline-badge' }, `id ${record.id}`)),
      collection === 'projects' ? h('p', { class: 'caption' }, 'Use the arrows in the project list to place this project on the site. Save Order publishes the arrangement.') : null,
      h('div', { class: 'form' }, fields, h('label', { class: 'wide advanced-fields' }, h('span', {}, 'Extra fields', h('span', { class: 'hint' }, ' JSON object, merged on save')), extraInput)),
      h('div', { class: 'row end' }, isNew ? null : h('button', { class: 'danger', onclick: remove }, 'Delete'), h('button', { class: 'cta', onclick: save }, isNew ? 'Create' : 'Save'))));
  }

  mount(
    head('publishing', collection === 'songs' ? 'Music library' : collection[0].toUpperCase() + collection.slice(1), saveOrder, h('button', { class: 'cta small', onclick: () => { location.hash = `#/content/${collection}/new`; } }, `+ New ${collection.slice(0, -1)}`)),
    h('div', { class: 'workspace-note' }, h('span', {}, `${records.length} ${collection}`), collection === 'projects' ? h('span', {}, 'Move projects with the arrows, then save the order.') : h('span', {}, 'Select a record to edit it.')),
    h('div', { class: 'split content-workspace' }, h('div', { class: 'card tight stack' }, filter, listEl), editorEl),
  );
  drawList(); drawEditor();
  window.addEventListener('hashchange', function warn() { window.removeEventListener('hashchange', warn); if (orderDirty) toast('Unsaved order change discarded', true); }, { once: true });
});

// =====================================================================
// CDN files
// =====================================================================
route(/^\/files(?:\/(.*))?$/, async (path = '') => {
  const data = await api('GET', `/api/files?${qs({ path })}`);
  const go = p => { location.hash = `#/files/${p}`; };
  const join = name => [data.path, name].filter(Boolean).join('/');
  const parts = data.path ? data.path.split('/') : [];
  const upload = h('input', { type: 'file', multiple: true, hidden: true, onchange: async () => {
    for (const file of upload.files) {
      try { toast(`Uploading ${file.name}…`); await api('PUT', `/api/files?${qs({ path: join(file.name) })}`, file, { raw: true, headers: { 'Content-Type': file.type || 'application/octet-stream' } }); } catch (e) { fail(e); }
    }
    navigate();
  } });
  const mkdir = async () => { const name = prompt('Folder name'); if (!name) return; try { await api('POST', '/api/files/mkdir', { path: join(name) }); navigate(); } catch (e) { fail(e); } };
  const rename = async item => {
    const to = prompt('New path (relative to CDN root)', item.path); if (!to || to === item.path) return;
    try { await api('POST', '/api/files/move', { from: item.path, to, dir: item.dir }); toast('Moved'); navigate(); } catch (e) { fail(e); }
  };
  const remove = async item => {
    if (!await confirmBox(`Delete ${item.dir ? 'folder' : 'file'} ${item.path}?${item.dir ? ' Everything inside goes too.' : ''}`, item.dir ? { typed: item.name } : {})) return;
    try { await api('DELETE', '/api/files', { path: item.path, dir: item.dir }); toast('Deleted'); navigate(); } catch (e) { fail(e); }
  };
  mount(
    head('cdn.deltavdevs.com', 'CDN files', upload, h('button', { class: 'outline small', onclick: mkdir }, 'New folder'), h('button', { class: 'cta small', onclick: () => upload.click() }, 'Upload')),
    h('div', { class: 'crumbs', style: 'margin-bottom: 1rem' }, h('button', { class: 'ghost', onclick: () => go('') }, '/'), parts.map((p, i) => [h('span', { class: 'caption' }, '/'), h('button', { class: 'ghost', onclick: () => go(parts.slice(0, i + 1).join('/')) }, p)])),
    h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, 'name'), h('th', {}, 'size'), h('th', {}, 'type'), h('th', {}, 'modified'), h('th', {}, ''))),
      h('tbody', {}, data.items.length ? data.items.map(item => h('tr', {},
        h('td', {}, item.dir ? h('a', { href: `#/files/${item.path}` }, `${item.name}/`) : h('a', { href: `${data.publicBase}/${item.path.split('/').map(encodeURIComponent).join('/')}`, target: '_blank', rel: 'noopener noreferrer' }, item.name)),
        h('td', {}, item.dir ? '' : bytes(item.size)), h('td', {}, item.type || ''), h('td', {}, item.modified ? ago(item.modified) : ''),
        h('td', { class: 'actions' },
          item.dir ? null : h('a', { href: `/api/files/raw?${qs({ path: item.path })}`, class: 'button-link' }, h('button', { class: 'ghost', type: 'button' }, 'download')),
          item.dir ? null : h('button', { class: 'ghost', onclick: () => navigator.clipboard.writeText(`${data.publicBase}/${item.path}`).then(() => toast('URL copied')) }, 'copy url'),
          h('button', { class: 'ghost', onclick: () => rename(item) }, 'move'),
          h('button', { class: 'ghost', onclick: () => remove(item) }, 'delete')))) : h('tr', {}, h('td', { colspan: 5, class: 'empty' }, 'Empty folder.'))))),
  );
});

// =====================================================================
// Postgres
// =====================================================================
function resultTable(result, { columns, onRow } = {}) {
  if (!result.fields.length) return h('p', { class: 'caption' }, `${result.command || 'OK'}${result.rowCount !== null ? ` · ${result.rowCount} rows` : ''}`);
  const types = columns ? Object.fromEntries(columns.map(c => [c.name, c])) : {};
  return h('div', { class: 'stack' },
    h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, result.fields.map(f => h('th', {}, types[f]?.pk ? `🔑 ${f}` : f, types[f] ? h('span', { class: 'type' }, types[f].type) : null)))),
      h('tbody', {}, result.rows.map(row => h('tr', { class: onRow ? 'clickable' : null, onclick: onRow ? () => onRow(row) : null }, row.map(v => h('td', { class: v === null ? 'null' : null, title: show(v).slice(0, 2000) }, show(v).slice(0, 300)))))))),
    h('p', { class: 'caption' }, `${result.rows.length} row${result.rows.length === 1 ? '' : 's'}${result.truncated ? ' (truncated to 1000)' : ''}${result.command && result.command !== 'SELECT' ? ` · ${result.command} ${result.rowCount}` : ''}`));
}

route(/^\/pg\/([a-z0-9_]+)(?:\/(sql|t)(?:\/([^/]+)\/([^/]+))?)?$/, async (conn, mode = 't', schema, table) => {
  const tables = await api('GET', `/api/pg/${conn}/tables`);
  const filter = h('input', { placeholder: 'Filter tables…', oninput: () => drawTables() });
  const tablesEl = h('div', { class: 'list' });
  const pane = h('div', { class: 'stack' });
  function drawTables() {
    const term = filter.value.toLowerCase();
    tablesEl.replaceChildren(...tables.filter(t => !term || `${t.schema}.${t.name}`.includes(term)).map(t => h('button', {
      class: schema === t.schema && table === t.name ? 'active' : '', onclick: () => { location.hash = `#/pg/${conn}/t/${encodeURIComponent(t.schema)}/${encodeURIComponent(t.name)}`; },
    }, h('span', { class: 'label' }, t.schema === 'public' ? t.name : `${t.schema}.${t.name}`), h('span', { class: 'sub' }, t.kind === 'v' ? 'view' : t.kind === 'm' ? 'matview' : `~${t.estimate} · ${t.size}`))));
  }
  drawTables();
  mount(
    head(`postgres · ${conn}`, mode === 'sql' ? 'SQL console' : table ? `${schema}.${table}` : 'Tables',
      h('button', { class: mode === 'sql' ? 'cta small' : 'outline small', onclick: () => { location.hash = `#/pg/${conn}/sql`; } }, 'SQL console')),
    h('div', { class: 'split' }, h('div', { class: 'card tight stack' }, filter, tablesEl), pane),
  );
  if (mode === 'sql') return sqlConsole(conn, pane);
  if (!table) return pane.replaceChildren(h('div', { class: 'card sunken empty' }, 'Pick a table, or open the SQL console.'));
  await tableBrowser(conn, schema, table, pane, 0);
});

async function tableBrowser(conn, schema, name, pane, offset) {
  const limit = 100;
  const data = await api('GET', `/api/pg/${conn}/table?${qs({ schema, name, limit, offset })}`);
  const pkCols = data.columns.filter(c => c.pk).map(c => c.name);
  const editable = ['r', 'p'].includes(data.kind) && pkCols.length > 0;
  const rowEditor = row => {
    const values = row ? Object.fromEntries(data.fields.map((f, i) => [f, row[i]])) : {};
    const inputs = {};
    const form = h('div', { class: 'form' }, data.columns.map(c => {
      const isNull = h('input', { type: 'checkbox', checked: row ? values[c.name] === null : false });
      const input = h('textarea', { class: 'code', rows: 1, placeholder: row ? '' : c.default ? `default: ${c.default}` : '' });
      input.value = row && values[c.name] !== null ? (typeof values[c.name] === 'object' ? JSON.stringify(values[c.name]) : String(values[c.name])) : '';
      inputs[c.name] = { input, isNull, original: input.value, wasNull: row ? values[c.name] === null : false };
      return h('label', { class: 'wide' }, h('span', {}, c.pk ? '🔑 ' : '', c.name, h('span', { class: 'hint' }, ` ${c.type}${c.nullable ? '' : ' not null'}`)), input, c.nullable ? h('label', { class: 'inline hint' }, isNull, 'NULL') : null);
    }));
    const dialog = h('dialog', { style: 'width: 720px' });
    const changed = () => Object.fromEntries(Object.entries(inputs).filter(([, v]) => row ? (v.isNull.checked !== v.wasNull || (!v.isNull.checked && v.input.value !== v.original)) : (v.isNull.checked || v.input.value !== '')).map(([k, v]) => [k, v.isNull.checked ? null : v.input.value]));
    const pk = row ? Object.fromEntries(pkCols.map(k => [k, values[k] === null ? null : String(values[k])])) : null;
    const act = async (method, body, msg) => { try { await api(method, `/api/pg/${conn}/row`, { schema, name, ...body }); toast(msg); dialog.close(); await tableBrowser(conn, schema, name, pane, offset); } catch (e) { fail(e); } };
    dialog.append(h('div', { class: 'stack' },
      h('h2', { class: 'headline', style: 'margin:0' }, row ? 'Edit row' : 'Insert row'),
      h('div', { style: 'max-height: 60vh; overflow: auto; padding-right: 4px' }, form),
      h('div', { class: 'row end' },
        row ? h('button', { class: 'danger', onclick: async () => { if (await confirmBox(`Delete this row from ${schema}.${name}?`)) act('DELETE', { pk }, 'Row deleted'); } }, 'Delete') : null,
        h('span', { class: 'grow' }),
        h('button', { class: 'outline', onclick: () => dialog.close() }, 'Cancel'),
        h('button', { class: 'cta', onclick: () => { const v = changed(); if (!Object.keys(v).length) return dialog.close(); act(row ? 'PATCH' : 'POST', row ? { pk, values: v } : { values: v }, row ? 'Row updated' : 'Row inserted'); } }, row ? 'Save' : 'Insert'))));
    dialog.addEventListener('close', () => dialog.remove());
    document.body.append(dialog); dialog.showModal();
  };
  pane.replaceChildren(
    h('div', { class: 'row' },
      h('button', { class: 'outline small', disabled: offset === 0, onclick: () => tableBrowser(conn, schema, name, pane, Math.max(0, offset - limit)) }, '← Prev'),
      h('span', { class: 'caption' }, `rows ${offset + 1}–${offset + data.rows.length}`),
      h('button', { class: 'outline small', disabled: data.rows.length < limit, onclick: () => tableBrowser(conn, schema, name, pane, offset + limit) }, 'Next →'),
      h('span', { class: 'grow' }),
      editable ? h('button', { class: 'cta small', onclick: () => rowEditor(null) }, '+ Insert row') : h('span', { class: 'caption' }, pkCols.length ? 'read-only relation' : 'no primary key — edit via SQL console')),
    resultTable(data, { columns: data.columns, onRow: editable ? rowEditor : null }),
  );
}

function sqlConsole(conn, pane) {
  const key = `telescreen.sql.${conn}`;
  const editor = h('textarea', { class: 'code', rows: 10, spellcheck: 'false', placeholder: 'SELECT now();' });
  try { editor.value = localStorage.getItem(key) || ''; } catch {}
  const write = h('input', { type: 'checkbox' });
  const out = h('div', { class: 'stack' });
  const run = async () => {
    const sql = editor.value.trim(); if (!sql) return;
    try { localStorage.setItem(key, editor.value); } catch {}
    if (write.checked && !await confirmBox(`Run this in WRITE mode on ${conn}? It autocommits.`, { danger: true })) return;
    out.replaceChildren(h('p', { class: 'caption' }, 'Running…'));
    try {
      const res = await api('POST', `/api/pg/${conn}/query`, { sql, write: write.checked });
      out.replaceChildren(h('p', { class: 'caption' }, `${res.ms}ms · ${write.checked ? 'write' : 'read-only, rolled back'}`), res.results.map(r => resultTable(r)));
    } catch (e) {
      out.replaceChildren(h('div', { class: 'notice error' }, e.message, e.detail?.hint ? h('div', { class: 'caption' }, `hint: ${e.detail.hint}`) : null, e.detail?.position ? h('div', { class: 'caption' }, `at character ${e.detail.position}`) : null));
    }
  };
  editor.addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); run(); } });
  write.addEventListener('change', () => { runBtn.className = write.checked ? 'danger' : 'cta'; runBtn.textContent = write.checked ? 'Run (write)' : 'Run'; });
  const runBtn = h('button', { class: 'cta', onclick: run }, 'Run');
  pane.replaceChildren(h('div', { class: 'card stack' }, editor,
    h('div', { class: 'row' }, h('label', { class: 'inline' }, write, 'Write mode (autocommit)'), h('span', { class: 'caption grow' }, 'Ctrl+Enter runs. Read-only mode rolls everything back.'), runBtn)), out);
  editor.focus();
}

// =====================================================================
// Redis
// =====================================================================
function tokenize(line) {
  const args = []; let cur = '', quote = null, any = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) { if (ch === '\\' && i + 1 < line.length) { cur += line[++i]; } else if (ch === quote) quote = null; else cur += ch; }
    else if (ch === '"' || ch === "'") { quote = ch; any = true; }
    else if (/\s/.test(ch)) { if (cur || any) args.push(cur); cur = ''; any = false; }
    else { cur += ch; any = true; }
  }
  if (quote) throw new Error('Unclosed quote');
  if (cur || any) args.push(cur);
  return args;
}
const formatReply = (v, indent = '') => Array.isArray(v) ? (v.length ? v.map((x, i) => `${indent}${i + 1}) ${Array.isArray(x) ? `\n${formatReply(x, `${indent}   `)}` : formatReply(x)}`).join('\n') : '(empty array)') : v === null ? '(nil)' : typeof v === 'number' ? `(integer) ${v}` : `"${v}"`;

route(/^\/redis\/([a-z0-9_]+)(?:\/(console))?$/, async (conn, mode) => {
  const match = h('input', { placeholder: 'MATCH pattern, e.g. deltav:*', value: sessionStorage.getItem(`telescreen.match.${conn}`) || '*' });
  const keysEl = h('div', { class: 'list' });
  const pane = h('div', { class: 'stack' });
  let cursor = '0', keys = [], selected = null;
  const scan = async (more = false) => {
    try {
      sessionStorage.setItem(`telescreen.match.${conn}`, match.value);
      const res = await api('GET', `/api/redis/${conn}/keys?${qs({ match: match.value || '*', cursor: more ? cursor : '0' })}`);
      cursor = res.cursor; keys = more ? keys.concat(res.keys) : res.keys; drawKeys();
    } catch (e) { fail(e); }
  };
  const drawKeys = () => keysEl.replaceChildren(
    ...keys.map(k => h('button', { class: selected === k.key ? 'active' : '', onclick: () => { selected = k.key; drawKeys(); showKey(k.key); } }, h('span', { class: 'label' }, k.key), h('span', { class: 'sub' }, `${k.type}${k.ttl >= 0 ? ` · ${ttlText(k.ttl)}` : ''}`))),
    keys.length ? null : h('p', { class: 'empty' }, 'No keys match.'),
    cursor !== '0' ? h('button', { onclick: () => scan(true) }, h('span', { class: 'label' }, 'Load more…')) : null);
  match.addEventListener('keydown', e => { if (e.key === 'Enter') scan(); });

  async function showKey(key) {
    let data;
    try { data = await api('GET', `/api/redis/${conn}/key?${qs({ key })}`); } catch (e) { fail(e); return; }
    const value = data.type === 'string' ? h('textarea', { class: 'code', rows: 12 }) : h('pre', { class: 'value' }, JSON.stringify(data.value, null, 2));
    if (data.type === 'string') { try { value.value = JSON.stringify(JSON.parse(data.value), null, 2); } catch { value.value = data.value; } }
    const ttl = h('input', { type: 'number', min: -1, placeholder: 'seconds (-1 = no expiry)', style: 'max-width: 220px' });
    pane.replaceChildren(h('div', { class: 'card stack' },
      h('div', { class: 'row' }, h('code', { class: 'grow', style: 'word-break: break-all' }, data.key), h('span', { class: 'pill' }, data.type), h('span', { class: 'outline-badge' }, `ttl ${ttlText(data.ttl)}`), data.length !== null ? h('span', { class: 'outline-badge' }, `len ${data.length}`) : null),
      value,
      h('div', { class: 'row' }, ttl,
        h('button', { class: 'outline small', onclick: async () => { if (ttl.value === '') return; try { await api('POST', `/api/redis/${conn}/expire`, { key, ttl: Number(ttl.value) }); toast('TTL updated'); showKey(key); } catch (e) { fail(e); } } }, 'Set TTL'),
        h('span', { class: 'grow' }),
        h('button', { class: 'outline small', onclick: async () => { const to = prompt('Rename to', key); if (!to || to === key) return; try { await api('POST', `/api/redis/${conn}/rename`, { key, to }); toast('Renamed'); selected = to; scan(); showKey(to); } catch (e) { fail(e); } } }, 'Rename'),
        h('button', { class: 'danger small', onclick: async () => { if (!await confirmBox(`Delete ${key}?`)) return; try { await api('DELETE', `/api/redis/${conn}/key`, { keys: [key] }); toast('Deleted'); selected = null; pane.replaceChildren(); scan(); } catch (e) { fail(e); } } }, 'Delete'),
        data.type === 'string' ? h('button', { class: 'cta small', onclick: async () => {
          let v = value.value; try { v = JSON.stringify(JSON.parse(v)); } catch {}
          try { await api('PUT', `/api/redis/${conn}/key`, { key, value: v, ttl: null }); toast('Saved (TTL kept)'); } catch (e) { fail(e); }
        } }, 'Save value') : h('span', { class: 'caption' }, 'edit non-strings from the console'))));
  }

  const bulkDelete = async () => {
    if (!keys.length) return;
    const list = keys.map(k => k.key);
    if (!await confirmBox(`Delete all ${list.length} loaded keys matching ${match.value}?`, { typed: `delete ${list.length}` })) return;
    try { const res = await api('DELETE', `/api/redis/${conn}/key`, { keys: list.slice(0, 1000) }); toast(`Deleted ${res.deleted}`); scan(); } catch (e) { fail(e); }
  };

  mount(
    head(`redis · ${conn}`, mode === 'console' ? 'Console' : 'Keys',
      h('button', { class: mode === 'console' ? 'outline small' : 'cta small', onclick: () => { location.hash = `#/redis/${conn}`; } }, 'Keys'),
      h('button', { class: mode === 'console' ? 'cta small' : 'outline small', onclick: () => { location.hash = `#/redis/${conn}/console`; } }, 'Console')),
    mode === 'console' ? redisConsole(conn) : h('div', { class: 'split' },
      h('div', { class: 'card tight stack' }, h('div', { class: 'row' }, h('div', { class: 'grow' }, match), h('button', { class: 'outline small', onclick: () => scan() }, 'Scan')), keysEl, h('button', { class: 'ghost', onclick: bulkDelete }, 'Delete all loaded keys…')),
      pane),
  );
  if (mode !== 'console') { pane.append(h('div', { class: 'card sunken empty' }, 'Pick a key.')); scan(); }
});

function redisConsole(conn) {
  const log = h('div', { class: 'log' }, h('div', { class: 'ts' }, `connected to ${conn} — each command runs on a fresh connection. ↑/↓ for history.`));
  const input = h('input', { class: 'mono', placeholder: 'INFO memory', autocomplete: 'off', spellcheck: 'false' });
  const history = []; let hi = 0;
  input.addEventListener('keydown', async e => {
    if (e.key === 'ArrowUp') { hi = Math.max(0, hi - 1); input.value = history[hi] || ''; e.preventDefault(); return; }
    if (e.key === 'ArrowDown') { hi = Math.min(history.length, hi + 1); input.value = history[hi] || ''; e.preventDefault(); return; }
    if (e.key !== 'Enter' || !input.value.trim()) return;
    const line = input.value; history.push(line); hi = history.length; input.value = '';
    log.append(h('div', {}, h('span', { class: 'ts' }, '>'), line));
    try {
      const args = tokenize(line);
      const destructive = /^(flushall|flushdb|del|unlink|config|shutdown|debug|script|function|swapdb|migrate|restore)$/i.test(args[0]);
      if (destructive && !await confirmBox(`Run ${args[0].toUpperCase()} on ${conn}?`)) { log.append(h('div', { class: 'warn' }, '(cancelled)')); return; }
      const res = await api('POST', `/api/redis/${conn}/command`, { args });
      log.append(h('div', {}, formatReply(res.result), h('span', { class: 'ts' }, `  ${res.ms}ms`)));
    } catch (err) { log.append(h('div', { class: 'error' }, `(error) ${err.message}`)); }
    log.scrollTop = log.scrollHeight;
  });
  setTimeout(() => input.focus());
  return h('div', { class: 'card stack' }, log, input);
}

// =====================================================================
// Railway
// =====================================================================
route(/^\/railway$/, async () => {
  const data = await api('GET', '/api/railway?fresh=1');
  if (!data.enabled) return mount(head('railway', 'Railway'), h('div', { class: 'notice warn' }, 'Set RAILWAY_PROJECT_TOKEN (or RAILWAY_API_TOKEN + project/environment ids) on the telescreen service.'));
  const logs = h('div', { class: 'stack' });
  const statusPill = s => h('span', { class: `pill ${s === 'SUCCESS' ? '' : ['FAILED', 'CRASHED'].includes(s) ? 'red' : ['BUILDING', 'DEPLOYING', 'QUEUED', 'INITIALIZING', 'WAITING'].includes(s) ? 'yellow' : 'muted'}` }, s || 'none');
  const act = async (service, action) => {
    const typed = action === 'stop' ? service.name : null;
    if (!await confirmBox(`${action[0].toUpperCase() + action.slice(1)} ${service.name}?`, { danger: action !== 'restart', typed })) return;
    try { await api('POST', `/api/railway/deployment/${action}`, { id: service.deployment.id }); toast(`${action} sent to ${service.name}`); setTimeout(navigate, 1500); } catch (e) { fail(e); }
  };
  const showLogs = async (service, kind = 'deploy') => {
    const filter = h('input', { placeholder: 'filter (deploy logs only)', style: 'max-width: 280px' });
    const body = h('div', { class: 'log' }, 'Loading…');
    const load = async () => {
      try {
        const res = await api('GET', `/api/railway/logs?${qs({ id: service.deployment.id, kind, filter: kind === 'deploy' ? filter.value : '' })}`);
        body.replaceChildren(...res.lines.map(l => h('div', { class: /err/i.test(l.severity) ? 'error' : /warn/i.test(l.severity) ? 'warn' : '' }, h('span', { class: 'ts' }, new Date(l.timestamp).toLocaleTimeString()), l.message)));
        if (!res.lines.length) body.append('(no lines)');
        body.scrollTop = body.scrollHeight;
      } catch (e) { body.replaceChildren(h('span', { class: 'error' }, e.message)); }
    };
    filter.addEventListener('keydown', e => { if (e.key === 'Enter') load(); });
    logs.replaceChildren(h('div', { class: 'card stack' },
      h('div', { class: 'row' }, h('h3', { class: 'grow', style: 'margin:0' }, `${service.name} logs`),
        ['deploy', 'build', 'http'].map(k => h('button', { class: k === kind ? 'cta small' : 'outline small', onclick: () => showLogs(service, k) }, k)),
        kind === 'deploy' ? filter : null, h('button', { class: 'outline small', onclick: load }, 'Refresh')), body));
    load();
    logs.scrollIntoView({ behavior: 'smooth' });
  };
  mount(
    head(`railway · ${data.environment.name}`, data.project.name, h('button', { class: 'outline small', onclick: navigate }, 'Refresh')),
    h('div', { class: 'table-wrap', style: 'margin-bottom: 1.5rem' }, h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, 'service'), h('th', {}, 'status'), h('th', {}, 'deployed'), h('th', {}, 'domain'), h('th', {}, ''))),
      h('tbody', {}, data.services.map(s => h('tr', {},
        h('td', {}, s.name), h('td', {}, statusPill(s.deployment?.status)), h('td', {}, ago(s.deployment?.createdAt)),
        h('td', {}, s.deployment?.staticUrl ? h('a', { href: `https://${s.deployment.staticUrl}`, target: '_blank', rel: 'noopener noreferrer' }, s.deployment.staticUrl) : ''),
        h('td', { class: 'actions' }, s.deployment ? [
          h('button', { class: 'ghost', onclick: () => showLogs(s) }, 'logs'),
          h('button', { class: 'ghost', onclick: () => act(s, 'restart') }, 'restart'),
          h('button', { class: 'ghost', onclick: () => act(s, 'redeploy') }, 'redeploy'),
          h('button', { class: 'ghost', onclick: () => act(s, 'stop') }, 'stop'),
        ] : '')))))),
    logs,
  );
});

// DeltaTime lives in its own module so it can grow independently.
import('./ward.js').then(m => m.register({ route, api, h, mount, head, toast, fail, confirmBox, qs, ago, dot, me: () => me })).catch(() => {
  route(/^\/ward(?:[/?].*)?$/, async () => mount(head('ward', 'Accounts'), h('div', { class: 'notice warn' }, 'Ward module failed to load.')));
});
import('./deltatime.js').then(m => m.register({ route, api, h, mount, head, toast, fail, confirmBox, qs, ago, dot })).catch(() => {
  route(/^\/deltatime(?:\/.*)?$/, async () => mount(head('deltatime', 'Fraud review'), h('div', { class: 'notice warn' }, 'DeltaTime module failed to load.')));
}).finally(boot);
