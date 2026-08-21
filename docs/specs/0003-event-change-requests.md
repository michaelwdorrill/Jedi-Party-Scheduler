# 0003 — Invitee change requests

**Status:** Ready to build
**Covers:** `IDEAS.md` item 13 · **Phase:** 2

Lets an invitee ask the organizer for two things — "can we move this?" (with a
proposed time) and "can we also invite this person?" — without ever being able
to change the event themselves.

## Why a request and not an edit

Today the only in-app way to push back on a time is to decline, which throws
away the useful half of the answer: the organizer sees "no" and not "no, but
Thursday works". Suggesting another guest has no in-app path at all — that
conversation happens in Discord and never reaches the event.

The obvious alternative, letting invitees edit, is wrong for this app.
Everything in the data model assumes exactly one person owns an event's
content (`events.organizer_id`, every write path in `lib/eventWrites.ts`), and
the privacy model is stated in terms of "its organiser and its invitees" as
different roles. A request keeps that intact: the organizer remains the only
writer, and **accepting a request is what performs the write** — through the
same code path the organizer's own edit uses, not a parallel one.

That last point is the load-bearing design decision in this spec. It means
acceptance inherits, for free, the optimistic-concurrency guard from migration
0013, every quota check in `eventWrites.ts`, and the existing invite
notification path — rather than reimplementing any of them against a
request-shaped input.

## `time_change` is a vote, not a unilateral organizer call

A proposed time change affects everyone who's already committed to the event,
not just the organizer, so it resolves the same way the app already resolves
"does this time work for the group": every current invitee can vote
`yes`/`no`/`maybe`, and the request auto-resolves once a majority of them says
yes, or is decided at a deadline if it never gets there. The organizer keeps
two things a regular voter doesn't: the ability to close the vote early
(accept or decline outright), and — because acceptance always goes through the
same revision-guarded write described below — no special path that bypasses
that guard just because the accept came from a vote instead of a click.

`add_invitee` requests are unaffected by this: there's no group-consensus
question there, only the organizer's invite quota and the target's
willingness (implicit in being invited at all), so it stays plain organizer
accept/decline.

### Who votes, and the threshold

Voters are the event's current invitees (the same rows in `event_invites`) —
not the organizer, who has the override instead. The requester is an invitee
too and is not a special case: filing a `time_change` request inserts their
own `yes` vote (they proposed it) into `event_change_request_votes`, and they
can change it later through the same vote endpoint everyone else uses.

The threshold is **computed at filing time, not organizer-configured** —
unlike an ordinary poll, there's no separate setup step where anyone chooses
one, and letting the requester set their own threshold would let them pick 1
and pass on their own vote. It's a simple majority of the invitee count read
at that moment: `floor(inviteeCount / 2) + 1`, minimum 1. This is deliberately
frozen on the request row (`vote_threshold_count`), not recomputed live —
someone being invited or removed after the request was filed shouldn't retroactively
change what it takes to pass.

One consequence worth stating because it looks like an edge case but isn't:
if the requester is the event's only invitee, the threshold is 1 and their own
implicit vote already meets it — the request resolves the instant it's filed.
That's correct, not a bug: there's no one else to ask.

### Deadline and fallback resolution

`vote_deadline_at` is likewise system-set, not organizer-chosen: `filed_at +
CHANGE_REQUEST_VOTE_WINDOW_MS` (72 hours — see `LIMITS` in `lib/validate.ts`).
This is a much shorter horizon than an ordinary poll's deadline (which
schedules an actual future session, often weeks out) because this is a
meta-question about an already-scheduled event and shouldn't sit open for
weeks.

Past the deadline, a still-pending `time_change` resolves the same way an
ordinary poll falls back past its own deadline (`lib/polls.ts`'s
`resolvePastDeadlinePolls`, `pickMostVotes`): if `yes` votes outnumber `no`
votes, it's accepted; otherwise (including a tie, or zero votes) it's
declined. Declining on a tie is the conservative choice — applying an edit
nobody clearly asked for is worse than not applying one that might still have
had support.

## User-visible behaviour

**As an invitee**, on an event I'm invited to:
- "Ask to move this" — pick a proposed start and end, optionally a note.
- "Suggest someone" — pick a person from the same server, optionally a note.
- Vote on an open `time_change` request from another invitee.
- See my own open requests, and withdraw one.

**As the organizer**, on my event:
- A pending-requests section: who asked, what for, their note, when, and (for
  a `time_change`) the running vote tally.
