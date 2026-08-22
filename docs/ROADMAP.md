# Roadmap

`IDEAS.md` is the capture surface — things get written down there the moment
they're thought of, unordered and undesigned, so they aren't lost. This file
is the ordering surface: which of those fourteen ideas we do, in what order,
and why that order rather than another. `specs/` is the third surface, where
an item that's about to be built gets designed properly.

An idea moves left to right: **captured** (`IDEAS.md`) → **scheduled** (a
phase here) → **specced** (`specs/NNNN-*.md`) → **built**. Nothing gets built
from `IDEAS.md` directly; a one-paragraph capture is not a design, and the
gap between those two is where most of the cost lives.

## What decides the order

Four rules, in priority order. They're written down because "what should we
do next" otherwise gets re-litigated every session, and usually answered with
whatever is freshest.

1. **Anything that changes how we ship comes before the things it would ship.**
   The sandbox (idea 1) and a real promotion path (idea 14) are worth less the
   later they land, because their entire value is in the changes that go
   through them. Building them after the large features means the large
   features were the ones that didn't get the benefit.

2. **Cheap and already-understood ships immediately.** Ideas 4, 7, 11 and 12
   are small, self-contained, and have no design questions left in them. They
   gain nothing from waiting, and they're exactly the class of item that
   quietly sits in a backlog for a year. Doing them first also keeps the
   backlog honest: what's left is genuinely the hard stuff.

3. **What decides a surface comes before what decorates it.** The calendar
   landing view (idea 5) changes the app's navigation model — which views
   exist and what you land on. The visual design pass (idea 8) styles whatever
   views exist. Doing 8 first means paying for it twice.

4. **A new dependency is paid for once, so group what needs it.** Outbound
   email doesn't exist anywhere in the Worker today; ideas 9 and 10 both want
   it. Google OAuth doesn't exist either, and only idea 2 wants it — which is
   part of why idea 2 is last.

## The phases

Phases are ordered, but not gated on each other except where a dependency is
called out. Nothing here is date-estimated; sizes are relative effort, not a
schedule.

### Phase 0 — Quick wins (ideas 4, 12, 7, 11)

**Spec:** `specs/0001-quick-wins.md`

Four small, independent changes with no schema work and no new subsystem:
Sunday-first calendar weeks, a client-side guard against an end before a
start, a server picker on the New Event form, and the owner-only list of
signed-up users. Ships as one branch of four commits, or four branches — they
don't interact.

The only one with a trap in it is the week-start change, and the spec says so:
the stored weekday encoding (`0=Mon..6=Sun`, in `event_recurrence_rules.by_weekday`)
must not move when the display order does.

### Phase 1 — Sandbox and promotion (ideas 1, 14)

**Spec:** `specs/0002-sandbox-and-promotion.md`

A second Worker + D1 (+ Discord application) to build against, and a promotion
path from it to production that doesn't depend on anyone remembering a manual
step. These are one piece of work, not two: a sandbox without a seamless
promotion path is a sandbox you skip when you're busy.

Everything from Phase 2 onward touches either the schema, the notification
outbox, or a new OAuth surface. Those are the changes we'd rather not first
observe in production — and per SETUP.md's drift section, the failure mode
we've actually hit is not "the deploy errored", it's "the deploy reported
success against a database that didn't match the code".

### Phase 2 — Features on the model we already have (ideas 13, 6, 3)

**Spec:** `specs/0003-event-change-requests.md` (idea 13). Ideas 6 and 3 get
specced when Phase 2 starts.

Three user-facing features that need no new infrastructure — they extend the
event/invite/notification model that already exists:

- **13, change requests.** The largest of the three and the most valuable:
  today an invitee's only way to push back on a time is to decline, which
  throws away the useful half of the answer.
- **6, poll date/time consistency.** Fixed-time events let you set separate
  start and end dates; the two poll creation paths don't. Cheaper than 13 and
  independent of it — worth slotting in whenever it fits.
