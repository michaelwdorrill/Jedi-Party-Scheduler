# 0016 — Warn, then purge, a stale account

**Status:** Built
**Covers:** `IDEAS.md` item 10
**Phase:** 4 → **v0.7**

## The problem

Nothing ever removes an account that has stopped using the app. `IDEAS.md`
item 10's own framing is the reason this matters now rather than later: idea
2 (Google Calendar sync, v0.8) will start a synced integration running on
someone's behalf, and that must not keep running forever for someone who
walked away from the site. Warn at two weeks and one week before a year of
inactivity, then purge if they still haven't come back.

## What "stale" is measured from

`sessions.ts` caps a session at a 7-day absolute TTL (`SESSION_TTL_MS`) with
no indefinite renewal — `rotateSession` can refresh the short-lived access
token many times within that window, but never past it. So anyone actively
using the app is forced through a real Discord login, and therefore a
`markLoginSucceeded` stamp, **at least once a week**. `users.last_login_at`
is already exactly the "have they used this" signal item 10's capture asks
for; no separate "used" concept needs inventing, and the capture's own open
question about that is answered by the schema that already existed.

One case needs a fallback: `upsertUser` stamps `last_login_attempt_at`
*before* the allow-list check that gates issuing a session runs, so a caller
rejected at that check can have a user row with `last_login_at` still `NULL`
— a login attempted, but never a real one. Measuring `NULL` as "infinitely
stale" would purge such a row the very next tick; measuring it as "never
stale" would let it sit forever. Neither is right, so the reference point is
`COALESCE(last_login_at, created_at)` — the account ages out from when it was
created if it never once got a session issued.

## The suppression rule, and what it deliberately doesn't cover

The capture's second open question — should organizing or being invited to a
future event suppress the purge — is decided **yes**, and the reasoning
matters more than the rule: this isn't the "integration runs forever" problem
item 10 exists to fix, it's the opposite failure. Purging an organizer
outright deletes their event for everyone else (`deleteUserCompletely`
removes every event a user organized). Purging an invitee can drop a session
below `specs/0014`'s minimum-attendees threshold and trigger the cancellation
cascade for people who did nothing wrong. Both are exactly the kind of
surprise this feature must not cause.

So an account with an **upcoming stake** is never purged while that stake
exists:

```sql
SELECT 1 FROM events WHERE organizer_id = ? AND status = 'active' AND (start_at IS NULL OR start_at > ?)
UNION
SELECT 1 FROM event_invites ei JOIN events e ON e.id = ei.event_id
  WHERE ei.user_id = ? AND ei.rsvp_status != 'declined'
    AND e.status = 'active' AND (e.start_at IS NULL OR e.start_at > ?)
```

`start_at IS NULL` covers an unresolved poll — it hasn't happened yet either.
A **declined** invite does not suppress: the invitee already opted out of
that session, so purging them changes nothing about who is coming. This is
re-checked every time the row is scanned, not decided once — an account
protected today by a future event is purged the tick after that event
resolves into the past, with no separate cursor or state needed for it.

Nothing here suppresses on a *past* event. Having organized or attended
something once is not a reason to keep a dormant account around — that
would make the feature apply to almost nobody.

## Warn, don't just purge

Two DMs, at 351 and 358 days of staleness (two weeks and one week before the
365-day cutoff), reusing the same leased-outbox shape `group_nudge_log`
(migration 0009) established for a user-scoped notification that has no
`event_id` to live in `notification_log` under. The "episode" key is
`last_login_at` (or its `created_at` fallback) rather than
`group_nudge_log`'s `last_event_at`, for the identical reason: if the person
logs back in, the reference point moves, this becomes a new episode, and the
old warning rows can never become due again.

**The warning bypasses `notifications_enabled`.** That toggle opts out of
gameplay pings — a reminder, a nudge, an invite. This is not that: it's the
one message that exists to stop an otherwise-irreversible deletion, and
suppressing it on the same toggle would mean someone who muted event
notifications loses their account with no notice at all, which defeats the
point of warning in the first place. The DM is short and infrequent (twice,
a year apart, only for an account already about to be erased) and is not the
kind of thing the opt-out was built to prevent.

## One combined scan, and why it isn't cursored

A single scan handles both jobs — decide the warning rung and check for the
purge threshold — off one `COALESCE(last_login_at, created_at)` age compared
against three thresholds, rather than a warning sweep and a purge sweep. This
mirrors the fold IDEAS item 47's reminders got: a second fixed per-tick query
costs more than it looks like against `cron/budget.ts`'s `RESERVED_QUERIES`.

It also, deliberately, is **not** built on `forEachGlobalRow` and carries no
cursor. `test/pass6.test.ts`'s purge-and-backlog scenario — a busy tick with
a 120-invitee notification backlog and a full terminal-history purge queue —
has no budget margin left to give; that test's own comment already records
IDEAS item 47 hitting this exact cliff once. Measured while building this:
adding even one more *charged* fixed query starves `sweepPurgeTerminalHistory`
completely, not just slows it down. So this sweep takes the same shape
`sweepCancellationCascade` already established for a new fixed scan that
can't afford to bump `RESERVED_QUERIES` — one bounded, uncursored read
(`LIMIT` the same `GLOBAL_SCAN_LIMIT` every other global scan uses),
deliberately uncharged against the shared `TickBudget`. This install's
`users` table is small enough that one bounded scan a tick is not a fairness
problem, and this feature's own threshold is a year, so a row the `LIMIT`
misses on a busy tick simply matches again next tick with nothing lost.

