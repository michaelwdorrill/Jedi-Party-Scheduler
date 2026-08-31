# 0014 — Attendance per occurrence, and a reminder ladder that reads it

**Status:** Draft — decisions locked (see below), one build question open
**Covers:** `IDEAS.md` items 47 and 48. Absorbs item 46, which is one symptom
of the same thing.
**Phase:** 3.8x → **v0.6** (stage 1), 0.6.x (stages 2 and 3)

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
- **The organizer is on the accepted rungs without answering** — see the
  decisions below.
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
- **The ladder only ever asks about the next occurrence; the website lets you
  answer any occurrence the calendar shows** (decision 2). A DM is about one
  session, and one that asked about six would be unreadable.
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
  apply are skipped rather than collapsed into a burst. **Decision 7 makes
  this rule load-bearing** rather than a detail — it is the whole difference
  between per-occurrence state and per-occurrence nagging, and daily events
  are creatable from the New Event form today.

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

**The migration is the risky part**, and it had an unanswerable case: a
recurring event's single existing `rsvp_status` applies, in the old model, to
the whole series, and there is no fact of the matter about which occurrence it
meant. Decision 5 settles it — nothing is carried over, everyone starts
unanswered, and the changelog says so. The costs of that are recorded with
the decision rather than here, because they are costs to *people* rather than
to the schema.

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
2. **A decision about who cancels — decided, see decision 4.** The organizer
   is told and offered the cancel; auto-cancel happens only if they opted
   into it when setting the minimum.
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

## Decisions (Michael, Aug 2026)

Taken before any code, because every one of them changes what gets built
rather than how it looks.

**1. The organizer is implicitly attending, and gets the accepted rungs.**
No answer required from them per occurrence: 24 hours and 1 hour, with the
single *Can't make it* button. This is `ORGANIZER_UNLESS_DECLINED` (idea 26)
carried over intact and made per-occurrence — they are running it, so they
are there unless they say otherwise, and now they can say otherwise for one
session without abandoning the series.

**2. Someone can answer for any occurrence the calendar shows; the DM only
ever asks about the next one.** Two different surfaces with two different
jobs: a DM is about one session and asking it to be about six would be
unreadable, while the website can reasonably let you decline the week you are
away.

*This coupled attendance to `IDEAS.md` item 22, and item 22 was then resolved
in the permissive direction* (v0.5, the same day): the calendar pages to any
month, forwards and back. So "any occurrence the calendar shows" now means
**any occurrence at all**, which is worth stating plainly rather than
inheriting quietly.

That is a larger promise than it was when the decision was taken, and it is
still the right one, because the thing it could have gone wrong on does not
apply: attendance rows are created by a person answering, never by the app
expanding a recurrence. Somebody who navigates to March 2028 and declines a
session there has created exactly one row, deliberately. The growth bound is
human effort, which is the only bound this app has ever needed.

What it does mean is that the **ladder's** restraint is doing all the work:
the DM only ever asks about the next occurrence. Without that, an unbounded
calendar would imply unbounded nagging.

**3. A change to an event clears attendance only if the date moves.** Moving
to another day re-asks everyone and restarts the ladder; shifting the time
within the same local day keeps every answer and only notifies. The test this
passes and the alternatives fail is whether it can be explained to a player
in one sentence: *"if we move it to a different day, you'll be asked again."*

The rule is deliberately about the **local** date in the event's own timezone,
not a UTC one, because "same evening, half an hour later" must not count as a
date change for a session that starts at 23:30.

**4. Below the minimum, the organizer decides — unless they asked not to be
asked.** Dropping below `minimum_attendees` DMs the organizer with a *Cancel
this session* button. If they ticked "cancel automatically" when setting the
minimum, it cancels itself and everyone still attending is told.

The reasoning is about what a button should be able to do to other people.
Auto-cancel by default means one person pressing *Can't make it* ends
everybody else's evening, possibly without ever realising they did it. An
organizer who genuinely wants "four players or it's off" can still have
exactly that; nobody gets it by accident.

**5. The migration drops existing answers rather than guessing.** No
`rsvp_status` is carried into `event_attendance`. Everyone starts unanswered
and the ladder asks.

This is the honest option and it is not the comfortable one, so the costs go
here rather than being discovered later:

- **Anyone who had declined will be asked again.** They said no once, under a
  model where that meant the whole series, and the release takes that away.
  That is the sharpest single consequence of this spec and the changelog has
  to say so plainly — this project has form for that (v0.4.4's entry said
  outright that nothing changed for anyone yet).
