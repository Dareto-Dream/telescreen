// Ward account management. Every write goes through Ward's /admin/v1, which
// validates it and records it in Ward's audit log under your email.

const SCOPES = ['openid', 'profile', 'email', 'offline_access', 'deltatime'];
const PROVIDERS = ['google', 'github', 'discord'];

export function register({ route, api, h, mount, head, toast, fail, confirmBox, qs, ago }) {
  const TABS = [['accounts', 'Accounts', '#/ward/accounts'], ['apps', 'Apps', '#/ward/apps'], ['audit', 'Audit log', '#/ward/audit']];
  const tabs = active => h('div', { class: 'tabs' }, TABS.map(([id, text, href]) => h('button', { class: active === id ? 'active' : '', onclick: () => { location.hash = href; } }, text)));
  const table = (rows, cols) => rows.length
    ? h('div', { class: 'table-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, cols.map(([name]) => h('th', {}, name)))), h('tbody', {}, rows.map(r => h('tr', {}, cols.map(([, fn]) => h('td', {}, fn(r))))))))
    : h('p', { class: 'empty' }, 'Nothing here.');
  const when = iso => iso ? h('span', { title: new Date(iso).toLocaleString() }, ago(iso)) : '—';
  const userLink = u => h('a', { href: `#/ward/user/${u.id}` }, u.display_name || u.username);
  const statusPill = u => u.suspended_at ? h('span', { class: 'pill red' }, 'suspended') : h('span', { class: 'pill muted' }, 'active');
  const lines = v => v.split('\n').map(s => s.trim()).filter(Boolean);

  async function status() {
    const s = await api('GET', '/api/ward');
    if (!s.enabled) { mount(head('ward', 'Accounts'), h('div', { class: 'notice warn' }, 'Set WARD_URL and WARD_ADMIN_KEY on the telescreen to manage Ward.')); return null; }
    return s;
  }

  // Secrets are shown once, in a dialog, and never stored by the telescreen.
  function showSecret(clientId, secret) {
    if (!secret) return;
    const dialog = h('dialog', {},
      h('p', { class: 'eyebrow' }, 'client secret'),
      h('p', { class: 'subheadline' }, `Copy this now. Ward only stores a hash, so it can't be shown again.`),
      h('dl', { class: 'stat' }, h('dt', {}, 'client_id'), h('dd', { class: 'mono' }, clientId), h('dt', {}, 'client_secret'), h('dd', { class: 'mono ward-secret' }, secret)),
      h('div', { class: 'row end ward-gap' },
        h('button', { class: 'outline', type: 'button', onclick: () => navigator.clipboard.writeText(secret).then(() => toast('Copied')) }, 'Copy secret'),
        h('button', { class: 'cta', type: 'button', onclick: () => dialog.close() }, 'Done')));
    dialog.addEventListener('close', () => dialog.remove());
    document.body.append(dialog);
    dialog.showModal();
  }

  // ---------------- accounts ----------------
  route(/^\/ward(?:\/accounts)?(?:\?(.*))?$/, async rawQuery => {
    const s = await status(); if (!s) return;
    const params = new URLSearchParams(rawQuery || '');
    const q = params.get('q') || '', filter = params.get('status') || 'all', offset = Number(params.get('offset') || 0);
    const data = await api('GET', `/api/ward/users?${qs({ q, status: filter, offset, limit: 50 })}`);
    const go = (next = {}) => { location.hash = `#/ward/accounts?${qs({ q, status: filter, ...next })}`; };
    const search = h('input', { placeholder: 'Name, @username, email, provider handle or id', value: q, class: 'ward-search' });
    search.addEventListener('keydown', e => { if (e.key === 'Enter') go({ q: search.value.trim(), offset: 0 }); });
    const statusSel = h('select', { onchange: e => go({ status: e.target.value, offset: 0 }) }, ['all', 'active', 'suspended'].map(v => h('option', { value: v, selected: v === filter }, v)));
    const st = s.stats;
    mount(
      head('ward', 'Accounts', search, statusSel),
      h('p', { class: 'caption ward-sub' }, `${s.url} · ${st.users} accounts · ${st.active_1d} active today · ${st.new_7d} new this week · ${st.mfa} with 2FA · ${st.suspended} suspended · ${st.failed_logins_1d} failed sign-ins today`),
      tabs('accounts'),
      table(data.users, [
        ['account', u => h('span', {}, userLink(u), ' ', h('span', { class: 'caption' }, `@${u.username}`))],
        ['email', u => u.email || '—'],
        ['sign-in', u => [u.has_password ? 'password' : null, ...u.providers].filter(Boolean).join(', ') || '—'],
        ['2fa', u => u.mfa ? 'on' : ''],
        ['status', statusPill],
        ['last sign-in', u => when(u.last_login_at)],
        ['joined', u => when(u.created_at)],
      ]),
      h('div', { class: 'row end ward-gap' },
        h('span', { class: 'caption grow' }, `${data.total} match${data.total === 1 ? '' : 'es'}`),
        offset > 0 ? h('button', { class: 'outline small', onclick: () => go({ offset: Math.max(0, offset - 50) }) }, '← Newer') : null,
        offset + 50 < data.total ? h('button', { class: 'outline small', onclick: () => go({ offset: offset + 50 }) }, 'Older →') : null),
    );
  });

  // ---------------- one account ----------------
  route(/^\/ward\/user\/([0-9a-f-]{36})$/, async id => {
    const s = await status(); if (!s) return;
    const { user, identities, sessions, grants, activity } = await api('GET', `/api/ward/users/${id}`);
    const act = async (method, path, body, done) => { try { await api(method, `/api/ward/users/${id}${path}`, body); toast(done); navigate(); } catch (e) { fail(e); } };
    const navigate = () => window.dispatchEvent(new HashChangeEvent('hashchange'));

    const name = h('input', { value: user.display_name, maxlength: 60 });
    const username = h('input', { value: user.username, maxlength: 32 });
    const email = h('input', { value: user.email || '', type: 'email', maxlength: 254 });
    const save = h('button', { class: 'cta small', onclick: () => act('PATCH', '', { display_name: name.value.trim(), username: username.value.trim(), email: email.value.trim() || null }, 'Saved') }, 'Save profile');

    const actions = h('div', { class: 'row' },
      user.suspended_at
        ? h('button', { class: 'cta small', onclick: async () => { if (await confirmBox(`Let ${user.username} sign in again?`, { danger: false })) act('POST', '/unsuspend', undefined, 'Unsuspended'); } }, 'Unsuspend')
        : h('button', { class: 'danger small', onclick: async () => {
          const reason = prompt(`Why suspend @${user.username}? Signs them out of Ward and every app.`);
          if (reason && reason.trim().length >= 3) act('POST', '/suspend', { reason: reason.trim() }, 'Suspended');
        } }, 'Suspend'),
      h('button', { class: 'outline small', onclick: async () => { if (await confirmBox('Sign them out of every browser and revoke every app token?')) act('POST', '/logout', undefined, 'Signed out everywhere'); } }, 'Sign out everywhere'),
      user.mfa ? h('button', { class: 'outline small', onclick: async () => { if (await confirmBox('Turn off their 2FA and delete recovery codes? Only do this after verifying who they are.', { typed: user.username })) act('POST', '/reset-mfa', undefined, '2FA reset'); } }, 'Reset 2FA') : null,
      user.email ? h('button', { class: 'outline small', onclick: async () => { if (await confirmBox(`Email a password reset link to ${user.email}?`, { danger: false })) act('POST', '/password-reset', undefined, 'Reset link sent'); } }, 'Send password reset') : null,
      h('button', { class: 'ghost small', onclick: async () => {
        if (!(await confirmBox(`Permanently delete @${user.username}? Their Ward identity is gone for good; sites keep their own data.`, { typed: user.username }))) return;
        try { await api('DELETE', `/api/ward/users/${id}`, { confirm: user.username }); toast('Deleted'); location.hash = '#/ward/accounts'; } catch (e) { fail(e); }
      } }, 'Delete account'),
    );

    const section = (title, body) => h('section', { class: 'card stack' }, h('h3', {}, title), body);
    mount(
      head('ward account', h('span', {}, user.display_name, ' ', statusPill(user))),
      tabs('accounts'),
      user.suspended_at ? h('div', { class: 'notice error ward-gap-below' }, `Suspended ${new Date(user.suspended_at).toLocaleString()}: ${user.suspended_reason || 'no reason given'}`) : '',
      h('div', { class: 'split' },
        h('div', { class: 'stack' },
          h('section', { class: 'card stack' },
            user.avatar_url ? h('img', { src: user.avatar_url, alt: '', referrerpolicy: 'no-referrer', class: 'ward-avatar' }) : null,
            h('dl', { class: 'stat' },
              h('dt', {}, 'id'), h('dd', { class: 'mono', title: user.id }, user.id),
              h('dt', {}, 'joined'), h('dd', {}, new Date(user.created_at).toLocaleString()),
              h('dt', {}, 'last sign-in'), h('dd', {}, user.last_login_at ? new Date(user.last_login_at).toLocaleString() : '—'),
              h('dt', {}, 'password'), h('dd', {}, user.has_password ? 'set' : 'none'),
              h('dt', {}, '2fa'), h('dd', {}, user.mfa ? 'on' : 'off'))),
          section('Profile', h('div', { class: 'stack' },
            h('label', {}, 'Display name', name), h('label', {}, 'Username', username),
            h('label', {}, h('span', {}, 'Email ', h('span', { class: 'hint' }, 'admin-set emails count as verified')), email), save)),
          section('Actions', actions),
        ),
        h('div', { class: 'stack' },
          section('Sign-in methods', table(identities, [
            ['provider', i => i.provider], ['account', i => i.handle || i.email || i.subject], ['linked', i => when(i.created_at)], ['last used', i => when(i.last_used_at)],
            ['', i => h('button', { class: 'ghost small', onclick: async () => { if (await confirmBox(`Unlink ${i.provider}? Make sure they still have another way in.`)) act('DELETE', `/identities/${i.provider}`, undefined, 'Unlinked'); } }, 'Unlink')],
          ])),
          section('Sessions', table(sessions, [
            ['how', s => s.amr.join(' + ')], ['ip', s => s.ip || '—'], ['browser', s => h('span', { class: 'caption', title: s.user_agent || '' }, (s.user_agent || '—').slice(0, 60))],
            ['started', s => when(s.created_at)], ['seen', s => when(s.last_seen_at)],
            ['', s => h('button', { class: 'ghost small', onclick: () => act('DELETE', `/sessions/${s.id}`, undefined, 'Session ended') }, 'End')],
          ])),
          section('Connected apps', table(grants, [
            ['app', g => h('a', { href: `#/ward/apps/${encodeURIComponent(g.client_id)}` }, g.name)], ['scopes', g => g.scopes.join(' ')], ['live tokens', g => g.live_tokens], ['last used', g => when(g.last_used_at)],
            ['', g => h('button', { class: 'ghost small', onclick: async () => { if (await confirmBox(`Disconnect ${g.name}? Its tokens stop working immediately.`)) act('DELETE', `/grants/${encodeURIComponent(g.client_id)}`, undefined, 'Disconnected'); } }, 'Disconnect')],
          ])),
          section('Activity', table(activity, [['when', a => when(a.at)], ['what', a => a.action], ['by', a => a.actor || '—'], ['ip', a => a.ip || '—'], ['detail', a => h('span', { class: 'caption mono' }, JSON.stringify(a.detail))]])),
        ),
      ),
    );
  });

  // ---------------- apps ----------------
  function clientForm(c = null) {
    const f = {
      name: h('input', { value: c?.name || '', maxlength: 80, placeholder: 'DeltaVDevs Blog' }),
      homepage: h('input', { value: c?.homepage_url || '', placeholder: 'https://blog.deltavdevs.com' }),
      redirects: h('textarea', { class: 'code ward-uris', placeholder: 'https://blog.deltavdevs.com/api/auth/ward/callback' }, (c?.redirect_uris || []).join('\n')),
      logouts: h('textarea', { class: 'code ward-uris short', placeholder: 'https://blog.deltavdevs.com/' }, (c?.post_logout_redirect_uris || []).join('\n')),
      scopes: SCOPES.map(sc => h('input', { type: 'checkbox', value: sc, checked: c ? c.scopes.includes(sc) : sc !== 'deltatime' })),
      resource: h('input', { type: 'checkbox', checked: Boolean(c?.resource_scopes?.includes('deltatime')) }),
      firstParty: h('input', { type: 'checkbox', checked: c?.first_party ?? true }),
      confidential: h('input', { type: 'checkbox', checked: true }),
    };
    const body = () => ({
      name: f.name.value.trim(), homepage_url: f.homepage.value.trim() || null,
      redirect_uris: lines(f.redirects.value), post_logout_redirect_uris: lines(f.logouts.value),
      scopes: f.scopes.filter(x => x.checked).map(x => x.value), first_party: f.firstParty.checked,
      resource_scopes: f.resource.checked ? ['deltatime'] : [],
      ...(c ? {} : { confidential: f.confidential.checked }),
    });
    const el = h('div', { class: 'form' },
      h('label', {}, 'Name', f.name), h('label', {}, 'Homepage', f.homepage),
      h('label', { class: 'wide' }, h('span', {}, 'Redirect URIs ', h('span', { class: 'hint' }, 'one per line, exact match, https (or http://localhost)')), f.redirects),
      h('label', { class: 'wide' }, h('span', {}, 'Post-logout redirect URIs ', h('span', { class: 'hint' }, 'optional')), f.logouts),
      h('div', { class: 'wide row' }, h('span', { class: 'caption' }, 'Scopes:'), f.scopes.map(x => h('label', { class: 'inline' }, x, x.value))),
      h('label', { class: 'inline' }, f.firstParty, h('span', {}, 'First-party ', h('span', { class: 'hint' }, 'your own site: shown as an official DeltaVDevs app'))),
      h('label', { class: 'inline wide' }, f.resource, h('span', {}, 'Serves DeltaTime stats ', h('span', { class: 'hint' }, 'resource server: may verify tokens other apps hold for the deltatime scope. Only DeltaTime itself.'))),
      c ? null : h('label', { class: 'inline' }, f.confidential, h('span', {}, 'Confidential ', h('span', { class: 'hint' }, 'has a server that can keep a secret (almost always)'))),
    );
    return { el, body };
  }

  route(/^\/ward\/apps$/, async () => {
    const s = await status(); if (!s) return;
    const { clients } = await api('GET', '/api/ward/clients');
    const form = clientForm();
    const create = h('button', { class: 'cta small', onclick: async () => {
      try { const res = await api('POST', '/api/ward/clients', form.body()); showSecret(res.client.id, res.client_secret); toast(`Registered ${res.client.name}`); location.hash = `#/ward/apps/${encodeURIComponent(res.client.id)}`; } catch (e) { fail(e); }
    } }, 'Register app');
    mount(
      head('ward', 'Apps'),
      tabs('apps'),
      h('p', { class: 'caption' }, 'Sites that let people sign in with Ward. Issuer: ', h('code', {}, s.url), ' · discovery at ', h('code', {}, `${s.url}/.well-known/openid-configuration`)),
      table(clients, [
        ['app', c => h('a', { href: `#/ward/apps/${encodeURIComponent(c.id)}` }, c.name)], ['client_id', c => h('code', {}, c.id)],
        ['type', c => [c.first_party ? 'first-party' : 'third-party', c.confidential ? 'confidential' : 'public'].join(' · ')],
        ['users', c => c.users], ['last used', c => when(c.last_used_at)], ['status', c => c.disabled_at ? h('span', { class: 'pill red' }, 'disabled') : h('span', { class: 'pill muted' }, 'live')],
      ]),
      h('section', { class: 'card stack ward-gap-above' }, h('h3', {}, 'Register a new app'), form.el, h('div', { class: 'row end' }, create)),
    );
  });

  route(/^\/ward\/apps\/([\w.-]+)$/, async id => {
    const s = await status(); if (!s) return;
    const { clients } = await api('GET', '/api/ward/clients');
    const c = clients.find(x => x.id === id);
    if (!c) { mount(head('ward', 'Apps'), tabs('apps'), h('p', { class: 'empty' }, 'No such app.')); return; }
    const form = clientForm(c);
    const refresh = () => window.dispatchEvent(new HashChangeEvent('hashchange'));
    mount(
      head('ward app', h('span', {}, c.name, ' ', c.disabled_at ? h('span', { class: 'pill red' }, 'disabled') : null)),
      tabs('apps'),
      h('div', { class: 'split' },
        h('section', { class: 'card stack' },
          h('dl', { class: 'stat' },
            h('dt', {}, 'client_id'), h('dd', { class: 'mono ward-select' }, c.id),
            h('dt', {}, 'type'), h('dd', {}, c.confidential ? 'confidential' : 'public (PKCE only)'),
            h('dt', {}, 'users'), h('dd', {}, c.users),
            h('dt', {}, 'created'), h('dd', {}, new Date(c.created_at).toLocaleString()),
            h('dt', {}, 'secret rotated'), h('dd', {}, c.secret_rotated_at ? new Date(c.secret_rotated_at).toLocaleString() : 'never')),
          h('p', { class: 'caption' }, 'Endpoints come from ', h('code', {}, `${s.url}/.well-known/openid-configuration`), '. PKCE (S256) is required.'),
          c.confidential ? h('button', { class: 'outline small', onclick: async () => {
            if (!(await confirmBox(`Rotate ${c.name}'s secret? The old one stops working immediately — update the site's env right after.`, { typed: c.id }))) return;
            try { const res = await api('POST', `/api/ward/clients/${encodeURIComponent(c.id)}/rotate-secret`); showSecret(c.id, res.client_secret); } catch (e) { fail(e); }
          } }, 'Rotate secret') : null,
          h('button', { class: c.disabled_at ? 'cta small' : 'outline small', onclick: async () => {
            if (!c.disabled_at && !(await confirmBox(`Disable ${c.name}? Nobody can sign in to it with Ward and all its tokens are revoked.`))) return;
            try { await api('PATCH', `/api/ward/clients/${encodeURIComponent(c.id)}`, { disabled: !c.disabled_at }); toast(c.disabled_at ? 'Enabled' : 'Disabled'); refresh(); } catch (e) { fail(e); }
          } }, c.disabled_at ? 'Enable' : 'Disable'),
          h('button', { class: 'ghost small', onclick: async () => {
            if (!(await confirmBox(`Delete ${c.name}? Every grant and token it has goes with it.`, { typed: c.id }))) return;
            try { await api('DELETE', `/api/ward/clients/${encodeURIComponent(c.id)}`, { confirm: c.id }); toast('Deleted'); location.hash = '#/ward/apps'; } catch (e) { fail(e); }
          } }, 'Delete app'),
        ),
        h('section', { class: 'card stack' }, form.el, h('div', { class: 'row end' }, h('button', { class: 'cta small', onclick: async () => {
          try { await api('PATCH', `/api/ward/clients/${encodeURIComponent(c.id)}`, form.body()); toast('Saved'); refresh(); } catch (e) { fail(e); }
        } }, 'Save'))),
      ),
    );
  });

  // ---------------- audit ----------------
  route(/^\/ward\/audit(?:\?(.*))?$/, async rawQuery => {
    const s = await status(); if (!s) return;
    const params = new URLSearchParams(rawQuery || '');
    const action = params.get('action') || '';
    const { entries } = await api('GET', `/api/ward/audit?${qs({ action, limit: 300 })}`);
    const filter = h('input', { placeholder: 'action prefix, e.g. login, admin., oauth.', value: action, class: 'ward-search' });
    filter.addEventListener('keydown', e => { if (e.key === 'Enter') location.hash = `#/ward/audit?${qs({ action: filter.value.trim() })}`; });
    mount(
      head('ward', 'Audit log', filter),
      tabs('audit'),
      table(entries, [
        ['when', a => when(a.at)], ['what', a => a.action], ['by', a => a.actor || '—'],
        ['account', a => a.user_id ? h('a', { href: `#/ward/user/${a.user_id}` }, a.user_id.slice(0, 8)) : '—'],
        ['app', a => a.client_id || ''], ['ip', a => a.ip || '—'], ['detail', a => h('span', { class: 'caption mono' }, JSON.stringify(a.detail))],
      ]),
    );
  });
}
