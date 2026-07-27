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

## Auth

Discord OAuth2's Authorization Code flow, but the *redirect_uri* is the
Worker, not the frontend — only the Worker holds the Discord client secret
needed to exchange the code for a token. After exchange, the Worker mints
its own short-lived JWT (HS256, `worker/src/lib/jwt.ts`, signed with a
secret only the Worker knows) and redirects back to the frontend with that
JWT in the URL hash fragment. The frontend stores it in `localStorage` and
sends it as a bearer token on every request — not a cookie, since the
frontend (`*.github.io`) and backend (`*.workers.dev`) are different
origins, which would make any cookie third-party and subject to browser
cookie-blocking.

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
cron from DMing someone twice for the same thing (its `UNIQUE` constraint is
the actual dedupe mechanism — the code inserts the log row *before*
attempting delivery, so a duplicate insert means "already handled, skip").

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
polls, sends "you've been invited" DMs for invites that haven't been
notified yet, and sends 24h/1h reminders for anything starting soon
(expanding recurring events just for the next 24h to check). It always
inserts into `notification_log` before attempting the Discord DM send —
that insert succeeding (not the DM succeeding) is what "sent" means, so a
DM that fails (e.g. the user has DMs closed) is logged as attempted and
won't be retried indefinitely.
