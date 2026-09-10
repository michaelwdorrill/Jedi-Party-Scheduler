# 0017 — Google Calendar sync

**Status:** Built — push half v0.8, pull half v0.8.1, pull half reworked v0.8.1 v2 (ships dormant: `GOOGLE_SYNC_MODE` is "off" until a Google client is provisioned)
**Covers:** `IDEAS.md` item 2
**Phase:** 5 — ships in v0.8 (push half); the pull half is v0.8.1, reworked within the same unreleased branch -- see **The pull half, twice over** below

## The change in one sentence

A person connects one Google account, picks one of their Google calendars, and
the sessions they are actually committed to start appearing on it — written by
the cron, never by the request that created the event.

## Why the push half alone is the release

Item 2's own decision (Aug 2026) already said to build this in two halves, and
this spec takes that literally rather than as a note about ordering within one
release. Push first, pull in v0.8.1. Three reasons, and only the third is new:

1. **Push needs no incremental sync model.** No `syncToken`, no webhook channel
   to renew, no conflict resolution — Uncle Owen is the sole author of the
   events it writes, so "what changed" is answerable from our own
   `events.revision` (migration 0013) without asking Google anything.

2. **It delivers the felt value.** The complaint behind item 2 is that a game
   night is invisible to the calendar the rest of someone's life runs on.
   Pushing fixes that. Pulling fixes a smaller, second thing — the scheduling
   assistant not knowing about a dentist appointment.

3. **The pull half is not the small addition it looks like, and this is the
   part item 2's capture did not anticipate.** `freebusy.query` itself is one
   POST. But the place its answer belongs is
   `computeBusyBlocksForUsers` (`worker/src/lib/freeBusy.ts:46`), which is
   called *synchronously inside a request* for up to `MAX_FREE_BUSY_USERS` (25)
   people at once. One Google call per connected user is up to 25 outbound
   subrequests in a single invocation, against a Free-plan ceiling of 50 — for
   a function whose entire existing design note is about how its cost is a
   *product* and every factor has to be small. So the pull half needs a cached
   busy table refreshed by the cron, plus a staleness rule, plus an answer for
   what the assistant shows while the cache is cold. That is a second design,
   not a second endpoint, and bolting it onto this release is how the v0.4.6
   lesson (`specs/0013` held back from v0.4.5) gets learned twice.

The scopes are chosen so the second half needs no re-consent — see **Scopes**
below. That is deliberate: making someone re-authorise in 0.8.1 would be the
avoidable cost of splitting the work.

### A constraint on the pull half, decided before it is built

**Only one Google calendar, explicitly chosen, may be read into Uncle Owen**
(Michael, Sept 2026). Not "all calendars this account can see", and not
implicitly the same calendar we write to.

This restates item 2's original capture — *"a single chosen Google calendar,
not all of them — e.g. just 'D&D Scheduling', not 'Family' or 'Fulham FC'"* —
and it survives contact with the design: `freebusy.query` takes an explicit
list of calendar ids, so scoping it to exactly one is the natural shape rather
than a restriction bolted on afterwards.

Three things follow, and the third is the one that matters for the security
review:

- **It is a second setting, not the existing one.** `calendar_id` is the
  *write* target; the pull half needs its own `read_calendar_id`. They are
  genuinely different choices — writing sessions into a dedicated "Games"
  calendar while reading busy time from a personal one is the obvious setup,
  and collapsing them would force one to be wrong.
- **It defaults to nothing.** Null means the pull half is off for that user,
  so nobody starts having a calendar read because they connected for pushing.
  Reading is opt-in on top of an opt-in.
- **Google cannot enforce this; only our code can.** Calendar OAuth scopes are
  account-wide — there is no per-calendar scope — so `calendar.readonly`
  grants read access to *every* calendar the account can see, and the promise
  that we touch only one is kept by the query we choose to send, not by the
  grant. That is an honest limitation to state plainly in the Privacy Policy
  rather than imply otherwise, and it is exactly the kind of claim a security
  reviewer should push on.

  The paragraph that used to close this bullet argued the opposite of what
  actually shipped, and it is worth saying so rather than quietly editing it
  away: it claimed `freebusy.query` over a full event read meant "even the
  calendar we do read gives up far less than the grant would allow." **The
  pull half, twice over** below records why that argument lost to a
  sandbox-verification finding and a direct request in the same day. The
  calendar-scope limitation above is unchanged and still the right way to
  read it; what changed is that *within* the one calendar chosen, this app now
  reads real events, not opaque intervals.

