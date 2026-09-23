// DeltaTime fraud review. Every write goes through DeltaTime's admin API, so its
// own permission rules and trust audit log apply.

const TRUST = {
  blue: { label: 'unscored', cls: 'muted' },
  green: { label: 'trusted', cls: '' },
  yellow: { label: 'suspected', cls: 'yellow' },
  red: { label: 'convicted', cls: 'red' },
};

export function register({ route, api, h, mount, head, toast, fail, confirmBox, qs, ago }) {
  const trustPill = level => h('span', { class: `pill ${TRUST[level]?.cls ?? 'muted'}` }, level ? `${level} · ${TRUST[level]?.label ?? '?'}` : '?');
  const userLink = (id, text) => h('a', { href: `#/deltatime/user/${id}` }, text || `#${id}`);
  const duration = s => { s = Number(s) || 0; const hrs = Math.floor(s / 3600), m = Math.round((s % 3600) / 60); return hrs ? `${hrs}h ${m}m` : `${m}m`; };
  const epoch = t => { if (!t) return '—'; const n = Number(t); return new Date(n > 1e12 ? n : n * 1000).toLocaleString(); };
  const TABS = [['queue', 'Queue'], ['alts', 'Alt candidates'], ['lookup', 'IP / machine'], ['audit', 'Trust log']];

  function shell(active, status, body) {
    const search = h('input', { placeholder: 'Find a user: name, email or id', style: 'min-width: 280px' });
    const results = h('div', { class: 'list', style: 'max-height: 320px' });
    search.addEventListener('keydown', async e => {
      if (e.key !== 'Enter' || !search.value.trim()) return;
      try {
        const { users } = await api('GET', `/api/deltatime/search?${qs({ q: search.value.trim() })}`);
        if (users.length === 1) { location.hash = `#/deltatime/user/${users[0].id}`; return; }
        results.replaceChildren(...users.map(u => h('button', { onclick: () => { location.hash = `#/deltatime/user/${u.id}`; } }, h('span', { class: 'label' }, u.username || u.google_name || u.github_username || `#${u.id}`), h('span', { class: 'sub' }, u.email || `#${u.id}`))));
        if (!users.length) results.replaceChildren(h('p', { class: 'empty' }, 'No matches.'));
      } catch (err) { fail(err); }
    });
    return [
      head('deltatime', 'Fraud review', search),
      status?.check ? h('p', { class: 'caption', style: 'margin-top: -1rem; margin-bottom: 1rem' }, `acting as ${status.check.creator.display_name || status.check.creator.username} (${status.check.creator.admin_level}) on ${status.url}`) : null,
      results,
      h('div', { class: 'tabs' }, TABS.map(([id, text]) => h('button', { class: active === id ? 'active' : '', onclick: () => { location.hash = `#/deltatime/${id}`; } }, text))),
      body,
    ];
  }

  async function status() {
    const s = await api('GET', '/api/deltatime');
    if (!s.enabled) throw new Error('DeltaTime is not connected. Set DELTATIME_URL and DELTATIME_ADMIN_KEY on telescreen.');
    return s;
  }

  const userTable = (rows, cols) => rows.length ? h('div', { class: 'table-wrap' }, h('table', {},
    h('thead', {}, h('tr', {}, cols.map(c => h('th', {}, c[0])))),
    h('tbody', {}, rows.map(r => h('tr', {}, cols.map(c => h('td', {}, c[1](r)))))))) : h('p', { class: 'empty' }, 'Nothing here. 🎉');

  // ---------------- queue ----------------
  route(/^\/deltatime(?:\/queue)?$/, async () => {
    const s = await status();
    const q = await api('GET', '/api/deltatime/queue');
    mount(...shell('queue', s, h('div', { class: 'stack' },
      h('p', { class: 'eyebrow' }, `Suspected (yellow)${q.suspected ? ` · ${q.suspected.length}` : ''}`),
      q.suspected === null ? h('div', { class: 'notice warn' }, 'Add TELESCREEN_PG_DELTATIME (DeltaTime\'s Postgres) to list suspected users. The admin API has no listing for them.')
        : userTable(q.suspected, [['user', r => userLink(r.id, r.username || r.github_username || `#${r.id}`)], ['email', r => r.email || ''], ['last reason', r => r.reason || ''], ['updated', r => ago(r.updated_at)]]),
      h('p', { class: 'eyebrow', style: 'margin-top: 1rem' }, `Leaderboard shadowbanned · ${q.shadowbanned.length}`),
      userTable(q.shadowbanned, [['user', r => userLink(r.id, r.display_name || r.username || `#${r.id}`)], ['reason', r => r.leaderboard_shadowban_reason || r.reason || ''], ['expires', r => r.leaderboard_shadowban_expires_at ? new Date(r.leaderboard_shadowban_expires_at).toLocaleString() : 'never']]),
      h('p', { class: 'eyebrow', style: 'margin-top: 1rem' }, `Convicted (red) · ${q.banned.length}`),
      userTable(q.banned, [['user', r => userLink(r.id, r.username || `#${r.id}`)], ['email', r => r.email]]),
    )));
  });

  // ---------------- alts ----------------
  route(/^\/deltatime\/alts(?:\/(\d+))?$/, async (days = '30') => {
    const s = await status();
    const data = await api('GET', `/api/deltatime/alts?${qs({ lookback_days: days })}`);
    const name = id => { const u = data.users[id]; return u ? (u.display_name || u.username || `#${id}`) : `#${id}`; };
    const trust = id => data.users[id]?.trust_level;
    const daysInput = h('select', { onchange: e => { location.hash = `#/deltatime/alts/${e.target.value}`; } }, [7, 30, 90, 365].map(d => h('option', { value: d, selected: String(d) === days }, `last ${d} days`)));
    mount(...shell('alts', s, h('div', { class: 'stack' },
      h('div', { class: 'row' }, h('p', { class: 'caption grow' }, `User pairs sharing the same machine name and IP. ${data.pairs.length} pairs${data.truncated ? ' (DeltaTime capped the scan at 5000 rows)' : ''}.`), daysInput),
      userTable(data.pairs, [
        ['user a', p => h('span', {}, userLink(p.user_a_id, name(p.user_a_id)), ' ', trust(p.user_a_id) ? trustPill(trust(p.user_a_id)) : null)],
        ['user b', p => h('span', {}, userLink(p.user_b_id, name(p.user_b_id)), ' ', trust(p.user_b_id) ? trustPill(trust(p.user_b_id)) : null)],
        ['machines', p => p.machines.map((m, i) => [i ? ', ' : '', h('a', { href: `#/deltatime/lookup/machine/${encodeURIComponent(m)}` }, m)])],
        ['ips', p => p.ips.map((ip, i) => [i ? ', ' : '', h('a', { href: `#/deltatime/lookup/ip/${encodeURIComponent(ip)}` }, ip)])],
        ['last seen', p => epoch(p.last_seen)],
      ]),
    )));
  });

  // ---------------- lookup ----------------
  route(/^\/deltatime\/lookup(?:\/(ip|machine)\/(.+))?$/, async (kind, value) => {
    const s = await status();
    const kindSel = h('select', { style: 'max-width: 140px' }, h('option', { value: 'ip', selected: kind !== 'machine' }, 'IP'), h('option', { value: 'machine', selected: kind === 'machine' }, 'machine'));
    const input = h('input', { placeholder: 'value', value: value || '' });
    const goLookup = () => { if (input.value.trim()) location.hash = `#/deltatime/lookup/${kindSel.value}/${encodeURIComponent(input.value.trim())}`; };
    input.addEventListener('keydown', e => { if (e.key === 'Enter') goLookup(); });
    let table = h('p', { class: 'empty' }, 'Look up everyone who sent heartbeats from an IP or machine name.');
    if (kind && value) {
      const res = await api('GET', `/api/deltatime/lookup?${qs({ [kind]: value })}`);
      table = userTable(res.users, [['user', r => userLink(r.user_id)], ['machine', r => r.machine || ''], ['ip', r => r.ip_address || ''], ['user agent', r => r.user_agent || '']]);
    }
    mount(...shell('lookup', s, h('div', { class: 'stack' }, h('div', { class: 'row' }, kindSel, h('div', { class: 'grow' }, input), h('button', { class: 'cta small', onclick: goLookup }, 'Look up')), table)));
  });

  // ---------------- audit ----------------
  route(/^\/deltatime\/audit$/, async () => {
    const s = await status();
    const data = await api('GET', '/api/deltatime/audit');
    const logs = data.audit_logs || data.trust_level_audit_logs || data.logs || [];
    mount(...shell('audit', s, userTable(logs, [
      ['when', l => ago(l.created_at)],
      ['user', l => l.user ? userLink(l.user.id, l.user.display_name || l.user.username) : l.user_id ? userLink(l.user_id) : ''],
      ['change', l => h('span', {}, trustPill(l.previous_trust_level), ' → ', trustPill(l.new_trust_level))],
      ['by', l => l.changed_by?.display_name || l.changed_by?.username || ''],
      ['reason', l => l.reason || ''],
    ])));
  });

  // ---------------- user ----------------
  route(/^\/deltatime\/user\/(\d+)$/, async id => {
    const s = await status();
    const data = await api('GET', `/api/deltatime/user/${id}`);
    const u = data.user;
    const reason = h('input', { placeholder: 'Reason (required, goes in DeltaTime\'s audit log)' });
    const notes = h('textarea', { rows: 2, placeholder: 'Internal notes (optional)' });
    const setTrust = async level => {
      if (!reason.value.trim()) { reason.focus(); return toast('Give a reason first', true); }
      const typed = level === 'red' ? `convict ${u.username || u.id}` : null;
      if (!await confirmBox(`Set ${u.display_name || u.username} to ${level} (${TRUST[level].label})?`, { danger: level === 'red' || level === 'yellow', typed })) return;
      try { const res = await api('POST', `/api/deltatime/user/${id}/trust`, { trust_level: level, reason: reason.value.trim(), notes: notes.value || undefined }); toast(res.message || 'Updated'); location.reload(); } catch (e) { fail(e); }
    };
    const expires = h('input', { type: 'datetime-local', style: 'max-width: 240px' });
    const shadowban = async () => {
      if (!reason.value.trim()) { reason.focus(); return toast('Give a reason first', true); }
      if (!await confirmBox(`Hide ${u.display_name || u.username} from leaderboards?`)) return;
      try { const res = await api('POST', `/api/deltatime/user/${id}/shadowban`, { reason: reason.value.trim(), expires_at: expires.value ? new Date(expires.value).toISOString() : undefined }); toast(res.message || 'Shadowbanned'); } catch (e) { fail(e); }
    };
    const unshadowban = async () => {
      if (!await confirmBox(`Show ${u.display_name || u.username} on leaderboards again?`, { danger: false })) return;
      try { const res = await api('DELETE', `/api/deltatime/user/${id}/shadowban`); toast(res.message || 'Restored'); } catch (e) { fail(e); }
    };

    const valuesEl = h('div', { class: 'stack' });
    const loadValues = async field => {
      try {
        const res = await api('GET', `/api/deltatime/user/${id}/values?${qs({ field })}`);
        const lookup = field === 'ips' ? 'ip' : field === 'machines' ? 'machine' : null;
        valuesEl.replaceChildren(h('p', { class: 'caption' }, `${res.count} distinct ${field}`), h('div', { class: 'row' }, res.values.map(v => lookup ? h('a', { href: `#/deltatime/lookup/${lookup}/${encodeURIComponent(v)}`, class: 'outline-badge', style: 'text-transform:none' }, v) : h('span', { class: 'outline-badge', style: 'text-transform:none' }, v))));
      } catch (e) { fail(e); }
    };

    const hbEl = h('div', { class: 'stack' });
    const start = h('input', { type: 'date', style: 'max-width: 180px' });
    const end = h('input', { type: 'date', style: 'max-width: 180px' });
    const loadHeartbeats = async (offset = 0) => {
      try {
        const res = await api('GET', `/api/deltatime/user/${id}/heartbeats?${qs({ start_date: start.value, end_date: end.value, limit: 500, offset })}`);
        hbEl.replaceChildren(
          h('div', { class: 'row' }, h('span', { class: 'caption grow' }, `${res.total_count} heartbeats · showing ${offset + 1}–${offset + res.heartbeats.length}`),
            h('button', { class: 'outline small', disabled: offset === 0, onclick: () => loadHeartbeats(Math.max(0, offset - 500)) }, '← Prev'),
            h('button', { class: 'outline small', disabled: !res.has_more, onclick: () => loadHeartbeats(offset + 500) }, 'Next →')),
          h('div', { class: 'table-wrap' }, h('table', {},
            h('thead', {}, h('tr', {}, ['time', 'project', 'entity', 'lang', 'editor', 'machine', 'ip', 'source', 'write', '+/-', 'user agent'].map(c => h('th', {}, c)))),
            h('tbody', {}, res.heartbeats.map(b => h('tr', {},
              h('td', {}, epoch(b.time)), h('td', {}, b.project || ''), h('td', { title: b.entity || '' }, b.entity || ''), h('td', {}, b.language || ''), h('td', {}, b.editor || ''),
              h('td', {}, b.machine || ''), h('td', {}, b.ip_address || ''), h('td', {}, b.source_type || ''), h('td', {}, b.is_write ? '✓' : ''),
              h('td', {}, b.line_additions || b.line_deletions ? `+${b.line_additions || 0}/-${b.line_deletions || 0}` : ''),
              h('td', { title: b.user_agent || '' }, b.user_agent || '')))))));
      } catch (e) { fail(e); }
    };

    mount(...shell(null, s, h('div', { class: 'stack' },
      h('div', { class: 'card stack' },
        h('div', { class: 'row' }, h('h2', { class: 'headline grow', style: 'margin:0' }, u.display_name || u.username || `#${u.id}`), trustPill(u.trust_level), h('span', { class: 'outline-badge' }, `id ${u.id}`)),
        h('dl', { class: 'stat', style: 'max-width: 640px' },
          h('dt', {}, 'username'), h('dd', {}, u.username || '—'), h('dt', {}, 'github'), h('dd', {}, u.github_username || '—'),
          h('dt', {}, 'emails'), h('dd', {}, (u.email_addresses || []).join(', ') || '—'), h('dt', {}, 'country / tz'), h('dd', {}, `${u.country_code || '—'} / ${u.timezone || '—'}`),
          h('dt', {}, 'joined'), h('dd', {}, new Date(u.created_at).toLocaleDateString()), h('dt', {}, 'last heartbeat'), h('dd', {}, epoch(u.last_heartbeat_at)),
          h('dt', {}, 'tracked time'), h('dd', {}, duration(u.stats?.total_coding_time)), h('dt', {}, 'heartbeats'), h('dd', {}, u.stats?.total_heartbeats ?? '—'),
          h('dt', {}, 'days active'), h('dd', {}, u.stats?.days_active ?? '—'), h('dt', {}, 'projects / languages'), h('dd', {}, `${u.stats?.projects_worked_on ?? '—'} / ${u.stats?.languages_used ?? '—'}`),
          h('dt', {}, 'api keys'), h('dd', {}, u.api_keys_count ?? '—'), h('dt', {}, 'admin level'), h('dd', {}, u.admin_level)),
      ),
      h('div', { class: 'card stack' },
        h('h3', {}, 'Verdict'),
        reason, notes,
        h('div', { class: 'row' },
          h('button', { class: 'outline small', onclick: () => setTrust('green') }, 'Trust (green)'),
          h('button', { class: 'outline small', onclick: () => setTrust('blue') }, 'Reset (blue)'),
          h('button', { class: 'outline small', onclick: () => setTrust('yellow') }, 'Suspect (yellow)'),
          h('button', { class: 'danger small', onclick: () => setTrust('red') }, 'Convict (red)'),
          h('span', { class: 'grow' }),
          expires,
          h('button', { class: 'outline small', onclick: shadowban }, 'Leaderboard shadowban'),
          h('button', { class: 'ghost', onclick: unshadowban }, 'lift shadowban')),
        h('p', { class: 'caption' }, 'Yellow is invisible to the user. Red hides them publicly. Shadowbans only hide them from leaderboards, with an optional expiry.')),
      h('div', { class: 'card stack' },
        h('h3', {}, 'Trust history'),
        userTable(data.trust_logs || [], [['when', l => ago(l.created_at)], ['change', l => h('span', {}, trustPill(l.previous_trust_level), ' → ', trustPill(l.new_trust_level))], ['by', l => l.changed_by?.display_name || l.changed_by?.username || ''], ['reason', l => l.reason || ''], ['notes', l => l.notes || '']])),
      h('div', { class: 'card stack' },
        h('h3', {}, 'Projects'),
        userTable(data.projects || [], [['project', p => p.name], ['time', p => duration(p.total_duration)], ['heartbeats', p => p.total_heartbeats], ['first', p => epoch(p.first_heartbeat)], ['last', p => epoch(p.last_heartbeat)], ['languages', p => (p.languages || []).join(', ')], ['repo', p => p.repo ? h('a', { href: p.repo, target: '_blank', rel: 'noopener noreferrer' }, 'repo') : '']])),
      h('div', { class: 'card stack' },
        h('div', { class: 'row' }, h('h3', { class: 'grow', style: 'margin:0' }, 'Fingerprints'), ['machines', 'ips', 'editors', 'user_agents', 'languages', 'projects'].map(f => h('button', { class: 'outline small', onclick: () => loadValues(f) }, f))),
        valuesEl),
      h('div', { class: 'card stack' },
        h('div', { class: 'row' }, h('h3', { class: 'grow', style: 'margin:0' }, 'Raw heartbeats'), start, end, h('button', { class: 'cta small', onclick: () => loadHeartbeats(0) }, 'Load')),
        hbEl),
    )));
    loadValues('machines');
  });
}
