# 0017 — Google Calendar sync

**Status:** Ready
**Covers:** `IDEAS.md` item 2
**Phase:** 5 — ships in v0.8 (push half); the pull half is v0.8.1

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
| `calendar.readonly` | list the user's calendars; `freebusy.query` | v0.8 / v0.8.1 |

`calendar.readonly` is broader than the picker strictly needs today
(`calendar.calendarlist.readonly` would list calendars and nothing else), and
it is requested anyway *on purpose*: `freebusy.query` needs it, and asking for
it now is what stops v0.8.1 from putting a fresh consent screen in front of
everyone who already connected. The alternative — narrow now, re-consent later
— trades a slightly smaller ask today for a worse moment later, and the whole
account is already inside the read/write `calendar.events` grant regardless.

Both are Google "sensitive" scopes, so the unverified-app 100-user ceiling and
its warning screen apply, exactly as item 2 accepted.

## The OAuth round trip

Modelled on `routes/guildRequests.ts`'s second Discord round trip
(`specs/0015`), which exists for the same structural reason: an OAuth redirect
is a top-level browser navigation and cannot carry an `Authorization` header,
so the flow has to prove who it is some other way.

1. `POST /google/connect-url` — authenticated, policy-gated. Mints a
   `signToken` (`lib/signedToken.ts`) with purpose `google_connect`, payload
   `{ userId, nonce }`, 10-minute TTL. Sets the nonce in an HttpOnly cookie
   scoped to `/google`. Returns Google's authorize URL with that signed token
   as `state`.
2. Google → `GET /google/callback?code&state`. Verifies the signature, the
   purpose, the expiry, **and** that the payload's nonce matches the cookie.
3. Exchanges the code, stores the encrypted refresh token, redirects to
   `#/settings?google=connected`.

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

Two tables, migration `0036_google_calendar_sync.sql`.

**`google_calendar_connections`** — one row per user, `user_id` the primary key.
Holds the encrypted refresh token and IV, the cached access token with its
expiry (so an ordinary tick spends no subrequest on a refresh), the Google
account email, the chosen `calendar_id`, `sync_enabled`, `last_synced_at`,
`last_error`, and a `status` of `active` or `disconnecting`.

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

**A calendar push is less urgent than every DM above it**, which is what makes
going last correct: a session that appears on Google twenty minutes later is
fine; a reminder that does not go out is not. The sweep resumes from where the
allowance ran out on the next tick, because `last_synced_at` ordering means the
connections it did not reach are the ones it reaches first next time.

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

## Policy

`CURRENT_POLICY_VERSION` 2 → 3, with `policy-version.txt` in the same commit
(item 43's guard). The Privacy Policy gains a Google section covering: which
calendar, which direction, what is sent (titles, times, server name, a link —
not descriptions), that a long-lived credential is stored encrypted, that it is
revoked on disconnect, and the 100-user unverified-app ceiling.

This bumps even though the feature ships dormant, which is the precedent v0.7
set exactly: version 2 shipped for Resend while `EMAIL_MODE` was `"stub"`. The
capability is in the code and the policy should describe the code.

## Ships dormant

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