## What the user sees

A **Connected calendars** card in Settings, between Scenery and Servers:

- Disconnected: one button, *Connect Google Calendar*, and a plain sentence
  about what will be written and where.
- Connected: the Google account's email, a dropdown of that account's writable
  calendars, a *Sync my sessions to this calendar* toggle, the time of the last
  successful sync, and *Disconnect*.

Nothing else in the app changes. There is no new page, no calendar-side UI, and
no indicator on an event that it has been mirrored — deliberately, because the
mirror is a copy, not a second source of truth, and drawing it in the app would
invite people to treat it as one.

## What this reverses, and how it is paid for

`ARCHITECTURE.md`'s auth section states plainly that Discord's access and
refresh tokens "are used once during that exchange and then discarded — nothing
in the app acts on Discord's behalf later, so retaining them would be keeping
API Data past the point it's needed."

This feature is the first thing in the app that genuinely does need to act on a
third party's behalf later, so that sentence stops covering everything. It is
not weakened; it is *scoped*. The new statement, which `ARCHITECTURE.md` gains:

> Discord tokens are still discarded at login. Google's refresh token is
> retained, because a scheduled sweep with nobody logged in is the entire
> mechanism — and it is the only long-lived third-party credential this app
> stores.

Three things pay for it:

- **Encrypted at rest.** `lib/crypto.ts` (new) wraps AES-GCM under a dedicated
  secret, `GOOGLE_TOKEN_ENCRYPTION_KEY`. A random 96-bit IV per record, stored
  alongside the ciphertext. Not `JWT_SIGNING_KEY`: that key already signs
  sessions and capability tokens, and one compromised secret should not both
  forge a session and decrypt everyone's Google credentials.
- **Never leaves the Worker.** No route returns a token, decrypted or not.
  `GET /me/export` returns the connection's *existence* — account email,
  calendar, timestamps — and never the credential, the same way it already
  returns notifications without returning the bot token.
- **Revoked on the way out.** Disconnecting and deleting an account both call
  Google's `oauth2/revoke`, so "we deleted our copy" is not the whole promise.

## Scopes

Two, both requested at connect time:

| Scope | For | Used by |
|---|---|---|
| `calendar.events` | create/update/delete the events we author | v0.8 |
| `calendar.readonly` | list the user's calendars; `events.list` on the one chosen for reading | v0.8 / v0.8.1 |

`calendar.readonly` is broader than the picker strictly needs today
(`calendar.calendarlist.readonly` would list calendars and nothing else), and
it is requested anyway *on purpose*: reading the chosen calendar needs it, and
asking for it now is what stops v0.8.1 from putting a fresh consent screen in
front of everyone who already connected. (`freebusy.query` was the original
call this scope covered; **The pull half, twice over** below records why that
call was replaced by `events.list` within the same release — the scope
requested did not need to change either time.) The alternative — narrow now, re-consent later
— trades a slightly smaller ask today for a worse moment later, and the whole
account is already inside the read/write `calendar.events` grant regardless.

Both are Google "sensitive" scopes, so the unverified-app 100-user ceiling and
its warning screen apply, exactly as item 2 accepted.

**One consequence of that which is not cosmetic, and which this spec missed
on first writing.** The ceiling and the warning are properties of being
*unverified*; the **publishing status** is a separate axis, and getting it
wrong breaks the feature outright. Google expires every refresh token issued
by an app whose status is **Testing** after 7 days — and a stored refresh
token presented by a cron sweep with nobody logged in is this entire design.
So production must run at **"In production", unverified**: warning screen,
100-user cap, and refresh tokens that survive. "We accept the unverified cap"
and "we stay in Testing" are not the same configuration, and only the first
was ever the decision. `docs/SETUP.md` section 7 carries the operational
version.

