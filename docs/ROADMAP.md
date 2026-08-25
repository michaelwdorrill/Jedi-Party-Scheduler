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

### Phase 3 — Calendar-first (ideas 5, 16, 15) → **v0.3** ✅ shipped

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
  and server reduced to a label/filter. The boundary that does *not* move:
  server stays load-bearing for invitation. **The free/busy-only server
  browse was deliberately left out of v0.3** — it shows events you are *not*
  invited to, which is a privacy-relevant design call rather than a layout
  one. Since rescoped upward into the **server noticeboard** (titles and
  attendee lists, not anonymous busy blocks); the four design calls are
  locked and written down in `specs/0007-server-noticeboard.md`, but it is
  unscheduled and blocked on a Privacy Policy rewrite. Still open in
  `IDEAS.md`, so it still counts against 1.0.
- **16, group creator membership.** Auto-seed the creator, backfill existing
  groups, ownership transfer on self-removal, and the owner/member split
  (owner adds-removes-renames-deletes; any member can create events for the
  group). Small, and it fixes the production symptom that surfaced it.
- **15, admin user-list gaps.** Telling "never a member" apart from
  "departed", and "logged in" from "was turned away at login". Small, and it
  belongs with the other "the app should say what it means" work.

### Phase 3.5 — Visual design pass (ideas 8, 20) → **v0.4** ✅ shipped

**Spec:** `specs/0009-binary-sunset.md` (Ready). The three pitches in
`specs/0008` were all rejected as insufficiently distinctive; the direction
that replaced them takes the app's own name as the brief — a Tatooine palette
and material system — and resolves pitch B vs pitch C by keeping **both** the
month grid and the agenda as views you swap between. That also settles idea
20's mobile question, which its entry called the real cost of the change.
The desert ships turned up: **full homestead is the default**, with a Settings
toggle to a calmer twin-suns treatment for anyone who wants it quieter. v0.4
touches no schema — both preferences live in local storage. A small amount of
motion rides along (a login hero, a twin-suns loading primitive replacing seven
ad-hoc `Loading…` strings, and one ambient detail), all of it behind
`prefers-reduced-motion`.

Styles the set of views that survived Phase 3. Rule 3 above is the whole
argument for this ordering — doing it first means paying for it twice.

Idea 8 is also the one item on this roadmap that wants *options* rather than
a spec: pitches to choose between, then a spec for the chosen one.

**Idea 20 (merge the Dashboard into the Calendar) rides along with it, and
deliberately isn't its own phase.** The itinerary becomes a right sidebar
beside the calendar instead of a separate tab. It needs no worker work at
all — after idea 5 both pages already call the same `GET /me/events` — so
it is purely a question of layout, which is what this phase is for. Keeping
it separate would mean designing the landing page once for the pass and
again for the merge, i.e. the same double-payment Rule 3 exists to avoid.
The design pitches should therefore assume the merged landing page rather
than the current two-tab split.

The open calls for idea 20 (whether the sidebar follows the calendar or
stays anchored to now, what happens on mobile, where the header and action
buttons live) are layout calls, so they get answered *by* the chosen pitch
rather than before it.

### Phase 3.6 — What v0.4 turned up (ideas 24, 26, 25, 23, 27, 28) → **v0.4.1** ✅ shipped

No spec. Six items captured *during* v0.4 — four of them found by building
and verifying it, which is the sandbox working as intended — and they are
here rather than at the back of the queue because this roadmap's own rules
put them here:

- **Rule 2 (cheap and already-understood ships immediately)** covers 26, 25,
  27 and 28. None of them had a design question left in them: 26's had been
  argued out in `IDEAS.md` down to which of two fixes and why, and 27 and 28
  arrived with their calls already made (opacity not strike; warn not block).
  These are exactly the class of item that otherwise sits in a backlog for a
  year.
