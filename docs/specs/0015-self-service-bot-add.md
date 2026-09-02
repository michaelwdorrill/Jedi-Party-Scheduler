# 0015 — Self-service "add this bot" link, gated by owner approval

**Status:** Decisions locked — blocked on one operational choice (see Open
questions)
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
not merely a member. Discord's `GET /users/@me/guilds` (already called during
login to sync membership, `lib/discord.ts`) returns a `permissions` bitfield
per guild; a request is only accepted for a guild where the requester's
bitfield includes `MANAGE_GUILD` or they are the guild's owner. Without this
check, any logged-in user could submit a request for a server they have no
authority over, and the owner-approval step would be reviewing a claim with
no way to verify it beyond trusting the requester's word.

This makes the request flow **login-gated**, not anonymous: the "public
page" idea 9's capture describes is public in the sense that anyone can
reach it and start the flow, not that it collects a server id from an
unauthenticated visitor. Reusing the existing Discord OAuth login is cheaper
than building a second identity-proving mechanism, and it is the same trust
boundary `user_guild_membership` sync already relies on for everything else
in the app.

## Flow

1. A signed-in user visits a new page (not the raw Discord bot-invite URL) and
   picks one of their administered servers from the list `GET /me/guilds`
   already resolves (or a new endpoint filtered to `MANAGE_GUILD`/owner —
   `GET /me/guilds` today only returns guilds relevant to event membership;
   check at build time whether it already carries `permissions` or needs one
   more field added, not a new endpoint).
2. If that guild id is already in the `guilds` allow-list and active, the page
   says so and stops — nothing to request.
3. Otherwise, `POST /guild-requests` creates a **pending** row (schema below)
   and redirects to Discord's own bot-authorization URL
   (`https://discord.com/oauth2/authorize?client_id=...&scope=bot&guild_id=...`),
   scoped to the specific guild so Discord's own consent screen is what
   actually adds the bot — this spec's request/approval flow governs whether
   the app *treats* that server as allow-listed, not whether the bot
   technically joins it. A server the owner never approves ends up with the
   bot present but unable to do anything the allow-list gates (every route
   that reads `guilds.is_active` already refuses an inactive/absent guild).
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

## Open questions

**One blocks implementation and needs Michael's answer, not a default guess:
which email provider.** Every Cloudflare Workers-compatible option is an HTTP
API call (Workers can't speak SMTP directly), so the code shape barely
changes between them, but the operational commitment does: an account, a
sending domain with SPF/DKIM DNS records on a domain Michael controls, an API
key stored as a Worker secret (`wrangler secret put`, the same pattern
`DISCORD_BOT_TOKEN` already uses — never in this repo, never in chat), and
for most providers a real, if small, cost once trial volume is exhausted.
Candidates: Resend, Postmark, SendGrid, Mailgun. This is exactly the kind of
external-service commitment this project's own guardrails (CLAUDE.md's
Cloudflare-account section) treat as needing a person to decide, not a
default to fall back on.

Two smaller questions follow from the first and can wait until it's answered:

1. **Does the sandbox send real email?** Either it uses the same provider
   against a low sending volume (fine if the provider's free tier is generous
   enough that testing this flow a handful of times doesn't matter), or the
   sandbox Worker stubs the send entirely and verification confirms "the
   right email *would* have been sent" from logs, the same shape
   `test/helpers.ts`'s `stubFetch` already gives the test suite. Leaning
   toward stubbing in the sandbox specifically: this flow sends to Michael's
   *own* inbox, so a stub avoids either spamming it during iteration or
   needing a second throwaway address.
2. **Should the requester ever be told the outcome?** Rejected out of scope
   above for the first build, but worth asking once real usage happens: an
   approved requester currently only learns by trying the site, which is a
   worse experience than the rest of this app tries to offer. Adding it later
   is one more outbound email per decision, not a schema change.
