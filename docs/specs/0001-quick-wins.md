# 0001 — Quick wins

**Status:** Ready
**Covers:** `IDEAS.md` items 4, 12, 7, 11 · **Phase:** 0

Four independent changes, grouped only by being small and having no design
questions left in them. None touches the schema. None depends on another —
they can ship as one branch or four, in any order.

---

## A. Calendar weeks run Sunday–Saturday (idea 4)

### What changes

The month grid's first column becomes Sunday and its last becomes Saturday,
everywhere a month grid is drawn.

### Where

- `frontend/src/lib/datetime.ts:18` — `buildMonthGrid`. Currently:

  ```ts
  const gridStart = firstOfMonth.minus({ days: (firstOfMonth.weekday - 1) % 7 });
  const gridEnd   = lastOfMonth.plus({ days: (7 - lastOfMonth.weekday) % 7 });
  ```

  Luxon's `weekday` is `1=Mon .. 7=Sun`. Sunday-first becomes:

  ```ts
  const gridStart = firstOfMonth.minus({ days: firstOfMonth.weekday % 7 });
  const gridEnd   = lastOfMonth.plus({ days: (6 - (lastOfMonth.weekday % 7)) % 7 });
  ```

  Worth checking by hand rather than by eye: `weekday % 7` maps Sunday (7) to
  0 and leaves Mon–Sat as 1–6, so `gridStart` steps back to the preceding
  Sunday and `gridEnd` forward to the following Saturday. The comment on the
  function ("Mon-Sun") needs updating with it.

- `frontend/src/components/MonthCalendarGrid.tsx:6` — `WEEKDAY_LABELS` becomes
  `['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']`.

### The trap

**The stored weekday encoding does not move.** `event_recurrence_rules.by_weekday`
is CSV ints with `0=Mon..6=Sun` (schema comment, `worker/migrations/0001_init.sql:81`),
`worker/src/lib/recurrence.ts:111` decodes it as `seriesStart.weekday - 1`, and
`worker/src/lib/validate.ts:141` range-checks 0–6. Renumbering that to make
Sunday 0 would silently reinterpret every recurring event already in the
database — a Monday game becomes a Sunday game with no migration and no error.

So: display order changes, encoding does not. If `RecurrenceForm.tsx`'s
weekday chips (`frontend/src/components/RecurrenceForm.tsx:3`) are reordered
to match the calendar, the reorder must be in the rendering only, with each
chip still carrying its existing `0=Mon..6=Sun` value — the component
currently derives the value from the array index (`value.byWeekday.includes(i)`
at line 65), which is exactly the pattern that breaks when the array is
reordered. Either leave that component Mon-first, or change it to iterate an
explicit `[{label, value}]` list. Leaving it Mon-first is defensible and is
the smaller change; reordering it is the more consistent one. **Decision:
reorder it, with explicit values**, since a form that disagrees with the
calendar next to it is the kind of small inconsistency this item exists to
remove.

### Tests

`frontend/test/` currently holds one test file. Add a `buildMonthGrid` test:
for a month starting on a Sunday, a month starting on a Monday, and a month
ending on a Saturday, assert the first grid day is a Sunday, the last is a
Saturday, and `days.length % 7 === 0`. That last assertion is the one that
catches an off-by-one in either expression.

---

## B. Block an end before the start in the form (idea 12)

### What changes

The New/Edit Event form refuses to submit a range whose end is at or before
its start, and says so inline, instead of letting the request go and
surfacing the server's rejection.

### Where

`frontend/src/pages/EventFormPage.tsx`. Three separate start/end pairs exist
and all three need it:

1. the single-event start/end fields,
2. each poll slot row (`PollOptionRow.tsx`),
3. the time-window mode's window start/end (`WindowAvailabilityPicker.tsx` /
   the window fields on the form).

`worker/src/lib/validate.ts` already rejects `endAt <= startAt` server-side.
This is a UX change, not a security one — **the server-side check stays
exactly as it is**, and the client-side guard is not permitted to become the
only check.

### Chosen UX

Inline message plus a disabled Save, not auto-pushing the end forward.
Auto-advance is friendlier for the common case (you moved the start and the
end should follow) but it silently rewrites a value the user typed, and the
one place that matters most — an overnight session ending at 1:00 AM — is the
case where the user's "end before start" reading is a legitimate intent
expressed against the wrong date. Telling them beats guessing for them.

