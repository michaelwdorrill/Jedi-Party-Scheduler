# 0005 — Event-specific invite links

**Status:** Built
**Covers:** `IDEAS.md` item 3 · **Phase:** 2

## Scoping decision: 13 doesn't replace this, and this is much smaller than
## the roadmap assumed

The roadmap held idea 3 until idea 13 (invitee change requests) shipped, on
the theory that 13's `add_invitee` request might turn out to cover most of
what 3 wanted, and to design the two together since both touch "someone
reaching an event they weren't already connected to." Having built 13, the
two turn out to solve different problems and 3 is still worth doing:

- **13** answers *who can be invited*: an invitee can ask the organizer to
  add someone else already in the app (guild-membership-checked
  server-side), and the organizer decides.
- **3** answers *how an already-invited person actually gets to the event*:
  today that's exclusively the bot's own DM (`sweepNewInvites`), and the
  original ask was for something the organizer can paste into their own
  message instead — because an unsolicited bot DM with a link reads as
  spam/scam to some people, however legitimate.

Those are orthogonal. Nothing about 13 gives the organizer a link to hand
someone themselves.

**The security-surface overlap the roadmap flagged with idea 9 doesn't
apply to what this actually needs to be.** Re-reading the original ask
closely: "a link... that takes a specific person straight to one event...
so the organizer can paste it into their own message" is not a request for
a link that *grants* access to someone new — it's a request for a
convenient, correctly-shaped link to someone who is *already* on the invite
list. That link already exists, today, with no new mechanism: this is a
`HashRouter` SPA (`frontend/src/main.tsx`), so `https://<frontend>/#/events/<id>`
is already the real, bookmarkable, shareable URL for an event's page, and
`loadEventIfVisible` (`worker/src/routes/events.ts`) already gates it
exactly the same way regardless of how someone arrives at that URL: log in
with Discord, be an active member of the event's guild, and be the
organizer or a current invitee. A person who isn't invited gets "Event not
found" whether they clicked a DM link, typed the URL by hand, or got it
pasted into a message by the organizer — nothing about *how* the link was
obtained changes what it can do. So there is no new access-granting
mechanism here, no token, nothing that widens who can reach an event or a
server — which is exactly the class of thing idea 9 (self-service bot add)
has to actually solve, and exactly what this doesn't need to.

That reframes the size. The roadmap's `M` estimate assumed a link that does
something the DM doesn't — some kind of standalone grant. Given the
existing authorization is already correct and link-shape-agnostic, the only
real gap is **discoverability**: nothing in the UI hands the organizer a
clean link to copy. That's a small, frontend-only feature.

## What ships

A **"Copy invite link"** button on `EventDetailPage.tsx`, visible to the
organizer only (matching the original ask's "the organizer can paste it" —
an invitee wanting to reshare is a different, unrequested feature, and
partly overlaps with 13's `add_invitee` request anyway).

- Copies `${location.origin}${location.pathname}#/events/<eventId>` —
  deliberately reconstructed rather than `location.href` verbatim, so it
  never carries the page's own transient state (`?occurrence=<date>` on a
  recurring-event day view) into a link meant to mean "this event," not
  "this specific occurrence I happened to be looking at."
- A brief inline note under the button sets the right expectation instead
  of implying a bypass: "Whoever you send this to will need to log in with
  Discord and be a member of this server to see it." This is the one place
  worth being explicit, since the *DM* version of this same link never
  needed the caveat spelled out (the recipient got there by already being
  logged in and receiving a DM, so the precondition was implicit).
- No backend change. No new endpoint. The link is exactly what the outbox's
  own `eventLink()` helper (`cron/reminders.ts`) already builds and sends
  today; this just exposes the same construction to the organizer directly
  instead of only ever handing it to the bot to DM.

## What this deliberately isn't

A magic/token-bearing link that would let someone **not already invited**
land on the event and see it — that genuinely would be idea 9's security
surface (self-service access to something the recipient wasn't already
cleared for), and nothing here does that. If that turns out to be wanted
later — e.g. "let me invite someone by link who hasn't logged into the app
yet at all" — that's a materially different, bigger feature (a real grant
mechanism, an expiry, a way to revoke it) and should get its own spec
against idea 9's design, not be folded into this one after the fact.

## Tests

None needed beyond typecheck/build — this is a `navigator.clipboard`
call and two string-concatenation branches, not new logic with edge cases
worth a dedicated test.
