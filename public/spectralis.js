// Spectralis content: the warnings, changelog, community list and verified creators the app and website show.
// Every save goes to the Spectralis backend (server side, with its own token), which validates it and answers
// with a plain message when something is wrong. Creator permissions are owner-only.

const TABS = [['warnings', 'Warnings', '#/spectralis/warnings'], ['changelog', 'Changelog', '#/spectralis/changelog'], ['community', 'Community', '#/spectralis/community'], ['creators', 'Verified creators', '#/spectralis/creators']];

const SEVERITIES = [['info', 'Info'], ['warning', 'Warning'], ['critical', 'Critical']];

// Icons the website's changelog knows how to draw.
const ICONS = ['Waves', 'Radio', 'Zap', 'Shield', 'FileCode2', 'Package', 'MonitorPlay', 'BarChart3', 'Activity', 'Layers', 'Sparkles', 'Music', 'Mic2', 'Terminal', 'RefreshCw', 'ListMusic', 'Globe', 'Crosshair', 'Dices', 'Trophy', 'Minimize2', 'Palette', 'Users', 'NotebookPen', 'Bug', 'GitFork'];

// What a creator's key can let a capsule do. The player only ever grants the overlap with what a capsule asks for.
const CAPABILITIES = [
  ['app.theme.deepControl', 'Deep control of the app theme'],
  ['app.layout.deepControl', 'Change the app layout'],
  ['app.chrome.effects', 'Window chrome effects'],
  ['visualizer.multiLayer', 'Compose several visualizer layers'],
  ['visualizer.wasm', 'Embed a WASM visualizer'],
  ['visualizer.shaderPack', 'Ship shader packs'],
  ['webview.localContent', 'Local HTML content in a web view'],
  ['webview.networkAccess', 'Web view content may use the network'],
  ['album.world', 'Interactive album world'],
  ['sharedPlay.hostCapsule', 'Be hosted through Shared Play'],
  ['sharedPlay.packageUpload', 'Upload assets for Shared Play'],
  ['timeline.appControl', 'Reactive timeline may control the app'],
  ['presence.richPresence', 'Override Discord rich presence'],
  ['worlds.wasm3d', 'Sandboxed Wasm/wgpu 3D world'],
  ['audio.dspPreset', 'Register a whole-rack DSP preset'],
  ['worlds.pointerLock', 'Request pointer lock'],
  ['worlds.pauseMenu', 'Customize the pause menu copy'],
];
const RISKY = new Set(['webview.networkAccess', 'app.layout.deepControl', 'app.theme.deepControl', 'presence.richPresence']);

