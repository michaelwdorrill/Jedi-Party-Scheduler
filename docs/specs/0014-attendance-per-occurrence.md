# 0014 — Attendance per occurrence, and a reminder ladder that reads it

**Status:** Draft
**Covers:** `IDEAS.md` items 47 and 48. Absorbs item 46, which is one symptom
of the same thing.
**Phase:** TBD → after v0.5

## The change in one sentence

**Attendance stops being one answer per event and becomes one answer per
occurrence**, and the reminder schedule stops being a fixed pair of DMs and
becomes a ladder whose rungs depend on what you have already said.

## What changes for the user

Today everyone invited gets the same two reminders — 24 hours and 1 hour
before — regardless of whether they answered the invitation, ignored it, or
declined it. The ladder replaces that with a schedule per answer:

| Your answer | Reminders | Controls on them |
|---|---|---|
| Haven't answered | 96h, 48h | *I'm in* / *Maybe* / *Can't make it* |
| *Maybe* | 72h, 24h | *I'm in* / *Can't make it* |
| *I'm in* | 24h, 1h | *Can't make it* only |
| *Can't make it* | none | — |

Two properties are worth stating as rules rather than leaving implicit:

- **A rung offers only the moves that make sense from where you are.** Three
  buttons to someone who has already committed is noise that invites a stray
  tap; no buttons at all makes the person whose plans just changed go to the
  website, which is the exact failure the interactive bot exists to remove.
  One button — the transition they actually need — is the answer to both.
- **Rungs are mutually exclusive and never fire in arrears.** Only the
  nearest due rung sends. An event that becomes visible late (a poll that
  resolves 30 hours out) must not fire 96h, 72h and 48h in one tick, which
  is what a naive "any unsent rung whose time has passed" rule would do.

## The decision underneath

Michael's, Aug 2026, and it settles a question the app has been half-answering
since it was built: **attendance is per occurrence.**

The schema is already per-occurrence in two dimensions and per-event in the
third, which is why nothing has forced the issue:

- `notification_log` dedupes on `(user_id, event_id, notification_type,
  occurrence_date)` — notifications are per occurrence.
- `event_occurrence_overrides` is keyed `(event_id, occurrence_date)` —
  cancellations and time changes are per occurrence.
- `event_invites` is `UNIQUE(event_id, user_id)` with a single `rsvp_status`
  — **attendance is per event.**

Nothing has cared, because today's reminders do not read attendance at all
(`pendingRecipients` selects everyone with a stake in the event and never
looks at `rsvp_status`). The ladder is the first feature whose behaviour
depends on that answer, and it is where the disagreement stops being
theoretical.

## What "an occurrence" is, per event shape

The point of the decision is that this table has one answer in every row:

| Event shape | Occurrences | Where attendance lives |
|---|---|---|
| Fixed-time event | Exactly one | One row, `occurrence_date = ''` |
| Single-winner poll | One, once resolved | One row, `occurrence_date = ''` |
| Window poll | One, once resolved (a span) | One row, `occurrence_date = ''` |
| **Multi-winner poll** | One per confirmed day | **Fans out into separate events — see below** |
| Recurring event | One per date in the rule | One row per `occurrence_date` |

`occurrence_date = ''` for non-recurring is not a new convention: it is the
one `notification_log` has used since migration 0001, and reusing it means
one code path rather than a nullable column with two meanings.

## Multi-winner polls become several events

Michael's call, and it is the simplifying one: *"when you do an option event,
it should really be multiple events being created at once."*

Today a multi-winner poll confirms individual days by setting `confirmed_at`
on each `event_poll_options` row while the parent event stays `active`. That
leaves one event with several real session times and — per the table above —
nowhere to put "I'm in for Thursday but not Saturday".

