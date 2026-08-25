# 0013 — Windowed candidates

**Status:** Built
**Covers:** `IDEAS.md` item 40. Items 39 and 41, which render its result,
shipped ahead of it in v0.4.5.
**Phase:** 3.10 → **v0.4.6**

## The change in one sentence

A poll's candidate slots stop being fixed times and become **windows with a
minimum session length**, so "the 25th 7:30–10, the 26th 7:30–10, the 30th
1–11, any 2.5 hours in any of them" is one poll.

## Why this is a merge, not a third mode

There are two poll modes today and each is a special case of the one above:

| Today | Under this spec |
|---|---|
| `poll_mode = 'options'` — fixed slots, voted yes/no/maybe | Candidates whose window length *is* the minimum, so there is no slack to choose within |
| `poll_mode = 'window'` — one span on the event, plus `window_block_minutes`, people submit a sub-range | A poll with exactly one candidate |

That is the argument for one tab and a checkbox rather than a mode picker,
and it is also the argument for the two current modes becoming *presets* of
the general one rather than surviving beside it.

## The model, and why it needs almost nothing new

`event_poll_options` already carries `start_at` and `end_at` per candidate.
**Under this spec those stop meaning "the session" and start meaning "the
window the session may fall in."** `events.window_block_minutes` already
exists and becomes the minimum session length for the whole poll.

So the shape of a poll is decided by one nullable column that already exists:

- `window_block_minutes IS NULL` → the candidate's span *is* the session.
  Vote yes/no/maybe. Exactly today's options poll.
- `window_block_minutes` set → each candidate is a window. Submit the
  sub-range you can commit to.

**The checkbox in the form is literally "is `window_block_minutes` set?"**

Only one table needs changing, and it is not `event_poll_options`: the
candidate's `start_at`/`end_at` change *meaning*, not shape.
`event_window_availability` is keyed
`(event_id, user_id)` — one submission per person per *poll*. Windowed
candidates need one per person per *candidate*, so it gains `option_id` and
the uniqueness moves to `(option_id, user_id)`. SQLite cannot alter a
constraint in place, so the table is recreated — the same move migration 0003
and 0005 already made on `notification_log`, and the reason those migrations
are worth reading before writing this one.

`poll_mode` stays for now, with `'window'` migrated to a single-candidate
poll rather than removed in the same release. Dropping a column the deployed
Worker still reads is the two-release change `deploy-worker.yml`'s ordering
comment already warns about; the read can go in v0.4.5 and the column in a
later one.

## Resolution: the longer session

This is the one genuinely new behaviour, and the only part that is not
bookkeeping. `bestWindowBlock` today slides a block of **exactly**
`blockMinutes` across the window and returns the position the most people
cover. The ask — *"2.5 hours is a minimum; if you're available the whole time
on the 30th, we have a longer session"* — needs the **maximal** span that
still clears the bar.

Two objectives, so they need an order, and the order is not arbitrary: **most
people first, then longest.** A poll that traded a person for an extra half
hour would be choosing a longer session with fewer players, which is the
wrong way round for this app.

The search stays cheap by not being a search over pairs:

1. Compute `c*`, the best coverage any minimum-length block achieves — this
   is exactly what `bestWindowBlock` already returns.
2. For each start `s` on the existing 30-minute grid, the largest end
   reachable at coverage `c*` is the `c*`-th largest `endAt` among
   submissions with `startAt <= s`. Cap at the window end; keep it only if
   `e - s >= blockMs`.
3. Take the longest such `(s, e)`.

That is `O(grid × N log N)` rather than `O(grid² × N)`, and it reuses the
`WINDOW_STEP_MS` grid and the `MAX_WINDOW_CANDIDATES` ceiling that already
bound the existing version. The ceiling still matters and gets tighter, not
looser: work is now per candidate rather than per poll, so the bound is
checked **per option** and a 20-candidate poll cannot buy 20× the work.

**Ties go to the earliest start**, matching what the existing window
resolution already does for equal counts — soonest wins.

## What each surface becomes