- Accept (applies it) or decline (optionally with a reason) — at any point,
  regardless of tally.
- A request whose event has moved since it was made is shown as stale — see
  "Staleness" below.

**Both** get a DM: the organizer when a request arrives, every other invitee
when a `time_change` vote opens, and the requester when their request is
decided. Same 15-minute cron delivery as every other notification in the app.

## Data model

### `event_change_requests` (new migration)

```sql
CREATE TABLE event_change_requests (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  requester_id TEXT NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL CHECK (kind IN ('time_change','add_invitee')),

  -- time_change only
  proposed_start_at INTEGER,
  proposed_end_at INTEGER,
  -- '' for non-recurring, matching notification_log's convention: SQLite
  -- treats every NULL as distinct in a UNIQUE index, which would defeat any
  -- dedupe this column takes part in for exactly the common case.
  occurrence_date TEXT NOT NULL DEFAULT '',

  -- add_invitee only
  target_user_id TEXT REFERENCES users(id),

  message TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','accepted','declined','withdrawn')),
  decision_note TEXT,
  -- events.revision as read when the request was made; see "Staleness".
  event_revision INTEGER NOT NULL,

  -- time_change only: frozen at filing time, see "Who votes, and the
  -- threshold" above. NULL for add_invitee.
  vote_threshold_count INTEGER,
  vote_deadline_at INTEGER,
  -- Consecutive failed deadline-resolution attempts, same purpose and same
  -- ordering use as events.poll_resolution_failures (migration 0012): keeps
  -- one broken row from holding a place in the deadline sweep's page ahead
  -- of healthy ones.
  vote_resolution_failures INTEGER NOT NULL DEFAULT 0,

  created_at INTEGER NOT NULL,
  decided_at INTEGER,
  -- NULL for a threshold/deadline auto-resolution; set only when the
  -- organizer closed it early.
  decided_by TEXT REFERENCES users(id)
);
CREATE INDEX idx_change_requests_event ON event_change_requests(event_id, status);
CREATE INDEX idx_change_requests_requester ON event_change_requests(requester_id, status);
```

`ON DELETE CASCADE` on `event_id` matches `event_invites` and means a deleted
event takes its requests with it — including out of the owner-facing surfaces
— with no extra sweep.

### `event_change_request_votes` (new table, same migration)

Shaped like `event_poll_votes`. Absence of a row means "hasn't voted", exactly
like `event_poll_votes` and `getOptionTallies`'s `LEFT JOIN` — there's no
separate "seeded pending" row to write or clean up.

```sql
CREATE TABLE event_change_request_votes (
  request_id TEXT NOT NULL REFERENCES event_change_requests(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id),
  vote TEXT NOT NULL CHECK (vote IN ('yes','no','maybe')),
  voted_at INTEGER NOT NULL,
  PRIMARY KEY (request_id, user_id)
);
```

### Notifications: a third outbox table, not a new type on `notification_log`

`change_request_log`, with the same shape as `group_nudge_log` (migration
0009's lease columns plus 0014's `content`), keyed:

```sql
CREATE TABLE change_request_log (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES event_change_requests(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id),
  notification_type TEXT NOT NULL CHECK (notification_type IN ('change_request_opened','change_request_decision')),
  sent_at INTEGER NOT NULL,
  delivered_at INTEGER,
  failed_at INTEGER,
  claim_token TEXT,
  claimed_until INTEGER,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER,
  content TEXT,
  UNIQUE(request_id, user_id, notification_type)
);
CREATE INDEX idx_change_request_log_user ON change_request_log(user_id);
```

The reason not to extend `notification_log` is structural, not stylistic. Its
UNIQUE key is `(user_id, event_id, notification_type, occurrence_date)`, which
cannot distinguish two requests on the same event — the second one would
collide with the first and silently never be delivered. Fixing that means
adding a column to a UNIQUE constraint, which SQLite can only do by rebuilding
the table, and `notification_log` in production now has real rows: SETUP.md
records that migration 0005's `DROP TABLE` approach was fine on an empty dev
database and had to be redone by hand as a rename-copy-drop against
production. A separate table avoids all of that, and `group_nudge_log` is the
existing precedent for "a different subject gets its own outbox table".

`notification_type` covers both directions with two values: `change_request_opened`
(organizer, and for `time_change` every other invitee whose vote is being
asked for) and `change_request_decision` (the requester, once the request is
accepted/declined/withdrawn). Renamed from the original `change_request` /
`change_request_decision` pair now that "opened" also fans out to voters, not
just the organizer.

