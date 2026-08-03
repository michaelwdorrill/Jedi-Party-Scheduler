# 0003 — Invitee change requests

**Status:** Draft
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

## `time_change` is a vote, not a unilateral organizer call (revised)

Originally scoped as organizer accept/decline. Revised: a proposed time change
affects everyone who's already committed to the event, not just the organizer,
so it resolves the same way the app already resolves "does this time work for
the group" — a poll, reusing `event_poll_votes`' shape (`yes`/`no`/`maybe`)
and the existing threshold/most-votes resolution model from
`lib/polls.ts` — rather than a single accept/decline decision. This also
answers open question 2 below (other invitees now *are* the mechanism, not
just notified after the fact).

Filing a `time_change` request creates one poll option (the proposed time)
and a vote from every current invitee, seeded `pending`/no-vote. The
requester's own vote is implicitly `yes` (they proposed it). The organizer
keeps two things a regular voter doesn't: the ability to close the vote early
(accept or decline outright, same as today's spec), and the same
revision-guarded write on acceptance described below — a favorable vote tally
is what makes accepting reasonable, not what performs the write. `add_invitee`
requests are unaffected by this change and stay organizer accept/decline,
since there's no group consensus question there — only the organizer's invite
quota and the target's willingness (implicit in being invited at all) are in
play.

This makes `event_change_requests` need a companion votes table
(`event_change_request_votes`, shaped like `event_poll_votes`:
`request_id, user_id, vote, voted_at`) and a resolution strategy/deadline
pair on the request row, mirroring `events.poll_strategy` /
`poll_threshold_count` / `poll_deadline_at`. The cron gains a sweep for
past-deadline pending time-change requests, resolved the same way
`lib/polls.ts` resolves an ordinary poll past its deadline. This is a bigger
piece of work than the original accept/decline shape and the schema above
will need a corresponding revision before Phase 2 starts — noted here so the
decision isn't lost, not fully re-specced yet.

## User-visible behaviour

**As an invitee**, on an event I'm invited to:
- "Ask to move this" — pick a proposed start and end, optionally a note.
- "Suggest someone" — pick a person from the same server, optionally a note.
- See my own open requests, and withdraw one.

**As the organizer**, on my event:
- A pending-requests section: who asked, what for, their note, when.
- Accept (applies it) or decline (optionally with a reason).
- A request whose event has moved since it was made is shown as stale and
  can't be accepted without being re-made — see "Staleness" below.

**Both** get a DM: the organizer when a request arrives, the requester when
it's decided. Same 15-minute cron delivery as every other notification in the
app.

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
  created_at INTEGER NOT NULL,
  decided_at INTEGER,
  decided_by TEXT REFERENCES users(id)
);
CREATE INDEX idx_change_requests_event ON event_change_requests(event_id, status);
CREATE INDEX idx_change_requests_requester ON event_change_requests(requester_id, status);
```

`ON DELETE CASCADE` on `event_id` matches `event_invites` and means a deleted
event takes its requests with it — including out of the owner-facing surfaces
— with no extra sweep.

### Notifications: a third outbox table, not a new type on `notification_log`

`change_request_log`, with the same shape as `group_nudge_log` (migration
0009's lease columns plus 0014's `content`), keyed:

```sql
UNIQUE(request_id, user_id, notification_type)
```

with `notification_type IN ('change_request','change_request_decision')`.

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

`lib/outbox.ts` is already parameterised over the table and its key columns
(`OutboxTable`, `OutboxKey`), so this is a union-type widening plus the new
table in the two places that enumerate them: `reapExhaustedDeliveries` and the
source-independent retry consumer added for F-04-H2.

## Endpoints

All under the existing `requireAuth` + event-visibility rules.

| Method | Path | Who |
|---|---|---|
| `POST` | `/events/:eventId/change-requests` | any invitee (not the organizer) |
| `GET` | `/events/:eventId/change-requests` | organizer sees all; an invitee sees only their own |
| `POST` | `/events/:eventId/change-requests/:id/accept` | organizer |
| `POST` | `/events/:eventId/change-requests/:id/decline` | organizer |
| `DELETE` | `/events/:eventId/change-requests/:id` | requester (withdraw) |

### Authorization details worth stating

- **The organizer cannot file a request on their own event.** They can edit
  it. Allowing it would create a second, weirder path to the same write.
- **`GET` is asymmetric on purpose.** An invitee seeing every other invitee's
  requests would leak "who wants to move this and why" to the whole invite
  list, which is a conversation between one person and the organizer.
- **`target_user_id` must be a member of the event's guild**, checked
  server-side against `user_guild_membership` — not merely present in the
  requester's `/me/friends` response. The friends endpoint is already
  guild-scoped, so this adds no disclosure the requester didn't have; the
  server-side check is there because the client's list is not an
  authorization decision.
- **A request naming someone already invited is rejected** (400), rather than
  accepted and then no-oping.

### Validation

In `lib/validate.ts` alongside the existing event validators, reusing them
where the shape matches:

- `time_change`: `proposed_end_at > proposed_start_at` (the same `<=`
  rejection the event validator applies), duration within
  `MAX_EVENT_DURATION_MS`, and `occurrence_date` required and well-formed if
  and only if the event is recurring.
- `message` / `decision_note`: length-capped like every other free-text field.
- `kind` decides which fields are permitted; a `time_change` carrying a
  `target_user_id` is a 400, not a silently ignored field.

### Bounds

Every per-event surface in this codebase is bounded (`LIMITS` in
`lib/validate.ts`), and this one has to be too — it's user-writable, it
generates DMs, and unbounded rows would be a cron-budget problem as well as a
storage one:

- `MAX_OPEN_CHANGE_REQUESTS_PER_USER_PER_EVENT = 3`
- `MAX_OPEN_CHANGE_REQUESTS_PER_EVENT = 50`

Both count `status = 'pending'` only, so a resolved request doesn't consume a
slot forever. Exceeding either is a 409 with a message that says which limit
was hit.

## Accepting a request

The point of the design: acceptance is translated into the *existing* write,
then executed by the existing code.

- **`time_change`, non-recurring** → the same update `PATCH /events/:eventId`
  performs, with `revision` set to the request's `event_revision`. If the
  event has moved since, the guard fails and the caller gets the ordinary 409
  — the correct outcome, not a special case.
- **`time_change`, recurring** → an occurrence override in
  `event_occurrence_overrides` for the request's `occurrence_date`, not a
  change to the series. Someone asking "can we move *this week's*?" is not
  asking to move every future week, and the override table exists for exactly
  this.
- **`add_invitee`** → the same path as `POST /events/:eventId/invites`, which
  already writes the `event_invites` row and leaves the invite DM to the
  existing sweep. The invitee quota (`MAX_INVITEES`) applies unchanged; an
  accept that would exceed it fails with the quota error rather than being
  special-cased through.

Marking the request `accepted` happens in the same D1 batch as the write it
authorises, so "the event changed" and "the request that caused it is closed"
cannot come apart.

## Staleness

`event_revision` is captured when the request is made. It is used for two
different things and they shouldn't be confused:

1. **Display.** If `events.revision` has moved on, the UI marks the request
   stale — the organizer is looking at a proposal made against a version of
   the event that no longer exists.
2. **Acceptance.** The revision guard on the underlying write is what actually
   prevents applying it. The display is advisory; the guard is the control.

A stale request is *not* auto-declined. The organizer may well still want it
(the edit may have been unrelated — a description fix), and silently
discarding someone's request because of an unrelated edit is worse than
showing it with a warning. Re-making it is one click.

## Cron changes, and the constant that has to move with them

Two new sweeps: one that finds `pending` requests with an undelivered
organizer notification, one that finds decided requests with an undelivered
requester notification. Both go through `deliverThroughOutbox` against
`change_request_log`, both are budgeted via `cron/budget.ts`, and both use a
keyset cursor from `cron/cursor.ts` like every other scan.

**`budget.ts`'s fixed-overhead reserve has to be re-measured.** The comment
there records "fourteen sweeps ... a tick against an empty database spends 21
queries", with 22 reserved. Adding sweeps raises that floor, and on the Free
plan's allowance of 50 there is not much room to be casual about it. The
existing `d1limits.test.ts` is where that gets re-asserted, not a guess in the
constant's comment.

Delivery is deliberately *not* done inline in the request handler, even though
that would be faster than waiting up to 15 minutes. A request handler that
DMs inline has to solve retry, deduplication and partial failure on its own —
which is the entire reason the outbox exists. Consistency with every other
notification in the app is worth more here than latency.

## Frontend

- `EventDetailPage.tsx` grows two sections: a request form (invitees) and a
  pending-request list with accept/decline (organizer). Reuse
  `InviteePicker.tsx` for the `add_invitee` target — it already does
  guild-scoped person selection.
- Time inputs reuse whatever helper spec 0001B extracts for the
  end-before-start check, so the request form can't submit a range the event
  form would have rejected.
- No new page. This belongs on the event, not next to it.

## Tests

Worker-side, in the style of the existing `passN.test.ts` files:

- A non-invitee gets 403; the organizer gets 403 on filing.
- An invitee's `GET` returns only their own requests, the organizer's returns
  all.
- `target_user_id` outside the guild → 403/400, and already-invited → 400.
- Both bounds enforced, and a resolved request frees a slot.
- Accepting a `time_change` after the event was edited → 409, and the event is
  unchanged.
- Accepting a recurring `time_change` writes an override and does not touch
  the series.
- Accepting an `add_invitee` at `MAX_INVITEES` fails with the quota error.
- Two concurrent accepts of the same request settle it once.
- Notification dedupe: two requests on one event produce two distinct
  `change_request_log` rows (the regression the separate table exists to
  prevent).

## Open questions

1. **Should declining an event offer to file a time-change request?** The
   decline flow is where the information currently gets lost, so catching it
   there would be the highest-value placement — but it also makes declining a
   two-step interaction. Probably: offer it, don't require it.
2. ~~Does an accepted `time_change` notify the other invitees?~~ **Resolved**:
   they're not just notified, they vote — see the revision above. They get a
   DM when the vote opens (same as a poll invite) rather than only after the
   fact.
3. **Should the requester be able to file against a poll event?** A poll has
   no single time to move. `add_invitee` makes sense on a poll; `time_change`
   doesn't. Assumed: `time_change` is rejected on `event_type = 'poll'`, and
   the equivalent for a poll is proposing a new option — a different feature,
   not specced here.
4. **History retention.** Settled requests currently live until their event is
   deleted. If that turns out to be too much, the terminal-history purge sweep
   is where they'd be pruned — but it draws on the same budget as everything
   else, so it needs a reason before it gets one.