**It also leaves them with no reminders at all**, which is item 47 and a live
bug rather than a design gap. `markResolved` is the only thing that sets
`events.start_at`, and it is single-winner only; `sweepReminders` selects
`WHERE start_at IS NOT NULL`. So a confirmed multi-winner day gets its one
"this day is confirmed" DM and then silence — no 24h, no 1h, today.

Fanning out fixes both at once. On confirmation, a multi-winner day becomes a
real event: its own row with `start_at`/`end_at`, the poll's invite list
copied to it, and its own attendance. Every reminder path, every calendar
query and every attendance read then works on it with no special case,
because it is not a special case any more.

Four things the fan-out has to decide:

1. **What happens to the poll row.** Kept, as the record of the vote, and
   marked resolved once its deadline passes. Deleting it would destroy the
   tallies that explain why those days were chosen.
2. **Provenance.** The created events need `created_from_poll_id` (and
   probably `created_from_option_id`), or the app cannot show "this came out
   of that poll" and cannot avoid creating the same day twice.
3. **Idempotency.** Confirmation is noticed by a cron sweep that deliberately
   re-scans, so creation must be safe to attempt repeatedly. A unique index
   on `(created_from_option_id)` makes the second attempt a no-op rather
   than a duplicate session.
4. **Single-winner stays as it is.** It resolves in place, which is already
   "one event, one time". Fanning out a single winner would mean creating an
   event to replace the one the person is already looking at.

## Recurring events: accept one at a time

Michael's second call, and it is what makes per-occurrence attendance
tractable rather than a burden: **you are invited to the series, but you
accept one occurrence at a time.**

- Answering never applies to the series. There is no "yes to all Thursdays",
  which is deliberate — the app's whole reason to exist is that people cannot
  reliably make every session.
- **The ladder for the next occurrence starts 24 hours after the previous one
  ends**, not 96 hours before the next one. For a weekly game night those are
  the same moment give or take; for anything sparser, the 24-hours-after rule
  is what stops the app going quiet for three weeks and then nagging.
- The **first** occurrence of a new recurring event has no predecessor, so its
  ladder starts when the invitation is sent, clamped to whichever rungs are
  still in the future.
- When the gap between occurrences is **shorter than the ladder** (a daily
  event, where "24 hours after the last one" is already inside the next one's
  24-hour rung), the nearest-due-rung rule handles it: rungs that no longer
  apply are skipped rather than collapsed into a burst.

This is also what makes "declined → no reminders" safe. Under the old
per-event model, one press of *Can't make it* for the week of a wedding
silenced every future session, with no obvious way back — the DM you would
press to undo it is the one that stopped arriving.

## Window polls, and the state only they can have

After a window poll resolves, `event_window_availability` still holds every
invitee's submitted range, and the resolved span is a sub-range of the
winning candidate. That gives three post-resolution states where a fixed-time
event has two:

1. **Their availability covers the resolved span.** They have said, in their
   own words, that they are free for exactly this. Treat as answered — the
   ladder does not nag them.
2. **They submitted, but the span falls outside what they offered.** The
   resolution algorithm optimises most-people-then-longest, so this is
   routine, and today it is *silent*: `getConfirmedAttendeeIds` simply
   excludes them and nothing ever says why. The ladder should treat them as
   unanswered **and say what happened**: "we landed on Saturday 8:00–10:30,
   which is outside the hours you gave."
3. **They never submitted.** Unanswered, full ladder.

State 2 is the most valuable notification in this spec. It is the one case
where the app knows something the person does not, and it exists only because
specs/0013 made candidates windows.

**Do not write `accepted` on their behalf for state 1.** "I'm free 7–10" is
availability, not a commitment to attend, and putting a commitment in
someone's mouth is exactly the kind of thing that erodes trust in a
notification system. Compute it instead: the ladder's "have they answered?"
predicate becomes `there is an attendance row` OR `(windowed AND their
availability covers the resolved span)`, folded into the recipient query as a
join rather than asked as a second statement — the Pass 9 lesson.

## Data model