The sandbox stays in Testing deliberately, and therefore needs reconnecting
about weekly. That is worth knowing rather than fixing: it exercises the
`invalid_grant` path — `accessTokenFor` classifying it as permanent,
`sync_enabled` going to 0, and Settings saying *"Google access was revoked or
expired. Reconnect to resume syncing."* — on a real schedule, for free.

## The OAuth round trip

Modelled on `routes/guildRequests.ts`'s second Discord round trip
(`specs/0015`), which exists for the same structural reason: an OAuth redirect
is a top-level browser navigation and cannot carry an `Authorization` header,
so the flow has to prove who it is some other way.

1. `POST /google/connect-url` — authenticated, policy-gated. Mints a
   short-lived `google_connect_start` token naming the caller and returns a URL
   **on this Worker**: `/google/start?t=…`.
2. The browser navigates top-level to `/google/start`. That verifies the start
   token, generates a nonce, sets it as an HttpOnly cookie scoped to `/google`,
   mints the `google_connect` state token `{ userId, nonce }`, and redirects to
   Google.
3. Google → `GET /google/callback?code&state`. Verifies the signature, the
   purpose, the expiry, **and** that the payload's nonce matches the cookie.
4. Exchanges the code, stores the encrypted refresh token, redirects to
   `#/settings?google=connected`.

**Why the extra hop, which looks like indirection and is not.** The obvious
shape is for step 1 to set the cookie and hand back Google's authorize URL
directly. It cannot: step 1 is a cross-origin XHR (the frontend is
`localhost:5173` or `uncleowen.space`; the Worker is `workers.dev`), and a
browser **discards `Set-Cookie` from a cross-origin fetch** unless the request
carries `credentials: 'include'` and the response sends
`Access-Control-Allow-Credentials`. This app's API client deliberately does
neither — it authenticates with a bearer token and wants no ambient cookie
authority anywhere. So the cookie would silently never be stored, and every
callback would fail the nonce check.

The alternatives were considered and rejected. Turning on CORS credentials
globally widens every route's surface to serve one feature. Dropping the cookie
and trusting the signed state alone reintroduces exactly the account-linking
attack the cookie exists to stop. A top-level navigation to the Worker's own
origin makes the cookie plainly first-party, which is what
`routes/guildRequests.ts` already gets for free by never needing to know who is
asking.

**Worth recording as the general trap:** the double-submit-cookie pattern
`routes/auth.ts` documents so carefully is only free when the endpoint that
sets the cookie is reached by navigation. Copying it into a flow that starts
with an authenticated XHR silently loses the cookie half — and it fails
*closed*, so it looks like a verification bug rather than a missing cookie.

**Why both a signed token and a cookie.** The signed token alone identifies the
user, which is what the callback needs — but it travels through Google in a URL
and is therefore not a secret. On its own, an intercepted `state` would let an
attacker complete the flow with *their* Google account and have it bound to the
victim's Uncle Owen account, which is the classic OAuth account-linking attack
and would put someone else's sessions on a stranger's calendar. The cookie is
the double-submit half that makes possession of the token insufficient, exactly
as `routes/auth.ts:25`'s comment already argues for login. Neither half is
redundant: the cookie says "this browser started it", the token says "and this
is who was logged in when they did".

`access_type=offline&prompt=consent` is required, not decoration — without
both, Google returns a refresh token on the first authorisation only, so a
reconnect after a disconnect silently yields a connection that works for an
hour and then cannot be renewed.

## Data model

Two tables from migration `0036_google_calendar_sync.sql`, plus what the pull
half added and then changed — see **The pull half, twice over** below for the
column history; this section states where things ended up.

**`google_calendar_connections`** — one row per user, `user_id` the primary key.
Holds the encrypted refresh token and IV, the cached access token with its
expiry (so an ordinary tick spends no subrequest on a refresh), the Google
account email, the chosen `calendar_id`, `read_calendar_id` (migration `0037`;
null means the pull half is off), `sync_enabled`, `last_synced_at`,
`last_error`, and a `status` of `active` or `disconnecting`. It carries no
state about what the pull half has actually imported any more — migration
`0039` dropped `busy_blocks`/`busy_cached_at`/`busy_window_end_at`, which is
where that used to live; `personal_events` (below) is where it lives now.