`lib/outbox.ts` is already parameterised over the table and its key columns
(`OutboxTable`, `OutboxKey`), so this is a union-type widening plus adding the
new table to `reapExhaustedDeliveries`'s list. Unlike `notification_log`'s
reminder/deadline sweeps, neither of the two sweeps below is windowed by a
moving predicate (see "Cron changes" for why), so — like `sweepNewInvites`,
which is in the same position and also has none — `change_request_log` does
not need one of the source-independent retry consumers added for F-04-H2. An
undelivered row simply keeps matching the primary sweep's own WHERE clause on
every tick until it's delivered or exhausted.

## Endpoints

All under the existing `requireAuth` + event-visibility rules.

| Method | Path | Who |
|---|---|---|
| `POST` | `/events/:eventId/change-requests` | any invitee (not the organizer) |
| `GET` | `/events/:eventId/change-requests` | organizer sees all; an invitee sees only their own |
| `POST` | `/events/:eventId/change-requests/:id/vote` | any invitee, `time_change` only |
| `POST` | `/events/:eventId/change-requests/:id/accept` | organizer |
| `POST` | `/events/:eventId/change-requests/:id/decline` | organizer |
| `DELETE` | `/events/:eventId/change-requests/:id` | requester (withdraw) |

### Authorization details worth stating

- **The organizer cannot file a request on their own event.** They can edit
  it. Allowing it would create a second, weirder path to the same write.
- **`GET` is asymmetric on purpose.** An invitee seeing every other invitee's
  requests would leak "who wants to move this and why" to the whole invite
  list, which is a conversation between one person and the organizer. An open
  `time_change` request is the one exception, and concretely: a non-organizer
  caller's `GET` returns their own requests (any kind, any status) plus every
  *other* invitee's `time_change` request that's still `pending` — visible
  because voting on it requires seeing it, invisible again once it's decided,
  same as an `add_invitee` request always is. The tally on those rows is
  aggregate-only (yes/no/maybe counts, not who cast which vote), mirroring
  `getOptionTallies`'s shape.
- **`target_user_id` must be a member of the event's guild**, checked
  server-side against `user_guild_membership` via the same
  `requireActiveGuildMember` helper `loadEventIfVisible` already uses — not
  merely present in the requester's `/me/friends` response. The friends
  endpoint is already guild-scoped, so this adds no disclosure the requester
  didn't have; the server-side check is there because the client's list is
  not an authorization decision.
- **A request naming someone already invited is rejected** (400), rather than
  accepted and then no-oping.
- **Voting requires being a current invitee**, the same
  `requireInvitedOrOrganizer`-shaped check `routes/polls.ts` uses, restricted
  to invitees (not the organizer — see "Who votes" above).

### Validation

In `lib/validate.ts` alongside the existing event validators, reusing them
where the shape matches:

- `time_change`: `proposed_end_at > proposed_start_at` (the same `<=`
  rejection the event validator applies), duration within
  `MAX_EVENT_DURATION_MS`, and `occurrence_date` required and well-formed if
  and only if the event is recurring. Rejected outright (400) if
  `event_type = 'poll'` — a poll has no single time to move (see Open
  Questions in the original draft; the equivalent for a poll would be
  proposing a new option, a different feature, not specced here).
- `message` / `decision_note`: length-capped like every other free-text field.
- `kind` decides which fields are permitted; a `time_change` carrying a
  `target_user_id` is a 400, not a silently ignored field.
- `vote`: one of `yes`/`no`/`maybe`, same as `POST /:eventId/poll/vote`.

### Bounds

Every per-event surface in this codebase is bounded (`LIMITS` in
`lib/validate.ts`), and this one has to be too — it's user-writable, it
generates DMs, and unbounded rows would be a cron-budget problem as well as a
storage one:

- `MAX_OPEN_CHANGE_REQUESTS_PER_USER_PER_EVENT = 3`
- `MAX_OPEN_CHANGE_REQUESTS_PER_EVENT = 50`
- `CHANGE_REQUEST_VOTE_WINDOW_MS = 72 hours`

Both count limits count `status = 'pending'` only, so a resolved request
doesn't consume a slot forever. Exceeding either is a 409 with a message that
says which limit was hit.

## Accepting a request

The point of the design: acceptance is translated into the *existing* write,
then executed by the existing code — whether the accept was triggered by the
organizer's click or by a vote crossing threshold.

