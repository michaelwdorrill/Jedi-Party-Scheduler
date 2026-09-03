# 0015 — Self-service "add this bot" link, gated by owner approval

**Status:** Ready
**Covers:** `IDEAS.md` item 9
**Phase:** 4 → **v0.7.1**

## The problem

Today a server gets onto the allow-list one way: Michael runs a
`wrangler d1 execute` insert into `guilds` by hand, per `docs/SETUP.md`.
There is no path for someone who wants the bot in their own server to ask
for it, and no record of "who asked, for what, and was it granted" beyond
whatever is in a chat thread. Idea 9's own capture is specific about the
shape: a public page distinct from the raw Discord OAuth bot-add URL (which
has no guardrail at all — anyone with that link adds the bot with no review),
a pending-request state, and an email to the owner to approve or reject
before the server can use the app.

## Why this waited for v0.7

`ROADMAP.md`'s Phase 4 called both items in it "operational rather than
user-requested," and nothing else in the backlog depends on this one — idea
2 (Google Calendar sync, v0.8) lists idea 10 as a dependency, not this. It
also needs a dependency nothing else in the app has paid for yet: **outbound
email**. `docs/SETUP.md`'s contact address is a `mailto:` link on the legal
pages; nothing in the Worker has ever sent a real email. Rule 4 (a new
dependency is paid for once) is why this was sequenced after idea 10 rather
than bundled with it — idea 10 turned out to need no email at all (it warns
by DM, which the bot already does), so building it first meant the actual
new-dependency item could stay isolated to this spec alone.

## Who may request, and for what

**Only someone who administers the target Discord server may request it** —
not merely a member. Discord's OAuth `GET /users/@me/guilds` returns a
`permissions` bitfield (and an `owner` boolean) per guild; a request is only
accepted for a guild where the requester's bitfield includes `MANAGE_GUILD`
(bit `0x20`) or `owner` is true. Without this check, any logged-in user could
submit a request for a server they have no authority over, and the
owner-approval step would be reviewing a claim with no way to verify it
beyond trusting the requester's word.