**`google_event_links`** — the mapping, keyed `UNIQUE(user_id, event_id,
occurrence_date)`. Carries the `google_event_id` we were given back, and
`synced_revision`/`synced_start_at`/`synced_end_at` recording what we last
wrote. `occurrence_date` is `''` for a non-recurring event, matching
`event_attendance`'s convention from `specs/0014` exactly — a new keying
convention for the same concept is how two parts of a codebase start
disagreeing about what an occurrence is.

The link row is what makes the sweep idempotent: a push is an INSERT-or-PATCH
decided by whether a row exists, and "did this already go out" is a lookup
rather than a question for Google.

## What gets pushed, and the occurrence decision

Every occurrence in a rolling **60-day forward window** of events the user
organises or holds a non-declined invite to. Sixty days because that is already
this app's idea of "upcoming" — `DashboardPage` asked `now → +60d`
(`IDEAS.md` item 20) and `MAX_WINDOW_SPAN_MS` is the same 60 days.

**Concrete occurrences, not an RRULE series.** A recurring event could be
pushed once as a Google recurring event, which is fewer API calls and fewer
rows. It is rejected for this build:

- It needs a faithful translation of `event_recurrence_rules` into RRULE,
  including the `0=Mon..6=Sun` `by_weekday` encoding that `specs/0001` already
  records as the trap in this area, plus `event_occurrence_overrides` as
  `EXDATE`/`RECURRENCE-ID` exceptions. A translation bug writes *wrong dates
  into someone's real calendar*, which is the least recoverable failure this
  feature can have.
- Per-occurrence is what the rest of the app already speaks. `specs/0014` made
  attendance per-occurrence; a per-occurrence decline is exactly the case where
  a series-level push would put a session on the calendar the person has said
  they are not attending.

The cost is more Google events for a long series — a weekly game is roughly
nine rows inside the window rather than one. That is bounded, and it buys
correctness in the one direction where being wrong is worst. RRULE stays
available as a later optimisation; nothing here forecloses it.

**Not pushed:** personal time blocks (they came *from* the user's own life;
mirroring them back is a loop), unresolved polls and their candidate days (a
maybe is not a commitment — the same rule `freeBusy.ts:216` already applies),
cancelled events (the link is deleted instead), and any occurrence the user has
declined.

Each pushed event carries the title, the app's own link to the occurrence, the
server name, and the times. **Descriptions are deliberately not sent.** Event
descriptions are the most sensitive free text the app holds, the privacy model
in `ARCHITECTURE.md` names them explicitly, and a calendar entry does not need
one to be useful. This is the same "narrower is the point" reasoning item 2
applied to pulling titles.

## The sweep, and the budget it has to fit

`sweepGoogleCalendar`, wired into `runReminderSweep` **after**
`staleAccounts` — last of the budget-charged sweeps.

The ordering is not arbitrary. `cron/budget.ts` carries three separate recorded
incidents of a new fixed per-tick query starving `sweepPurgeTerminalHistory`
completely (item 47's first attempt, `sweepCancellationCascade`,
`sweepStaleAccounts`), and its comment states the counterintuitive part
plainly: raising `RESERVED_QUERIES` to "match" a new charge makes the remainder
*smaller*, not unchanged. So this sweep takes the treatment those three
converged on rather than the naive one:

- **`RESERVED_QUERIES` stays at 24.** Its discovery read — one query for
  connections with `sync_enabled = 1`, ordered by `last_synced_at` — runs
  uncharged, the same as `sweepStaleAccounts`' and
  `sweepPurgeTerminalHistory`'s own candidate SELECTs.
- **No cursor**, so no `CursorStore` slot and no extra bookkeeping statement.
  Ordering by `last_synced_at` ascending is a cursor for free: the least
  recently synced connection is next by construction.
- **Not in `reapExhaustedDeliveries`'s table list**, for the reason
  `lib/outbox.ts:98` gives for `account_purge_warnings` and
  `organizer_rsvp_notice_log` — one more table there is one more real query on
  every tick forever.