- **Rule 1 (anything that changes how we ship comes before the things it
  would ship)** covers 23 and 24. 23 is a gap in the promotion path itself.
  24 is the app's ability to tell you it is broken — and v0.5 adds a whole
  new inbound surface to be broken. Shipping that on a frontend that reports
  every failure as an empty calendar means debugging it the same expensive
  way 24 was found in the first place.

The two halves that turned out to be one item are worth recording, because
they are why this shipped as one release rather than six errands. **24 and 26
are the same bug seen from both ends**: the organiser's RSVP returned a 403,
and the client swallowed it, so the buttons looked inert rather than refused.
Fixing either alone leaves the other looking like a different bug.

What actually cost the time was neither of the headline fixes but 26's
*audit*. A real `event_invites` row for the organiser touched every
`... UNION SELECT <organizer>` that had been folding them in by hand — one of
which would have overridden a decline — plus a vote threshold that had been
counting them against spec 0003, plus an invite sweep that would have DM'd
every organiser about every event they had ever run the moment the backfill
landed. The lesson for scheduling, not just for this item: "give it a row"
was a one-line change with a day of consequences, and the consequences were
all in code that had been written *around* the row's absence.

**23 is only half-done and stays open.** Its free third option shipped — the
rule is now written down in CLAUDE.md — but the two real fixes (a sandbox
Pages project, or a downloadable preview bundle from CI) are still
undecided, and the underlying gap is unchanged: there is still no branch you
can push a frontend change to and have anything happen.

### Phase 3.7 — The project's own machinery (ideas 29, 30, 31) → **v0.4.2** ✅ shipped

No spec; docs and CI only, no worker code and no schema. Placed ahead of v0.5
by **Rule 1** — anything that changes how we ship comes before the things it
would ship — and v0.5 is the release that most needs the shipping route to be
trustworthy, since it adds a public inbound endpoint whose verification loop
runs entirely through the sandbox.

- **31, the advisory that could never pass.** It asked the Deployments API for
  `sha=github.sha`, the merge commit — a commit that by construction never
  existed when the sandbox was deployed from a feature branch's head. It now
  compares the `worker/` **subtree hash** instead, which is immune to merge
  commits, rebases and squashes, and ignores frontend and docs commits that
  landed on `main` in between. Checked against the case that produced the
  entry: v0.4.1's `692eb89` and its merge `ec8b33d` share a `worker/` tree, so
  the new predicate matches where the old one warned.
- **30, drift nobody reported.** Both workflows now say it out loud. The
  production deploy reports how far `sandbox` is behind the release; the
  sandbox deploy reports how far the branch it is building is behind `main`
  and how many of those commits touch `worker/`. The second is the one worth
  having, because it fires *before* a verification session rather than after.
  Fast-forwarding `sandbox` from the production workflow was considered and
  rejected: it would redeploy the sandbox out from under whatever feature is
  parked on it.
- **29, a backlog that never emptied.** `IDEAS.md` is now two sections, and
  the 1.0 test reads against **Still open** alone.

**The deployed app stays at 0.4.1, deliberately.** `APP_VERSION`,
`PUBLISHED_AT` and the changelog page are not bumped for this release,
because nothing in the app changed — no worker code, no frontend, no schema.
`lib/changelog.ts` says in its own header that it records *releases as users
experience them*, not commits, so a 0.4.2 entry there would be a version
stamp with an empty list under it. v0.4.2 is a release of the project's
machinery, and it is versioned here and in `IDEAS.md` rather than in the
app's footer.