**Creation.** One "potential invite (poll)" tab. Candidates are listed as
they are now, each with a start and end (idea 6 already gave them separate
dates). A checkbox — *"these are windows; find any N hours that works"* —
reveals the minimum-length field. Ticking it changes nothing about the
candidates already entered; it changes what they mean.

**Voting.** With no minimum, the existing yes/maybe/no per candidate. With
one, the existing `WindowAvailabilityPicker` per candidate — it is already
generic over an arbitrary span (idea 18 confirmed that when window polls
gained multi-day spans), so this is a matter of rendering one per candidate
rather than one per poll.

**Resolution and DMs.** A windowed poll resolves to a candidate *and a span
within it*, so the confirmation names both. `multi_winner` composes without
special-casing: each candidate resolves independently once its own best block
clears the threshold, which is already what multi-winner means.

## What this leaves for 39 and 41

Both are rendering problems this makes worse before it makes better, which is
why they ship together:

- **39** — `SchedulingAssistant` shows one candidate (`pollSlots[0]`) on a
  fixed 8am–2am axis. A poll whose whole point is comparing three windows is
  unusable through a view that shows one of them.
- **41** — an unresolved poll appears on the calendar only on its *deadline*
  date. Windowed candidates make the candidate days more meaningful, not
  less, so they need to be on the calendar, marked as provisional.

## Migration

```sql
-- Recreate event_window_availability keyed on the option.
-- Existing window polls become single-candidate polls first, so their
-- submissions have an option to point at.
```

Two ordering requirements, both learned the hard way in this repo:

- **Convert before recreating.** Every existing `poll_mode = 'window'` event
  gets one `event_poll_options` row spanning its `window_start_at`/`_end_at`,
  and its availability rows are rewritten to reference it. A window poll with
  no options row would otherwise lose its submissions.
- **Run `db:verify` against the sandbox immediately after applying**, not at
  the end of the branch. Recreating a table is exactly the operation behind
  three past schema-drift incidents (`SETUP.md`), and the one where a
  rebuilt table silently dropped an index (migration 0016).

## Testing

- **The two presets still behave.** A poll with no minimum resolves exactly
  as an options poll does today; a single-candidate poll with a minimum
  resolves exactly as a window poll does today. These are the regression
  tests that make "merge" a true claim rather than a hopeful one.
- **The longer session.** Submissions that all cover a 4-hour span on one
  candidate resolve to 4 hours, not to the 2.5-hour minimum.
- **Coverage beats length.** Five people covering 2.5 hours beats four
  covering five hours.
- **Per-candidate independence.** A submission on candidate A does not affect
  candidate B's resolution.
- **The ceiling holds per option**, so a 20-candidate poll is not 20× the
  work of a 1-candidate one.

## Open questions, as built

1. **Does an existing window poll's DM copy need rewriting?** Settled by
   doing something narrower and more useful than rewording: a windowed poll's
   resolution DM now names the **span**, not just the start. "We found two
   and a half hours" and "everyone can stay until eleven" are different
   outcomes and the old copy could not tell them apart. Live polls are
   otherwise left alone, as the leaning said.
2. **Can a poll mix windowed and fixed candidates?** Answered no, as leaned.
   One minimum per poll, on the event.

## What the build changed about this spec

Two things above were written before the code existed and are wrong in the
file as originally drafted; they are corrected in place, and recorded here so
the diff between plan and result is legible:

- **`window_start_at`/`window_end_at` did not move onto the option.** The
  candidate's existing `start_at`/`end_at` changed meaning instead, which is
  why the migration only had to touch one table.
- **Multi-winner needed one special case after all.** Confirming a windowed
  candidate narrows its row from the window to the span that won, in the same
  compare-and-set that sets `confirmed_at` — a fixed slot already knows its
  session time, and a window does not until it resolves. Everything else
  composed as claimed.

One consequence worth stating plainly, since it is the thing most likely to
surprise later: **`event_window_availability` keeps `event_id` alongside
`option_id`.** Three callers ask "how many people have answered anything on
this poll" — the submission ceiling, the export, and account deletion — and
routing those through `event_poll_options` would turn each into a join. It is
denormalised deliberately, with `ON DELETE CASCADE` on both parents so it
cannot outlive either.