- **A hard per-tick cap** of `MAX_SYNC_USERS_PER_TICK = 3` connections and
  `MAX_SYNC_WRITES_PER_TICK = 10` Google calls, both charged through the
  existing `budget.trySpend()`/`reserveDelivery()` accounting so calendar
  pushes and DMs draw on one allowance rather than two that are each
  "reasonable".

**Corrected after the first sandbox verification, and the correction is the
more useful half of this section.** The design above — run last on every tick,
take whatever the notification sweeps leave — is wrong, and it failed in the
worst available way: silently, completely, and while looking idle rather than
broken.

Measured against the real sandbox, what the notification sweeps leave is
**eleven queries**, stable, every tick. This sweep needs ten for the calendar
read and two more for a single write. So it reserved the ten, read the whole
calendar, could not afford one write, and returned *before* stamping
`last_synced_at` — no entries, no `last_error`, nothing in the logs. It did
that roughly 380 times across four days and the operator's only evidence was a
Settings card that had said "Last synced: not yet" since the moment it
connected.

Two things were wrong, and both are worth naming separately:

- **Reserve-before-spend was applied to half the unit of work.** `lib/outbox.ts`
  states the rule — "reserving first means a delivery this tick cannot afford
  costs nothing at all" — and this sweep cited it while reserving only the
  read. Its actual unit is read-*then*-write, so that is what has to be
  affordable before anything begins. It now reserves both, and says so in the
  log when it cannot.
- **"Last, on the leftovers" is the wrong shape for indivisible work.** It is
  right for deliveries, which are cheap divisible units — one DM at a time,
  stop when the money runs out. It cannot work for a task with a fixed
  ten-query cost before its first useful unit, because the leftovers are
  reliably smaller than that fixed cost. Being last did not make this sweep
  low-priority; it made it never run.

**So it runs hourly, and goes first on the tick it runs** (`SYNC_INTERVAL_MS`,
55 minutes; `googleSyncDue` answers the question uncharged before the tick
spends anything). Hourly is the honest cadence for a mirror rather than a
concession: a session reaching someone's Google calendar within the hour is
fine, where a reminder that misses its window is not.

The trade is explicit. On the one tick in four that it runs, the notification
sweeps have less to spend — which the outbox is built to absorb, since an
undelivered row simply waits for the next tick fifteen minutes later. On the
other three they get *more* than before this feature existed, because the sweep
no longer burns eleven queries per tick achieving nothing. `MAX_CONNECTIONS_PER_TICK`
drops to 1 to bound what that one tick costs.

A refresh-token exchange is one subrequest, and only when the cached access
token is inside its expiry skew — so a steady-state tick spends zero on auth.

## Disconnect, and what happens to what was already written

Disconnecting sets `status = 'disconnecting'` rather than deleting the row, and
the sweep then removes the future occurrences it wrote before revoking the
token and dropping the connection.

The tempting alternative — revoke immediately, leave the events behind — is
rejected because it silently makes the app's mess someone else's problem, in
their real calendar, with no way for them to tell which entries were ours
except by reading them. Doing it the other way round (delete, then revoke)
needs the token to survive the deletions, which is exactly why the row lingers
in `disconnecting` rather than the request doing it all synchronously and
timing out on somebody with a busy fortnight.

Past occurrences are deliberately left alone. They are a record of something
that actually happened, and reaching into someone's calendar history to erase
it is a worse default than leaving it.

If cleanup cannot finish — the token is already revoked at Google's end, the
calendar was deleted — the sweep gives up after `MAX_DELIVERY_ATTEMPTS`-style
exhaustion and drops the connection anyway. Holding a credential forever
because a tidy-up failed is the worse of the two outcomes.

`deleteUserCompletely` (`lib/db.ts:437`) gains both tables, children first,
consistent with every other table in that batch.

## The pull half, twice over

The pull half shipped in v0.8.1 as `freebusy.query` against the chosen
calendar, cached as an opaque `{startAt, endAt}` blob on
`google_calendar_connections` and merged into `computeBusyBlocksForUsers`
indistinguishably from Uncle Owen's own busy time. Both the endpoint choice
and the cache-not-content choice were deliberate, argued positions in this
spec's earlier revision. Both reversed, in the same day, before this release
left the branch — found and decided during sandbox verification, not planned
in advance, which is exactly the kind of correction this file exists to keep
honest about rather than edit away.

