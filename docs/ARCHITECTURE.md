# Architecture

## Why two deployments

GitHub Pages only serves static files — no server-side code, no secrets, no
database, no long-running process. Discord OAuth's code-exchange step needs
a client secret, "friends" and events need shared storage, and Discord DM
notifications need something that runs on a schedule. None of that can live
in the static site, so the frontend (GitHub Pages) and backend (a Cloudflare
Worker + D1 database) are separate deployments that talk over HTTP.

```
Browser (GitHub Pages, static React app)
   |  fetch() with `Authorization: Bearer <JWT>`
   v
Cloudflare Worker (Hono router)  <-->  D1 (SQLite)
   |  Cron Trigger every 15 min
   v
Discord REST API (OAuth token exchange, bot DMs)
```

There are two deployments of these two deployments: production, and an
optional sandbox (`docs/specs/0002-sandbox-and-promotion.md`) — a second
Worker, D1 database and Discord application in the same Cloudflare account,
for exercising a change against the real thing before it reaches production.
The sandbox has no second frontend deployment; `FRONTEND_URL` points it at a
local Vite dev server instead, which the OAuth redirect above already makes
work with no extra plumbing. It holds **no real user data** — a checked-in
seed script (`worker/scripts/seed-sandbox.sql`) provides synthetic users,
guilds and events instead, and production data is never copied into it.

## Auth

Discord OAuth2's Authorization Code flow, but the *redirect_uri* is the
Worker, not the frontend — only the Worker holds the Discord client secret
needed to exchange the code for a token. After exchange, the Worker mints
its own short-lived JWT (HS256, `worker/src/lib/jwt.ts`, signed with a
secret only the Worker knows) and redirects back to the frontend with that
JWT in the URL hash fragment. The frontend stores it in `localStorage` and
sends it as a bearer token on every request — not a cookie, since the
frontend (`uncleowen.space`, served by GitHub Pages) and backend
(`*.workers.dev`) are different origins, which would make any cookie
third-party and subject to browser cookie-blocking. Moving the frontend to a
custom domain did not change this: the two halves are still cross-origin, so
the bearer token remains the right call. It would only stop applying if the
Worker were served from a subdomain of the same site (e.g. `api.uncleowen.space`
via a Cloudflare route), which would make a first-party cookie possible.

The JWT is short-lived and the session behind it is revocable server-side
(`sessions` table), so logout is a real revocation rather than just deleting
the client's copy — see `frontend/src/auth/pendingRevocation.ts` for the
queue that retries a revocation whose request never landed.

"Which Discord servers can this user see" is answered once at login (and
on every login) by calling Discord's
`/users/@me/guilds` with the user's own OAuth token and intersecting the
result against the `guilds` table (the owner-curated allow-list), caching
the result in `user_guild_membership`. Discord's access and refresh tokens
are used once during that exchange and then discarded -- nothing in the app
acts on Discord's behalf later, so retaining them would be keeping API Data
past the point it's needed. The bot token is used for exactly one thing:
sending DMs.

## Privacy model

Two separate guarantees, worth keeping distinct:

