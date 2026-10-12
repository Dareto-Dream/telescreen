// Mail: staff mailboxes at mail.deltavdevs.com. Create mailboxes, decide who is in each one, add aliases and watch
// delivery. Nothing here shows what a message says: members read mail in Mail itself, and that is logged there.

const TABS = [['mailboxes', 'Mailboxes', '#/mail/mailboxes'], ['delivery', 'Delivery', '#/mail/delivery'], ['log', 'Log', '#/mail/log']];

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
    const s = await api('GET', '/api/mail');
    if (!s.enabled) { show(head('mail', title), h('div', { class: 'notice warn' }, 'Set MAIL_URL and MAIL_ADMIN_KEY on telescreen to run Mail from here.')); return false; }
    return true;
  }
  const owner = () => (isOwner() ? null : h('p', { class: 'caption' }, 'Only owners can change mailboxes and who is in them.'));

  // ---------------- mailboxes ----------------
  route(/^\/mail(?:\/mailboxes)?(?:\?.*)?$/, async () => {
    if (!await ready('Mailboxes')) return;
    const [o, list] = await Promise.all([api('GET', '/api/mail/overview'), api('GET', '/api/mail/mailboxes')]);
    const c = o.counts;
    const address = h('input', { placeholder: `name@${o.domains[0]}`, autocomplete: 'off' });
    const name = h('input', { placeholder: 'Display name' });
    const kind = h('select', {}, h('option', { value: 'personal' }, 'Personal'), h('option', { value: 'shared' }, 'Shared (company, support)'));
    show(
      head('mail', 'Mailboxes', h('a', { href: 'https://mail.deltavdevs.com/', target: '_blank', rel: 'noopener', class: 'button-link' }, h('button', { class: 'outline small', type: 'button' }, 'Open Mail'))),
      tabs('mailboxes'),
      h('p', { class: 'caption' }, `${c.mailboxes} mailboxes · ${c.memberships} memberships · ${c.messages} messages · ${c.received_day} received and ${c.sent_day} sent in the last day${c.bounced_week ? ` · ${c.bounced_week} bounced this week` : ''}`),
      o.ingest ? null : h('div', { class: 'notice warn' }, 'INGEST_SECRET is not set on Mail, so incoming mail is refused.'),
      o.sending ? null : h('div', { class: 'notice warn' }, 'Sending is not set up on Mail yet (CF_ACCOUNT_ID and CF_API_TOKEN). People can read mail but not send it.'),
      table(list.mailboxes, [
        ['Mailbox', m => h('span', {}, h('a', { href: `#/mail/mailboxes/${m.id}` }, m.name), h('br'), h('span', { class: 'caption mono' }, m.address))],
        ['', m => h('span', { class: 'caption' }, `${m.kind}${m.disabled_at ? ' · disabled' : ''}`)],
        ['People', m => String(m.members)],
        ['Aliases', m => String(m.aliases)],
        ['Messages', m => `${m.messages}${m.last_message ? ` · ${ago(m.last_message)}` : ''}`],
      ], 'No mailboxes yet.'),
      h('h2', { class: 'subheadline' }, 'New mailbox'),
      owner(),
      h('div', { class: 'row' }, address, name, kind, h('button', { class: 'cta small', disabled: !isOwner(), onclick: act(async () => {
        const created = await api('POST', '/api/mail/mailboxes', { address: address.value.trim(), name: name.value.trim(), kind: kind.value });
        location.hash = `#/mail/mailboxes/${created.mailbox.id}`;
      }, 'Created') }, 'Create')),
    );
  });

  route(/^\/mail\/mailboxes\/([0-9a-f-]{36})$/, async id => {
    if (!await ready('Mailbox')) return;
    const [d, activity] = await Promise.all([api('GET', `/api/mail/mailboxes/${id}`), api('GET', `/api/mail/mailboxes/${id}/activity`)]);
    const m = d.mailbox;
    const name = h('input', { value: m.name });
    const signature = h('textarea', { rows: 3 }, m.signature || '');
    const alias = h('input', { placeholder: `alias@${m.address.split('@')[1]}`, autocomplete: 'off' });
    const q = h('input', { placeholder: 'Find a Ward account by name or email' });
    const results = h('div', { class: 'stack' });
    let timer;
    q.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        const term = q.value.trim();
        if (term.length < 2) { results.replaceChildren(); return; }
        try {
          const { users } = await api('GET', `/api/ward/users?q=${encodeURIComponent(term)}`);
          const have = new Set(d.members.map(x => x.ward_sub));
          results.replaceChildren(...users.slice(0, 8).map(u => h('div', { class: 'row' },
            h('span', {}, `${u.name || u.username || 'Ward user'}${u.email ? ` · ${u.email}` : ''}`),
            have.has(u.id) ? h('span', { class: 'caption' }, 'already in') : h('button', { class: 'outline small', disabled: !isOwner(), onclick: act(() => api('PUT', `/api/mail/mailboxes/${id}/members/${u.id}`, { role: 'member' }), 'Added') }, 'Add'))));
          if (!users.length) results.replaceChildren(h('p', { class: 'caption' }, 'No Ward account matches.'));
        } catch (e) { fail(e); }
      }, 250);
    });
    show(
      head('mail', m.name,
        h('button', { class: 'outline small', disabled: !isOwner(), onclick: act(() => api('PATCH', `/api/mail/mailboxes/${id}`, { disabled: !m.disabled_at }), m.disabled_at ? 'Enabled' : 'Disabled') }, m.disabled_at ? 'Enable' : 'Disable'),
        h('button', { class: 'danger small', disabled: !isOwner(), onclick: async () => {
          if (!await confirmBox(`Delete ${m.address} with all ${m.messages} of its messages? This can't be undone.`, { typed: m.address })) return;
          try { await api('DELETE', `/api/mail/mailboxes/${id}`, { confirm: m.address }); toast('Deleted'); location.hash = '#/mail/mailboxes'; } catch (e) { fail(e); }
        } }, 'Delete')),
      tabs('mailboxes'),
      h('p', { class: 'caption' }, `${m.address} · ${m.kind}${m.disabled_at ? ' · disabled, mail to it is refused' : ''} · ${m.messages} messages · created ${ago(m.created_at)}`),
      owner(),
      h('div', { class: 'row' }, name, h('button', { class: 'outline small', disabled: !isOwner(), onclick: act(() => api('PATCH', `/api/mail/mailboxes/${id}`, { name: name.value.trim() }), 'Saved') }, 'Rename')),
      h('h2', { class: 'subheadline' }, `People (${d.members.length})`),
      h('p', { class: 'caption' }, 'Everyone listed can read and send from this mailbox. Removing someone takes effect on their next page load.'),
      table(d.members, [
        ['Name', x => h('span', {}, x.name || h('span', { class: 'caption' }, 'not signed in yet'), h('br'), h('span', { class: 'caption' }, x.email || x.ward_sub))],
        ['Role', x => {
          const sel = h('select', { disabled: !isOwner() }, ['member', 'manager'].map(r => h('option', { value: r, selected: r === x.role }, r)));
          sel.addEventListener('change', act(() => api('PUT', `/api/mail/mailboxes/${id}/members/${x.ward_sub}`, { role: sel.value }), 'Role changed'));
          return sel;
        }],
        ['Added', x => `${ago(x.added_at)}${x.added_by ? ` by ${x.added_by}` : ''}`],
        ['Last seen', x => (x.last_seen_at ? ago(x.last_seen_at) : '')],
        ['', x => h('button', { class: 'ghost danger-text', disabled: !isOwner(), onclick: async () => { if (await confirmBox(`Remove ${x.name || x.ward_sub} from ${m.address}?`)) act(() => api('DELETE', `/api/mail/mailboxes/${id}/members/${x.ward_sub}`), 'Removed')(); } }, 'remove')],
      ], 'Nobody can open this mailbox.'),
      h('div', { class: 'stack' }, q, results),
      h('h2', { class: 'subheadline' }, 'Aliases'),
      h('p', { class: 'caption' }, 'Other addresses that deliver here and can be sent from.'),
      table(d.aliases, [
        ['Address', a => h('span', { class: 'mono' }, a.address)],
        ['', a => h('button', { class: 'ghost danger-text', disabled: !isOwner(), onclick: act(() => api('DELETE', `/api/mail/mailboxes/${id}/aliases/${encodeURIComponent(a.address)}`), 'Alias removed') }, 'remove')],
      ], 'No aliases.'),
      h('div', { class: 'row' }, alias, h('button', { class: 'outline small', disabled: !isOwner(), onclick: act(() => api('POST', `/api/mail/mailboxes/${id}/aliases`, { address: alias.value.trim() }), 'Alias added') }, 'Add alias')),
      h('h2', { class: 'subheadline' }, 'Activity'),
      h('p', { class: 'caption' }, 'Who opened, sent or removed things. Never what a message said.'),
      table(activity.entries, [['When', e => ago(e.at)], ['Who', e => e.who || 'removed account'], ['What', e => e.action], ['Detail', e => h('span', { class: 'mono caption' }, JSON.stringify(e.detail))]], 'No activity yet.'),
    );
  });

  // ---------------- delivery ----------------
  route(/^\/mail\/delivery$/, async () => {
    if (!await ready('Delivery')) return;
    const [o, { entries }] = await Promise.all([api('GET', '/api/mail/overview'), api('GET', '/api/mail/ingest-log')]);
    show(head('mail', 'Delivery'), tabs('delivery'),
      h('p', { class: 'caption' }, `Last day: ${o.counts.received_day} received, ${o.counts.rejected_day} refused (no such mailbox), ${o.counts.errors_day} unreadable. Sent and bounced: ${o.counts.sent_day} and ${o.counts.bounced_week} this week.`),
      table(entries, [
        ['When', e => ago(e.at)], ['From', e => h('span', { class: 'mono caption' }, e.envelope_from || '')], ['To', e => h('span', { class: 'mono caption' }, e.envelope_to || '')],
        ['Result', e => `${e.result}${e.reason ? `: ${e.reason}` : ''}`], ['Size', e => (e.size ? `${Math.ceil(e.size / 1024)} KB` : '')],
      ], 'Nothing has been delivered yet.'));
  });

  // ---------------- log ----------------
  route(/^\/mail\/log$/, async () => {
    if (!await ready('Log')) return;
    const { entries } = await api('GET', '/api/mail/audit');
    show(head('mail', 'Log'), tabs('log'),
      table(entries, [['When', e => ago(e.at)], ['Who', e => e.actor || ''], ['What', e => e.action], ['Detail', e => h('span', { class: 'mono caption' }, JSON.stringify(e.data))]], 'Nothing logged yet.'));
  });
}