**First reversal: `freebusy.query` → `events.list`.** Google's `freebusy.query`
only reports events Google itself considers "Busy" — an all-day event defaults
to "Free" transparency the instant it is created, with no request parameter to
override that. Sandbox verification hit this directly: a real all-day
commitment produced an empty busy answer, `last_error` null, because Google
had genuinely and correctly answered the question asked — just not the
question anyone nominating a calendar as *their availability source* actually
meant to ask. Decided (Michael, Sept 2026): every event on the chosen calendar
counts as busy, Google's own per-event flag notwithstanding. The calendar-scope
constraint above (**A constraint on the pull half**) is still the privacy
control this feature offers; a second filter on top of it, keyed to a toggle
inside Google's own UI nobody using this feature would think to check, was
never actually protecting anything.

**Second reversal, decided the same conversation: cache opaque intervals →
import real entries.** Once the calendar-of-record's own Busy/Free flag no
longer decided what counted, the next question was what an imported item
should *become* inside Uncle Owen — and Personal Time (`specs/0004`'s design,
carried since v0.1) turned out to already be exactly that shape: no server, no
invite list, no RSVP, just a title, a time, an optional description, private
to its owner (`migrations/0004_personal_events_and_free_busy.sql` — this
feature predates the `specs/` convention, which is why there is no numbered
design doc to point to for it instead). Caching an anonymous interval and
asking the owner to separately
remember what it was is strictly worse than storing what it actually is, once
the destination is a place only the owner ever sees. So `read_calendar_id` now
drives a real sync into `personal_events` (migration `0039`) rather than a
JSON cache on the connection row, and `google_calendar_connections` carries no
memory of what the pull half has produced any more — `personal_events` is that
memory.

What this changed, concretely:

- **Storage.** `personal_events` gains `google_event_id` (migration `0039`),
  unique per `(user_id, google_event_id)`, which is what makes re-syncing the
  same window idempotent — an upsert, not a duplicate. `busy_blocks` /
  `busy_cached_at` / `busy_window_end_at` are dropped from
  `google_calendar_connections`; nothing reads them once this shipped.
- **What Google is asked for.** `listCalendarEvents`
  (`worker/src/lib/googleCalendar.ts`) replaces `queryFreeBusy`, calling
  `events.list` with `singleEvents: true` (Google itself expands any recurring
  source event into individual instances, each with its own id — nothing here
  imports a recurrence rule) and a `fields` mask of exactly `id`, `status`,
  `start`, `end`, `summary`, `description`. Still the narrowest request that
  can do the job: no attendees, no location, no conferencing links, no
  organizer identity, ever requested.
- **What the privacy guarantee actually is, now.** It moved from "Google never
  sends us a title" to "nobody but the row's owner ever receives one." Both
  are real guarantees; the second is the one that matters for a feature whose
  whole point, after this change, is showing the owner what they imported.
  `computeBusyBlocksForUsers` — what *someone else* scheduling around this
  person receives — is unchanged in shape and still carries nothing but a time
  range; it now reads that range from `personal_events` like any other row
  rather than from a Google-specific cache, which is one less special case in
  a function whose header already argues for fewer of them.