export function register({ route, api, h, mount: baseMount, head, toast, fail, confirmBox, ago, me }) {
  const mount = (...nodes) => baseMount(...nodes.filter(Boolean));
  const isOwner = () => me()?.level === 'owner';
  const refresh = () => window.dispatchEvent(new HashChangeEvent('hashchange'));
  const lines = v => v.split('\n').map(s => s.trim()).filter(Boolean);
  const commas = v => v.split(',').map(s => s.trim()).filter(Boolean);
  const tabs = active => h('div', { class: 'tabs' }, TABS.map(([id, text, href]) => h('button', { class: active === id ? 'active' : '', onclick: () => { location.hash = href; } }, text)));
  const field = (label, control, { wide = false, hint = '' } = {}) => h('label', { class: wide ? 'wide' : '' }, h('span', {}, label, hint ? h('span', { class: 'hint' }, ` ${hint}`) : null), control);
  const text = (value, attrs = {}) => h('input', { value: value ?? '', autocomplete: 'off', ...attrs });
  const area = (value, rows = 3) => h('textarea', { rows, value: value ?? '' });
  const select = (options, value) => {
    const el = h('select', {}, options.map(([v, l]) => h('option', { value: v }, l ?? v)));
    el.value = value;
    return el;
  };
  const bool = (label, checked) => h('label', { class: 'check' }, h('input', { type: 'checkbox', checked }), h('span', {}, label));

  async function overview(active, title) {
    const s = await api('GET', '/api/spectralis');
    if (!s.enabled) { mount(head('spectralis', title), h('div', { class: 'notice warn' }, 'Set SPECTRALIS_URL and SPECTRALIS_ADMIN_TOKEN on telescreen to edit Spectralis from here.')); return null; }
    if (s.error) { mount(head('spectralis', title), tabs(active), h('div', { class: 'notice error' }, s.error)); return null; }
    return s;
  }

  const save = async (path, body, what) => {
    try { await api('PUT', path, body); toast(`${what} saved. The app and site pick it up within a minute.`); refresh(); } catch (e) { fail(e); }
  };

  // ---------- warnings ----------
  route(/^\/spectralis(?:\/warnings)?(?:[?].*)?$/, async () => {
    if (!await overview('warnings', 'Warnings')) return;
    const list = await api('GET', '/api/spectralis/warnings');
    const cards = [];

    const card = (w = {}) => {
      const f = {
        id: text(w.id, { placeholder: 'unique-name, e.g. 6.1.0-update' }),
        title: text(w.title), message: area(w.message, 3),
        severity: select(SEVERITIES, w.severity || 'warning'),
        active: bool('Showing to users', w.active !== false), dismissible: bool('Users can dismiss it', w.dismissible !== false),
        versions: text((w.versions || []).join(', '), { placeholder: 'empty = every version, e.g. 6.1.0, 6.0.1' }),
        linkLabel: text(w.linkLabel), linkUrl: text(w.linkUrl, { placeholder: 'https://…' }),
      };
      const el = h('div', { class: 'card stack' },
        h('div', { class: 'form' },
          field('Id', f.id), field('Severity', f.severity),
          field('Title', f.title, { wide: true }), field('Message', f.message, { wide: true }),
          field('Only for versions', f.versions, { wide: true, hint: 'comma separated, exact match' }),
          field('Link text', f.linkLabel), field('Link address', f.linkUrl)),
        h('div', { class: 'row' }, f.active, f.dismissible, h('span', { class: 'grow' }), h('button', { class: 'outline small danger', onclick: () => { cards.splice(cards.indexOf(entry), 1); el.remove(); } }, 'Remove')));
      const entry = { el, read: () => ({
        id: f.id.value.trim(), title: f.title.value.trim(), message: f.message.value.trim(), severity: f.severity.value,
        active: f.active.querySelector('input').checked, dismissible: f.dismissible.querySelector('input').checked,
        versions: commas(f.versions.value), ...(f.linkLabel.value.trim() || f.linkUrl.value.trim() ? { linkLabel: f.linkLabel.value.trim(), linkUrl: f.linkUrl.value.trim() } : {}),
      }) };
      cards.push(entry);
      return el;
    };

    const holder = h('div', { class: 'stack' }, list.map(card));
    mount(
      head('spectralis', 'Warnings', h('button', { class: 'outline small', onclick: () => holder.prepend(card()) }, 'Add warning'), h('button', { class: 'cta small', onclick: () => save('/api/spectralis/warnings', cards.map(c => c.read()), 'Warnings') }, 'Save all')),
      tabs('warnings'),
      h('p', { class: 'caption' }, 'Shown in the app as a notice when someone starts it. Leave versions empty to show it to everyone.'),
      list.length ? null : h('p', { class: 'empty' }, 'No warnings yet.'),
      holder,
    );
  });

  // ---------- changelog ----------
  route(/^\/spectralis\/changelog(?:[?].*)?$/, async () => {
    if (!await overview('changelog', 'Changelog')) return;
    const list = await api('GET', '/api/spectralis/changelog');
    const releases = [];

    const release = (r = {}) => {
      const f = {
        version: text(r.version, { placeholder: '7.0.0' }), date: text(r.date, { placeholder: 'Latest, Previous, or a date' }),
        label: text(r.label), summary: area(r.summary, 5), metrics: area((r.metrics || []).join('\n'), 3),
      };
      const groups = [];
      const group = (g = {}) => {
        const gf = { icon: select(ICONS.map(i => [i]), ICONS.includes(g.icon) ? g.icon : 'Sparkles'), title: text(g.title), bullets: area((g.bullets || []).join('\n'), 4) };
        const gel = h('div', { class: 'card stack' }, h('div', { class: 'form' }, field('Icon', gf.icon), field('Group title', gf.title), field('Bullets', gf.bullets, { wide: true, hint: 'one per line' })),
          h('div', { class: 'row end' }, h('button', { class: 'outline small danger', onclick: () => { groups.splice(groups.indexOf(ge), 1); gel.remove(); } }, 'Remove group')));
        const ge = { read: () => ({ icon: gf.icon.value, title: gf.title.value.trim(), bullets: lines(gf.bullets.value) }) };
        groups.push(ge);
        return gel;
      };
      const gholder = h('div', { class: 'stack' }, (r.groups || []).map(group));
      const move = dir => {
        const i = releases.indexOf(entry), j = i + dir;
        if (j < 0 || j >= releases.length) return;
        [releases[i], releases[j]] = [releases[j], releases[i]];
        dir < 0 ? el.previousElementSibling?.before(el) : el.nextElementSibling?.after(el);
      };
      const el = h('details', { class: 'card', open: !r.version },
        h('summary', {}, h('strong', {}, r.version || 'New release'), r.label ? ` — ${r.label}` : '', r.date ? h('span', { class: 'pill muted' }, r.date) : null),
        h('div', { class: 'stack spaced' },
          h('div', { class: 'form' }, field('Version', f.version), field('Date tag', f.date), field('Title', f.label, { wide: true }), field('Summary', f.summary, { wide: true }), field('Headline numbers', f.metrics, { wide: true, hint: 'one per line, up to 8' })),
          h('h3', {}, 'Groups'), gholder,
          h('div', { class: 'row' }, h('button', { class: 'outline small', onclick: () => gholder.append(group()) }, 'Add group'), h('span', { class: 'grow' }),
            h('button', { class: 'outline small', onclick: () => move(-1) }, 'Move up'), h('button', { class: 'outline small', onclick: () => move(1) }, 'Move down'),
            h('button', { class: 'outline small danger', onclick: () => { releases.splice(releases.indexOf(entry), 1); el.remove(); } }, 'Remove release'))));
      const entry = { read: () => ({ version: f.version.value.trim(), label: f.label.value.trim(), date: f.date.value.trim(), summary: f.summary.value.trim(), metrics: lines(f.metrics.value), groups: groups.map(g => g.read()) }) };
      releases.push(entry);
      return el;
    };

    const holder = h('div', { class: 'stack' }, list.map(release));
    mount(
      head('spectralis', 'Changelog', h('button', { class: 'outline small', onclick: () => { const el = release(); holder.prepend(el); releases.unshift(releases.pop()); } }, 'Add release'), h('button', { class: 'cta small', onclick: () => save('/api/spectralis/changelog', releases.map(r => r.read()), 'Changelog') }, 'Save all')),
      tabs('changelog'),
      h('p', { class: 'caption' }, 'The first release is the latest one on the website. Tag it "Latest" and the one before it "Previous".'),
      holder,
    );
  });

  // ---------- community ----------
  route(/^\/spectralis\/community(?:[?].*)?$/, async () => {
    if (!await overview('community', 'Community')) return;
    const list = await api('GET', '/api/spectralis/community');
    const people = [];
    const slugOf = name => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

    const person = (p = {}) => {
      const f = { name: text(p.name), subtitle: text(p.subtitle) };
      let avatar = p.avatar || '';
      const preview = h('img', { class: 'avatar', alt: '', src: avatar || null, width: 48, height: 48 });
      const file = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp' });
      file.addEventListener('change', async () => {
        const image = file.files[0];
        const slug = slugOf(f.name.value);
        if (!image) return;
        if (!slug) { toast('Give them a name first.', true); file.value = ''; return; }
        try {
          const res = await api('PUT', `/api/spectralis/community/avatars/${slug}`, image, { raw: true, headers: { 'Content-Type': image.type } });
          avatar = res.url; preview.src = `${res.url}?v=${Date.now()}`;
          toast('Avatar uploaded. Save to publish it.');
        } catch (e) { fail(e); }
      });
      const el = h('div', { class: 'card row' }, preview,
        h('div', { class: 'stack grow' }, h('div', { class: 'form' }, field('Name', f.name), field('What they do', f.subtitle)), file),
        h('button', { class: 'outline small danger', onclick: () => { people.splice(people.indexOf(entry), 1); el.remove(); } }, 'Remove'));
      const entry = { read: () => ({ name: f.name.value.trim(), subtitle: f.subtitle.value.trim(), avatar }) };
      people.push(entry);
      return el;
    };

    mount(
      head('spectralis', 'Community', h('button', { class: 'outline small', onclick: () => document.querySelector('#community-list').append(person()) }, 'Add person'), h('button', { class: 'cta small', onclick: () => save('/api/spectralis/community', people.map(p => p.read()), 'Community') }, 'Save all')),
      tabs('community'),
      h('p', { class: 'caption' }, 'The people shown in the community bar on the website. Avatars are PNG, JPEG or WebP up to 2 MB.'),
      h('div', { class: 'stack', id: 'community-list' }, list.map(person)),
    );
  });

  // ---------- verified creators ----------
  route(/^\/spectralis\/creators(?:\/([0-9a-f]{64}|new))?(?:[?].*)?$/, async target => {
    if (!await overview('creators', 'Verified creators')) return;
    const creators = await api('GET', '/api/spectralis/creators');
    const owner = isOwner();
    const statusPill = s => h('span', { class: `pill ${s === 'active' ? 'green' : s === 'suspended' ? 'yellow' : 'muted'}` }, s);

    const rows = h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, ['', 'creator', 'status', 'permissions', 'key', ''].map(t => h('th', {}, t)))),
      h('tbody', {}, creators.map(c => h('tr', {},
        h('td', {}, c.avatarUrl ? h('img', { class: 'avatar', alt: '', src: c.avatarUrl, width: 32, height: 32 }) : ''),
        h('td', {}, c.displayName), h('td', {}, statusPill(c.status)), h('td', {}, `${c.allowedCapabilities.length} of ${CAPABILITIES.length}`),
        h('td', {}, h('code', {}, `${c.fingerprint.slice(0, 12)}…`)),
        h('td', { class: 'actions' }, h('button', { class: 'ghost', onclick: () => { location.hash = `#/spectralis/creators/${c.fingerprint}`; } }, owner ? 'edit' : 'view')))))));

    const existing = creators.find(c => c.fingerprint === target);
    const form = target && (target === 'new' || existing) ? editor(existing) : null;

    function editor(c) {
      const isNew = !c;
      const f = {
        fingerprint: text(c?.fingerprint, { placeholder: '64 hex characters: SHA-256 of the creator\'s public key', ...(isNew ? {} : { readonly: true }) }),
        displayName: text(c?.displayName), profileUrl: text(c?.profileUrl, { placeholder: 'https://…' }),
        keyId: text(c?.keyId, { placeholder: 'optional label' }),
        status: select([['active', 'Active'], ['suspended', 'Suspended (treated as revoked)'], ['revoked', 'Revoked for good']], c?.status || 'active'),
      };
      const caps = new Set(c?.allowedCapabilities || []);
      const boxes = CAPABILITIES.map(([id, label]) => {
        const box = h('input', { type: 'checkbox', checked: caps.has(id), disabled: !owner });
        box.addEventListener('change', () => { box.checked ? caps.add(id) : caps.delete(id); });
        return h('label', { class: 'check' }, box, h('span', {}, h('code', {}, id), ` ${label}`, RISKY.has(id) ? h('span', { class: 'pill yellow' }, 'sensitive') : null));
      });
      [...caps].filter(id => !CAPABILITIES.some(([k]) => k === id)).forEach(id => boxes.push(h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: true, disabled: !owner, onchange: e => { e.target.checked ? caps.add(id) : caps.delete(id); } }), h('span', {}, h('code', {}, id), ' (not in this list)'))));
      for (const el of Object.values(f)) if (!owner) el.disabled = true;

      const file = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp', disabled: !owner });
      const finish = async () => {
        const fingerprint = f.fingerprint.value.trim().toLowerCase();
        if (!/^[0-9a-f]{64}$/.test(fingerprint)) throw new Error('The fingerprint must be 64 lowercase hex characters.');
        await api('PUT', `/api/spectralis/creators/${fingerprint}`, {
          displayName: f.displayName.value.trim(), profileUrl: f.profileUrl.value.trim() || undefined, keyId: f.keyId.value.trim() || undefined,
          status: f.status.value, allowedCapabilities: [...caps],
        });
        if (file.files[0]) await api('PUT', `/api/spectralis/creators/${fingerprint}/avatar`, file.files[0], { raw: true, headers: { 'Content-Type': file.files[0].type } });
        return fingerprint;
      };
      return h('div', { class: 'card stack' },
        h('h3', {}, isNew ? 'Register a creator key' : c.displayName),
        !owner ? h('div', { class: 'notice warn' }, 'Only owners can change creators and their permissions.') : null,
        c?.revokedAtUtc ? h('div', { class: 'notice error' }, `Revoked ${ago(c.revokedAtUtc)}. The player rejects this creator's capsules.`) : null,
        h('div', { class: 'form' }, field('Key fingerprint', f.fingerprint, { wide: true }), field('Display name', f.displayName), field('Profile link', f.profileUrl), field('Status', f.status), field('Key label', f.keyId)),
        h('div', { class: 'row' }, c?.avatarUrl ? h('img', { class: 'avatar', alt: '', src: `${c.avatarUrl}?v=${Date.now()}`, width: 48, height: 48 }) : null, field('Avatar', file, { hint: 'PNG, JPEG or WebP, up to 2 MB' })),
        h('h3', {}, 'What this creator\'s capsules may do'),
        h('p', { class: 'caption' }, 'A capsule is rejected if it asks for anything not ticked here.'),
        h('div', { class: 'stack' }, boxes),
        owner ? h('div', { class: 'row' },
          h('button', { class: 'cta', onclick: async () => { try { const fp = await finish(); toast('Creator saved. Players re-check within five minutes.'); location.hash = `#/spectralis/creators/${fp}`; refresh(); } catch (e) { fail(e); } } }, 'Save creator'),
          h('span', { class: 'grow' }),
          !isNew ? h('button', { class: 'outline danger', onclick: async () => {
            if (!await confirmBox(`Delete ${c.displayName}? Their capsules stop verifying. Revoke instead to keep a record.`, { typed: c.displayName })) return;
            try { await api('DELETE', `/api/spectralis/creators/${c.fingerprint}`); toast('Creator deleted.'); location.hash = '#/spectralis/creators'; } catch (e) { fail(e); }
          } }, 'Delete') : null) : null);
    }

    mount(
      head('spectralis', 'Verified creators', owner ? h('button', { class: 'cta small', onclick: () => { location.hash = '#/spectralis/creators/new'; } }, 'Register key') : null),
      tabs('creators'),
      h('p', { class: 'caption' }, 'Artists whose signed capsules the app trusts, and what each is allowed to do. Revoking a key makes the app reject its capsules.'),
      rows, form,
    );
  });
}