- **`time_change`, non-recurring** → `updateEvent(env, eventId, guildId,
  { isRecurring: false, startAt: request.proposed_start_at, endAt:
  request.proposed_end_at, revision: request.event_revision }, stored)` — the
  same call `PATCH /events/:eventId` makes, with `revision` set to the
  request's `event_revision`. If the event has moved since, the guard fails
  and `updateEvent` throws its ordinary `ConflictError` — the correct
  outcome, not a special case. This is also what makes concurrent acceptance
  safe with no extra locking: two triggers racing to accept the same request
  (a vote crossing threshold at the same moment the organizer clicks accept)
  both call `updateEvent` with the same `request.event_revision` as their
  guard, so at most one of them can match `revision = storedRevision` — the
  loser gets `ConflictError`, not a double-applied edit. An auto-resolution
  trigger (a vote crossing threshold) catches that error and treats it as "someone
  else already resolved this", not a failure to surface to the voter.
- **`time_change`, recurring** → an upsert into
  `event_occurrence_overrides` for the request's `occurrence_date`, not a
  change to the series — the existing `POST
  /:eventId/occurrences/:date/cancel` endpoint already writes this table with
  no revision guard on it (an occurrence override is not tracked by
  `events.revision` anywhere in the app today), so this follows that same
  precedent rather than inventing a new one: no revision check on this path,
  the event row itself is never touched.
- **`add_invitee`** → the same path as `POST /events/:eventId/invites`
  (`addInvitesToEvent`), which already writes the `event_invites` row and
  leaves the invite DM to the existing sweep. `addInvitesToEvent` itself has
  no ceiling on an event's *total* invitee count (`MAX_INVITEES` only bounds
  one request's input array), so the accept handler checks the event's
  current invite count against `LIMITS.MAX_INVITEES` itself before calling
  it, and fails with the quota error rather than being special-cased through
  if accepting would exceed it.

Once the underlying write succeeds, the request row is marked accepted with a
single `UPDATE event_change_requests SET status = 'accepted', decided_at = ?,
decided_by = ? WHERE id = ? AND status = 'pending'`. This is a best-effort
follow-up, not a joint transaction with the write above — the earlier
revision guard is what actually prevents a double-apply (see above), so this
step only has to prevent double-*bookkeeping*, not double-*writing*. Declining
is a single `UPDATE ... WHERE status = 'pending'` with no companion write.

## Staleness

`event_revision` is captured when the request is made. It is used for two
different things and they shouldn't be confused:

1. **Display.** If `events.revision` has moved on, the UI marks the request
   stale — the organizer is looking at a proposal made against a version of
   the event that no longer exists. (Recurring `time_change` requests are
   never marked stale by this signal, since their accept path doesn't consult
   `events.revision` — see "Accepting a request" above.)
2. **Acceptance.** The revision guard on the underlying write is what actually
   prevents applying a stale non-recurring `time_change`. The display is
   advisory; the guard is the control.

A stale request is *not* auto-declined. The organizer may well still want it
(the edit may have been unrelated — a description fix), and silently
discarding someone's request because of an unrelated edit is worse than
showing it with a warning. Re-making it is one click.

## Cron changes, and the constant that has to move with them

Two new sweeps, both in `cron/reminders.ts` alongside the existing ones:

- **`sweepChangeRequestNotifications`** — undelivered `change_request_opened`
  and `change_request_decision` rows, in a *single* query rather than two:
  a discriminated `UNION ALL` of both recipient-generation queries, ordered
  by `(request_id, user_id)`, `LIMIT budget.deliveriesAffordable`, no
  `CursorStore` entry needed. Splitting this into two separately-named
  functions (as an earlier pass of this spec had it) reads cleaner, but each
  one is a fixed query that runs every tick whether or not there's anything
  to do — see the `RESERVED_QUERIES` note below for why that split has a
  real, measured cost, and why it isn't worth paying for a distinction that's
  otherwise just organizational. This sweep gets away without a cursor
  because its predicate only shrinks as rows are delivered (a delivered row
  drops out of the `LEFT JOIN ... WHERE crl.id IS NULL OR ...` filter and
  never matches again) rather than staying eligible indefinitely the way
  "confirmed poll option" or "poll deadline in the next day" do — the same
  shape `sweepNewInvites` already relies on for the same reason.
- **`resolvePastDeadlineChangeRequests`** — mirrors
  `resolvePastDeadlinePolls` exactly: `SELECT ... WHERE status = 'pending'
  AND kind = 'time_change' AND vote_deadline_at <= ? ORDER BY
  vote_resolution_failures, vote_deadline_at, id LIMIT
  MAX_CHANGE_REQUESTS_RESOLVED_PER_INVOCATION`, per-row try/catch bumping
  `vote_resolution_failures` on failure, budgeted via `budget.trySpend`. No
  cursor, same reasoning as the poll sweep it mirrors.