```sql
CREATE TABLE event_attendance (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  -- '' for a non-recurring event, matching notification_log's convention
  -- since 0001: SQLite has no partial-unique-with-null that behaves the way
  -- this needs, and two meanings for one nullable column is how the poll_mode
  -- confusion started.
  occurrence_date TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  rsvp_status TEXT NOT NULL CHECK (rsvp_status IN ('accepted','declined','tentative')),
  responded_at INTEGER NOT NULL,
  UNIQUE(event_id, occurrence_date, user_id)
);
```

Note what is **not** in it: `pending`. Under the old model every invitee had a
row from the moment they were invited, so "no answer" needed a value. Here the
absence of a row *is* no answer, which removes a class of bug where a row
exists but means nothing.

`event_invites` keeps its `rsvp_status` column for one release and then loses
it. What it becomes is the invite list — who may see and answer — which is
what its name says.

**The migration is the risky part**, and it has an unanswerable case. A
recurring event's single existing `rsvp_status` applies, in the old model, to
the whole series; there is no fact of the matter about which occurrence it
meant. Proposal: copy it to the **next** occurrence only, and let the ladder
ask again for the ones after. Copying it to every future occurrence would
manufacture commitments nobody made; dropping it entirely would silently
un-answer people who did answer.

Blast radius, measured rather than estimated: **16 references to
`rsvp_status` across 9 worker files**, and **3 across 2 frontend files**. The
worker side is the whole job — `attendance.ts`, `eventWrites.ts`,
`reminders.ts`, `events.ts`, `freeBusy.ts`, `groups.ts`, `interactions.ts`,
`dmComponents.ts`, `routes/events.ts`.

## `custom_id` goes to v2

specs/0010 put no occurrence date in the button id, for a reason it stated
plainly: *"rsvp_status is per event, not per occurrence, so a recurring
event's RSVP is one answer — putting a date in the id would imply a
per-occurrence model the schema does not have."* This spec gives the schema
that model, so the id has to carry the date:

```
uo:v2:rsvp:accepted:<eventId>:<occurrenceDate>
```

At 36 characters of UUID plus a 10-character ISO date that is about 68, still
inside Discord's 100.

**This is the versioning earning its keep in its first release.** There are
live v1 buttons sitting in DMs right now whose meaning is "the whole event".
They must not be silently reinterpreted as "the next occurrence". `v1` presses
already answer "this message is out of date — open it on the site", which is
exactly right and needs no new code.

## The cancellation cascade

Michael's third call: if declines drop attendance below what the session
needs, cancel it and tell everyone who was still coming.

Three things this needs that do not exist:

1. **A minimum.** Polls have `poll_threshold_count`; a fixed-time event has no
   concept of "enough people". This wants an optional `minimum_attendees` on
   the event, set by the organizer. **Optional and unset by default** — see
   below.
2. **A decision about who cancels.** Auto-cancelling is a large power to hand
   a button: one person pressing *Can't make it* ends everybody else's
   evening, and the presser may not even realise it happened. Proposal: when
   an event drops below its minimum, **the organizer is told and offered the
   cancel**, and auto-cancel is available only if they opted into it when
   setting the minimum. An organizer who wants "four players or it's off"
   can have exactly that; nobody gets it by accident.
3. **Honesty about "immediately".** The interaction handler has three seconds
   and cannot fan out DMs to an event's invitees inside it. What it *can* do
   synchronously is record the decline and mark the event, so the state is
   correct the moment the button is pressed; the DMs then go out through the
   outbox on the next tick, up to fifteen minutes later. Anything that claims
   faster is either lying or using `ctx.waitUntil`, which specs/0010 already
   rejected for losing failures silently.

## What it costs the cron

- **The scan window goes from 24 hours to 96.** `sweepReminders` is keyset-
  paginated and budget-bounded, so this does not break anything, but roughly
  four times as many events fall in the window each pass and the cursor
  rotates more slowly.