- **Event content** (titles, descriptions, games, who's invited) is visible
  only to an event's organiser and its invitees. This is enforced in every
  query, not just hidden in the UI, and there is no admin endpoint that reads
  other people's event data. It is *not* protected against whoever controls
  the Cloudflare account, who can query D1 directly -- the Privacy Policy says
  so plainly rather than implying otherwise.
- **Free/busy availability** is a much weaker disclosure, and deliberately so.
  `lib/freeBusy.ts` returns `{startAt, endAt}` and nothing else: no titles, no
  guild, no participants, no event ids, and overlapping commitments are merged
  so you can't even count how many separate things someone has on. Users who
  set `free_busy_visible = 0` are returned with `visible: false` and an empty
  list, so the UI can say "hidden" rather than falsely imply they're free.

Personal events (`personal_events`) are private to their owner in the first
sense -- nobody else can read their title through any endpoint -- while still
feeding the second, so blocking out travel or work makes you unavailable
without telling anyone what you're doing.

## Data model

See `worker/migrations/0001_init.sql` for the full schema. The short version:
`events` holds both fixed-time events and "potential invite" polls
(`event_type`); recurring events get a row in `event_recurrence_rules`
instead of a fixed `start_at`/`end_at`; `event_invites` tracks who's invited
and their RSVP; polls get candidate slots in `event_poll_options` with votes
in `event_poll_votes`; and `notification_log` is what prevents the reminder
cron from DMing someone twice for the same thing. Its `UNIQUE` constraint is
what makes the claim safe, but the row is no longer a record of *intent* —
see "Delivery is an outbox, not a log" below for what its columns actually
mean and why "we wrote the row" and "the DM arrived" had to stop being the
same fact.

## Recurring events

Occurrences are expanded on read (`worker/src/lib/recurrence.ts`) for
whatever window the calendar is currently showing (this month + next month,
~60 days) rather than pre-generated and stored. A Worker request is
short-lived and there's no natural place to run a "keep occurrences
materialized" background job beyond the cron we already have for
reminders — expanding on read is self-healing (no risk of a stale/missing
materialization job leaving gaps) and cheap at a 60-day window. The
expansion fast-forwards past old periods using date arithmetic rather than
stepping day-by-day from the series' start, so a multi-year-old
never-ending weekly event stays cheap to expand.

## Polls ("potential invites")

Two resolution strategies, both configured per-poll:

- **threshold** — resolves the instant an option's yes-count reaches the
  configured number, checked synchronously right after each vote.
- **most_votes** — never resolves early; the cron sweep picks the
  highest-voted option once the poll's deadline passes.

The deadline is mandatory on every poll (even `threshold` ones) as a
safety net: if a `threshold` poll never reaches its target, the cron sweep
resolves it via most-votes logic once the deadline passes, so a poll can
never just hang open forever.

## Notifications

A single Cloudflare Cron Trigger (`*/15 * * * *`,
`worker/src/cron/reminders.ts`) does everything: resolves past-deadline
polls, sends "you've been invited" DMs, sends 24h/1h reminders for anything
starting soon (expanding recurring events just for the next 24h to check),
nudges idle groups, and prunes expired history.

### Delivery is an outbox, not a log

`notification_log` (and `group_nudge_log` for group nudges) is a **leased
outbox**, not a record of intent — see `worker/src/lib/outbox.ts`. Each row
carries `delivered_at` / `failed_at` / `attempt_count` / `next_attempt_at`
and a `claim_token` + `claimed_until` lease.

A sender takes the lease with a single `INSERT … ON CONFLICT DO UPDATE …
WHERE … RETURNING` statement. Because the whole claim is one statement,
exclusion comes from the database serialising it: two overlapping ticks
cannot both send the same DM, because the loser's `WHERE` no longer matches
and it gets no row back. The lease expires on its own, so a Worker that dies
mid-send doesn't strand the row.

Only a confirmed Discord response writes `delivered_at`. A 429 or 5xx sets
`next_attempt_at` with exponential backoff; a permanent 4xx (DMs closed, bot
removed) sets `failed_at`. A row that exhausts `MAX_DELIVERY_ATTEMPTS` stops
being claimable and is settled by a per-tick reaper.

### The tick has a budget, and a cursor

Cloudflare caps **both** D1 queries and outbound subrequests per invocation
(50 each on Free, 1,000 on Paid). The cron's cost is not one expensive query
— it is a *product* of individually-reasonable limits: one event at the
300-invitee maximum wants 300 DMs, which is well past a Free invocation's
allowance before the other eleven sweeps have run.

Two mechanisms keep that bounded:

- **`worker/src/cron/budget.ts`** gives the tick an explicit allowance and
  charges it for both the deliveries it makes *and* the scanning it does to
  find them. When it runs out, sweeps stop cleanly. Stopping early is a
  delay; being killed mid-flight by the platform is a lost or duplicated DM.
- **`worker/src/cron/cursor.ts`** (table added in 0010, made keyset in 0011)
  records how far each scan got. Without it a budget-limited tick would
  rescan the same prefix every fifteen minutes and never reach anything past
  it — deferral would be starvation.

  The cursor stores the last *key* processed, not a count. That distinction
  matters because the reminder scans' predicate (`start_at >= now`) moves
  every tick: rows drop off the front as events begin, so an offset counted
  against one tick's result set points somewhere else in the next one's, and
  the rows it skips are due reminders nothing downstream recovers. Resuming
  after a key is stable under that. End-of-scan is detected by getting back a
  short page, never inferred from a full one.

  It remains a fairness mechanism, not a correctness one: correctness comes
  from the outbox, which won't send twice however many times a sweep revisits
  an event.

Recipient queries fold the "already settled?" check into the query that
fetches them (`pendingRecipients`), so an event whose notifications are all
delivered costs one query and returns nothing, rather than one query per
participant to rediscover there is nothing to do.

Everything whose cost scales with stored data draws on the same allowance —
notification delivery, per-event scanning, expired-poll resolution, and the
terminal-history purge. Only the genuinely fixed per-tick sweeps are reserved
for. Maintenance yields to notifications, so a busy tick defers the purge to a
quieter one rather than pushing the invocation past its ceiling.

`WORKERS_PLAN` in `worker/wrangler.toml` tells the budget which allowance it
has. It *describes* the account's plan; it does not change it. See
`docs/SETUP.md` for the throughput this implies.