**This cannot reuse the main login session, and the first draft of this spec
assumed it could — worth recording why, since the fix changes the flow.**
`routes/auth.ts` fetches `/users/@me/guilds` once, during the OAuth callback,
and its own comment says the access/refresh tokens are deliberately *not*
persisted afterward ("nothing in the app needs to act on Discord's behalf
later, so keeping them would be retaining API Data beyond what the
functionality requires" — the same discipline `ARCHITECTURE.md` calls out as
a feature for Phase 5's Google sync question). So there is no live Discord
token anywhere after login to ask "does this session's user administer guild
X" with. And it isn't a matter of caching the answer at login time either:
`user_guild_membership.guild_id` is a foreign key into `guilds(id)` — it
*structurally cannot hold a row* for a guild that isn't already on the
allow-list, which is exactly the set idea 9 exists to let someone reach.

**So the permission check gets its own short-lived Discord OAuth round trip,
separate from login, at the moment someone starts a request — not a standing
"here are all the servers you administer" table synced at every login.**
`GET /guild-requests/connect` redirects through Discord's authorize screen
(scope `identify guilds`, the same scope login already asks for) to
`GET /guild-requests/callback`, which exchanges the code, calls
`fetchDiscordUserGuilds`, filters to guilds where the caller has
`MANAGE_GUILD` or owner, and hands the frontend that filtered list —
discarding the access/refresh tokens immediately after that one call,
identical to `routes/auth.ts`'s own discipline. Nothing new is retained
about which servers someone administers beyond the lifetime of that one
request; a person who submits a request twice a year re-proves it twice a
year, which is the honest cost of not keeping a standing record. This also
sidesteps a staleness question a persisted table would raise for free: admin
rights on a Discord server can be revoked, and a live check at request time
can't be wrong about someone's *current* standing the way a cached one could.

The list handed back to the frontend needs its own short-lived proof that it
came from *this* request's OAuth round trip and wasn't tampered with — a
signed token (reusing `lib/jwt.ts`, same shape the decision-link token below
uses) carrying the picked guild's id/name/requester id, minted by the
callback and consumed by the actual `POST /guild-requests` call. Without it,
`POST /guild-requests` would have to either trust a bare guild id the browser
sends (exactly the unverifiable claim this whole check exists to avoid) or
re-run the OAuth exchange a second time.

This makes the request flow **login-gated** for the main site session (idea
9's "public page" is public in the sense that anyone can reach it and start
the flow, not that it accepts a server id from a fully anonymous visitor)
**and additionally Discord-verified per request** via the round trip above,
which is the part that actually proves administrator standing.

**A second OAuth round trip means a second registered redirect URI, and this
was missed until sandbox testing hit it.** Discord refuses an
`/oauth2/authorize` request with "Invalid OAuth2 redirect_uri" unless the
exact URI is pre-registered on the application, and only `/auth/callback`
had ever been added — for either the sandbox or the production Discord
application; nothing about login breaks without the second one, which is
exactly why it went unnoticed until `/add-bot` was actually exercised rather
than just built. `docs/SETUP.md` now lists `/guild-requests/callback`
alongside `/auth/callback` everywhere the first one is set up, but
**production's Discord application still needs it added by hand** before
`/add-bot` will work there — this is a one-time dashboard change, not
something a deploy can carry.

## Flow

1. A signed-in user visits a new page (not the raw Discord bot-invite URL)
   and starts a request. This kicks off the `/guild-requests/connect` round
   trip above; they come back with a short list of servers they administer
   that aren't already allow-listed, each carrying the signed token described
   above.
2. If Discord reports every administered guild is already on the allow-list
   and active, the page says so and stops — nothing to request.
3. Otherwise the user picks one of the remaining servers. `POST
   /guild-requests`, carrying that server's signed token from step 1, creates
   a **pending** row (schema below) and redirects to Discord's own
   bot-authorization URL
   (`https://discord.com/oauth2/authorize?client_id=...&scope=bot&guild_id=...`),
   scoped to the specific guild so Discord's own consent screen is what
   actually adds the bot — this spec's request/approval flow governs whether
   the app *treats* that server as allow-listed, not whether the bot
   technically joins it. A server the owner never approves ends up with the
   bot present but unable to do anything the allow-list gates (every route
   that reads `guilds.is_active` already refuses an inactive/absent guild).

   **"Scoped to the specific guild" needs `disable_guild_select=true`, and
   the first build shipped without it.** `guild_id` on its own only
   *pre-selects* the server in Discord's dropdown; the person can change it,
   which is precisely what sandbox testing did by accident — requested one
   server, installed the bot into another, and nothing in the flow noticed
   the two had diverged. Worth being exact about what that did and didn't
   break, because the two are easy to conflate: the allow-list was never at
   risk, since approval writes `guild_add_requests.guild_id` — the *requested*
   server, recorded before Discord was ever involved — and never anything
   Discord hands back afterwards. So no unapproved server could be
   allow-listed by this. What it produced instead was an incoherent pair: an
   approved server with no bot in it, and a bot sitting in a server nobody
   reviewed. Neither is a security failure; both are the flow lying about
   what it did.

   Verified by direct A/B against Discord rather than by test alone, which
   matters here: the regression test can only prove the Worker *emits* the
   parameter, not that Discord honours it — a wrong parameter name would
   leave every check green and the bug live. Loading the same bot-invite URL
   twice, identical but for that one parameter, the dropdown is locked with
   it and freely changeable without it.
4. The owner gets an email: server name, requester's Discord username, a link
   to approve, a link to reject. Both links carry a short-lived signed token
   (see below) rather than requiring the owner to be logged into the site
   from whatever device they read the email on.
5. Approving performs the exact allow-list insert the manual `wrangler d1
   execute` step in `SETUP.md` does today; rejecting marks the request
   decided with no insert. Either way the requester is **not** emailed back —
   nothing in the app sends outbound email to anyone but the owner (see
   below), so the requester finds out by trying the site, the same way they
   would find out today by asking Michael directly.

## Why an emailed signed link, not only an `/admin` page

Idea 9's own capture offered both options. Both ship: the signed email link
is the fast path (approve or reject in one click from wherever the owner
reads mail), and the existing owner-only admin surface (`routes/admin.ts`,
already gated by `isOwner`) gets a `GET /admin/guild-requests` list and
`POST /admin/guild-requests/:id/approve|reject` as the fallback/audit trail —
useful if an email is lost, delayed, or the owner wants to review history.
Building only the in-app page would mean the "you have a pending request"
signal only ever reaches someone already in the habit of checking it, which
is a real gap for something that might arrive once every few months.

The email link's token is a short-lived signed JWT (reusing `lib/jwt.ts`'s
existing signing key and machinery — no new secret to provision), carrying
the request id and the action (`approve`/`reject`), not a separately stored
per-request secret. A 7-day expiry is enough slack for an owner who doesn't
check a particular inbox daily, comfortably inside `SESSION_TTL_MS`'s own
7-day precedent elsewhere in this codebase. The token needs no server-side
revocation list: the endpoint that consumes it also checks
`guild_add_requests.decided_at IS NULL` before acting, so a stale or reused
link on an already-decided request is simply a no-op, the same idempotency
discipline `deliverThroughOutbox`'s claim-token pattern uses elsewhere.

The consuming endpoint (`GET /guild-requests/:token/decide`) sits **outside**
`adminRoutes`' `isOwner` session gate, since the caller is presenting a
capability token, not a session — the same reasoning `specs/0012`'s cross-spec
note gives for why the Discord interactions endpoint ignores the policy gate:
it's a different kind of caller than a logged-in browser.

