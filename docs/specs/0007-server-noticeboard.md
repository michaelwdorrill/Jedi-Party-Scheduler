# 0007 — The server noticeboard

**Status:** Decisions locked, not yet designed
**Covers:** `IDEAS.md` item 5 (second half) · **Phase:** TBD · **Ships in:** TBD

## What this is

The other half of idea 5, deliberately left out of v0.3 (see
`0006-calendar-first.md`, "Not in scope"): being able to look at a server and
see what's on, including events you are not invited to.

v0.3 made servers stop mattering for *viewing your own stuff*. This makes a
server mean something again, but in the opposite direction from the old
switcher: not "the mode the app is in", but a place you can look at.

## The framing that settles it

> "I think you can see event titles and who'll be going. If you're in a
> server, that's more public noticeboard type thing than anything."

This is a bigger step than the "free/busy blocks only" version the spec
originally assumed, and it is a deliberate one. A shared server is treated as
a semi-public space, the way a pinned message in a channel is.

## Decisions

| # | Question | Decision |
|---|---|---|
| 1 | Default-on with a per-event private toggle, or opt-in per event? | **Default on.** An event on a server is visible on that server's noticeboard unless the organiser marks it private. |
| 2 | Retroactive, or new events only? | **New events only.** Events that already exist were created under a policy that promised otherwise; they stay private. |
| 3 | Are descriptions visible? | **Out.** Title and attendee list only. |
| 4 | Can an invitee hide themselves from the attendee list? | **No.** A noticeboard that lets people opt out of being on it stops being a reliable answer to "who's going". |

## What that means concretely

Visible to any verified member of the server, for a non-private event created
after this ships:

- the event title
- when it is
- who has been invited and their RSVP state

Not visible:

- the description
- anything about events marked private
- anything at all about events created before this ships
- anything on a server the viewer isn't a verified member of

## The blockers before this can be built

**1. The Privacy Policy currently promises the opposite.** `PrivacyPage.tsx`
(the "Events" bullet) says:

> **Events.** Only the organiser and the people invited to an event can see
> its details. Sharing a Discord server with someone does not let you see
> their events.

Both sentences become false. This has to be rewritten *and* the change
surfaced to users — not edited quietly — before the feature is enabled. The
`LAST_UPDATED` constant in `lib/legal.ts` exists for this.

Decision 2 (new events only) is what makes this defensible: nobody's existing
events change visibility under them retroactively.

**2. The `is_private` column and the creation-time default.** Decision 1 plus
decision 2 means the flag can't simply default to "visible" in the schema —
existing rows would flip. Either the migration backfills existing rows to
private explicitly, or visibility keys off a "created after" boundary. The
backfill is cleaner and is what should happen; a timestamp comparison is the
kind of implicit rule that gets forgotten.

**3. Query shape.** This is a genuinely different query from `/me/events` —
it is scoped by guild membership rather than by the caller's own invite rows,
so the bound that made the cross-guild calendar cheap (see 0006) does not
apply. It needs its own pagination and its own thinking about the D1 query
budget, not a widened `buildCalendarOccurrences`.

**4. Interaction with personal time blocks.** Personal blocks are private by
design and are not events on a server. They are out of scope here and must
stay invisible on the noticeboard. Worth an explicit test.