Precise rule: compare the resolved instants, not the wall-clock times, so a
7:30 PM → 1:00 AM *next-day* range is valid and a 7:30 PM → 1:00 AM *same-day*
range is not. Equal instants are invalid, matching the server's `<=`.

### Tests

Frontend tests here are shallow by design (see `.github/workflows/ci.yml`'s
note on why the frontend only tests the revocation queue). Extract the
comparison into a small pure helper in `frontend/src/lib/datetime.ts` and unit
test that — same-day end-before-start, next-day end, equal instants, and one
DST-boundary case in a zone that has one.

---

## C. Pick the server on the New Event screen (idea 7)

### What changes

The New Event form gets its own server picker. Which server an event belongs
to stops being an inherited side effect of the top-bar guild switcher.

### Where

- `frontend/src/pages/EventFormPage.tsx:26` currently reads the guild from
  `?guild=` in the query string, falling back to `loadedGuildId` for edits
  (line 82). The guild-scoped fetches — friends (line 96), groups (line 96),
  voice channels (line 107) — all key off it, as does the create call
  (`POST /guilds/${guildId}/events`, line 299).
- `frontend/src/auth/GuildContext.tsx` already exposes the full `guilds` list,
  so the picker needs no new endpoint.

### Behaviour

- **Create:** a required select, defaulted to the currently selected guild
  from `GuildContext` (so the common path is unchanged — the default is just
  no longer invisible). Changing it re-fetches friends, groups and voice
  channels for the newly chosen guild and **clears the invitee, group and
  voice-channel selections**, because those are ids scoped to the old guild
  and carrying them across would submit references the server will reject.
  That clearing is the only behavioural subtlety here and should be visible to
  the user, not silent.
- **Edit:** rendered read-only. Moving an existing event between servers is
  not what this item asks for, and it isn't a small change — the event's
  invites, group references and voice channel are all guild-scoped.
- The `?guild=` param keeps working as the initial value, so existing links
  into the form (e.g. from a calendar day click) still land on the right
  server.
- Whether choosing a server here also changes the top-bar switcher: **no.**
  One control should not silently retarget another; the form's choice is
  local to the form.

### Tests

Covered by typecheck and manual verification. If the clear-on-change logic
grows past a few lines, it's worth pulling out and unit testing.

---

## D. Owner-only view of everyone signed up (idea 11)

### What changes

A page at `/admin/users` (owner only) listing every user in the system: who
they are, which guilds they're in, and when they last logged in.

### Where

- `worker/src/routes/admin.ts` already gates the whole router on
  `isOwner(c.env, c.get('userId'))` and returns 403 otherwise. The new
  endpoint goes behind the same middleware — no new auth path.
- The frontend has no admin page yet; this adds the first one.

### Endpoint

`GET /admin/users?limit=&after=`

Returns, per user: `id`, `username`, `globalName`, `lastLoginAt`,
`notificationsEnabled`, and the list of guilds they're a member of (id +
name), from `user_guild_membership` where `is_member = 1`.

Two constraints the rest of this codebase would apply and this endpoint
should too:

- **Bounded.** Page it — `LIMIT` with a keyset cursor on `users.id`, the same
  shape `worker/src/cron/cursor.ts` uses, rather than an unbounded `SELECT *
  FROM users`. Today that's a handful of rows; the point of the bound is that
  it stays correct when it isn't.
- **Two queries, not N+1.** Fetch the page of users, then their memberships in
  one `WHERE user_id IN (...)` against the page, and join in memory. D1's
  per-invocation query ceiling is the reason the cron folds its checks into
  single queries (`lib/outbox.ts`'s `PENDING_NOTIFICATION_JOIN`); a per-user
  membership query would be the same mistake in a request handler.

### What it must not become

An event-data endpoint. ARCHITECTURE.md's privacy model states plainly that
there is no admin endpoint that reads other people's event data, and this must
not quietly become the first one. Users, guild membership and last-login only
— no titles, no invitee lists, no free/busy.

### Frontend

A minimal table under a new `/admin` route, linked from `SettingsPage` only
when the logged-in user is the owner. It needs no design work beyond matching
the existing pages — idea 8 (the visual design pass) will reach it later.
Handle the 403 by not rendering the link at all *and* by the page failing
closed, since the link's absence is not a security control.

### Tests

Worker-side: a test that a non-owner gets 403 and an owner gets the list —
mirroring however `admin.ts`'s existing guild routes are covered in
`worker/test/`.