## Schema

```sql
CREATE TABLE guild_add_requests (
  id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL,             -- Discord guild id; NOT a guilds(id) FK, since the whole point is it isn't allow-listed yet
  guild_name TEXT NOT NULL,           -- as Discord reported it at request time
  requested_by TEXT NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  requested_at INTEGER NOT NULL,
  decided_at INTEGER,
  UNIQUE(guild_id, status) -- see note below on re-requesting a rejected guild
);
```

The `UNIQUE(guild_id, status)` constraint (rather than `UNIQUE(guild_id)`)
needs one more decision at build time: SQLite partial unique indexes make
this exact, e.g. `CREATE UNIQUE INDEX ... ON guild_add_requests(guild_id)
WHERE status = 'pending'` — only one *pending* request per guild at a time,
but a previously-rejected guild can be requested again later (an owner
declining once shouldn't permanently block a future ask, e.g. after the
server changes hands).

## What this spec deliberately does not cover

- **Revoking/removing a server from the allow-list.** Out of scope; the
  manual path still exists for that, and nothing about self-service adding
  implies self-service removing.
- **Notifying the requester of the decision.** No email to anyone but the
  owner — see Open questions below for why this is deliberately narrow to
  start.
- **Rate-limiting requests.** The `MANAGE_GUILD` check already bounds who can
  create one; a single person spamming requests for guilds they administer is
  a nuisance for the owner's inbox, not a security hole, and this app has no
  request-rate-limiting infrastructure anywhere else to extend (`sessions.ts`
  notes login itself has none, "a bigger piece of infrastructure this app
  doesn't have yet").

## Decided: Resend

**Michael picked Resend** (Sept 2026) — generous free tier at this app's
volume, an HTTP API (no SMTP, which Workers can't speak anyway), and the
simplest domain-verification path of the candidates considered. This unblocks
the build; nothing else in this spec changes.

Operational consequences, spelled out so the build doesn't silently assume
they're already true:

- **`RESEND_API_KEY` is a new Worker secret**, provisioned the same way
  `DISCORD_BOT_TOKEN` already is (`wrangler secret put`, per environment,
  never committed, never pasted into chat). Production and sandbox get
  **separate** Resend API keys if Michael creates a second Resend account or
  a scoped key for it — not required before the build lands (see the
  sandbox stubbing decision below), but needed before v0.7.1 actually ships
  live email from the sandbox for a real end-to-end check.
- **A sending domain Michael controls needs SPF/DKIM records added** in
  Resend's dashboard before any real send will deliver rather than bounce or
  land in spam. This is a one-time setup step outside this repo — nothing in
  the Worker can do it — and blocks *live* sending, not the code itself,
  which can be built and merged first and simply left unable to send for
  real until DNS is verified.
- `lib/email.ts` wraps Resend's `POST https://api.resend.com/emails` behind
  one function (`sendOwnerEmail`), matching how `lib/discord.ts` wraps the
  Discord API — one place that knows the provider, so a future provider swap
  (unlikely, but idea 9's capture named several candidates for a reason)
  touches one file.

## Decided: the sandbox stubs the send

Confirmed rather than left as a leaning: `EMAIL_MODE` is a new per-environment
string var (`wrangler.toml`, alongside `WORKERS_PLAN` and the other
environment-scoped settings) — `'live'` in production, `'stub'` everywhere
else including local dev and the sandbox. In `'stub'` mode `sendOwnerEmail`
logs what it would have sent (recipient, subject, both decision links) via
`console.log` and returns success without calling Resend at all. This flow
sends to Michael's *own* inbox, so live-sending it from the sandbox during
routine iteration would either spam that inbox or need a second throwaway
address for no real benefit — `wrangler tail --env sandbox` during a
verification pass shows the stubbed content just as well as an inbox would,
and is exactly the check step CLAUDE.md's sandbox section already calls out.
Flipping `EMAIL_MODE` to `'live'` in the sandbox for one real end-to-end
check, once the sending domain is verified, is a one-line `wrangler.toml`
edit Michael can make and revert locally — not something this build needs to
decide for him.

Checked against `check:env-parity` (`scripts/check-env-parity.mjs`) rather
than assumed: it only requires `[vars]` and `[env.sandbox.vars]` to carry the
same *key set*, plus one value-equality rule hardcoded to `WORKERS_PLAN`
specifically (and a value-*inequality* rule for the D1 `database_id`s). A new
key present in both blocks with different values — exactly `EMAIL_MODE`'s
shape — already passes with no changes to that script. `DISCORD_PUBLIC_KEY`
is the existing precedent for a var that's expected to differ in value
between the two environments.

## Decided: no requester notification in this build

Stays out of scope for v0.7.1 as the spec originally leaned. An approved
requester learns by trying the site, same as today's fully-manual process.
Revisit once real usage happens; adding it later is one more outbound email
per decision, not a schema change.