- **3, event-specific invite links.** Gives the organizer something to paste
  themselves instead of the bot DMing a link that reads as a scam. Held until
  13 shipped on the theory that 13's "invite this person" request might cover
  most of it. Resolved, per `specs/0005`: they solve different problems (13 is
  *who* can be invited, 3 is *how* an already-invited person gets a link) and
  3 is still worth doing — but much smaller than assumed, since a plain
  `#/events/:id` link is already gated by the same visibility check regardless
  of how someone arrives at it, so this needed no new grant mechanism and none
  of idea 9's security surface after all. Shipped as a "copy invite link"
  button, no backend change.

### Phase 3 — Shape, then paint (ideas 5, 8)

The calendar landing view (5) settles which views exist and what the app opens
on, including the free/busy-only server view — which is a privacy-relevant
call, not just a layout one, and should be designed against
`lib/freeBusy.ts`'s existing guarantees rather than around them. The visual
design pass (8) then styles the set of views that survived. Rule 3 above is
the whole argument for this ordering.

Idea 8 is also the one item here that wants *options* rather than a spec —
pitches to choose between, then a spec for the chosen one.

### Phase 4 — Growth and lifecycle (ideas 9, 10)

Both are operational rather than user-requested, and both are best done once
the app is something we're happy to show people — which is what Phase 3
delivers.

- **9, self-service bot add with owner approval**, brings the outbound email
  path with it. That's the real cost of the item; build it as its own
  reviewable piece rather than as a detail of the approval flow.
- **10, stale-account purge**, needs no email (it warns by DM, which we
  already do) but does need `users.last_login_at` sweeping on the existing
  cron — and every new sweep draws on the same per-tick budget as
  notifications, so it gets designed against `cron/budget.ts` and
  `cron/cursor.ts` like every other scan.

Sequenced 9 then 10, but they're independent; 10 can go earlier if the sweep
work looks cheap.

### Phase 5 — Google Calendar sync (idea 2)

The biggest lift, and deliberately last. It wants a second OAuth provider,
a second set of refreshable tokens to store securely (note that we currently
store *no* long-lived third-party tokens — ARCHITECTURE.md's auth section
treats discarding Discord's tokens as a feature, and this reverses that), a
sync and conflict model, and a Privacy Policy revision covering which
calendar, which direction, and what Google sees.

It benefits from every earlier phase: the sandbox to develop an OAuth flow
against, the settled navigation to hang a "connected calendars" surface off,
and idea 10's purge so a sync doesn't quietly run forever for someone who
stopped using the site.

## Summary

| # | Idea | Size | Phase | Depends on | Spec |
|---|---|---|---|---|---|
| 4 | Sunday-first calendar weeks | XS | 0 | — | 0001 |
| 12 | Block end-before-start in the form | S | 0 | — | 0001 |
| 7 | Server picker on New Event | S | 0 | — | 0001 |
| 11 | Owner-only list of all users | S | 0 | — | 0001 |
| 1 | Sandbox/staging environment | M | 1 | — | 0002 |
| 14 | Seamless sandbox → prod promotion | M | 1 | 1 | 0002 |
| 13 | Invitee change requests | L | 2 | — | 0003 |
| 6 | Poll date/time consistency | M | 2 | — | 0004 |
| 3 | Event-specific invite links | S | 2 | 13 (scoped down after) | 0005 |
| 5 | Calendar landing view | L | 3 | — | TBD |
| 8 | Visual design pass | L | 3 | 5 | pitches first |
| 9 | Self-service bot add + email | L | 4 | — | TBD |
| 10 | Stale-account auto-delete | M | 4 | — | TBD |
| 2 | Google Calendar sync | XL | 5 | 1, 5, 10 | TBD |

## Things this roadmap is not

- **Not a commitment to build all fourteen.** Phase 2's idea 3 is explicitly
  contingent on what idea 13 turns out to cover. Phase 5 is large enough that
  "we decided not to" remains a legitimate outcome.
- **Not a freeze on the security-review cycle.** Passes 3–10 produced most of
  what's in `IDEAS.md`; if a pass surfaces something with a security
  consequence, it jumps the queue rather than joining the back of it.
- **Not a substitute for `SETUP.md`.** Anything here that touches deploys,
  secrets or migrations has to keep that document true — particularly the
  never-edit-an-applied-migration rule, which Phase 1 makes twice as easy to
  get wrong now that there are two databases to be in sync with.
