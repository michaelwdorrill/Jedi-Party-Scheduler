# 0007 — The server noticeboard

**Status:** Built — v0.8.1
**Covers:** `IDEAS.md` item 5 (second half) · **Phase:** 5 · **Ships in:** 0.8.1

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


## How the blockers were resolved

**1. The Privacy Policy** was rewritten in the same release, and the policy
version bumped 3 → 4 so everyone re-accepts. The "Events" bullet split in two:
full detail still goes only to the organiser and invitees, and a second bullet
describes the limited view a server gets. Shipped alongside the Google pull
half so both changes cost one re-acceptance rather than two.

**2. `is_private` and the backfill** landed as migration 0038, taking the
spec's own recommendation over the timestamp alternative. `ADD COLUMN ...
DEFAULT 0` followed by `UPDATE events SET is_private = 1`: new rows visible,
every existing row explicitly private. That single UPDATE is what makes this a
new rule for new events rather than a retroactive change of terms, and there is
a test asserting it is still present in the migration — its absence would be
invisible in review and catastrophic in production.

**3. Query shape** got `lib/noticeboard.ts` rather than a widened
`buildCalendarOccurrences`, exactly as this spec predicted. The reasoning held
up on contact: that function is bounded by what the *caller* is personally
attached to, and 0006's whole cost argument rests on that bound; scoping by
guild membership removes it. So this query has its own ~2-month range cap, its
own 100-event limit ordered by start time, and its own shared occurrence
ceiling for recurring expansion — the technique `lib/freeBusy.ts` uses, for the
same reason. It refuses with a 422 rather than truncating, because a silently
shortened noticeboard is indistinguishable from a quiet server.

**4. Personal time blocks** never had to be filtered: they live in
`personal_events`, which this query does not touch. There is a test asserting a
personal block's title never appears in the response, checked against the raw
serialised body rather than the parsed object.

## One thing the decisions did not cover

Polls. An unresolved poll has no time yet and its candidate days are maybes, so
listing either would advertise a session that may never happen — the same
reasoning `lib/freeBusy.ts` applies to what counts as busy. Unresolved polls
are excluded outright; a resolved one has a real `start_at` and appears like
any other event.

**The second half of that was wrong in the first build, and the test suite
agreed with it.** A resolved poll's `status` is `'resolved'`, not `'active'`,
so the query's `status = 'active'` threw every decided poll off the board —
and in doing so made the poll clause after it unreachable, since nothing could
survive to be tested by it. What hid this is that the only poll test asserted
an *absence*: the unresolved poll was correctly missing from the board, but for
the wrong reason, and a test that passes for the wrong reason cannot fail when
the reason changes. The fix is `status IN ('active','resolved')`, the form
`freeBusy.ts` was already using, plus the test asserting the resolved poll is
*present* — which fails against the old query, checked rather than assumed.

The general lesson is idea 31's again, from the other side: a filter tested
only by what it excludes is half-tested. Every "must not appear" assertion here
now has a paired "must appear" one, because absence is the answer a broken
query gives too.