## The purge itself is not modelled in the budget at all

`deleteUserCompletely` reuses the exact account-erasure path `DELETE /me`
already exercises — the idea's own capture asked for this — and that
function is, deliberately, **one D1 batch**: its own comment explains that
consolidating it there was specifically to avoid a failure partway through
leaving a half-erased account with no record deletion was even attempted.
That atomicity is incompatible with the shared per-tick `TickBudget`, which
exists to let a sweep stop cleanly and resume next tick — there is no
"resume the erasure next tick" for a delete that already committed. Trying to
gate a ~25-statement atomic batch behind `budget.trySpend` would also simply
never fire on the Free-plan model most of this app's budget math is written
against (`FREE_D1_QUERIES = 50`, `RESERVED_QUERIES = 24` leaves 26 available
— less than the batch itself needs before a single other statement runs).

So the purge is capped at **one per tick**, independent of the shared budget,
reachable only once the (uncharged, but real) discovery scan above has
already run. One is enough: two accounts crossing the exact same 365-day
boundary in the same 15-minute window is not a case this app's scale needs
to plan for, and a second candidate is simply picked up on the very next
tick — the same "eventually, not necessarily this tick" guarantee every
other sweep here relies on.

## Schema

```sql
CREATE TABLE account_purge_warnings (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  last_login_at INTEGER NOT NULL,
  warning_type TEXT NOT NULL CHECK (warning_type IN ('stale_2wk', 'stale_1wk')),
  sent_at INTEGER NOT NULL,
  delivered_at INTEGER,
  failed_at INTEGER,
  claim_token TEXT,
  claimed_until INTEGER,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER,
  content TEXT,
  UNIQUE(user_id, last_login_at, warning_type)
);
```

Migration 0028. `deleteUserCompletely` gets one more explicit child delete
(`DELETE FROM account_purge_warnings WHERE user_id = ?`), next to
`group_nudge_log`'s — the FK has no cascade, matching every other child
table's discipline there.

**Deliberately left out of `reapExhaustedDeliveries`'s fixed per-tick table
list.** That reaper is unconditional and unbudgeted — one more table there is
one more real query on every tick forever. Confirmed by running it: adding
`account_purge_warnings` there reproduced the exact same
`sweepPurgeTerminalHistory`-starving cliff as a charged discovery query would.
The gap this leaves is cosmetic, not a correctness one: `claim()`'s `WHERE`
clause already stops reclaiming a row once `attempt_count` reaches
`MAX_DELIVERY_ATTEMPTS` regardless of `failed_at`, so an exhausted warning
simply stops being retried — it just never gets `failed_at` stamped to say
so, on a table nothing else reads.

## Ordering in the tick

`sweepStaleAccounts` runs **last** among the budget-charged sweeps in
`runReminderSweep`, after `sweepPurgeTerminalHistory` and the retry
consumers. Its own threshold is a year of inactivity — it has nothing to
lose by being the sweep starved on a busy tick, and everything ahead of it
(same-day reminders, the terminal-history purge with its own zero-margin
budget fit) is more time-sensitive than a warning DM or a purge that will
simply fire again next tick regardless.

## Testing

`test/staleAccounts.test.ts`:

- A recently-active account gets no warning and no purge.
- The 2-week warning fires at 351 days and is not resent on a later tick.
- The 1-week warning fires at 358 days (only that rung — rungs already in
  the past when an account is first scanned are never sent retroactively).
- `notifications_enabled = 0` does not suppress the warning.
- A never-logged-in account is measured from `created_at`.
- A fully stale account with nothing scheduled is purged.
- An account organizing a future active event is not purged.
- An account holding a non-declined invite to a future active event is not
  purged.
- An account that *declined* its invite to a future event is purged anyway.
- An account whose only stake is a past event is purged.
- Two simultaneously-eligible accounts: one is purged per tick, the other is
  picked up on the next.

`test/deletion.test.ts` gained a fixture row and assertion confirming
`deleteUserCompletely` clears `account_purge_warnings`.

`test/pass9.test.ts`'s empty-tick query-count ceiling moved from 25 to 26 (one
more real, deliberately uncharged, query — see that assertion's own comment)
and `test/pass6.test.ts`'s zero-margin purge-and-backlog scenario needed no
change at all, which is the point of the uncursored/uncharged design above:
it was the thing that broke, twice, while this was being built, before the
final shape stopped breaking it.

## Open questions

None outstanding for this build. Two things worth revisiting only if the
app's scale changes enough to matter:

1. **`STALE_PURGE_MAX_PER_TICK = 1`** bounds a batch this app's expected
   install size will essentially never need to actually cap. If a much
   larger multi-guild deployment ever made simultaneous stale-boundary
   crossings routine rather than vanishingly rare, this would need revisiting
   alongside whatever made the `users` table large enough that the
   uncursored scan's `LIMIT` starts actually mattering too.
2. **The purge erasure isn't modelled in `TickBudget` at all.** That was the
   correct call for an atomic, once-a-year-per-account operation against
   today's numbers; it would need a real answer (not just a bigger cap) if
   this app ever ran on an install large enough for `deleteUserCompletely`'s
   own batch to approach a real per-invocation ceiling by itself.
