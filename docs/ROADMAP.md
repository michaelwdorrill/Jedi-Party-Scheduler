# Roadmap

`IDEAS.md` is the capture surface — things get written down there the moment
they're thought of, unordered and undesigned, so they aren't lost. This file
is the ordering surface: which of those captured ideas we do, in what order,
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

### Phase 3 — Calendar-first (ideas 5, 16, 15) → **v0.3**

The headline release, and the one that answers the loudest standing
complaint: the app is *too server-heavy*. Idea 5 was rescoped in Aug 2026
from "a landing view" to "an organizing principle" — see its entry in
`IDEAS.md` for why a view change alone can't deliver it (there is no
cross-guild event query in the app at all; `GET /guilds/:guildId/events` is
the only one there is).

The three items ship together because they're all "the app stops making you
think about servers":

- **5, calendar-first.** A new `GET /me/events`, the calendar as the landing
  page, the guild switcher demoted from global nav to a contextual control,
  and server reduced to a label/filter. Includes the free/busy-only server
  browse — a privacy-relevant call, not just a layout one, designed against
  `lib/freeBusy.ts`'s existing guarantees rather than around them. The
  boundary that does *not* move: server stays load-bearing for invitation.
- **16, group creator membership.** Auto-seed the creator, backfill existing
  groups, ownership transfer on self-removal, and the owner/member split
  (owner adds-removes-renames-deletes; any member can create events for the
  group). Small, and it fixes the production symptom that surfaced it.
- **15, admin user-list gaps.** Telling "never a member" apart from
  "departed", and "logged in" from "was turned away at login". Small, and it
  belongs with the other "the app should say what it means" work.

### Phase 3.5 — Visual design pass (idea 8) → **v0.4**

Styles the set of views that survived Phase 3. Rule 3 above is the whole
argument for this ordering — doing it first means paying for it twice.

Idea 8 is also the one item on this roadmap that wants *options* rather than
a spec: pitches to choose between, then a spec for the chosen one.

### Phase 3.75 — An interactive bot (idea 19) → **v0.5**

One new inbound surface (a Discord interactions endpoint) turns the bot from
a megaphone into something you can answer. Sequenced after the design pass
because the in-Discord flows should mirror a settled in-app model, not a
moving one — and because the "DMs read like spam" problem it partly addresses
is also being addressed from the other side by rich embeds and idea 3's
invite link.

### Phase 4 — Growth and lifecycle (ideas 9, 10) → **v0.6**

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

### Phase 5 — Google Calendar sync (idea 2) → **v0.7**

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

Scoped down in Aug 2026 (see idea 2 in `IDEAS.md`): **push first, pull
second**, pull via `freebusy.query` rather than full event read, event titles
explicitly out of scope for the first build, and the 100-user unverified-app
ceiling accepted rather than designed around.

## Versions

The app entered **Beta at v0.2**, the moment there was a written backlog
being worked through rather than a pile of unsorted intentions.

**v1.0 is defined by the backlog, not by a feature set: when `IDEAS.md` is
empty, we leave Beta.** That deliberately makes 1.0 a moving target — new
ideas get captured all the time, and each one pushes 1.0 out. That's the
intended behaviour, not a flaw in the definition: shipping 1.0 should mean
"there is nothing captured that we still intend to build", and the honest way
to reach it is to keep clearing the list rather than to freeze it.

The version numbers below are therefore a *plan*, not a promise. If a new
idea lands in the middle, it gets a phase like everything else and the tail
shifts.

| Version | Contents | Status |
|---|---|---|
| 0.1 | Everything up to and including the sandbox and promotion guardrails (Phases 0–1) | Shipped |
| **0.2** | Phase 2 — invitee change requests, poll date consistency, invite links; plus the dependency upgrades and the version stamp | **Shipped 22 Aug 2026** |
| 0.3 | Phase 3 — calendar-first (5), group creator membership (16), admin list gaps (15) | Next |
| 0.4 | Visual design pass (8) | Planned |
| 0.5 | Interactive bot (19) | Planned |
| 0.6 | Self-service bot add + email (9), stale-account purge (10) | Planned |
| 0.7 | Google Calendar sync (2) | Planned |
| 1.0 | `IDEAS.md` empty — leave Beta | When the list clears |

## Summary

| # | Idea | Size | Phase | Ver | Depends on | Spec |
|---|---|---|---|---|---|---|
| 4 | Sunday-first calendar weeks | XS | 0 | 0.1 | — | 0001 |
| 12 | Block end-before-start in the form | S | 0 | 0.1 | — | 0001 |
| 7 | Server picker on New Event | S | 0 | 0.1 | — | 0001 |
| 11 | Owner-only list of all users | S | 0 | 0.1 | — | 0001 |
| 1 | Sandbox/staging environment | M | 1 | 0.1 | — | 0002 |
| 14 | Seamless sandbox → prod promotion | M | 1 | 0.1 | 1 | 0002 |
| 13 | Invitee change requests | L | 2 | 0.2 | — | 0003 |
| 6 | Poll date/time consistency | M | 2 | 0.2 | — | 0004 |
| 3 | Event-specific invite links | S | 2 | 0.2 | 13 (scoped down after) | 0005 |
| 17 | Frontend dependency majors | M | 2 | 0.2 | — | none needed |
| 18 | Multi-day window slider labels | XS | 2 | 0.2 | 6 | none needed |
| 5 | Calendar-first, not server-first | L | 3 | 0.3 | — | TBD |
| 16 | Group creator membership + roles | M | 3 | 0.3 | — | TBD |
| 15 | Admin list: departed vs never-member | S | 3 | 0.3 | — | TBD |
| 8 | Visual design pass | L | 3.5 | 0.4 | 5 | pitches first |
| 19 | Interactive bot (RSVP, slash, sync) | L | 3.75 | 0.5 | 8 | TBD |
| 9 | Self-service bot add + email | L | 4 | 0.6 | — | TBD |
| 10 | Stale-account auto-delete | M | 4 | 0.6 | — | TBD |
| 2 | Google Calendar sync | XL | 5 | 0.7 | 1, 5, 10 | TBD |

Ideas 15–19 were captured after this roadmap was first written and had never
been scheduled; they're placed above. 17 and 18 are struck through as done.

## Things this roadmap is not

- **Not a commitment to build everything captured.** Phase 2's idea 3 was
  explicitly contingent on what idea 13 turned out to cover (it survived, but
  a third of its assumed size). Phase 5 is large enough that "we decided not
  to" remains a legitimate outcome. Deciding *not* to build something also
  clears it off `IDEAS.md`, and therefore also counts toward 1.0 — a backlog
  item can leave the list by being built or by being ruled out, as idea 19's
  channel-posting sub-item already was.
- **Not a freeze on the security-review cycle.** Passes 3–10 produced most of
  what's in `IDEAS.md`; if a pass surfaces something with a security
  consequence, it jumps the queue rather than joining the back of it.
- **Not a substitute for `SETUP.md`.** Anything here that touches deploys,
  secrets or migrations has to keep that document true — particularly the
  never-edit-an-applied-migration rule, which Phase 1 makes twice as easy to
  get wrong now that there are two databases to be in sync with.