- **Read-only, structurally.** An imported row's source of truth is Google, so
  `routes/personal.ts` refuses to `PATCH` or `DELETE` one (409, server-side —
  the frontend's matching UI state is a convenience, not the boundary). A sync
  reconciles the window: an event that stops appearing gets its row deleted,
  bounded to `start_at` falling inside the window being synced, so a past
  occurrence this sync was never asked about is left alone rather than
  reasoned about from its absence in an answer that was never about it.
  Disabling the read calendar, or switching which one is read, deletes every
  row it produced immediately (`routes/google.ts`'s `PATCH` handler) — the
  same "a disclosure has to stop the moment it's turned off" rule the cache
  version already followed, now enforced by deleting real rows instead of
  clearing a blob.
- **Budget.** The old mechanism cost one subrequest and one D1 write, flatly,
  because `freebusy.query` merged everything into a handful of intervals
  before it ever reached this app. Reading real events one-for-one does not
  merge anything, so `MAX_IMPORTED_EVENTS_PER_SYNC` (40) caps what one sync
  will import, and `cron/budget.ts`'s new `tryPersonalEventImport` reserves
  the exact worst-case statement count that cap produces — one subrequest, one
  `DELETE`, and however many chunked multi-row upserts 40 rows need at
  `IMPORT_PARAMS_PER_ROW` (10) bound parameters each, computed once from those
  two constants so the reservation can never silently drift from what the sync
  actually sends. Reserved fully before the Google call runs, same
  reserve-before-spend shape **The sweep, and the budget it has to fit**
  already established the hard way for the push half.

Nothing about *when* this runs changed: still the same hourly slot, still
first on the tick, for the same reasons recorded above.

## Policy

`CURRENT_POLICY_VERSION` 2 → 3, with `policy-version.txt` in the same commit
(item 43's guard). The Privacy Policy gains a Google section covering: which
calendar, which direction, what is sent (titles, times, server name, a link —
not descriptions), that a long-lived credential is stored encrypted, that it is
revoked on disconnect, and the 100-user unverified-app ceiling.

This bumps even though the feature ships dormant, which is the precedent v0.7
set exactly: version 2 shipped for Resend while `EMAIL_MODE` was `"stub"`. The
capability is in the code and the policy should describe the code.

**Bumped again, 4 → 5, for the pull half's rework** (**The pull half, twice
over**, above). Version 4 already covered a Google connection reading
busy/free times from a nominated calendar; what it did not cover, and could
not stand in for, is that this service now *stores* real content from that
calendar — event titles and descriptions, not opaque time ranges — even
though that content is disclosed to nobody but the connection's own owner. A
version whose text says "Google reads nothing but blank blocks reach anyone
else" is accurate about disclosure and silent about retention, and retention
of a third party's calendar content is exactly the class of change this
mechanism exists to surface consent for. Both reversals landed on the same
branch before v0.8.1 left it, so this is a second bump within one still-held
release rather than a second release — the same situation `policy.ts`'s own
history already has a precedent for staying honest about (see the
scratch-commit note there for what happens when a bump like this is folded in
silently instead).

`GOOGLE_SYNC_MODE` is `"off"` in both environments until Michael provisions a
Google Cloud project, OAuth client and the encryption secret (`docs/SETUP.md`
section 7). With it off, the routes answer 503 with a plain "not configured
yet" and the sweep returns immediately. Same shape as `EMAIL_MODE`, and the one
var `check:env-parity` will expect to differ between sandbox and production
once sandbox is switched on first.

## Failure modes

| What | Where it lands | Behaviour |
|---|---|---|
| Refresh token revoked by the user at Google | 400 `invalid_grant` | `sync_enabled = 0`, `last_error` set, Settings says reconnect. Never retried in a loop. |
| 401 on an API call | token expired mid-tick | Refresh once, retry once, then defer to next tick. |
| 403 rate limit / 5xx | Google throttling | Stop this connection for this tick; `last_synced_at` ordering retries it first next tick. |
| 404 on a PATCH | user deleted the entry in Google | Delete the link row and re-insert next tick. A user deleting our copy is not an error. |
| 410 Gone | entry already deleted | Treat as a successful delete. |

## Open questions

1. **Does a per-occurrence decline delete the pushed entry, or leave it marked?**
   This build deletes it. Marking it (`[declined]` in the title) is arguably
   more informative, but it means the calendar keeps showing a commitment the
   person has refused, and the app's own calendar fades and un-fades rather
   than annotating.
2. **What happens when someone changes their chosen calendar with entries
   already written?** This build leaves the old entries where they are and
   writes new ones to the new calendar. Migrating them is a bulk move with no
   obvious failure story; leaving them is at least legible. Worth revisiting if
   it turns out to be annoying in practice, which is a question for whoever
   uses it rather than for this document.
3. **Should the 60-day window be configurable?** Not in this build. A setting
   nobody changes is a setting that costs a column and a UI row forever.