- **Five rungs instead of two** means up to five DMs per person per
  occurrence over an event's life, against a Free-plan allowance of 50
  subrequests per tick with 4 reserved. The ladder does not raise the *peak*
  (rungs are mutually exclusive, so any one tick still sends at most one per
  person) but it raises the total.
- **One extra join** on the recipient query for the attendance row, spliced in
  the way `PENDING_NOTIFICATION_JOIN` is rather than asked separately.
- **The fan-out** costs one insert per confirmed multi-winner day, once.

## Staging

This is two or three releases, and pretending otherwise is how a data
migration goes wrong — the lesson v0.4.6 recorded about holding specs/0013
back from v0.4.5.

1. **Per-occurrence attendance.** The table, the migration, every read and
   write path, `custom_id` v2. No new user-visible behaviour except that a
   recurring event's answer now applies to one occurrence. This is the
   release that can break things quietly, so it ships alone.
2. **The ladder.** Five rungs, the per-status controls, the window-poll
   "outside your hours" DM.
3. **The fan-out and the cascade.** Multi-winner becoming real events, the
   minimum-attendees field, the organizer's cancel.

Item 47's missing reminders can be fixed in stage 1 or before it, and should
not wait for the fan-out — a one-line change to the reminder sweep's
selection would give confirmed multi-winner days the reminders they have
never had.

## Testing

- The migration, against a database holding each shape: a fixed event with
  answers, a recurring event with one series-wide answer, a resolved
  single-winner poll, a confirmed multi-winner poll, and a window poll with
  covering and non-covering submissions.
- Each ladder rung fires once and only once per occurrence, and a status
  change mid-ladder moves the person to the right rung rather than repeating
  a sent one.
- An event that becomes visible inside the ladder fires exactly one rung.
- A decline on occurrence N leaves occurrence N+1's ladder intact — the
  regression this whole spec exists to prevent.
- A v1 `custom_id` in a live DM answers "out of date" rather than being
  interpreted under v2 rules.
- The fan-out is idempotent across repeated sweeps.

## Open questions

1. **Does the organizer get a ladder?** They have an invite row (idea 26) and
   an implicit "yes". Probably they get the accepted rungs and no controls,
   but "the organizer declines their own session" is a real case the app
   already handles elsewhere (`ORGANIZER_UNLESS_DECLINED`).
2. **What does the event page show for a recurring event now?** One answer per
   occurrence means the detail page needs an occurrence picker, or the next
   occurrence's answer with a way to see the rest. This is a real frontend
   design question and it is not costed here.
3. **Does a change request (specs/0003) reset attendance?** If the organizer
   moves a session by two hours, everyone's "I'm in" was for the old time.
   Arguably every answer should revert to unanswered and the ladder restart.
   Arguably that is infuriating for a ten-minute shift.
4. **How far ahead do recurring occurrences get attendance rows?** They are
   computed, not stored, so "the next one" is a moving target the ladder has
   to resolve on every tick.

## Rejected alternatives

- **Reading `event_poll_votes` as multi-winner attendance.** The data is
  already there — a `yes` on a confirmed day is "I'm coming that day" — and
  it needs no new table. Rejected because it makes two sources of truth for
  one question, in the notification path, where a disagreement between them
  is invisible until someone is not reminded. The fan-out removes the
  question instead of answering it twice.
- **Keeping attendance per event and scoping "no more reminders" to the next
  occurrence only.** Needs somewhere to record "declined for 2026-09-03",
  which is per-occurrence attendance wearing a disguise.
- **Writing `accepted` for window-poll submitters whose range covers the
  resolved span.** Cheaper than a join per tick, and it makes the website
  consistent for free. Rejected because it records a commitment the person
  never made.
- **A `pending` row per invitee per occurrence.** Mirrors today's model, and
  makes "who hasn't answered" a simple query. Rejected because a recurring
  event would accumulate rows for occurrences nobody has been asked about
  yet, and because absence is already an unambiguous way to say "no answer".
