# 0004 — Poll date/time consistency

**Status:** Built
**Covers:** `IDEAS.md` item 6 · **Phase:** 2

A fixed-time event's form lets the organizer set separate start and end
dates (an overnight session, or one spanning several days). Both poll
creation paths — candidate days/times ("options" mode) and the time-window
mode — didn't offer that same shape: each candidate slot, and the window
itself, was constrained to a single calendar date with two time-of-day
fields. This gives both the same two-date/two-time shape the single-event
form already has.

## Why this needed no backend or schema change

Every place this data lands already stores a full millisecond timestamp with
no same-day constraint:

- `event_poll_options.start_at`/`end_at` — `worker/src/lib/validate.ts`'s
  `assertTimeRange(opt.startAt, opt.endAt, 'pollOptions[]',
  LIMITS.MAX_EVENT_DURATION_MS)` only checks `endAt > startAt` and a
  ~1-year duration cap. Nothing checks that both timestamps fall on the same
  calendar day.
- `events.window_start_at`/`window_end_at` — same shape, capped at
  `LIMITS.MAX_WINDOW_SPAN_MS` (60 days), already far more permissive than
  "one day."

So the single-day limitation was purely `EventFormPage.tsx` constructing
both timestamps from one `<input type="date">` value. Fixing it is a
frontend-only change: give the form the missing second date field and
build the two timestamps from their own date, exactly like the single-event
fields already do.

## What changes

`frontend/src/pages/EventFormPage.tsx`:

- **`PollSlotDraft`** (one candidate day/time row in "options" mode) gains
  an `endDate` field alongside its existing `date`/`startTime`/`endTime`.
  Rendering adds a second `<input type="date">` next to the end time,
  mirroring the single-event fields' four-input layout (start date, start
  time, end date, end time) rather than the poll form's previous three
  (date, start time, end time).
- **Window mode**'s single `windowDate` becomes `windowStartDate` +
  `windowEndDate`, with the same two-date layout.
- **Validation**: `pollSlotsValid` and `windowRangeValid` change from
  `isValidRange(date, startTime, date, endTime, zone)` (end date pinned to
  the same value as start) to `isValidRange(startDate, startTime, endDate,
  endTime, zone)` — reusing the same `isValidRange` helper from spec 0001B,
  just no longer hiding its `endDate` parameter behind a repeated `date`.
- **Submission**: `pollOptions[].endAt` and `windowEndAt` are built from
  their own end-date field instead of reusing the start date's.
- **The "moving the start drags the end forward" nudge**
  (`handleStartDateChange`, spec 0001B/idea 12) is applied per-slot and to
  the window fields too, not just the single-event fields — the same trap
  (an easily-reachable end-before-start state when only the date changes)
  exists in all three places now that all three have two independent dates.
- **Edit-mode loading**: the `useEffect` that populates form state from a
  loaded `EventDetail` now reads both dates out of each poll option's
  `startAt`/`endAt` and the window's `windowStartAt`/`windowEndAt`, instead
  of discarding the end timestamp's date.

Nothing in `worker/` changes. No migration. `PollOptionRow.tsx` and
`WindowAvailabilityPicker.tsx` (the invitee-facing renderers) already
display full multi-day ranges via `formatTimeRange`, which has led with the
date since spec 0001A — they needed no change either.

## Not in scope

- The scheduling assistant's per-slot preview (`SchedulingAssistant`'s
  `date`/`proposedStart`/`proposedEnd` props, keyed off `pollSlots[0]` for
  options mode) still previews only the *first* candidate slot's range.
  That's a pre-existing simplification unrelated to this fix — multi-slot
  availability preview is a bigger feature, not a date-field bug.
- No new tests beyond what spec 0001B already covers for `isValidRange`
  itself; this change is call-site wiring, not new logic.
