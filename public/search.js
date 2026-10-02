// Search engine admin. Every write goes through the search service's /admin/v1 (server side, with its own
// key), which validates it, enforces the crawl limits and records it in its audit log under your email.

const TABS = [['overview', 'Engine', '#/search'], ['crawls', 'Crawls', '#/search/crawls'], ['sources', 'Seeds & blocklist', '#/search/sources'], ['optouts', 'Opt-outs', '#/search/optouts'], ['keys', 'API keys', '#/search/keys']];

// One-click starting points for the crawl form. The server still enforces its own ceiling.
const PRESETS = [
  ['One site, thoroughly', { name: 'site crawl', scope: 'seeds', max_pages: 2000, max_depth: 5, domain_cap: 2000, delay_ms: 500, sitemap_urls: 2000 }],
  ['A few sites, shallow', { name: 'quick look', scope: 'seeds', max_pages: 300, max_depth: 2, domain_cap: 100, delay_ms: 1000, sitemap_urls: 50 }],
  ['Explore outward', { name: 'explore', scope: 'anywhere', max_pages: 1000, max_depth: 2, domain_cap: 20, delay_ms: 1000, sitemap_urls: 0 }],
];

export function register({ route, api, h, mount, head, toast, fail, confirmBox, qs, ago, dot, me }) {
  const tabs = active => h('div', { class: 'tabs' }, TABS.map(([id, text, href]) => h('button', { class: active === id ? 'active' : '', onclick: () => { location.hash = href; } }, text)));
  const refresh = () => window.dispatchEvent(new HashChangeEvent('hashchange'));
  const num = n => (n === null || n === undefined ? '—' : Number(n).toLocaleString('en-US'));
  const size = n => (!n ? '—' : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : n < 1073741824 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1073741824).toFixed(2)} GB`);
  const when = ts => (ts ? h('span', { title: new Date(ts * 1000).toLocaleString() }, ago(new Date(ts * 1000).toISOString())) : '—');
  const lines = v => v.split('\n').map(s => s.trim()).filter(Boolean);
  const isOwner = () => me()?.level === 'owner';
  // Widths go through the CSSOM: the CSP has no 'unsafe-inline', so a style attribute would be ignored.
  const meter = (value, max) => {
    const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
    const fill = h('div');
    fill.style.width = `${pct.toFixed(1)}%`;
    return h('div', { class: `meter${pct >= 100 ? ' full' : pct >= 85 ? ' warn' : ''}`, title: `${pct.toFixed(1)}%` }, fill);
  };
  const table = (rows, cols, empty = 'Nothing here.') => (rows.length
    ? h('div', { class: 'table-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, cols.map(([name]) => h('th', {}, name)))), h('tbody', {}, rows.map(r => h('tr', {}, cols.map(([, fn]) => h('td', {}, fn(r))))))))
    : h('p', { class: 'empty' }, empty));
  const statusPill = s => h('span', { class: `pill ${s === 'running' ? 'green' : s === 'queued' || s === 'cancelling' ? 'yellow' : 'muted'}` }, s);

  async function status() {
    const s = await api('GET', '/api/search');
    if (!s.enabled) { mount(head('search', 'Search engine'), h('div', { class: 'notice warn' }, 'Set SEARCH_URL and SEARCH_ADMIN_KEY on telescreen to run the search engine from here.')); return null; }
    if (s.error) { mount(head('search', 'Search engine'), tabs('overview'), h('div', { class: 'notice error' }, s.error)); return null; }
    return s;
  }

  // The API key secret is shown once, in a dialog, and never stored here.
  function showSecret(title, rows) {
    const dialog = h('dialog', {}, h('p', { class: 'eyebrow' }, title), h('p', { class: 'subheadline' }, 'Copy this now. Only a hash is stored, so it cannot be shown again.'),
      h('dl', { class: 'stat' }, rows.flatMap(([k, v, secret]) => [h('dt', {}, k), h('dd', { class: secret ? 'mono ward-secret' : 'mono' }, v)])),
      h('div', { class: 'row end ward-gap' },
        h('button', { class: 'outline', type: 'button', onclick: () => navigator.clipboard.writeText(rows.find(r => r[2])?.[1] || '').then(() => toast('Copied')) }, 'Copy'),
        h('button', { class: 'cta', type: 'button', onclick: () => dialog.close() }, 'Done')));
    dialog.addEventListener('close', () => dialog.remove());
    document.body.append(dialog);
    dialog.showModal();
  }

  // ---------------- engine overview ----------------
  route(/^\/search$/, async () => {
    const s = await status(); if (!s) return;
    const st = s.status, cr = st.crawler || {}, ix = st.index || {}, b = cr.budget || {};
    const alive = cr.ts && Date.now() / 1000 - cr.ts < 90;
    const state = !alive ? 'no heartbeat' : st.paused ? 'paused' : 'crawling';
    const toggle = h('button', { class: st.paused ? 'cta' : 'outline', onclick: async () => {
      try { await api('POST', `/api/search/crawl/${st.paused ? 'resume' : 'pause'}`, {}); toast(st.paused ? 'Crawler resumed' : 'Crawler paused (in-flight fetches finish)'); setTimeout(refresh, 600); } catch (e) { fail(e); }
    } }, st.paused ? 'Resume crawling' : 'Pause crawling');
    const domain = h('input', { placeholder: 'example.com', class: 'ward-search' });
    const recrawl = h('button', { class: 'outline', onclick: async () => {
      if (!domain.value.trim()) return domain.focus();
      try { await api('POST', '/api/search/crawl/recrawl', { domain: domain.value.trim() }); toast(`Recrawl of ${domain.value.trim()} queued`); domain.value = ''; } catch (e) { fail(e); }
    } }, 'Recrawl domain');
    const rebuild = h('button', { class: 'outline', disabled: !isOwner(), title: isOwner() ? '' : 'owners only', onclick: async () => {
      if (!await confirmBox('Rebuild the whole index from the stored pages? It runs in the background and swaps in when finished.', { danger: false })) return;
      try { await api('POST', '/api/search/index/rebuild', {}); toast('Index rebuild queued'); } catch (e) { fail(e); }
    } }, 'Rebuild index');
    const errors = Object.entries(cr.errors || {});
    mount(
      head('search', 'Search engine', toggle, h('button', { class: 'outline small', onclick: refresh }, 'Refresh')),
      h('p', { class: 'caption ward-sub' }, `${s.url} · ${state}${cr.ts ? ` · heartbeat ${ago(new Date(cr.ts * 1000).toISOString())}` : ''}`),
      tabs('overview'),
      b.hit ? h('div', { class: 'notice warn ward-gap-below' }, `The global page budget (${num(b.pages_max)}) is spent: only recrawls and crawl jobs run. Start a job on the Crawls tab to fetch more.`) : null,
      h('div', { class: 'grid' },
        h('div', { class: 'card tight' }, h('h3', {}, dot(alive ? (st.paused ? null : true) : false), 'Crawler'), h('dl', { class: 'stat' },
          h('dt', {}, 'state'), h('dd', {}, state), h('dt', {}, 'pages / s (avg)'), h('dd', {}, cr.pages_per_sec_avg ? cr.pages_per_sec_avg.toFixed(1) : '—'),
          h('dt', {}, 'fetch p50 / p95'), h('dd', {}, `${num(cr.fetch_p50_ms)} / ${num(cr.fetch_p95_ms)} ms`), h('dt', {}, 'in flight'), h('dd', {}, num(cr.inflight)),
          h('dt', {}, 'queued'), h('dd', {}, num(cr.queued)), h('dt', {}, 'known URLs'), h('dd', {}, num(cr.known_urls)), h('dt', {}, 'quarantined hosts'), h('dd', {}, num(cr.quarantined_hosts)))),
        h('div', { class: 'card tight' }, h('h3', {}, 'Global budget'), h('dl', { class: 'stat' }, h('dt', {}, 'pages'), h('dd', {}, `${num(b.pages_used)} / ${num(b.pages_max)}`)), meter(b.pages_used, b.pages_max),
          h('dl', { class: 'stat ward-gap' }, h('dt', {}, 'stored bytes'), h('dd', {}, `${size(b.bytes_used)} / ${size(b.bytes_max)}`)), meter(b.bytes_used, b.bytes_max)),
        h('div', { class: 'card tight' }, h('h3', {}, dot(ix.live_docs > 0), 'Index'), h('dl', { class: 'stat' },
          h('dt', {}, 'live documents'), h('dd', {}, num(ix.live_docs)), h('dt', {}, 'generation'), h('dd', {}, num(ix.generation)), h('dt', {}, 'segments'), h('dd', {}, num(ix.segments)), h('dt', {}, 'size on disk'), h('dd', {}, size(ix.bytes)))),
        h('div', { class: 'card tight' }, h('h3', {}, 'Needs attention'), h('dl', { class: 'stat' },
          h('dt', {}, 'opt-outs to review'), h('dd', {}, h('a', { href: '#/search/optouts' }, num(st.pending?.optouts))), h('dt', {}, 'queued commands'), h('dd', {}, num(st.pending?.crawl_requests)),
          h('dt', {}, 'crawl jobs running'), h('dd', {}, h('a', { href: '#/search/crawls' }, num(st.jobs?.active)))))),
      h('div', { class: 'row ward-gap-above' }, domain, recrawl, rebuild),
      errors.length ? h('div', { class: 'stack ward-gap-above' }, h('p', { class: 'eyebrow' }, 'fetch outcomes this run'), table(errors, [['kind', ([k]) => k], ['count', ([, v]) => num(v)]])) : null,
    );
  });

  // ---------------- crawls ----------------
  route(/^\/search\/crawls$/, async () => {
    const s = await status(); if (!s) return;
    let limits = { max_pages: 50000, max_depth: 6, min_delay_ms: 250, max_live_jobs: 5 };
    const listEl = h('div', {});
    const field = (label, el, hint) => h('label', {}, h('span', {}, label, hint ? h('span', { class: 'hint' }, ` ${hint}`) : null), el);
    const name = h('input', { placeholder: 'what is this crawl for?', value: 'site crawl', maxlength: '80' });
    const seeds = h('textarea', { class: 'code search-urls', placeholder: 'https://example.com/\nhttps://docs.example.org/start\n(one URL per line; a bare domain gets https://)' });
    const scope = h('select', {}, [['seeds', "Stay on the seeds' own sites"], ['anywhere', 'Follow links anywhere'], ['custom', 'Only these domains']].map(([v, t]) => h('option', { value: v }, t)));
    const custom = h('input', { placeholder: 'example.com, docs.example.org', disabled: true });
    scope.addEventListener('change', () => { custom.disabled = scope.value !== 'custom'; });
    const maxPages = h('input', { type: 'number', min: '1', value: '2000' });
    const depth = h('input', { type: 'number', min: '1', max: '6', value: '3' });
    const cap = h('input', { type: 'number', min: '1', value: '2000' });
    const delay = h('input', { type: 'number', min: '250', step: '250', value: '1000' });
    const sitemaps = h('input', { type: 'number', min: '0', max: '5000', value: '50' });
    const apply = p => {
      name.value = p.name; scope.value = p.scope; custom.disabled = scope.value !== 'custom';
      maxPages.value = p.max_pages; depth.value = p.max_depth; cap.value = p.domain_cap; delay.value = p.delay_ms; sitemaps.value = p.sitemap_urls;
    };
    const submit = h('button', { class: 'cta', type: 'submit' }, 'Start crawl');
    const form = h('form', { class: 'card form' },
      h('div', { class: 'wide preset-row' }, h('span', { class: 'caption' }, 'start from:'), PRESETS.map(([label, p]) => h('button', { class: 'outline small', type: 'button', onclick: () => apply(p) }, label))),
      field('Name', name),
      field('Scope', scope),
      h('div', { class: 'wide' }, field('Seed URLs', seeds, '(where the crawl starts)')),
      h('div', { class: 'wide' }, field('Custom scope', custom, '(only used with “Only these domains”)')),
      field('Max pages', maxPages, '(new pages this crawl may fetch)'),
      field('Max depth', depth, '(link hops from a seed, 1–6)'),
      field('Per-domain cap', cap, '(pages per site)'),
      field('Delay per host (ms)', delay, '(politeness; robots.txt Crawl-delay still wins)'),
      field('Sitemap URLs per host', sitemaps),
      h('div', { class: 'wide row end' }, h('span', { class: 'caption grow', id: 'limits-note' }), submit));
    form.addEventListener('submit', async e => {
      e.preventDefault();
      const urls = lines(seeds.value).map(l => (/^https?:\/\//i.test(l) ? l : `https://${l}`));
      if (!urls.length) return seeds.focus();
      const body = { name: name.value.trim() || 'crawl', seeds: urls, max_pages: Number(maxPages.value), max_depth: Number(depth.value), domain_cap: Number(cap.value), delay_ms: Number(delay.value), sitemap_urls: Number(sitemaps.value) };
      if (scope.value === 'anywhere') body.follow_external = true;
      if (scope.value === 'custom') body.scope = custom.value.split(',').map(x => x.trim()).filter(Boolean);
      const where = scope.value === 'anywhere' ? 'following links to any site' : scope.value === 'custom' ? `within ${body.scope.join(', ') || 'no domains'}` : "within the seeds' own sites";
      const ok = await confirmBox(`Crawl up to ${num(body.max_pages)} new pages from ${urls.length} seed${urls.length === 1 ? '' : 's'}, ${body.max_depth} hops deep, ${where}, ${body.delay_ms} ms between requests to a host?`, { danger: scope.value === 'anywhere' && body.max_pages > 5000 });
      if (!ok) return;
      submit.disabled = true;
      try { const { job } = await api('POST', '/api/search/crawl/jobs', body); toast(`Crawl #${job.id} queued; the worker picks it up within ~10 seconds`); seeds.value = ''; await load(); } catch (err) { fail(err); } finally { submit.disabled = false; }
    });

    function draw(jobs) {
      listEl.replaceChildren(table(jobs, [
        ['#', j => j.id],
        ['crawl', j => h('span', {}, j.name, ' ', h('span', { class: 'caption' }, j.standing ? 'standing' : `${j.seeds.length} seed${j.seeds.length === 1 ? '' : 's'}`))],
        ['status', j => h('span', {}, statusPill(j.status), j.note ? h('span', { class: 'caption', title: j.note }, ` ${j.note}`) : null)],
        ['progress', j => h('div', {}, h('div', { class: 'caption' }, `${num(j.fetched)} / ${num(j.max_pages)} pages · ${num(j.queued)} queued`), meter(j.fetched, j.max_pages))],
        ['depth', j => j.max_depth],
        ['scope', j => (j.scope.length ? j.scope.join(', ') : 'anywhere')],
        ['started', j => when(j.started_at || j.created_at)],
        ['by', j => (j.requested_by || '').replace(/^admin:/, '')],
        ['', j => (['queued', 'running'].includes(j.status) ? h('button', { class: 'ghost', onclick: async () => {
          if (!await confirmBox(`Cancel crawl #${j.id} (${j.name})? Pages already fetched stay indexed.`)) return;
          try { await api('POST', `/api/search/crawl/jobs/${j.id}/cancel`, {}); toast('Cancelling'); await load(); } catch (e) { fail(e); }
        } }, 'cancel') : '')],
      ], 'No crawls yet.'));
    }
    async function load() {
      const d = await api('GET', '/api/search/crawl/jobs');
      limits = d.limits || limits;
      maxPages.max = String(limits.max_pages);
      const note = form.querySelector('#limits-note');
      if (note) note.textContent = `Limits: up to ${num(limits.max_pages)} pages per crawl, depth ${limits.max_depth}, at least ${limits.min_delay_ms} ms between requests, ${limits.max_live_jobs} running at once.`;
      draw(d.jobs);
    }
    mount(head('search', 'Crawls', h('button', { class: 'outline small', onclick: refresh }, 'Refresh')),
      h('p', { class: 'caption ward-sub' }, 'Each crawl has its own page budget on top of the global one, stays inside its scope, and respects robots.txt. The DeltaVDevs sites run as a standing crawl.'),
      tabs('crawls'), form, h('p', { class: 'eyebrow ward-gap-above' }, 'crawls'), listEl);
    await load();
    // live progress while this page is open
    const timer = setInterval(() => { if (!location.hash.startsWith('#/search/crawls') || !document.body.contains(listEl)) return clearInterval(timer); load().catch(() => {}); }, 5000);
  });

  // ---------------- seeds + blocklist ----------------
  route(/^\/search\/sources$/, async () => {
    const s = await status(); if (!s) return;
    const [seeds, block] = await Promise.all([api('GET', '/api/search/seeds'), api('GET', '/api/search/blocklist')]);
    const seedUrl = h('input', { placeholder: 'https://example.com/', class: 'ward-search' });
    const boost = h('input', { type: 'number', min: '0', max: '100000', value: '1000', title: 'higher jumps the queue' });
    const addSeed = h('button', { class: 'cta small', onclick: async () => {
      if (!seedUrl.value.trim()) return seedUrl.focus();
      try { await api('POST', '/api/search/seeds', { url: seedUrl.value.trim(), boost: Number(boost.value) }); toast('Seed added'); refresh(); } catch (e) { fail(e); }
    } }, 'Add seed');
    const target = h('input', { placeholder: 'example.com  or  url:https://example.com/page', class: 'ward-search' });
    const reason = h('input', { placeholder: 'reason (optional)' });
    const addBlock = h('button', { class: 'cta small', onclick: async () => {
      if (!target.value.trim()) return target.focus();
      try { await api('POST', '/api/search/blocklist', { target: target.value.trim(), reason: reason.value.trim() || undefined }); toast('Blocked'); refresh(); } catch (e) { fail(e); }
    } }, 'Block');
    mount(head('search', 'Seeds & blocklist'), tabs('sources'),
      h('p', { class: 'eyebrow' }, `seeds · ${seeds.seeds.length}`),
      h('p', { class: 'caption' }, 'URLs the default crawl starts from. The boost lets a seed jump the queue. For a bounded crawl with its own limits, use the Crawls tab instead.'),
      h('div', { class: 'row ward-gap-below' }, seedUrl, boost, addSeed),
      table(seeds.seeds, [['url', r => r.url], ['boost', r => r.boost], ['note', r => r.note || ''], ['added', r => when(r.added_at)], ['', r => h('button', { class: 'ghost', onclick: async () => { try { await api('DELETE', `/api/search/seeds?${qs({ url: r.url })}`); refresh(); } catch (e) { fail(e); } } }, 'remove')]], 'No extra seeds.'),
      h('p', { class: 'eyebrow ward-gap-above' }, `blocklist · ${block.blocklist.length}`),
      h('p', { class: 'caption' }, 'Domains, hosts or single URLs the crawler never fetches. Blocking does not delete what is already stored; for that, approve an opt-out or purge.'),
      h('div', { class: 'row ward-gap-below' }, target, reason, addBlock),
      table(block.blocklist, [['target', r => r.target], ['reason', r => r.reason], ['added', r => when(r.added_at)], ['', r => h('button', { class: 'ghost', onclick: async () => { try { await api('DELETE', `/api/search/blocklist?${qs({ target: r.target })}`); refresh(); } catch (e) { fail(e); } } }, 'unblock')]], 'Nothing blocked.'));
  });

  // ---------------- opt-outs ----------------
  route(/^\/search\/optouts(?:\?(.*))?$/, async rawQuery => {
    const s = await status(); if (!s) return;
    const filter = new URLSearchParams(rawQuery || '').get('status') || 'pending';
    const { optouts } = await api('GET', `/api/search/optouts?${qs({ status: filter })}`);
    const pick = h('select', { onchange: e => { location.hash = `#/search/optouts?${qs({ status: e.target.value })}`; } }, ['pending', 'verified', 'purged', 'rejected'].map(v => h('option', { value: v, selected: v === filter }, v)));
    mount(head('search', 'Opt-outs', pick), tabs('optouts'),
      h('p', { class: 'caption ward-sub' }, 'Site owners prove control (DNS TXT or a meta tag) and are blocklisted and purged automatically. “Manual” requests land here for a human decision.'),
      table(optouts, [
        ['target', r => r.target], ['kind', r => r.kind], ['proof', r => r.method], ['status', r => statusPill(r.status)], ['contact', r => r.contact || ''], ['note', r => r.note || ''], ['requested', r => when(r.created_at)],
        ['', r => (r.status === 'pending' ? h('span', {}, h('button', { class: 'ghost', disabled: !isOwner(), title: isOwner() ? '' : 'owners only', onclick: async () => {
          if (!await confirmBox(`Approve removal of ${r.target}? It is blocklisted now and every stored page, version and index entry is purged.`)) return;
          try { await api('POST', `/api/search/optouts/${encodeURIComponent(r.id)}/approve`, {}); toast('Approved; purge queued'); refresh(); } catch (e) { fail(e); }
        } }, 'approve'), h('button', { class: 'ghost', onclick: async () => {
          if (!await confirmBox(`Reject the request for ${r.target}?`, { danger: false })) return;
          try { await api('POST', `/api/search/optouts/${encodeURIComponent(r.id)}/reject`, {}); toast('Rejected'); refresh(); } catch (e) { fail(e); }
        } }, 'reject')) : '')],
      ], `No ${filter} requests.`));
  });

  // ---------------- API keys ----------------
  route(/^\/search\/keys(?:\?(.*))?$/, async rawQuery => {
    const s = await status(); if (!s) return;
    const owner = new URLSearchParams(rawQuery || '').get('owner') || '';
    const keys = owner ? (await api('GET', `/api/search/keys?${qs({ owner })}`)).keys : null;
    const ownerIn = h('input', { value: owner, placeholder: 'user:<ward account id>  or  service:name', class: 'ward-search' });
    ownerIn.addEventListener('keydown', e => { if (e.key === 'Enter') location.hash = `#/search/keys?${qs({ owner: ownerIn.value.trim() })}`; });
    const tier = h('select', {}, ['free', 'standard', 'admin'].map(t => h('option', { value: t }, t)));
    const keyName = h('input', { placeholder: 'key name (optional)' });
    const daily = h('input', { type: 'number', min: '1', placeholder: 'daily limit (optional)' });
    const issue = h('button', { class: 'cta small', disabled: !isOwner(), title: isOwner() ? '' : 'owners only', onclick: async () => {
      if (!ownerIn.value.trim()) return ownerIn.focus();
      try {
        const k = await api('POST', '/api/search/keys', { owner: ownerIn.value.trim(), tier: tier.value, name: keyName.value.trim() || undefined, daily_limit: daily.value ? Number(daily.value) : undefined });
        showSecret('new API key', [['owner', ownerIn.value.trim()], ['tier', k.tier], ['key', k.key, true]]);
        refresh();
      } catch (e) { fail(e); }
    } }, 'Issue key');
    mount(head('search', 'API keys'), tabs('keys'),
      h('p', { class: 'caption ward-sub' }, 'Keys are hashed on the search service; the secret is shown once when issued. Owners are strings such as user:<ward id> or service:name.'),
      h('div', { class: 'row ward-gap-below' }, ownerIn, tier, keyName, daily, issue, h('button', { class: 'outline small', onclick: () => { location.hash = `#/search/keys?${qs({ owner: ownerIn.value.trim() })}`; } }, 'List keys')),
      keys === null ? h('p', { class: 'empty' }, 'Enter an owner to list their keys.') : table(keys, [
        ['prefix', k => k.prefix], ['name', k => k.name], ['tier', k => k.tier], ['daily limit', k => num(k.daily_limit)], ['created', k => when(k.created_at)], ['last used', k => when(k.last_used_at)],
        ['status', k => (k.revoked_at ? h('span', { class: 'pill red' }, 'revoked') : h('span', { class: 'pill green' }, 'active'))],
        ['', k => (!k.revoked_at && isOwner() ? h('button', { class: 'ghost', onclick: async () => {
          if (!await confirmBox(`Revoke key ${k.prefix}…? Anything using it stops working immediately.`)) return;
          try { await api('DELETE', `/api/search/keys/${encodeURIComponent(k.id)}?${qs({ owner })}`); toast('Revoked'); refresh(); } catch (e) { fail(e); }
        } }, 'revoke') : '')],
      ], 'That owner has no keys.'));
  });
}