- **The first tick after release has a backlog**, because every upcoming
  event's invitees are simultaneously unanswered. It is a throughput spike,
  not a spam spike: the nearest-due-rung rule still means one DM per person
  per occurrence, and the outbox drains the rest over successive ticks. Worth
  watching the first few ticks on the sandbox with a realistic number of
  events before doing it in production.
- **The alternative was worse.** Copying an answer forward across occurrences
  nobody was ever shown manufactures commitments, which is the exact failure
  per-occurrence attendance exists to prevent.

**6. The event page is an occurrence page; the series is only a label.** The
calendar shows a recurring event on every date its rule puts it on. Clicking
one opens *that* occurrence. The page may say "Part of the *X* series", but it
carries no occurrence picker and no navigation to its siblings — each
occurrence stands on its own, and the calendar is how you reach any other.

This was written up here as the largest remaining unknown, and it is not one,
because **the app already navigates exactly this way**:

- `EventChip.tsx` already links a recurring occurrence to
  `/events/:id?occurrence=YYYY-MM-DD`.
- `EventDetailPage` already reads that parameter, and already gates *Cancel
  this occurrence* on it — beside the series-level *Edit* and *Cancel event*,
  so "each stands alone but the series still exists" is the shape that is
  built.
- `specs/0005` already decided the matching half in the same direction: the
  copy-invite-link deliberately reconstructs the URL *without* `?occurrence=`,
  because an invitation means the event, not the day the organizer happened to
  be looking at.

So per-occurrence attendance hangs off a structure that exists and is already
consistent with itself. Two sub-calls follow, both stage 1 and both small:

**6a. A reminder DM links to the occurrence it is about.** `eventLink`
(`worker/src/cron/reminders.ts:345`) builds `/#/events/:id` with no occurrence,
and it is the link in every invite, reminder and change-request DM. A ladder
rung is per occurrence by construction, so its link has to be too — otherwise
the DM asking about the 10th opens a page with no idea which night it meant.
Mechanical, and that path is already being rewritten for `custom_id` v2. **The
invite DM keeps the bare link**, per 0005: you are invited to the series.

**6b. The bare `/events/:id` shows the next upcoming occurrence.** Someone
arriving from an invite link, a copied link or an older DM has to land on
something, and "choose a day before you can see anything" is a worse landing
than the page they get today. It shows the next occurrence's answer, and the
calendar reaches the rest. No redirect to an occurrence URL — the bare link
must keep meaning the series, or 0005's rule is undone by the fix.

**7. A recurring occurrence carries its own state, not its own nagging.**
Per occurrence: the answer, and where that answer sits on the ladder. *Not*
per occurrence: a DM each tick for every occurrence inside the ladder window.

The distinction sounds academic and is not, though it is invisible at weekly
or sparser — a 168-hour gap never puts two occurrences inside a 96-hour
ladder, so both readings behave identically for a normal game night. **Daily
is where they diverge, and daily is creatable today**:
`frontend/src/components/RecurrenceForm.tsx:53` offers *Daily* with an
interval, so "every day" and "every 2 days" are both reachable from the New
Event form right now. Under the rejected reading a daily event puts four
ladders in flight at once and DMs a person up to four times per tick.

What prevents it is already in this spec, and decision 7 promotes it from
incidental to load-bearing: the ladder for occurrence N+1 starts 24 hours
after N ends, and only the nearest due rung ever sends. This decision exists
so that "occurrences are independent" is never read as licence to build the
other thing.

## Still open

*The question that stood first here — what the event page shows for a
recurring event, "the largest remaining unknown" — is answered by decision 6,
and turned out to be mostly built already. What remains is a measurement, not
a decision.*

1. **How are a recurring event's occurrences resolved on each tick?** They are
   computed from the rule, not stored, so "the next one" is a moving target
   and "every one the calendar shows" is a range that has to be expanded per
   event per tick. `expandOccurrencesForEvent` already does this for
   reminders; whether it can carry the attendance join cheaply is a build
   question worth measuring before stage 2.

   Two numbers make it measurable rather than vague. The reminder sweep
   currently expands each recurring event over `windowEnd = now + 24 * HOUR_MS`
   (`worker/src/cron/reminders.ts:708`), and the ladder's furthest rung is 96
   hours — so **the expansion window widens fourfold**, and `pendingRecipients`
   gains an attendance join per occurrence on top of that. For weekly events
   the occurrence count per event per tick stays 0 or 1 either way; the cost
   lands on daily events and on the join, not on the wider window itself.
   Measure against `cron/budget.ts` with the sandbox seeds before stage 2,
   which is also when the first-tick backlog from decision 5 wants watching.

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