The reason these three were worth a release rather than a spare afternoon is
the shape 31 turned out to have: it was not a check that was wrong, it was a
check that was *uninformative in a way nobody could point at*, and had been
since it was written. It fired identically on every release whether or not
the sandbox was used, which trains the reader to ignore it — and CLAUDE.md
had already written that training down as a discipline problem ("read it more
carefully") rather than a predicate problem. A guardrail that cannot fail
usefully is worse than no guardrail, because it costs attention and returns
nothing.

### Phase 3.8 — What watching someone else use it turned up (33, 34, 35) → **v0.4.3** ✅ shipped

No spec. Three items captured in one sitting from watching a friend use the
app, which is a different source from every other phase here — the security
review cycle, or building the previous release. All three were small and
already understood, which is Rule 2.

- **34, groups visible to a whole server.** The decided strict option: you see
  only the groups you are in. `GET /guilds/:guildId/groups` was deleted rather
  than restricted, since with the invitee picker reading `/me/groups` it had no
  callers left. **The behaviour change to know about: an organizer can no
  longer invite a group they are not part of.** That is the same leak from the
  other side, and the changelog says so in those words rather than calling it
  "improved privacy".
- **33, the horizon.** A regression, not a wish: `4a0ee7e` reused the
  `.uo-ground` and `.uo-vaporators` declaration blocks for other classes while
  the markup kept the old names, so both silently became `position: static` and
  rendered at the top of the sky layer for two releases. Fixed by merging them
  into one `.uo-horizon` — two viewBoxes stretched independently could only
  line up at one aspect ratio, so restoring the rules alone would not have
  fixed the complaint.
- **35, avatars.** Frontend-only: the hash was already stored, already
  returned, already typed. Nothing rendered it.
- **38, the seed that could only run once.** Found while trying to verify 34
  with a group the tester was not in. `npm run seed:sandbox` failed on a bare
  foreign-key error, because the seed group is configured to make the idle
  sweep fire and `group_nudge_log` does not cascade from `groups` — so the
  first run's *success* is what made the second impossible. Not planned into
  this release; it was in the way of testing it.

**What this phase is really evidence for.** Every one of these was found by a
person using the app rather than by a review pass or a test, and 33 had been
live and wrong since v0.4 without anyone noticing. That is an argument for
item 23 (there is still no way to put a frontend change in front of anyone but
Michael) and, more cheaply, for watching someone else use it more often.

### Phase 3.9 — Consent that means something (idea 37) → **v0.4.4** ✅ shipped

**Spec:** `specs/0012-policy-reacceptance.md` (Built).

Rule 1 again, applied to policy rather than to code: nothing in the app
recorded agreement to anything, so any of the three scheduled items that
rewrite the Privacy Policy — 0007, 0011, and **v0.5**, whose interactions
endpoint falsifies the current promise that the bot "only sends direct
messages" — would have shipped a materially different policy to people who had
only ever agreed to the previous one, with no mechanism to notice.

Two things worth carrying forward:

- **The bump self-executes.** `sessions.policy_version` records the version in
  force when a session was issued; `isSessionActive` requires it to match. So
  a bump invalidates every outstanding session lazily, on each holder's next
  request, with no mass write and no deploy step. The alternative — an
  `UPDATE sessions` fired by something a person has to remember — is the class
  of manual step `specs/0002` exists to remove.
- **It shipped dormant**, at version 1 with matching defaults. Logging out the
  whole user base to agree to a policy that had not changed would have taught
  people to click through the screen before the first time it meant anything —
  the same lesson item 31 cost, in a different costume.

### Phase 3.75 — An interactive bot (idea 19) → **v0.5** ← next

**Spec:** `specs/0010-interactive-bot.md` (Draft). It scopes v0.5 down to the
endpoint, the three response widgets, the edit-on-resolve and embeds on the
DMs that gain components — and pushes slash commands and Discord Scheduled
Events sync out to specs of their own, on the grounds that each is a separate
surface with its own permission model rather than a detail of this one. It
also absorbs idea 32: the sent message's id is discarded today, so
edit-on-resolve carries a migration and a cross-application editability rule
that idea 19's capture assumed away.

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

**v1.0 is defined by the backlog, not by a feature set: when `IDEAS.md`'s
"Still open" section is empty, we leave Beta.** (Until v0.4.2 that read
"when `IDEAS.md` is empty", and since nothing ever cleared the file, the one
test 1.0 is defined by could not pass — item 29.) That deliberately makes 1.0 a moving target — new
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
| **0.2** | Phase 2 — invitee change requests, poll date consistency, invite links; plus the dependency upgrades and the version stamp | Shipped 22 Aug 2026 |
| **0.3** | Phase 3 — calendar-first (5), group creator membership (16), admin list gaps (15), changelog page | **Shipped 22 Aug 2026** |
| **0.4** | Phase 3.5 — visual design pass (8), Dashboard/Calendar merged into one landing page (20) | **Shipped 23 Aug 2026** |
| **0.4.1** | Phase 3.6 — error states (24), organizer RSVP (26), CI action majors (25), the sandbox-frontend rule written down (23, partial), past events faded (27), past-date warning (28) | **Shipped 24 Aug 2026** |
| **0.4.2** | Phase 3.7 — the sandbox advisory made meaningful (31), sandbox drift reported (30), `IDEAS.md` split into open and built (29). Repo only: the deployed app stays 0.4.1 | **Shipped 25 Aug 2026** |
| **0.4.3** | Phase 3.8 — group visibility restricted to members (34), the horizon re-pinned (33), Discord avatars (35) | **Shipped 25 Aug 2026** |
| **0.4.4** | Phase 3.9 — Policy/Terms re-acceptance (37) | **Shipped 25 Aug 2026** |
| 0.5 | Interactive bot (19), and the message-id cost it turned out to carry (32) | Planned |
| 0.6 | Self-service bot add + email (9), stale-account purge (10) | Planned |
| 0.7 | Google Calendar sync (2) | Planned |
| 1.0 | `IDEAS.md`'s **Still open** section empty — leave Beta | When the list clears |

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
| 5 | Calendar-first, not server-first | L | 3 | 0.3 | — | 0006 |
| 16 | Group creator membership + roles | M | 3 | 0.3 | — | none needed |
| 15 | Admin list: departed vs never-member | S | 3 | 0.3 | — | none needed |
| 8 | Visual design pass | L | 3.5 | 0.4 | 5 | 0009 (0008 superseded) |
| 20 | Merge Dashboard into Calendar | M | 3.5 | 0.4 | 5 | 0009 (0008 superseded) |
| 19 | Interactive bot (RSVP, slash, sync) | L | 3.75 | 0.5 | 8 | TBD |
| 9 | Self-service bot add + email | L | 4 | 0.6 | — | TBD |
| 10 | Stale-account auto-delete | M | 4 | 0.6 | — | TBD |
| 2 | Google Calendar sync | XL | 5 | 0.7 | 1, 5, 10 | TBD |
| 21 | Calendar chip click opens New Event | S | 3.5 | 0.4 | — | 0009 — done |
| 22 | Calendar can only show 2 months | M | — | — | — | deferred out of 0009 |
| 24 | A failed API call renders as "nothing scheduled" | M | 3.6 | 0.4.1 | — | none needed |
| 26 | Organizer gets a 403 from their own RSVP buttons | M | 3.6 | 0.4.1 | 24 | none needed |
| 25 | CI actions on a deprecated Node runtime | XS | 3.6 | 0.4.1 | — | none needed |
| 23 | No sandbox frontend (rule written down only) | S | 3.6 | 0.4.1 | — | still open |
| 27 | Fade events that have already happened | XS | 3.6 | 0.4.1 | — | none needed |
| 28 | Warn on an event created in the past | XS | 3.6 | 0.4.1 | — | none needed |
| 29 | `IDEAS.md` never marked shipped items | S | 3.7 | 0.4.2 | — | none needed |
| 30 | Sandbox/`main` drift goes unreported | S | 3.7 | 0.4.2 | — | none needed |
| 31 | Sandbox advisory can never pass | S | 3.7 | 0.4.2 | 30 | none needed |
| 32 | `sendBotDm` discards the sent message id | S | 3.75 | 0.5 | 19 | in 19's spec |
| 33 | Ground and vaporators unpinned since v0.4 | S | 3.8 | 0.4.3 | — | none needed |
| 35 | Discord avatars where people are listed | S | 3.8 | 0.4.3 | — | none needed |
| 34 | Groups are visible to server members who aren't in them | S | 3.8 | 0.4.3 | — | none needed |
| 38 | Sandbox seed could not be re-run (its own cron broke it) | S | 3.8 | 0.4.3 | — | none needed |
| 39 | Availability grid shows one candidate, fixed 8am-2am | M | — | — | — | TBD |
| 40 | Candidate polls and window polls merged into windowed candidates | L | — | — | 39 | TBD |
| 41 | Polls render on their deadline, not their candidate days | M | — | — | — | TBD |
| 42 | Month chips show the time and truncate the title away | S | — | — | — | none needed |
| 43 | Nothing guards CURRENT_POLICY_VERSION against an accidental bump | S | — | — | 37 | TBD |
| 36 | Groups server-agnostic, valid on a shared server (intersection rule) | M | — | — | 5, 34, 37 | 0011 |
| 37 | Re-agree to the Policy/Terms when they change | M | 3.9 | 0.4.4 | — | 0012 |

Ideas 15–19 were captured after this roadmap was first written and had never
been scheduled; they're placed above. Ideas 21 and 22 were found while writing
the v0.4 pitches: 21 is a live bug that all three pitches force a fix for, so
it rides along in 0.4; 22 is a behaviour change rather than a design one and is
deliberately left unscheduled. 17 and 18 are struck through as done.

Ideas 23–28 were all captured during v0.4 and are placed in Phase 3.6 above,
with the argument for putting them ahead of v0.5 rather than behind it. Three
notes on that placement:

- **23 ships partially and stays open.** Only its free third option (write the
  rule down) is done; the gap itself is undecided. It still counts against 1.0.
- **22 remains unscheduled**, and this is now the second release it has sat
  out. It is a real constraint — you cannot look at a month more than one
  ahead — but it is a behaviour change with a cost (`GET /me/events` is bounded
  by `MAX_QUERY_RANGE_MS`, and the two-month window is what makes the landing
  page one query), so it wants a spec rather than a slot.
- **Ideas 29-31 shipped as v0.4.2**, in Phase 3.7 above. They were captured
  here as unscheduled and "not blocking v0.5"; Rule 1 moved them in front of
  it anyway, and 30 and 31 were indeed cheaper together, being the same
  surface.
- **Ideas 32-35 were captured after v0.4.2 and are placed as follows.** 32
  (the sent DM's message id is discarded, so idea 19's "edit the original
  message" sub-item is not the cheap one it is written up as) is not its own
  item at all — it is a cost inside v0.5, and belongs in idea 19's spec rather
  than in a phase. 33 and 35 are both small, frontend-only and
  already-understood, which is Rule 2, so they get a phase of their own rather
  than a queue position: **Phase 3.8**, to ride whichever release is next
  through the frontend. 34 is the one that does not place itself — see below.

- **Phase 3.8 shipped as v0.4.3**, and the note it was placed with holds up:
  33 and 35 were both small and already understood, which is Rule 2. Worth
  recording that 33 was *not* the one-line CSS restore its capture implied —
  the two SVGs had to be merged, because independently stretched viewBoxes can
  only line up at one aspect ratio.

- **34 shipped in v0.4.3** as the strict option: you see only the groups you
  are in. Chosen over consistency with `specs/0007-server-noticeboard.md` on
  the grounds that 0007's noticeboard argument is about *events* — things that
  happen at a time — and a group roster is a list of people. It restricted
  inviting as well as viewing, exactly as flagged: the New Event form's invitee
  picker was fed by `GET /guilds/:id/groups`, which is now deleted, so an
  organizer can no longer invite a group they are not part of. The changelog
  says that in plain words.

- **36 is the same question asked properly, and its rule is now decided.** A
  group becomes a list of people, valid when there exists at least one server
  containing *every* member — the **intersection rule**. That is stronger than
  the "pairwise" it was asked for, and for the reason pairwise was asked for:
  pairwise lets A–B, B–C and A–C each share a different server, leaving no
  server all three are in and therefore no voice channel they can all join.
  Since the event's guild is the venue people actually click through to,
  "where is everyone playing" is the requirement, and the intersection rule is
  its literal statement. It is also cheaper to check than pairwise, and it has
  a repair story pairwise lacks: a group with no common server has no venue,
  which can be shown and blocked on, rather than requiring the app to eject
  somebody.

  **`events.guild_id` stays `NOT NULL`; only groups lose theirs.** An earlier
  reading of this had the event's guild becoming nullable and therefore
  colliding with `specs/0007-server-noticeboard.md`'s premise, making 36
  urgent to decide before 0007 was built. That was wrong, and correcting it
  removes the sequencing pressure: the venue is always a server every member
  is in, so all five things the event's guild holds up survive untouched.
  36 is a group-side change plus one intersection check, and 0007 is not
  blocked by it. Four small calls remain open (which server when several
  qualify, what happens when someone leaves the venue afterwards, whether a
  departed member is dropped from the event or the group, and whether leaving
  a server still revokes your view of its events) — they want a spec, after
  v0.5.

- **37 is a Rule 1 item, is now fully decided, and should go in front of the
  two specs that need it.** Nothing in the app records agreement to anything: there is no policy
  version server-side, no acceptance column, and login is the implicit
  consent. Both `specs/0007` and `specs/0011` rewrite the Privacy Policy, so
  either would ship a materially different policy to people who agreed to the
  old one with no mechanism to notice. That is the same argument Phase 3.7
  made for the sandbox guardrails, applied to policy instead of code — which
  means it wants a slot before the noticeboard or the group model, not after
  them. All four of its open calls were settled in Aug 2026, and
  `specs/0012-policy-reacceptance.md` writes them up. **v0.5 is one of the
  releases that needs it**, not just 0007 and 0011: `specs/0010`'s
  interactions endpoint falsifies the Privacy Policy's current promise that
  the bot "only sends direct messages", since it starts receiving button
  presses and editing its own messages. So 37 goes in front of the
  interactive bot, whichever order the rest take.

- **39 and 40 were found using the app to run a real poll**, which is the
  third distinct source of backlog items after the security-review cycle and
  building the previous release. 39 is a bug with two halves (the grid shows
  only the first candidate, and a fixed 8am-2am slice of it); 40 is a model
  change that makes today's two poll modes special cases of one general one —
  a candidate that is a window, with a minimum duration. **40 subsumes 39**,
  so 39 is not wasted work done first, and 40 without it would ship a mode
  nobody can read. Both want scheduling against v0.5 rather than ahead of it,
  since neither changes how we ship.

- **41 and 42 came from the same session as 39 and 40** — using the app to
  run a real poll and then looking at the month it produced. 42 is the
  cheapest item on this list (a one-line chip that spends its whole width on
  the time, so every event in a month looks the same) and is worth taking
  whenever the frontend is next open. 41 is a genuine gap rather than a
  styling one: an unresolved poll is rendered on the day *voting closes*, and
  the candidate days it proposes appear nowhere, so the content of the poll is
  invisible on the calendar. Its design cost is fan-out, not appearance —
  twenty candidates could bury a month's real events under one poll's maybes.

- **The tail did not shift.** v0.4.1 is inserted, not substituted: 0.5 through
  0.7 keep their contents. That is the roadmap behaving as designed — a new
  idea gets a phase like everything else — but it is worth saying plainly,
  because six new items landing in one release cycle is also the mechanism by
  which 1.0 keeps moving away.

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
