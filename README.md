# Telescreen

The DeltaVDevs admin console, running at `https://telescreen.deltavdevs.com`. It replaces the old `/balls` admin suite on the main site, which now redirects here.

- **Site content:** projects, songs, albums and staff, proxied to the main backend's `/api/admin/*`.
- **CDN files:** browse, upload, move and delete on `cdn.deltavdevs.com` over WebDAV.
- **DeltaTime fraud review:** a queue of suspected, shadowbanned and convicted users, plus alt candidates (users sharing a machine and IP), IP/machine lookup, the trust audit log, and a per-user page with raw heartbeats and fingerprints. Verdicts and shadowbans go through DeltaTime's own `/api/admin/v1`, so its permission rules and `trust_level_audit_logs` apply.
- **Postgres:** a table browser, row insert/edit/delete by primary key, and a SQL console that is read-only by default.
- **Redis:** SCAN browser, typed value viewer, string edit, TTL, rename, delete, and a raw command console.
- **Railway:** service status, deploy/build/HTTP logs, and restart/redeploy/stop.
- **Overview:** health of every configured endpoint, database and cache.

Styles come from `css.deltavdevs.com`. The client uses no framework and has no build step.

## Security model

- **Sign-in:** "Continue with Ward" (PKCE, state, and the `iss` check). The Ward account needs staff level `admin` or `owner`, read from the `admin` scope. Telescreen re-checks the level with Ward's admin API (cached a minute), so a demotion or suspension ends the session; if Ward is unreachable it keeps the session's level so Telescreen still works in an outage.
- **Owner-only:** setting staff levels, deleting Ward accounts or apps, rotating an app's secret, writing SQL, raw Redis commands, and Railway redeploys/restarts.
- **Google backup:** while Ward sign-in is new, Google + `ADMIN_EMAILS` still works (allowlisted people count as owners). Remove `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`/`ADMIN_EMAILS` to turn it off.
- **Sessions:** a stateless HMAC-signed `__Host-` cookie (SameSite=Strict, httpOnly, 12h by default). Telescreen does not depend on the Redis or Postgres it administers. To revoke all sessions, rotate `SESSION_SECRET`.
- **Writes:** every write requires a same-origin request and a per-session CSRF header.
- **Secrets:** backend, WebDAV, DeltaTime and Railway credentials are only in server env. The browser never sees them; tests assert this.
- **Headers:** a strict CSP with no inline script, `frame-ancestors 'none'`, `no-store` and `noindex`. Downloaded CDN files are served sandboxed.
- **Audit:** every mutation and every SQL/Redis command is written to stdout as `audit` JSON, so it ends up in Railway logs.
- **SQL read-only mode** is a seatbelt, not a sandbox. It runs a read-only session and transaction and always rolls back. Write mode autocommits on a throwaway connection.

## Setup

Copy `.env.example` and fill it in. On Railway, point connections at the other services with reference variables, for example `TELESCREEN_PG_MAIN=${{Postgres.DATABASE_URL}}`.

**Ward:** create a first-party Ward app with scopes `openid profile email admin`, redirect URI `https://telescreen.deltavdevs.com/auth/ward/callback`, then set `WARD_CLIENT_ID` and `WARD_CLIENT_SECRET` (alongside `WARD_URL` and `WARD_ADMIN_KEY`).

**Google (backup):** in the OAuth client, add the redirect URI `https://telescreen.deltavdevs.com/auth/google/callback`. You can reuse the blog's client.

**DeltaTime:** sign into DeltaTime as your admin user and create an admin API key at `/admin/admin_api_keys`. Set it as `DELTATIME_ADMIN_KEY`. Verdicts are attributed to that key's owner.

```sh
npm install
npm run dev   # uses .env
npm test      # set TEST_PG_URL to also run the Postgres console test
```