**`budget.ts`'s fixed-overhead reserve had to be re-measured, and the margin
turned out tighter than "a small increase" suggested.** The comment there
recorded "fourteen sweeps ... a tick against an empty database spends 21
queries", with 22 reserved. Two more always-run sweeps raise that floor by two
more fixed queries (one empty-result read each) — `RESERVED_QUERIES` moves to
24, re-asserted for real (not guessed) in `d1limits.test.ts` and
`pass9.test.ts`'s empty-tick measurement. That two-query cost is *why* the two
notification types share one query instead of two separate sweeps: a three-
query version of this (which an earlier pass of this spec called for) made
`pass6.test.ts`'s existing "a full terminal purge and a spent notification
budget still fit one tick" test fail outright, not just take longer to
converge — with three fixed queries, the steady-state budget left over for the
90-day purge after every other sweep's fixed cost was one query short of what
a two-chunk purge batch needs, *every single tick, forever*, since nothing
about that shortfall changes as more ticks pass. Getting back to two fixed
queries restored the exact margin that test depends on. The lesson generalises
past this one feature: on a Free-plan tick, a fixed per-sweep cost is not a
rounding error, and "small" isn't a safe assumption to write into a spec
without checking it against the sweep that's already living closest to the
ceiling.

Delivery is deliberately *not* done inline in the request handler, even though
that would be faster than waiting up to 15 minutes. A request handler that
DMs inline has to solve retry, deduplication and partial failure on its own —
which is the entire reason the outbox exists. Consistency with every other
notification in the app is worth more here than latency. The one place this
is *not* true is threshold resolution: a vote crossing the majority threshold
resolves the request (and, for `time_change`, applies the write) synchronously
in the vote handler, exactly the way `checkThresholdAndResolve` does for an
ordinary poll — only the DM about it goes through the outbox on the next tick.

## Frontend

- `EventDetailPage.tsx` grows two sections: a request form (invitees) and a
  pending-request list with accept/decline and, for `time_change`, a vote
  tally and a vote control (organizer sees the tally; other invitees see the
  tally plus their own vote buttons). Reuse `InviteePicker.tsx` for the
  `add_invitee` target — it already does guild-scoped person selection.
- Time inputs reuse whatever helper spec 0001B extracts for the
  end-before-start check, so the request form can't submit a range the event
  form would have rejected.
- No new page. This belongs on the event, not next to it.

## Tests

Worker-side, in the style of the existing `passN.test.ts` files:

- A non-invitee gets 403; the organizer gets 403 on filing.
- An invitee's `GET` returns only their own requests, the organizer's returns
  all (with vote tallies on `time_change` rows, no per-voter breakdown).
- `target_user_id` outside the guild → 403/400, and already-invited → 400.
- Both open-request bounds enforced, and a resolved request frees a slot.
- Filing a `time_change` as the event's only invitee resolves it immediately
  (threshold of 1, requester's own implicit vote meets it).
- A second invitee's `yes` vote crossing the majority threshold applies the
  write and marks the request accepted, synchronously in the vote handler.
- Accepting (via organizer override) a `time_change` after the event was
  edited by someone else → `ConflictError`/409, and the event is unchanged.
- Accepting a recurring `time_change` writes an occurrence override and does
  not touch the series or `events.revision`.
- Accepting an `add_invitee` at `MAX_INVITEES` fails with the quota error.
- Two concurrent accept triggers on the same `time_change` (organizer click
  racing threshold-crossing vote) settle it once; the loser's write attempt
  throws `ConflictError` and is swallowed if it came from auto-resolution.
- Past-deadline resolution: `yes > no` accepts, a tie or `no >= yes` declines.
- Notification dedupe: two requests on one event produce two distinct
  `change_request_log` rows (the regression the separate table exists to
  prevent).

## Open questions

1. **Should declining an event offer to file a time-change request?** The
   decline flow is where the information currently gets lost, so catching it
   there would be the highest-value placement — but it also makes declining a
   two-step interaction. Probably: offer it, don't require it. Not part of
   this build.
2. **History retention.** Settled requests currently live until their event is
   deleted. If that turns out to be too much, the terminal-history purge sweep
   is where they'd be pruned — but it draws on the same budget as everything
   else, so it needs a reason before it gets one.
