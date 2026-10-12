// The home movie player (Ward sign-in, no public access). Owner manages who's on its allowlist here; everyone
// else just sees it's owner-only. The player itself checks this list on every sign-in, not just at the door.

export function register({ route, api, h, mount, head, toast, fail, confirmBox, me }) {
  route(/^\/movies$/, async () => {
    if (me()?.level !== 'owner') { mount(head('movies', 'Movies'), h('div', { class: 'notice warn' }, 'Owner only.')); return; }
    const s = await api('GET', '/api/movies');
    if (!s.enabled) { mount(head('movies', 'Movies'), h('div', { class: 'notice warn' }, 'Set MOVIES_URL and MOVIES_ADMIN_KEY on telescreen to manage the allowlist from here.')); return; }
    const { emails } = await api('GET', '/api/movies/allowlist');
    const input = h('input', { placeholder: 'name@example.com', type: 'email' });
    const add = h('button', { class: 'cta small', onclick: async () => {
      const email = input.value.trim();
      if (!email) return;
      try { await api('POST', '/api/movies/allowlist', { email }); toast('Added'); refresh(); } catch (e) { fail(e); }
    } }, 'Add');
    const refresh = () => window.dispatchEvent(new HashChangeEvent('hashchange'));
    const remove = async email => {
      if (!await confirmBox(`Remove ${email} from the movies allowlist?`)) return;
      try { await api('DELETE', `/api/movies/allowlist?email=${encodeURIComponent(email)}`); toast('Removed'); refresh(); } catch (e) { fail(e); }
    };
    mount(
      head('movies', 'Movies'),
      h('p', { class: 'caption' }, 'Who can sign in to the movie player with Ward. Nobody else gets past the login page, Ward account or not.'),
      h('div', { class: 'row' }, input, add),
      emails.length
        ? h('div', { class: 'table-wrap' }, h('table', {}, h('tbody', {}, emails.map(email => h('tr', {}, h('td', {}, email), h('td', { class: 'actions' }, h('button', { class: 'outline small', onclick: () => remove(email) }, 'Remove')))))))
        : h('p', { class: 'empty' }, 'Nobody is allowlisted yet — the player is unreachable until someone is.'),
    );
  });
}
