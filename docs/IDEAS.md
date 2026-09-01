# Future ideas (the capture surface)

Things written down the moment they're thought of, so they aren't lost —
mostly during the Pass-3/4 security review cycle and after. Deliberately not
designed or scoped here, just captured, and the numbering is chronological
rather than any kind of priority.

**Ordering lives in `ROADMAP.md`, and design in `specs/`.** An idea is
captured here, scheduled there, specced there, and only then built — a
paragraph in this file is not a design, and nothing should be built straight
out of it. Adding a new idea here does not require touching the roadmap; the
roadmap gets revisited between phases.

## How this file is kept

Two sections: **Still open**, and **Already built** below it. When something
ships, its entry is annotated with the version and moved down. It is not
deleted, because for several of these the most valuable part is the record of
a decision and *why the alternative was rejected* — which is worth more after
shipping than before.

That matters more than housekeeping usually does, because `ROADMAP.md`
defines 1.0 as "when `IDEAS.md` is empty, we leave Beta". For the first four
releases nothing ever cleared this file, so the one test 1.0 is defined by
could never pass, and the list read as roughly 25 open items when the real
number was closer to a dozen (item 29). **That test now reads against "Still
open" alone.**

Entries are headings rather than a numbered list, and that is deliberate: a
Markdown ordered list renumbers itself from its first item, so once entries
move between sections the numbers a reader sees stop being the numbers
`ROADMAP.md` and `specs/` refer to. The number in each heading is an
identity, not a position — it never changes and is never reused.

## Still open

### 52. The calendar chip never shows your own answer

Found verifying v0.6 on the sandbox (Michael, Aug 2026): declining a
fixed-time event's occurrence records correctly and the event page shows it,
but the calendar's month/agenda chip looks identical to an occurrence you
haven't answered or have accepted. `EventChip.tsx` only ever reads
`occurrence.status` (cancelled) and `occurrence.isProvisional` (an open
poll's candidate day) — it has never read `myRsvpStatus` at all, for any
event type, so this isn't a v0.6 regression: declining has never been visible
on the calendar, only on the event page itself.

It stood out now because specs/0014 made per-occurrence answers real and
independent for the first time — two occurrences of the same recurring event
can genuinely disagree, and the calendar is the one place you'd see both at
a glance, but currently can't. A cheap version: a third visual state
alongside cancelled/provisional, in the spirit of `EventChip`'s own comment
about composing states rather than adding shades ad hoc — options include a
dimmed/outlined treatment for `declined`, or nothing at all for `declined`
(since "I'm not going" arguably doesn't need a chip cluttering your own
calendar) with `tentative` getting the "maybe" dashed-outline treatment
`isProvisional` already uses.

### 2. Google Calendar sync

Pull a single chosen Google calendar (not all of them — e.g. just "D&D
Scheduling", not "Family" or "Fulham FC") in as read-only availability on
the Uncle Owen calendar, and push events the user is part of back out to
Google. Flagged as the biggest lift: real OAuth-with-Google plumbing, a
second set of tokens to store/refresh securely, a sync/conflict model, and a
new privacy surface (which calendar, which direction, what Google sees) that
the Privacy Policy would need to cover.

**Decided (Aug 2026), after considering and rejecting an .ics/webcal feed
as a cheaper substitute:** a subscription feed is read-only by
construction, so it cannot do the two-way sync that is the whole point
here — and Google refreshes external ICS feeds on its own schedule,
typically 12–24 hours, which is useless for a scheduling app where a
moved session has to propagate now. OAuth is the only route to the stated
goal. Three further calls made at the same time:
- **Build it in two halves.** Push first (Uncle Owen → Google): needs
  OAuth, but no incremental sync, no webhook channel renewal, no conflict
  model, and it delivers most of the felt value. Pull second.
- **Pull via `freebusy.query`, not full event read.** Scheduling only
  needs busy/free times, never titles — which is a narrower scope, a
  smaller privacy surface, and exactly the language `lib/freeBusy.ts`
  already speaks. Pulling event *titles* is wanted eventually but is
  explicitly out of scope for the first build.
- **The 100-user unverified-app cap is accepted.** Google requires app
  verification for the read/write `calendar` scope; unverified means a
  100-user ceiling and an "unverified app" warning screen. That's fine at
  this app's scale, and the Privacy Policy revision is accepted as part
  of the cost.

### 5. Calendar-first, not server-first — partly shipped in v0.3

(was: "calendar landing view"). Land on "just your calendar" with no
guild-switcher tab up front. Then offer views for: a specific server's
calendar (showing blocked/busy time even for events you're not invited to —
i.e. free/busy, not full detail), your personal events only, your Uncle Owen
game events only, and personal+game combined.

**Rescoped (Aug 2026) from a view change to an organizing-principle
change.** The stated pain is that the app is "too server heavy — people
shouldn't be thinking of this a server at a time." A landing view alone
doesn't fix that, because the server-scoping is structural: the *only*
event-listing endpoint is `GET /guilds/:guildId/events`, and
`CalendarPage` early-returns when no guild is selected. There is no
cross-guild "my events" query anywhere in the app.

The counterintuitive part, and the reason this is more tractable than it
sounds: **the cross-guild personal calendar is a cheaper query than the
per-guild one it replaces.** Today's asks for every event in a guild
(up to `MAX_ACTIVE_EVENTS_PER_GUILD`, whether or not you're involved);
the replacement asks for events you organize or are invited to, which is
bounded by your own invite rows. The expensive shape — "every event in
every guild I'm in" — is the *server browse* view, which stays opt-in and
keeps its existing per-guild bounds. (See `validate.ts`'s own warning
that per-guild quotas multiply: "'300 events' becomes 4,200 the moment
someone is in fourteen of them.")

What it takes: a new `GET /me/events?from=&to=` returning events across
every guild where you're still an active member, each carrying
`guildId`/`guildName`; the guild switcher demoted from global nav to a
contextual control; server becoming a label/filter rather than a mode.
The recurrence, override and RSVP loaders already take arbitrary event-id
lists rather than a guild, so they need no change.

**The boundary that must not move:** server stays load-bearing for
*invitation*. `filterActiveGuildMembers` is what stops an event on one
server pulling in someone you only share a different server with, and
relaxing that would be a real privacy regression. Servers stop mattering
for *viewing*; they keep mattering for *who you can add*.

**Built in v0.3** (`specs/0006-calendar-first.md`) — `GET /me/events` and
`GET /me/groups`, the calendar and dashboard spanning every server, server
demoted to a filter/label, and the top-bar switcher removed. **One piece
deliberately deferred:** the free/busy-only *server browse* ("see what
else is on in a server, without event detail"). It's a genuinely different
query with a privacy dimension -- it shows blocks for events you are not
invited to -- and belongs designed against `lib/freeBusy.ts`'s guarantees
rather than bolted onto the personal calendar. Still open.

**Rescoped again (Aug 2026), upward: not free/busy, a noticeboard.**
"If you're in a server, that's more public noticeboard type thing than
anything" -- so the browse view shows event *titles* and *who's going*,
not anonymous busy blocks. Four calls locked: visible by default with a
per-event private toggle; new events only, never retroactive;
descriptions stay hidden; invitees cannot hide themselves from the
attendee list. Design and the blockers (the Privacy Policy currently
promises the exact opposite) are in
`specs/0007-server-noticeboard.md`. Still open.

### 9. Self-service "add this bot to your server" link, gated by owner approval

A public page/link (distinct from the raw Discord OAuth bot-add URL, which
just adds the bot with no guardrail) that lets someone add the bot to their
own Discord server. If that server is already on the allow-list, it just
works. If it isn't, the request queues instead of silently granting access,
and the site owner gets an email to approve or reject it before the server
can actually use the app. Needs: an outbound email path (nothing in the
Worker sends email today — SETUP.md's contact address is just a mailto link
on the legal pages), a pending-request state in D1 distinct from the
existing `guilds` allow-list, and an approve/reject action (email link with
a signed token, or a page under `/admin`) that feeds the same allow-list
insert the manual `curl`/`wrangler d1 execute` step in SETUP.md does today.

### 10. Auto-delete accounts that have gone stale

If someone hasn't logged in for a year, warn them by DM at two weeks and one
week out, then purge them from the system if they still haven't logged back
in. Point of it: a synced integration (see idea 2, Google Calendar)
shouldn't quietly keep running forever for someone who's stopped using the
site. Needs: a last-login timestamp to sweep on (cron, same pattern as the
existing reminder sweeps), two new DM types, and reusing the
account-deletion path `SettingsPage.tsx`'s type-to-confirm delete already
exercises — minus the user initiating it. Worth deciding whether "logged in"
should also count as "used" for someone who stays signed in and never opens
the site, and whether organizing/being invited to a future event should
suppress the purge even if login is stale.


### 23. The sandbox has no frontend, so the sandbox-first rule has a blind spot for frontend-only changes — partly shipped in v0.4.1

`deploy-sandbox.yml` is worker-only — every step runs with
`working-directory: worker` — and `deploy-pages.yml` publishes the frontend
from `main` and nowhere else. So pushing a frontend-only branch to `sandbox`
deploys a Worker that didn't change and puts the actual diff nowhere anyone
can click.

`SETUP.md` and CLAUDE.md already say the intended route is
`VITE_API_BASE_URL=<sandbox worker url> npm run dev` locally, and for a
worker change that's clearly right — a second Pages deployment would be
cost for no benefit. But v0.4 is three branches of almost entirely
frontend work (`specs/0009`), which is the first time the gap really
bites: "verify it on the sandbox" turns into "run it on your own machine",
which only Michael can do, and which leaves no artifact anyone else can
look at.

Sharper than first written: `deploy-sandbox.yml`'s push trigger also
carries `paths: ['worker/**', '.github/workflows/deploy-sandbox.yml']`, so
a frontend-only push to `sandbox` is not merely unhelpful — it is a
complete no-op, and the Actions tab shows no run at all. That path filter
is *correct* (deploying an unchanged Worker achieves nothing), which is
what makes this a design gap rather than a bug: there is simply no branch
you can push a frontend change to and have anything happen.

Worth knowing alongside it: `ci.yml` runs on `push: branches: [main]` and
on `pull_request`, so a feature branch with no PR open gets no CI either.
A frontend branch therefore has *zero* automated verification until a PR
exists — which is fine if you know it, and misleading if you assume
pushing a branch ran something.

Found while pushing v0.4 branch 1. Worth deciding between:
- **A sandbox Pages project.** Cleanest, and makes "go look at it" a link
  rather than a local build. Cost is a second Pages deployment plus the
  env-parity surface that `check:env-parity` would want extending to.
- **A preview build artifact on CI.** Cheaper — upload `frontend/dist`
  from the existing CI run so any branch has something downloadable — but
  it's a static bundle with no API base URL baked in, so it needs one
  configured at build time to be useful.
- **Leave it, and make the rule explicit.** Say plainly in CLAUDE.md that
  frontend-only changes are verified locally, so nobody reads
  "sandbox-first" as promising something it can't do for them.

The third is free and should happen regardless of whether the first two do.

**Partially done** — the third option shipped in v0.4.1: CLAUDE.md now
says plainly that the sandbox is the Worker only, that a frontend-only
push to `sandbox` produces no workflow run at all, and that frontend
changes are verified locally against the deployed sandbox Worker. It also
records the two adjacent traps (no CI on a branch without a PR; a mixed
branch deploys its worker half only, which is the more confusing of the
two because something *does* run).

**This stays open.** Writing the rule down is not closing the gap — there
is still no branch you can push a frontend change to and have anything
happen, and the choice between a sandbox Pages project and a CI preview
bundle is still unmade.


### 36. Should a group be server-agnostic, requiring only that people share a server?

Asked (Aug 2026) alongside the decision on 34, and it is the more interesting
half: rather than a group belonging to one server, let a group be just a list
of people, with the rule that membership requires sharing a server.

**Why this is directionally right.** It finishes what idea 5 started. v0.3
made *viewing* server-agnostic (the calendar spans every server; the switcher
went away; server became a label). Idea 5's spec drew the boundary explicitly
and said which half was not moving: "server stays load-bearing for
*invitation*... Servers stop mattering for *viewing*; they keep mattering for
*who you can add*." This asks whether that half can move too, and the answer
is yes, provided the property being protected is stated correctly. The guild
is not a filing category — it is *proof that these people already know each
other*. `filterActiveGuildMembers` exists so that knowing a user's ID is not
enough to graft them onto a roster or DM them a private event's title.

**Decided (Aug 2026): the intersection rule.** A group is valid when there
exists at least one server containing *every* member. Michael chose "pairwise"
over the cheaper adder-anchored star, with the reason that settles the whole
design: *"otherwise where is everyone playing?"* — and that reason is worth
more than the rule it was given for, because **pairwise does not actually
deliver it**. Pairwise says every *pair* shares a server: A–B share X, B–C
share Y, A–C share Z satisfies it, and there is no server all three are in, so
there is no voice channel they can all join. The intersection rule is what
"where is everyone playing" means. It is strictly stronger than pairwise, and
it happens to be cheaper: one `GROUP BY guild_id HAVING COUNT(*) = <members>`
over `user_guild_membership` (already indexed `(user_id, is_member)`) instead
of n² pairs.

It also repairs the repair problem. Under pairwise, one person leaving one
server can invalidate a group with no sensible answer to which of twelve
people the app should eject. Under the intersection rule the group simply has
**no venue** — a state you can show, and block event creation on, without
ejecting anybody.

So: a group is a list of people, plus the invariant that their common-server
set is non-empty. An event picks its venue from that set.

**The plainest statement of what this buys, from the person who asked for
it:** *"If all 5 are on server A and B, that group should be selectable for
both servers."* Today it is selectable for exactly one — whichever server it
happened to be created on — because `groups.guild_id` is a single column and
the invitee picker filters by it. Under the intersection rule that group's
common-server set is {A, B} and it is offered for an event on either. That is
the concrete symptom to fix, and the sentence spec 0011 should be read
against.

**`events.guild_id` stays, and stays `NOT NULL`.** An earlier draft of this
entry framed it as "either it becomes nullable or a cross-server group's event
has to nominate a server, which puts the filter back", and concluded this had
to be decided before `specs/0007-server-noticeboard.md` was built. That was a
false choice. The event's guild is the *venue* — `voiceChannelLink(guildId,
channelId)` is `discord.com/channels/{guild}/{channel}`, the actual link
people click to go and play — and under the intersection rule the venue is
always a server every member is in. Only *groups* lose their `guild_id`.
That makes this item substantially smaller than first priced, and it means
0007 is not blocked by it.

**The five things `events.guild_id` holds up**, all of which survive:
1. **The venue** (`cron/reminders.ts`'s `voiceChannelLink`, and
   `fetchGuildVoiceChannels` for the picker).
2. **The invitation boundary** (`lib/eventWrites.ts` — direct invitees
   rejected, group-derived silently dropped).
3. **Control of the event** — `routes/events.ts` requires active guild
   membership to view one event, edit, cancel, add invitees or RSVP, *on top
   of* holding an invite row.
4. **Continuing visibility** — `lib/calendar.ts`'s `/me/events` predicate
   joins membership on `e.guild_id`, so leaving a server removes its events
   from your calendar even though the invite row survives. This is a
   deliberate revocation mechanism, not an accident of the query.
5. **Label, filter, and 0007's entire scope.**

**Still to decide, and each is small:**
- **More than one common server.** Who picks the venue? Leaning: the
  organizer, at creation, defaulting to the venue of the group's last event.
- **Someone leaves the venue server after the event exists.** Today they
  silently vanish from the event (role 4) and get no voice link. Leave it,
  auto-re-anchor to another common server, or warn the organizer? Leaning
  leave-it-and-warn: silently moving where people are meeting is worse than
  saying one person can't reach it.
- **A group member who left the venue server but still shares another.**
  Leaning: drop them from *that event* (matching today's silent drop for
  group-derived invitees), never from the group.
- **Does leaving a server still revoke your view of events you were invited
  to?** Today yes, deliberately. Leaning keep — and it stays coherent here,
  since every member is in the venue server at creation by construction.

**What changes in the code**, roughly: `groups.guild_id` goes away, along with
`assertValidGroupMemberTargets`'s "not current members of this server" check,
replaced by an intersection check over the proposed roster. `resolveInvitees`
keeps filtering group-derived invitees against the event's guild, which is now
redundant-but-stricter rather than the primary boundary. Both frontend group
surfaces lose their server picker. The Privacy Policy needs a pass: the
guarantee it can still make is that you are never in a group with someone you
share no server with — which the intersection rule preserves exactly, and
which the adder-anchored alternative would have lost.

**One genuinely nice property, worth noting because it is counterintuitive:
the membership *freshness* check gets cheaper, not dearer.** Today the event's
guild is fixed, so a stale cached row for that one guild must be revalidated
against Discord or the request is refused (`MembershipUnavailableError`, 20
live revalidations per request). Asking "which servers do all of these people
share" can be answered from whichever cached rows are fresh, and only needs a
live call when a candidate venue's rows are all stale.

Wants a spec — not for the rule, which is now decided, but for the four open
calls above and the migration. Not v0.5.

### 43. A constant that must only ever change deliberately has nothing stopping it changing by accident

Found the hard way, an hour after `specs/0012` was built (Aug 2026).
`CURRENT_POLICY_VERSION` was bumped to 2 as an uncommitted edit on a scratch
branch, `git checkout` carried the modified file across to the release
branch, and `git add -A` swept it into an unrelated commit — which was then
pushed. Merging it would have logged out every production user and put an
acceptance gate in front of them, for a policy that had not changed.

Caught by reading the diff afterwards rather than by anything automatic, and
that is the point: **the one change in this codebase whose entire design
principle is "this must never happen unintentionally" had nothing at all
guarding it.** The spec argued at length about not deriving the version from
a content hash, so that a typo fix would not log the world out — and then a
stray `git add` did exactly that.

The class of mistake matters more than the instance. Any constant whose
value is a *decision* rather than a fact — this one, `APP_VERSION`,
`PUBLISHED_AT` — can be changed by an editor, a merge or a sweep with no
signal at all, and the blast radius here is every session in production.

Options, roughly in order of cost:
- **A CI check on `main` pushes** asserting `CURRENT_POLICY_VERSION` matches
  a value recorded elsewhere (a lockfile-ish `policy.version` committed
  alongside), so changing it requires changing two files on purpose. Cheap,
  and it fails loudly at exactly the right moment.
- **A required note in the changelog.** If the version moved, the release
  must carry a changelog entry saying so — which is true of every legitimate
  bump anyway.
- **Nothing, and rely on review.** Rejected on the evidence: review is what
  just missed it.

Related to item 31's lesson from the other direction. There the guardrail
existed and could not fail usefully; here the guardrail does not exist at all
for the change most in need of one.

### 46. A reminder DM shows the buttons but not the answer already on record

Found by pressing them (v0.5, sandbox, Aug 2026). The invite DM was answered
"I'm in" at 5:45 and edited itself to say so. The 24-hour reminder for the
same event arrived at 6:30 carrying all three buttons and no indication that
an answer exists at all — so the only way to find out what you had said is to
press something and see what it changes to.

Offering the buttons again is *right*: a reminder is exactly when someone
changes their mind, and that was the argument for putting controls on
reminders in the first place. The gap is narrower than "don't show buttons"
— it is that the message states the event and the time and omits the one
fact the recipient already gave it.

Cheap version: the reminder's text carries the current answer ("You said:
I'm in") and the buttons stay as they are. The sweep already loads the
invite row it filters recipients on, so the status is in hand and needs no
extra query — worth confirming that claim against `pendingRecipients` before
building, since it selects users rather than invites.

Sharper version, and probably better: the *pressed* button is styled as the
current answer, so the DM shows state rather than describing it. Discord has
no "selected" style for buttons, so this means rebuilding the row with the
current answer's button disabled or relabelled ("✓ You're in"), which is
more code and a second thing to keep in step with `rsvp_status`.

Related to the edit-on-resolve work in `specs/0010`, which is the same shape
from the other end — a message whose controls should reflect state that has
moved since it was sent.

One half of this landed for polls without being aimed at it. Keeping the
controls after an answer (v0.5) meant the select had to be rebuilt, and a
rebuilt select can carry `default: true` on the picks — so a poll DM you
have answered *does* reopen showing what is on record. That only covers the
message you answered, though. A **new** reminder about the same poll is a
fresh send with a fresh select, and it still arrives blank. So the gap here
is unchanged for reminders, and buttons never had the mechanism at all.


### 48. Reminders should depend on whether you have answered

Asked for by Michael, Aug 2026, after pressing the v0.5 buttons: the app
sends everyone the same two reminders — 24 hours and 1 hour — whether they
accepted, said maybe, declined, or never answered at all. `pendingRecipients`
does not read `rsvp_status` in any form.

The proposal is a ladder: no answer gets nudged at 96 and 48 hours, a maybe
at 72 and 24, an accepted at 24 and 1, a decline gets nothing further. Each
rung carries only the controls that make sense from where the person is —
which is the part that makes item 46 fall out as a special case rather than
a separate fix.

Designing it turned up the thing underneath, and Michael decided it:
**attendance is per occurrence, not per event.** `notification_log` and
`event_occurrence_overrides` are both keyed per occurrence; `event_invites`
holds one `rsvp_status` per event. Nothing had forced those to agree because
nothing read attendance in the notification path. The ladder is the first
thing that does.

Fully specced in `specs/0014-attendance-per-occurrence.md`, including the two
calls that make it tractable: a multi-winner poll fans out into separate
events on confirmation, and a recurring event is accepted one occurrence at a
time with the next ladder starting 24 hours after the last session ends.

### 49. Everyone in an event should see everyone's answer, whatever kind of event it is

Asked for by Michael, Aug 2026, looking at a multi-winner poll showing "1 in"
and "2 in" per night with no way to find out who.

**Most of this is already true, which makes it much cheaper than it sounds.**
`GET /events/:eventId` returns `rsvpStatus` for every invitee to anyone
`loadEventIfVisible` lets through — the organizer and every invitee, gated on
active membership of the event's server. There is no permission change here
and no new privacy surface: the data is already shared with exactly the
people this asks for.

What blocks it is one expression in `EventDetailPage`:

```tsx
{event.eventType === 'single' ? inv.rsvpStatus : ''}
```

And that expression is *defensible*, which is the part worth thinking about
before deleting it. `rsvp_status` on a poll invitee is almost always
`pending`, because nobody RSVPs to a poll — they vote. A column reading
"pending" beside everybody's name is worse than a blank one.

So the gap is narrower than the request, and it is one event type:

- **Fixed-time events** already do this.
- **Window polls** already do it too, and better: since v0.4.5 (idea 39) the
  availability view names everyone and draws the hours they gave.
- **Options polls** show tallies and nothing else. `getOptionTallies` returns
  counts plus the caller's own vote; no names, so the frontend could not
  render them even if it wanted to.

**The work**, then: attach voters to the poll response, and render them per
candidate. Bounded by `MAX_POLL_OPTIONS` x invitees, which is the product
spec 0006 was careful about — one extra query joined on the options rather
than one per option.

**And a question v0.5 created an hour before this was asked.** Edit-on-resolve
gives people RSVP buttons once a poll settles, so a resolved poll now carries
*both* a historical vote and a current RSVP. "Voted yes on Thursday, has
since said they can't make it" is precisely what an organizer needs to see
and precisely what one column cannot say. Probably: votes while the poll is
open, RSVPs once it has resolved, and both on a resolved poll's detail page
with the vote shown as history rather than as an answer.

Worth doing with `specs/0014` in view rather than before it: that spec makes
attendance per occurrence, and a multi-winner poll fans out into separate
events — at which point "who is coming to this night" stops being a poll
question at all and becomes an ordinary event's invitee list, which already
works.

## Already built

Kept for the reasoning, not as a to-do list. Nothing below counts against the
1.0 test above: where an entry argues its way to a decision and rejects an
alternative, that argument is why the entry is still here at all.

### 1. A sandbox/staging environment separate from production — shipped in v0.1

A second Cloudflare Worker + D1 database (and possibly a second Discord
application/bot) to build and test future features against, instead of
building directly in prod.

### 3. Manual, event-specific invite links — shipped in v0.2

A link (not a bot-sent DM) that takes a specific person straight to one
event, or to the poll/time-options for one event, so the organizer can paste
it into their own message rather than have the bot DM a link that reads as
spam/scam.

### 4. Calendar weeks should run Sunday–Saturday, not Monday–Sunday — shipped in v0.1

### 6. Poll date/time handling inconsistency — shipped in v0.2

A fixed-time event lets you set separate start and end dates/times.
Potential-invite events (both candidate-day polls and the time-window mode)
currently don't offer that same separate start-date/end-date shape — worth
revisiting so the two creation paths behave consistently.

### 7. Pick the server directly on the New Event screen — shipped in v0.1

Right now which server an event belongs to is set by the top-bar guild
switcher, and the event form just inherits whatever that's currently set to.
That's not coming across as intuitive — the New Event screen itself should
offer a server picker rather than relying on a dropdown elsewhere on the
page.

### 8. Visual design pass — shipped in v0.4

The app has had zero design attention — it's functional, not designed. Wants
pitches/options for making the whole platform look better (layout, color,
typography, general polish) before or around release.

### 11. Owner-only view of everyone signed up — shipped in v0.1

A page (or endpoint) restricted to the site owner — same `OWNER_DISCORD_ID`
check `worker/src/routes/admin.ts` already uses for the guild allow-list —
listing every user across all servers: who they are, which guilds they're
in, last login. No one else would be able to see it. Mostly needs a frontend
page; the owner-only check and the underlying `users` table already exist.

### 12. Stop an end date/time before the start from being enterable at all in the New Event form — shipped in v0.1

`worker/src/lib/validate.ts` already rejects `endAt <= startAt` server-side,
but `EventFormPage.tsx` has no client-side guard, so the only feedback right
now is a rejected submit. Found while testing after the schema-drift fix
(see SETUP.md) — the form let you set an end date/time before the start with
no warning until you tried to save. Worth deciding the exact UX: disable the
Save button and show an inline message, or auto-push the end forward as you
change the start. Applies to the single-event start/end fields; the poll
slot rows and the time-window mode have their own start/end pairs and would
need the same treatment.

### 13. Let invitees ask the organizer for a change — shipped in v0.2

Two requests, same shape: "can we move this?" (with a proposed new time) and
"can we also invite this person?" (naming someone). Today the only way an
invitee can push back on a time is to decline, which loses the information —
the organizer sees a "no" and not "no, but Thursday works" — and there is no
in-app path at all to suggest another guest; that conversation currently
happens in Discord and never reaches the event. Deliberately a *request*,
not an edit: the organizer stays the only person who can change the event,
and accepting a request is what applies it. Needs a new table for the
pending requests, two new notification types on the existing outbox
(organizer gets "someone asked for X", requester gets the accept/decline
back), and a decision about what happens to an open request when the
organizer edits the event out from under it — `events.revision` (migration
0013) already gives us a token to detect exactly that. Also worth deciding
whether the "invite this person" flavour can name someone the requester can
see but the organizer can't, and whether a request count needs bounding the
way every other per-event surface is.

### 14. Promotion from sandbox to prod should be one boring step — shipped in v0.1

The companion to idea 1: standing up a second Worker + D1 is only half of
it, and the half that doesn't decide whether the sandbox actually gets used.
If shipping a change that has been verified in the sandbox means hand-run
`wrangler` commands, hand-copied secrets, or remembering which of the two
databases a migration has been applied to, the sandbox becomes the thing you
skip when you're in a hurry — which is precisely when you shouldn't. The
target is: merge to `main` and prod gets what the sandbox already proved,
with no step that depends on remembering anything. Notably this is not a
from-scratch build — `.github/workflows/deploy-worker.yml` and
`deploy-pages.yml` already typecheck, test, migrate and deploy on push to
`main`; what's missing is a second environment for them to target first, and
a promotion path between the two that can't silently diverge. The
schema-drift incidents in SETUP.md are the argument for care here: the
failure mode isn't "the deploy errors", it's "the deploy reports success
against a database that doesn't match the code".

### 15. The owner-only user list can't tell "never a member" apart from "was a member, later marked departed" — shipped in v0.3

Found while diagnosing why a Discord server member showed zero servers on
`/admin/users` despite genuinely being in one of them:
`user_guild_membership` rows aren't deleted when someone leaves (or is
recorded as having left) a server — `is_member` just flips to 0, either via
`syncGuildMembership` (an OAuth login's own fresh guild list came back
without that guild) or the cron's `revalidateStaleMemberships` (a periodic
bot-API recheck said `not_member`). The admin endpoint's `WHERE
ugm.is_member = 1` filter (`worker/src/routes/admin.ts`) makes both of those
look identical to "this person has never been in that server" — the only way
to tell them apart today turned out to be a raw SQL query against
`user_guild_membership` for one specific user. Worth either showing departed
memberships greyed-out/labeled on the same page, or exposing
`verified_at`/`is_member` history somewhere reachable without a manual DB
query.

Same investigation surfaced a second, related gap worth fixing alongside
it: `last_login_at` is stamped by `upsertUser` in `worker/src/routes/auth.ts`
*before* the zero-shared-guilds check that can still reject the login
with a 403 and no session issued — so a bounced login attempt currently
looks identical to a real, successful one on the admin page. Distinguishing
"logged in" from "attempted to log in and was turned away" on that same
view would have made this specific investigation a one-query answer
instead of three wrong guesses.

**Done in v0.3.** Both halves: the admin endpoint dropped its
`is_member = 1` filter and now tags each membership, with departed ones
struck through; and migration 0018 split `last_login_attempt_at` (stamped
by `upsertUser` as soon as Discord returns a profile) from
`last_login_at` (stamped by the new `markLoginSucceeded`, only once a
session is actually issued).

### 16. A group's creator can never be counted as a member of their own group — shipped in v0.3

Found in production: the "Spacebros" idle-group nudge fired correctly
(`sweepIdleGroups`, `worker/src/cron/reminders.ts` — right on schedule, to
the second) but the creator never got it, because they were never in
`group_members` to begin with. That's not an oversight in one save — it's
structural, and it's a closed loop:

- `group_members` is populated only from whatever list gets submitted
  when a group is created or edited (`worker/src/routes/groups.ts`).
  Nothing auto-adds `created_by`.
- The picker that list comes from (`GroupEditor.tsx`, fed by
  `GroupsPage.tsx`'s `GET /me/friends`) is backed by `listFriends`
  (`worker/src/lib/db.ts:293`), which binds `AND u.id != ?` against the
  caller's own id — correct for "who can I invite to an event" (its
  original purpose), silently wrong for "who's in this group" (reused
  for a second purpose it wasn't designed for).
- Only the creator may edit a group's membership (`group.created_by !==
  userId` → 403 on every mutating route in `groups.ts`), so nobody else
  can add them either. There is currently no path, through the UI or the
  API as designed, for a group's creator to ever appear in
  `group_members` for their own group.

Consequences beyond the idle nudge: anything else that reads
`group_members` to mean "who's in this group" inherits the same gap.
Fix shape is fairly clear — either seed `group_members` with the creator
automatically on create (and on ownership transfer, if that ever
exists), or give `GroupEditor` its own member-source query that doesn't
carry `listFriends`'s self-exclusion. Worth deciding which before
building it: auto-seeding changes what "N members" means for every
existing group the moment it ships (retroactively, or only for new
groups?), where a dedicated query is a smaller, more local fix.

**Half-done, and the decisions are now made (Aug 2026).** Commit 5f83816
took the smaller option — `GroupsPage` merges the caller into the list
it hands the picker, so a creator *can* tick themselves. They still
aren't a member automatically, and every group created before that fix
still doesn't have its creator in it. Remaining work, as decided:
- **Auto-seed `created_by` into `group_members` on create**, and
  **backfill existing groups** (so this applies retroactively — the
  "N members" counts on existing groups will move, which is correct).
- **Ownership transfer when an owner removes themselves:** hand the
  group to the member with the most `accepted` RSVPs on events invited
  via that group. Tiebreak by earliest `added_at`, then user id, so it's
  deterministic. If there is no one to transfer to, block the removal
  rather than orphan the group.
- **Permissions:** only the owner may add/remove members, rename, or
  delete. **Any member may create events for the group.** (Note that
  inviting a group to an event is already open to any guild member —
  `resolveInviteeUserIds` checks the group's guild, not its ownership —
  so this is mostly about making that intentional rather than incidental.)

### 17. Two frontend dependency majors deliberately sitting behind `npm audit` — shipped in v0.2

**Done.** Both cleared: `react-router-dom` 6→7.18.2 and
`vite` 5→8.2.2 (`npm audit fix --force`'s own resolution left
`@vitejs/plugin-react` and `vitest` on versions that don't actually
support vite 8 as a peer — force-installed anyway with `ERESOLVE`
warnings — so those two needed pinning by hand: `@vitejs/plugin-react`
6.1.0 and `vitest` 4.1.11, the versions that declare real vite-8
support). `npm audit` now reports zero vulnerabilities. Verified: clean
`npm ci` from the committed lockfile, typecheck, lint, full test suite,
production build, and a headless-browser check of both the dev server
and the built `vite preview` output (HashRouter navigation, an
unauthenticated redirect, an unmatched route, and a visual screenshot
of the Tailwind-styled login page) all came back clean.

### 18. A multi-day window poll's availability slider shows only times, no dates, once submissions can span more than one day — shipped in v0.2

Found while building idea 6 (poll date/time consistency):
`WindowAvailabilityPicker.tsx` was already generic over the window's full
millisecond span (it never assumed a single day), so letting the organizer's
form propose a multi-day window (e.g. "Friday evening through Sunday night")
needed no change there. But its labels (`fmt()`, `h:mm a` only) and the
submission-bar tooltips show a bare time-of-day — fine when the whole window
fits in one day, ambiguous once it doesn't ("6:00 PM" on which of the
window's days?). Fix shape: switch `fmt()` to include the date whenever
`windowEndAt - windowStartAt` exceeds 24h, mirroring how `formatTimeRange`
already leads with the date for exactly this reason.
**Done** — shipped in v0.2.

### 20. Merge the Dashboard into the Calendar as one landing page — shipped in v0.4

Two top-level tabs currently split what is one question. `/` is the
Dashboard — a "Welcome back" header, the New Event / Personal time buttons,
and an "Upcoming sessions" list — and `/calendar` is the grid. The itinerary
would work better as a **right sidebar alongside the calendar** than as a
separate tab you have to go to first.

**This is a pure layout change, and idea 5 is why.** Before v0.3 it
wouldn't have been: the Dashboard and the Calendar were fed by
different queries. Now both call the same `GET /me/events` — the
Dashboard asks for now→+60d and takes the first 8, the Calendar asks
for the visible range — so merging them needs no new endpoint, no
schema change and no worker work at all. It is the mirror image of
idea 5, which *looked* like a view change and turned out to be
structural.

Decisions it needs, none of them settled:

- **Does the sidebar follow the calendar, or stay anchored to now?**
  They want different ranges: "what's coming up" means from *now*,
  while the grid pans to arbitrary months. Anchoring the sidebar to
  now (so paging to December doesn't empty it) is the more useful
  behaviour and costs a second, smaller query.
- **Mobile.** A sidebar beside a month grid doesn't fit a phone. It
  has to collapse to a stacked list above or below the grid, or behind
  a toggle. This is the real cost of the change and the reason it
  isn't trivial.
- **What happens to `/`, `/calendar`, and the nav.** The merged view
  should own `/`, with `/calendar` kept as a redirect rather than
  removed — it's linked from the Dashboard's own empty state today
  and may be bookmarked.
- **Where the header and the two action buttons go**, and whether the
  `guilds.length === 0` empty state ("you don't share any allow-listed
  servers") still has a home. It currently gates the whole Dashboard.

**Sequencing: this belongs *inside* the v0.4 design pass (idea 8), not
before or after it.** Phase 3.5 is defined as styling "the set of views
that survived Phase 3" — and this changes which views there are. Doing
the design pass first and re-laying-out the landing page second means
designing that page twice, which is exactly the argument that put idea
8 after idea 5 in the first place. So the design pitches should be
drawn with the merged calendar+itinerary landing page as a given.

### 21. Clicking an event chip on the month calendar opens the New Event form instead of the event — shipped in v0.4

`MonthCalendarGrid` renders each day cell as `<button onClick={() =>
onDayClick(day)}>` and nests the day's `EventChip`s inside it — and
`EventChip` renders a react-router `<Link>`, i.e. an `<a href>`. So a click
on a chip triggers the chip's own navigation *and* bubbles to the day cell's
handler, which `navigate('/events/new?date=…')`. The day-cell handler runs
second and wins, so the event you clicked never opens.

Also invalid HTML on its own terms — an anchor inside a button — which
collapses the two into one ambiguous control for keyboard and
screen-reader users. Found while auditing the calendar for the v0.4
design pass (`specs/0008`). The nesting and the double-fire are plain
from the code; the exact landing page is worth confirming against the
deployed sandbox before the fix is written.

Fix is forced by all three of 0008's pitches — every one of them has to
say what a day cell *is*, and none can keep "a button that contains
links". Likely shape: the cell stops being a button, chips stay links,
and "new event on this day" becomes an explicit affordance rather than
the cell's whole background.

### 24. A failed API call is displayed as "you have nothing scheduled" — shipped in v0.4.1

`CalendarPage` does `api.get(...).then(setOccurrences).finally(() =>
setLoading(false))` — no `.catch`. `api.get` *does* throw an `ApiError` on a
non-ok response (`client.ts`), so the rejection goes unhandled,
`occurrences` stays `[]`, `loading` flips to false, and the user is shown
the cheerful empty state: "Nothing scheduled in this window yet."

So a 404, a 500, an expired session or an unreachable Worker all render
identically to a genuinely empty calendar. Only `AuthCallbackPage` and
`EventFormPage` have a `.catch` anywhere in `pages/`.

Found the expensive way: the sandbox Worker predated v0.3 and had no
`/me/events` route at all, so every calendar request 404'd — and the app
said, confidently and in a friendly tone, that there was nothing on. It
cost a long detour of testing a *frontend* branch against what looked
like missing data. The screen that is supposed to tell you what is
happening was the one actively hiding it.

Wants: an error state distinct from the empty state, on every page that
loads data. Probably a small `useAsync`-style hook rather than a `.catch`
bolted onto each call, since `DashboardPage`, `GroupsPage`,
`EventDetailPage`, `PersonalEventPage` and `AdminUsersPage` all have the
same shape. Worth doing alongside v0.4's design pass — an error state is
a surface that needs designing, and `specs/0009` is already deciding what
empty states look like.

**Done** — shipped in v0.4.1 as the guessed shape: `lib/async.ts`
(`useAsync`, `useAction`, `describeError`) plus an `ErrorState`/
`InlineError` pair beside `EmptyState`. Three cases turned out to be
*worse* than a wrong empty state rather than equal to it, and are worth
recording because none was visible from the original capture:

- A failed load on an **edit** form (event or personal event) left the
  form at its blank defaults, where saving would overwrite the real
  record with them.
- A failed `/guilds` left `guilds` empty, which the calendar rendered as
  "you don't share any allow-listed Discord servers with this app yet" —
  a false statement about the user's standing with the app, not a missing
  list. `GuildContext` now carries an error of its own.
- Mutations, not just loads. Every handler on `EventDetailPage` was
  `await api.post(...); await load();` with no catch, so a refused
  request became an unhandled rejection and the button appeared inert.
  That is the half that made idea 26 so confusing to hit.

**A fourth case, found on the sandbox after the above had shipped**, and
the most important of them: the same bug sat one level *below* every page,
in `AuthContext`. `refreshUser` did `try { await api.get('/me') } catch {
setUser(null) }`, and `AuthGuard` redirects whenever the user is null — so
an unreachable Worker or a 5xx was reported as "you are not logged in",
which is a statement about the person rather than about the request. A 401
never reaches that catch (the API client refreshes, then bounces on its
own), so it was only ever catching failures that meant *we could not find
out*.

It also made the rest of this item unreachable in practice: **any** way of
breaking the API bounced you to the login page before a page could render
an error state at all. That is what the sandbox review actually
demonstrated — the recipe for triggering the new error state could not
work, and the reason it could not work was this.

Fixed in the same release: `AuthContext` carries an `error`, `AuthGuard`
checks it *before* the redirect and offers a retry, and the rule lives in
a tested `describeAuthError`. The token is untouched throughout, so a
retry — or a reload once the server is back — logs straight in with no
second OAuth round trip.

### 25. CI actions are on a deprecated Node runtime — shipped in v0.4.1

Every workflow pins `actions/checkout@v4` and `actions/setup-node@v4` — ten
call sites across `ci.yml`, `deploy-pages.yml`, `deploy-sandbox.yml` and
`deploy-worker.yml`. GitHub now forces those onto Node 24 and emits a
deprecation warning on every run (seen on Deploy Sandbox #1).

Advisory today, a broken deploy whenever GitHub stops forcing the
substitution. Bumping both to `@v5` is a ten-line change with no logic in
it — the kind of thing that is trivial now and an emergency later, on the
day a release is already blocked.

Worth pairing with a decision about whether to pin action versions by
major at all, since this will recur every couple of years.

**Done** — shipped in v0.4.1. The pinning decision was made rather than
deferred, and written into `ci.yml` as a comment: **stay on major tags,
not commit SHAs.** SHA-pinning is genuinely stronger (a major tag is
mutable) but is a standing maintenance cost forever, on a repo maintained
by one person in their spare time; the realistic threat here is a broken
deploy on a blocked release day, not a compromised upstream action. What
the choice obliges is bumping *early*, which is what this was.

### 26. The organizer is shown RSVP buttons they get a 403 for — shipped in v0.4.1

On a fixed-time event you organised, "I'm in / Maybe / Can't make it" render
and do nothing at all when clicked.

Two halves. The server's `POST /events/:eventId/rsvp` does
`UPDATE event_invites ... WHERE event_id = ? AND user_id = ?` and then
`if (result.meta.changes === 0) return c.text('Not invited to this
event', 403)`. An organiser has no `event_invites` row — the model treats
them as implicitly attending, which is why the attendance and reminder
queries all say `... UNION SELECT ?` with the organiser id rather than
reading a row. So the update matches nothing and the organiser is told
they are not invited to their own event.

The client half is idea 24 again: `handleRsvp` is
`await api.post(...); await load();` with no `.catch`, so the 403 becomes
an unhandled rejection and the button appears inert. Two bugs, and the
second is what makes the first so confusing to hit.

The UI has no organiser check either — `EventDetailPage` gates the RSVP
block on `eventType === 'single' && startAt && endAt` and nothing else.

Which way to fix it is a real design question, not a typo:
- **Give the organiser an `event_invites` row** at creation, accepted by
  default. Lets them decline their own session, which is a genuine case —
  the DM can be ill. But every `UNION SELECT ?` in `attendance.ts`,
  `reminders.ts` and `changeRequests.ts` then risks double-counting, so
  it is a wider change than it looks.
- **Hide the buttons from the organiser** and say "you're the organiser,
  you're counted as attending". Matches the model as built, cheap, and
  loses the ability to say you can't make your own event.

**Refined on the sandbox, and decided.** It is narrower than first
written: an organiser who *also* invites themselves gets a row like anyone
else and can RSVP normally. `inviteStatements` in `lib/eventWrites.ts`
inserts only the invitees it is given, all at `'pending'` — so the 403
only strikes an organiser who did not add themselves, which is the common
case and the one that looks broken.

**Decision: give the organiser a real `event_invites` row at creation,
defaulted to `'accepted'`** rather than `'pending'` — they are the one
person whose attendance is not in question. That keeps "I can't make my
own session" possible, which hiding the buttons would have cost.

The care is all in the audit that comes with it. Every
`... UNION SELECT ?` that folds the organiser in by hand
(`attendance.ts`, `reminders.ts`, `changeRequests.ts`) has to be
revisited: with a real row present, a union that forces the organiser
into the accepted set would override a decline and report them as
attending anyway. `changeRequests.ts` also counts
`COUNT(*) FROM event_invites` for its thresholds, and those counts move by
one. Plus a migration to backfill existing events.

**Sharpened again, by Michael.** The event that worked was a *group*
event and he was a member of that group — so his invite row came from
group resolution, not from anything organiser-specific.
`resolveInvitees` in `lib/eventWrites.ts` builds the list from direct user
ids plus group members and has no organiser case at all, and idea 16 (v0.3)
guarantees a group's creator is a member of it. So:

- **Group event, organiser in the invited group** → row via
  `invitedVia: 'group'`, RSVP works. Always has.
- **Non-group event** (individual invitees, or none) → no row → 403.

That narrows the fix usefully: add the organiser after resolution *only if
they are not already among the invitees*. Group events are then untouched,
and the blast radius is non-group events only — which also shrinks the
`COUNT(*)` threshold concern in `changeRequests.ts`, since group events
already counted the organiser.

The `UNION SELECT <organiser>` audit still stands and is still the risky
half: with a real row present, a union that forces the organiser into the
accepted set would override a decline and report them attending anyway.

Found while verifying v0.4 branch 1 on the sandbox.

**Done** — shipped in v0.4.1, exactly as decided above. The audit was the
expensive half and turned up one more than expected: `sweepNewInvites`
reads a backfilled row as a fresh invite, so without a guard every
organiser would have been DM'd "You've been invited to <your own event>",
once per event they had ever run, the first tick after migration 0019
landed. The migration therefore writes its own settled `notification_log`
rows *before* the invites they suppress, because migrations apply minutes
before the Worker that guards against them deploys. One knock-on worth
knowing: `MAX_RESOLVED_INVITEES` now counts the organiser, so an organiser
who is not themselves an invitee can name 24 others rather than 25.

### 27. Fade events that have already happened — shipped in v0.4.1

A past session on the month grid renders exactly like an upcoming one, so
the eye has to read dates to work out what is still ahead. The grid covers
this month and next, so roughly half of what is on screen at any time is
already over.

Wants to stay distinguishable from *cancelled*, which is already
`line-through` plus reduced opacity. Two different states that both mean
"not happening" would collapse into one if past events simply dimmed too —
so past is probably opacity alone, cancelled keeps the strike.

Note an asymmetry v0.4 introduced: the agenda view filters to today
onwards, so past events never appear there at all, while the grid shows
them. That is arguably correct rather than a bug — the grid is the shape of
a month and the agenda is what is next — but it means this only applies to
the grid, and the two views should be *deliberately* different rather than
accidentally so.

Also worth deciding: does an in-progress event (started, not yet ended)
count as past? It should not.

**Done** — shipped in v0.4.1, with both calls as guessed above: past is
opacity alone, cancelled keeps the strike, and past means *ended* rather
than *started*. The grid/agenda asymmetry is now a comment in
`MonthCalendarGrid` rather than an accident.

### 28. Warn — but do not block — when an event is created in the past — shipped in v0.4.1

Nothing stops you dating an event yesterday today.

**Blocking is the wrong fix**, and the reason is worth writing down: every
reminder query in `cron/reminders.ts` bounds on `start_at >= now`, so a
past event is never picked up by the cron. No overdue DMs, no stuck outbox
rows, no operational harm at all. It simply sits there.

Meanwhile there are legitimate reasons to do it: logging a session that
already happened, correcting a mistyped year on an event that has since
passed, or editing any old event at all — a naive rule would block that
last one, which would be actively obstructive.

So: an inline warning on the form, not a hard stop. Worth contrasting with
idea 12 (v0.1), which *does* hard-block an end before a start. The
distinction is that end-before-start is incoherent, while a past date is
merely unusual — block the incoherent, warn on the unusual.

Timezones make the case stronger: "tonight at 7" can already be in the past
in the organiser's own zone by the time the form is submitted, and a hard
block would reject it with no way forward.

**Done** — shipped in v0.4.1 as an inline warning next to idea 12's hard
block, so the block-the-incoherent / warn-on-the-unusual distinction is
visible in the markup too. One case the capture didn't anticipate:
**recurring events are excluded rather than warned about.** Their start
date is the series start, routinely in the past on any established series,
and the warning's own claim — that no reminders will be sent — is false
there, since future occurrences still get them.

### 29. `IDEAS.md` doesn't say which of its items have shipped, which breaks the definition of 1.0 — shipped in v0.4.2

`ROADMAP.md` states it plainly: "**v1.0 is defined by the backlog, not by a
feature set: when `IDEAS.md` is empty, we leave Beta.**" But nothing clears
this file. Only items 17 and 18 carry a `**Done**` marker; ideas 3, 4, 5, 6,
7, 8, 11, 12, 13, 14, 15, 16, 20 and 21 all shipped across v0.1–v0.4 and are
still written here in the present tense, as though they were open.

So the list can never empty, and the one test 1.0 is defined by can never
pass. Worse for anyone reading, the file currently reads as a backlog of
~25 open items when the real number is closer to a dozen — which makes it
look far more daunting than it is, and makes "what's left" a question you
have to answer by cross-referencing the roadmap's status column.

Noticed while marking 23–28 in v0.4.1, which is when the convention
became visible by being followed.

Two ways to fix it, and they are not equivalent:
- **Mark in place** (what 17, 18 and 23–28 do): keep the entry, strike or
  annotate it with the version it shipped in. Preserves the reasoning,
  which is often the most valuable part — several entries here record a
  decision and *why the alternative was rejected*, and that is worth more
  after shipping than before.
- **Move to an archive** (`IDEAS-done.md`, or a section at the bottom).
  Actually empties the list, so the 1.0 test can pass, at the cost of a
  second file to keep in step.

Leaning towards the second *plus* the first — annotate, then move the
annotated entry down into an "Already built" section in the same file, so
there is one file, the reasoning survives, and the open list is genuinely
the open list. Either way this is a docs-only change with no code in it,
and it should probably happen before the next release rather than after,
since every release makes the gap wider.

**Done in v0.4.2** — both halves, as this entry leans towards: annotate *and*
move. Entries became headings rather than an ordered list along the way,
because a Markdown ordered list renumbers itself from its first item, and the
numbers here are identities that `ROADMAP.md` and `specs/` refer to — the
moment entries move between sections, a list would start showing a reader
numbers that mean nothing. Twenty-four entries moved down, leaving an open
list around a dozen rather than the twenty-five the file used to read as —
and deliberately no count is quoted here, for the reason item 30 makes:
a number you have to keep true by hand is one that goes quietly stale. Two
of the open ones (5, 23) are partly-shipped items whose remaining half is
real work.

### 30. The `sandbox` branch is behind `main` and nobody would notice — shipped in v0.4.2

Nothing reports this — there is no check that says "sandbox is N commits
behind production", and the advisory note on the production deploy answers a
different question (was *this commit* deployed to sandbox first), which is
easy to read past and was read past for all of v0.4.

**The specific figure first written here has already gone stale, which
is the point rather than a correction.** It said `origin/sandbox` sat at
v0.4 *branch 1*, two branches behind. It now sits at `692eb89`, v0.4.1's
sandbox-verified head — one docs-only commit behind `main` — because
v0.4.1 went through the sandbox properly. Nothing announced either state.
A number you have to re-derive by hand every time you want it is the gap;
how big it happens to be today is not.

The consequence is quiet rather than dramatic: the next person to verify
something on the sandbox is verifying it against a Worker several
releases old, and will attribute anything odd to their own change. That
is exactly how idea 24 cost a long detour — a sandbox Worker predating
v0.3 had no `/me/events` route, and the app reported the resulting 404 as
an empty calendar.

Cheap fix shape: have `deploy-sandbox.yml` (or a tiny scheduled workflow)
report the sandbox branch's distance from `main`, and say so in the job
summary. Alternatively make the *production* deploy fast-forward
`sandbox` to the commit it just shipped, so the sandbox is never behind
production even when a change skipped it — which is a different claim
from "this was tested on sandbox", but a much easier one to keep true.

**Done in v0.4.2** — reported rather than fast-forwarded.
`deploy-worker.yml` says how far `sandbox` is behind the release it is
deploying; `deploy-sandbox.yml` says how far the branch it is building is
behind `main`, and how many of those commits touch `worker/`. The second is
the one that matters, because it fires *before* a verification session rather
than after it. Fast-forwarding `sandbox` from the production workflow was
rejected: it would redeploy the sandbox out from under whatever feature is
parked on it.

### 31. The sandbox advisory on the production deploy can never pass under a merge-commit workflow, so it fires on every release regardless — shipped in v0.4.2

Guardrail 3 in `deploy-worker.yml` asks the GitHub Deployments API
`?environment=sandbox&sha=${{ github.sha }}` — that is, *this exact commit*.
But `github.sha` on a push to `main` is the **merge commit**, which by
construction did not exist when the sandbox was deployed: the sandbox is
deployed from the feature branch's head, and merging creates a new commit
with the same tree and a different SHA.

So the check compares a SHA that cannot match. It reports "no matching
sandbox deployment" on a release that went through the sandbox properly,
and on one that skipped it entirely, and there is no way to tell the two
apart from its output.

Found on the v0.4.1 production deploy, which was verified on the sandbox
at `692eb89` and merged as `ec8b33d`. The advisory fired anyway.

This reframes what `CLAUDE.md` currently says about it. The existing text
treats "it fired on every production deploy of v0.3 and was read past" as
a discipline problem — read it more carefully. It is not: a check that
fires identically whether or not you did the right thing is training the
reader to ignore it, and they are correct to. The advisory has been
crying wolf since it was written, and nobody noticed because its output
was never *wrong* in a way anyone could point at, only uninformative.

Worth noting the design intent survives this: `specs/0002` chose advisory
over blocking deliberately (a hard gate on a single-maintainer project
gets bypassed wholesale, and a bypassed gate protects nothing). That call
is still right. The problem is the predicate, not the severity.

Three possible fixes, in rough order of cost:
- **Check the PR's head commit, not the merge commit.** On a
  `pull_request`-merged push, the merged branch head is recoverable
  (`github.event.head_commit` is the merge; the PR's head SHA needs an
  API call or the merge commit's second parent, `HEAD^2`). That is a
  few lines and makes the check mean what it always claimed to mean.
- **Compare trees rather than commits.** `git rev-parse HEAD^{tree}`
  against the sandbox deployment's tree answers "was this exact code
  deployed to sandbox", which is the real question and is immune to
  rebases, squashes and merge commits alike.
- **Fast-forward merges only**, so main's SHA is the branch head that
  was sandboxed. Cheapest to implement, but it constrains how every
  future PR lands to make one check work, which is backwards.

Related to idea 30 — both are cases of the sandbox's relationship to
production being unreported rather than wrong. Doing them together is
probably cheaper than doing either alone.

**Done in v0.4.2** — the second of the three options, comparing trees rather
than commits, narrowed further to the `worker/` subtree since the sandbox
deploys the Worker and nothing else. That also makes it immune to frontend
and docs commits landing on `main` in between, which a whole-tree comparison
would not have been. Verified against the case that produced this entry:
`692eb89` (sandbox) and `ec8b33d` (its merge) have the same `worker/` tree,
so the new predicate matches where the old one warned. The remaining blind
spot is stated in the workflow itself: a sandbox deploy of a branch never
merged and since deleted is unreachable from the production checkout, and the
step reports how many such deployments it had to skip.

### 33. The ground and the vaporators lost their positioning in v0.4 and have been unpinned ever since — shipped in v0.4.3

Reported from watching someone else use it: the vaporators on the home
screen are not standing on the ground. They are not standing anywhere —
neither element has any CSS at all.

`Sky.tsx` renders `.uo-ground` and `.uo-vaporators`, and its own comment says
"The ground, pinned to the bottom edge at every window size". Nothing pins
it. Those two rules existed once and were **deleted by `4a0ee7e`** ("Busier
sky, independent suns, real dust haze"), which reused their declaration
blocks for `.uo-haze` and `.uo-craft` instead of adding new ones. The markup
kept the class names, so nothing broke loudly; the styles simply vanished
from underneath them. They have been missing through v0.4 and v0.4.1.

Measured on the built bundle at 1280x800, with the real stylesheet: both SVGs
compute to `position: static`, in normal flow at the *top* of the fixed sky
layer — ground at 0-192px, vaporators at 192-346px — rather than at the foot
of the viewport. They are also the only two `uo-` classes in `Sky.tsx` with no
rule anywhere in `index.css`, which is a cheap thing to assert in a test.

Restoring the deleted rules (`position: absolute; bottom: 0; height: 15vh /
13vh` with the old min-heights) puts them back at the bottom, but does not by
itself answer the thing being complained about, and this is the part worth
designing rather than patching: **the two SVGs have independent viewBoxes
(`0 0 1000 150` and `0 0 1000 120`) and both carry `preserveAspectRatio="none"`,
so each is stretched by a different factor at every window size.** A foot at
`y=120` in one coordinate space cannot stay on a dune crest at `y≈44` in
another that is being scaled differently. Even correctly pinned they only
line up at one aspect ratio. The honest fix is one SVG containing both, so
the feet and the dune line are in the same coordinate space and stretch
together.

Two smaller things found alongside: `.horizon-foot` has a rule in `index.css`
("Rendered by Layout") and is rendered by nothing — dead since the scene moved
into `Sky.tsx`. And the login page never mounts `Sky` at all; its vaporators
are the separate, correctly-styled `.uo-hero-vaps`, which is why the fault is
invisible until you log in.

Frontend-only, so per CLAUDE.md it is verified locally against the sandbox
Worker rather than on the sandbox — the gap item 23 is still about.

**Done in v0.4.3.** Both halves: the deleted positioning is restored, and the
two SVGs became one. The merge is the part that mattered — two viewBoxes of
different heights, both with `preserveAspectRatio="none"`, are stretched by
different factors at every window size, so a foot could only meet a dune at
one aspect ratio. One `.uo-horizon` puts the feet and the dunes in the same
coordinate space. Measured on the built bundle at 1280x800, 390x844 and
1920x1080: the band's bottom is the viewport's bottom in all three, and a
vaporator foot sits at a constant 52% of the band's height rather than
drifting. The feet are drawn *behind* the near dune so they read as standing
in the sand rather than on it.

The dead `.horizon-foot` rule went with it. One element with one name is also
one fewer class that can be silently orphaned the way `4a0ee7e` orphaned these
two.

**A second instance, found verifying the first.** The login page never mounts
`Sky` — its vaporators are `.uo-hero-vaps`, a separate scene drawn inline in
`LoginPage.tsx` — so it was the one screen where this fix changed nothing, and
it was also the screen Michael happened to be looking at. It had the same
symptom for a different reason: the hero is already one SVG, so coordinate
spaces were never the problem; instead all three masts ended at a constant
`y=552` while the near dune's surface varies with x, sitting at y≈568 under
the leftmost vaporator and y≈556 under the right-hand one. The left pair
floated by up to 16 units.

Fixed by running the masts past the lowest point of both dune paths and
letting the sand overlap them (they were already drawn first, so they were
already behind it). That is deliberately not "match the numbers up": two
numbers that must agree are what came apart here in the first place, and a
mast that ends underground cannot drift above the surface however the dune is
later reshaped.

**And a third round, from the same verification: in-app the vaporators were
planted but stubby.** Merging the two SVGs had left the whole scene inside the
old ground band — 15vh — and a mast can only ever be a fraction of the box it
is drawn in, so they came out as knee-high posts while the login hero's (drawn
against a full-viewport SVG) stayed tall. The viewBox is now 400 units with
the sand as the bottom 150 and the 250 above it deliberately empty headroom,
and the band is 40vh so the *sand* still occupies the 15vh the original ground
did. Everything above the sand is transparent, so the taller element covers
nothing. Masts measure 118-205px across 1280x620 through 1920x1080, with the
foot at a constant 85% of the band in every case.

### 34. A server member can see every group in that server, including ones they are not in — and every group's full member list — shipped in v0.4.3

Reported from watching someone else use it: "he can see groups he's not a
part of". Confirmed, and it is the query's design rather than a leak through
a crack. `GET /me/groups` (`routes/me.ts`) selects every row in `groups`
joined only on *guild* membership — `user_guild_membership.is_member = 1`
within the grace window — with no `group_members` predicate on the caller at
all. `GET /guilds/:id/groups` (`routes/guilds.ts`) has the same shape. So the
visibility rule today is "if you are in the server, you see all of its
groups".

The larger half is what comes with each group: both routes then fetch every
group's **full member list** — id, username, global name, avatar hash — and
return it. So a server member does not merely learn that a group exists; they
learn exactly who is in it, for every group in the server.

This needs a decision, not a patch, and it is the same decision
`specs/0007-server-noticeboard.md` already made for *events* — where the call
was that a server is "more public noticeboard type thing than anything", so
titles and attendee lists are visible by default. Groups being visible the
same way is at least arguable on the same grounds, and if that is the answer
then this is a documentation gap rather than a bug. But it was never
*decided* for groups; it fell out of the query. Three options:
- **Leave it, and say so.** Consistent with 0007's noticeboard model. Costs a
  line in the Privacy Policy and the Groups page saying what other members can
  see.
- **Show groups, hide rosters.** Non-members see a group's name and size but
  not who is in it. Cheapest change with a real privacy effect, and it keeps
  the invitee picker working, which is what the per-guild route feeds.
- **Show only groups you are in.** Strictest, and it breaks the "ask to be
  added to that group" path, since you cannot ask about something you cannot
  see.

Note the interaction with item 16: since v0.3 a group's creator is always a
member, so "groups I am in" is now a well-defined set for every group — which
is what makes option 3 implementable at all.

The Privacy Policy needs reading before any of the three is chosen; it is
already the blocker on 0007, and this touches the same promise.

**Decided (Aug 2026): option 3 — you see only the groups you are in**, even
when the group is on a server you are in. That is the strictest of the three
and it was chosen over the noticeboard-consistency argument deliberately: a
group roster is a list of *people*, and spec 0007's reasoning about a server
being a public noticeboard was about *events*, which are things that happen at
a time. "Who is in this D&D party" is not a listing on a noticeboard.

**The consequence to go in with eyes open: it restricts inviting, not just
viewing.** `GET /guilds/:id/groups` is what feeds the New Event form's
invitee picker, so an organizer who can only see groups they are in can only
*invite* groups they are in. Today they can invite any group on the server.
That is a real behaviour change, and it is the right one — inviting twelve
people you cannot name, by picking a group you are not part of, is the same
leak from the other side — but it will be noticed, and it should be in the
changelog in those words rather than as "improved privacy".

It also removes the "browse the server's groups and ask to be added" path,
which was option 3's stated cost. Accepted: asking happens in Discord, where
these people already are, and the app is not where that conversation belongs.

This makes 34 a small, decided change rather than an open question, so it
moves onto the roadmap. Note it lands naturally as part of item 36 too — if
groups stop being server-scoped at all, "the groups you can see" and "the
groups you are in" become the same set by construction.

**Done in v0.4.3**, as the strict option decided above. `/me/groups` gains a
`group_members` join and `GET /guilds/:guildId/groups` is deleted rather than
restricted — with the invitee picker reading `/me/groups`, it had no callers
left. Group reads and writes now require membership of the group *and* active
membership of its server; the second is not made redundant by the first,
because roster rows survive someone leaving a server.

The whole suite passed the moment the fix went in, which says something worth
recording: **nothing pinned the old behaviour**. `test/groupVisibility.test.ts`
now does, and it was checked against the pre-fix code — three of its five
tests fail there, and the two that pass are the ones deliberately pinning
behaviour that must *not* change (a departed member, a stale membership row).

### 35. Show Discord avatars where people are listed — shipped in v0.4.3

Requested: people's Discord profile pictures when looking at who to add to a
group and who is already in one. Names alone make an invitee picker hard to
scan, and the app already looks like Discord-adjacent furniture everywhere
else.

**The data is already there, all the way through.** `users.avatar_hash` is
written at login from Discord's `/users/@me` (`routes/auth.ts`), every
member-listing route already selects it and returns it as `avatarHash`
(`routes/me.ts`, `routes/guilds.ts`, `routes/groups.ts`), and the frontend
already types it on both `User` and the group-member shape
(`types/index.ts`). Nothing renders it — there is no reference to
`cdn.discordapp.com` anywhere in the frontend. So this is a pure frontend
change: an `<Avatar>` primitive over
`https://cdn.discordapp.com/avatars/{id}/{hash}.png?size=64`, with a fallback
for a null hash (Discord's default avatar endpoint, or initials in the
group's palette colour — the palette work landed in v0.4).

Three things to get right rather than discover:
- **The null case is common**, not an edge: `avatar_hash` is null for anyone
  who has never set an avatar, and the fallback is what most non-Discord-native
  users will see.
- **The hash goes stale.** It is refreshed only when someone logs in, so
  somebody who changes their avatar keeps the old one here until their next
  login, and a stale hash 404s. That wants an `onError` fallback rather than a
  broken image.
- **It is the first third-party asset the app loads.** There is no CSP today
  (no `_headers` file in `frontend/public`), so nothing blocks it now, but a
  CSP added later needs `img-src` to include `cdn.discordapp.com` — and
  loading these tells Discord the IP of everyone viewing the page, which is
  worth a Privacy Policy line even though every user here is already a Discord
  user.

**Done in v0.4.3.** A single `<Avatar>` primitive, used on the Groups page
roster and the invitee picker. No backend change was needed at all — the hash
was already stored, already returned, already typed.

Both fallbacks the entry called for are real code paths rather than
hypotheticals: a null hash (anyone who never set a picture) and an `onError`
(a hash only refreshes at login, so it 404s for anyone who changed their
avatar since). Both fall back to an initial. The pure parts live in
`lib/avatar.ts` so they could be tested — the frontend suite has no DOM
environment — including that a leading emoji is not sliced in half, which
plain `name[0]` does.

The Privacy Policy needed no amendment: it already said avatars are shown to
other members of servers you share, "so people can identify who they're
inviting", which is exactly this.

### 38. The sandbox seed could not be re-run, and the cron was what broke it — shipped in v0.4.3

`npm run seed:sandbox` failed with a bare `FOREIGN KEY constraint failed:
SQLITE_CONSTRAINT_FOREIGNKEY` — no table named, nothing to act on. The file
had claimed "safe to re-run: everything is deleted and reinserted... in FK-safe
order" since it was written.

**The first run is what breaks the second, and it does it on purpose.**
`group_nudge_log` references both `groups` and `users` with no
`ON DELETE CASCADE`, and the seed group sets `idle_reminder_days = 0`
*specifically* so `sweepIdleGroups` fires on the first cron tick — which is
the whole point of the fixture. So roughly fifteen minutes after the first
successful seed, the sandbox's own cron has written rows that make the seed's
`DELETE FROM groups` and `DELETE FROM users` impossible. The file's most
useful feature disabled its second-most useful one.

The second half is ordinary accumulation: deleting the seed *guild* fails once
anyone's own group or event lives on it, and deleting seed *users* fails once
they are on a real group's roster or a real event's invite list. None of those
FKs cascade either.

**Fixed in v0.4.3** by narrowing what the file deletes to what it actually
owns — the seed events (which cascade to invites, poll options, votes, window
availability, change requests and notification rows), the seed group and its
roster, and the cron bookkeeping the seed itself caused — and *upserting* the
guild, the users and their memberships rather than deleting them. An invite on
a real event that was sourced from the seed group has its `source_group_id`
detached rather than the invite removed, which is the same move
`routes/groups.ts` already makes when deleting a group for real.

`test/seed.test.ts` runs the file against a schema built from the migrations,
twice, with both kinds of state in between. Checked against the pre-fix file:
the two failure-mode tests fail there and the two structural ones pass, so it
reproduces the reported error rather than merely asserting the new behaviour.
It also asserts the collateral damage that must *not* happen — a seed user
someone added to a real group stays on that roster.

**The lesson worth keeping is about seeds generally:** a fixture designed to
exercise a background job will, once that job runs, contain state the fixture
did not create. "Delete everything with my prefix" is only true before the
first tick.

### 37. Updating the Privacy Policy or Terms should force everyone to re-agree — shipped in v0.4.4

Asked (Aug 2026): every time the Privacy Policy or the Terms change, people
should be logged out before their next visit, so they have to agree to the
updated version before using the app again.

**Nothing in the app records agreement to anything today.** There is no
`accepted_*` column, no policy version server-side, and no consent check
anywhere — logging in *is* the implicit agreement, and the policy's own
"last updated" is `LAST_UPDATED`, a hand-maintained string constant in
`frontend/src/lib/legal.ts`. So this is two mechanisms, not one, and the
second is the one that makes it mean something:

1. **Revoke.** `revokeAllSessionsForUser` already exists in `lib/sessions.ts`
   — the logout half is a single call per user, or one `UPDATE sessions SET
   revoked_at = ?` across the table.
2. **Record.** A logout on its own does not capture consent; it just puts the
   login page in front of someone, which is where the agreement is already
   implicit. Getting the thing actually asked for ("they have to agree")
   needs a recorded acceptance: `users.accepted_policy_version`, set when
   they agree, and refused service until it matches.

**The version has to live in the Worker, not the frontend.** Enforcement is
server-side or it is decorative — a client-side check is bypassed by not
being the client. That means the current arrangement inverts: the Worker owns
`CURRENT_POLICY_VERSION`, the frontend reads it (from `/me`, which the app
already calls on every load) rather than holding its own copy. Two constants
that must agree, in two deployables, is exactly the drift
`scripts/check-env-parity.mjs` exists to catch elsewhere.

**Shape that fits what is already there:** bump a Worker-side
`CURRENT_POLICY_VERSION`; `requireAuth` (or a middleware just after it)
returns a distinct status — 403 with a machine-readable code, not a bare
403 — when `users.accepted_policy_version` is behind it; the frontend shows
the agreement screen and calls `POST /me/accept-policy`; every other route
stays refused until it does. Revoking sessions at the same time is then the
belt to that braces, and it is what makes it a *logout* as asked rather than
a quiet interstitial.

**Decided (Aug 2026), all four, after a walkthrough.** The finding that
shaped the first two: `DELETE /me` and `GET /me/export` both sit behind
`requireAuth`, so **a logged-out person cannot leave properly or take their
data with them.** "Agree or you cannot use the app" needs an answer for
someone who genuinely will not agree, and the only honest answers are *leave*
and *export*, both of which need a session. So the shape is a hybrid rather
than either extreme:

1. A version bump revokes every session — the logout, unambiguously.
2. Their next visit is the login page (public, and it links both documents).
   They log in, and the session issued is **unaccepted**: a check just after
   `requireAuth` refuses every route except `GET /me`, `GET /me/export`,
   `DELETE /me` and `POST /me/accept-policy`.
3. Accepting unlocks everything. Declining leaves them able to export, to
   delete, and to change their mind later.

Logging in therefore stops implying agreement, which is the thing that is
wrong today.

- **Declining keeps the exit door open**, as above. One caveat on
  presentation: `deleteUserCompletely` revokes sessions and then deletes
  **every event that person organised**, not only their own rows — so
  "delete my account" has blast radius on other people's calendars and must
  not sit one click from "I don't agree". Link to the existing Settings flow
  with its confirmation.
- **DMs keep going.** This is the architectural default rather than a new
  behaviour: the cron never reads sessions (its only reference is
  `pruneStaleSessions`, housekeeping), and recipients come from
  `event_invites` and `users.notifications_enabled`. Suppressing them is the
  option that costs work, and its cost lands on the wrong person — someone
  misses a session because they have not opened the website yet, and so does
  whoever organised it. Revisit only if a policy change is specifically about
  notifications.
- **The version is a hand-maintained constant**, not derived from the
  documents' contents. `legal.ts` already argues this case for `APP_VERSION`:
  a derived value makes "published" mean "last redeployed". Deriving this one
  from a content hash would log out every user for a typo fix. A CI guard
  against the forgotten bump was considered and left out for now — if it is
  ever added it has to be able to *fail usefully*, with a documented override
  for non-substantive edits, per what item 31 cost.
- **One version covering both documents.** They change rarely and almost
  always together; two counters double the bookkeeping and force the
  acceptance screen to explain which document moved. Accepted cost: splitting
  them later needs a migration, which is cheap in a repo that does them
  routinely and may never be needed.

**One more thing, small and easy to get wrong:** new users must be stamped
with the current version at signup (`upsertUser`), or someone who has just
created an account meets an acceptance gate as the first screen after the
login that created it.

**Specced as `specs/0012-policy-reacceptance.md`.** The design that made it
cheap: rather than a mass `UPDATE sessions` triggered by a deploy step
somebody has to remember, the session row records the policy version it was
issued under and `isSessionActive` requires it to still match. Bumping the
constant then invalidates every outstanding session lazily, on each holder's
next request — no mass write, nothing to run twice, and no extra query, since
`isSessionActive` already selects that row.

**Why this is worth doing before the next policy change rather than after.**
Two scheduled items rewrite the Privacy Policy:
`specs/0007-server-noticeboard.md` (blocked on it) and
`specs/0011-groups-without-servers.md` (changes what a group is). Both would
ship a materially different policy to people who agreed to the old one, with
no mechanism to notice. That is this roadmap's Rule 1 — a change to how we
ship comes before the things it would ship — applied to policy rather than
to code.

**Done in v0.4.4**, per `specs/0012-policy-reacceptance.md`, and the build
found a cheaper mechanism than the capture assumed. The obvious version is a
mass `UPDATE sessions SET revoked_at` fired by a deploy step somebody has to
remember; instead the session row records the policy version it was issued
under and `isSessionActive` requires it to still match. Bumping the constant
invalidates every outstanding session lazily, on each holder's next request —
no write, no deploy step, nothing to run twice, and no extra query, because
that function already reads the row.

Ships **dormant** at version 1 with matching migration defaults, so nobody was
logged out on the day it deployed. The mechanism was exercised on the sandbox
by bumping the constant there by hand.

The trap the spec named was real and is now pinned: `upsertUser` runs on every
login, so `accepted_policy_version` is in its INSERT list and not in its
`ON CONFLICT DO UPDATE` list. Verified by introducing exactly that mutation —
the named test fails and nothing else in the suite does, which is the whole
reason it exists. Without it the feature would have looked finished and done
nothing.

### 40. Merge candidate polls and window polls into one thing: candidates that are windows — shipped in v0.4.6

Asked (Aug 2026), and it is the better model rather than a third mode. Today
there are two:

- **`poll_mode = 'options'`** — `event_poll_options` rows with fixed
  start/end, voted yes/no/maybe.
- **`poll_mode = 'window'`** — one `window_start_at`/`window_end_at` on the
  event plus `window_block_minutes`, and people submit the sub-range they can
  commit to. `bestWindowBlock` slides a block across the window and picks the
  position the most people cover.

The ask: let each *candidate* carry its own window, with one minimum duration
across the poll. "25th 7:30-10, 26th 7:30-10, 30th 1-11, any 2.5-hour block in
any of those qualifies — and if everyone is free the whole time on the 30th,
we get a longer session."

**Why this is a merge and not an addition: both current modes are special
cases of it.** A candidate whose window is exactly the block length is
today's options poll. A poll with exactly one candidate is today's window
poll. That is the argument for one tab with a checkbox rather than three
modes to choose between — and for the two existing modes becoming presets of
the general one rather than surviving alongside it.

**The one genuinely new behaviour is the longer session.** `bestWindowBlock`
returns a block of *exactly* `blockMinutes` — it slides a fixed-width window
and maximises the count. "2.5 hours is a minimum, and if you're all free
longer you get longer" needs it to return the maximal span that still clears
the threshold, which is a different search: for each start, extend while the
covering set stays above the bar. That is a change to the resolution
algorithm, not just to the schema, and it needs its own bound — the existing
`MAX_WINDOW_CANDIDATES` ceiling exists because work already scales with span
x submissions, and this adds a dimension.

Rough shape of the rest: `window_start_at`/`window_end_at` move from `events`
onto `event_poll_options` (per candidate), `window_block_minutes` stays on the
event (one minimum for the whole poll), and `event_window_availability` keys
on the option rather than the event. It composes with
`poll_resolution_mode = 'multi_winner'` for free: each candidate resolves
independently once its best block clears the threshold, which is exactly what
multi-winner already means for options.

Not small — schema, resolution algorithm, the creation form, the voting UI and
the DM copy — and it wants a spec. It also subsumes **39**: an availability
grid that shows every candidate is the same view this needs, so doing 39 first
is not wasted, and doing 40 without it would leave the new mode unusable for
the same reason the old one is.

**Shipped in v0.4.6**, as `specs/0013`. What landed, and the two places it
differs from the sketch above:

- **`window_start_at`/`window_end_at` did not move onto
  `event_poll_options`** — the candidate's existing `start_at`/`end_at`
  simply changed meaning. Set a minimum and they are the window a session may
  fall in; leave it unset and the candidate *is* the session. So the whole
  shape of a poll is decided by one nullable column that already existed, and
  the checkbox in the form is literally "is `window_block_minutes` set?".
  `poll_mode` stops being read but stays in the schema: dropping a column the
  deployed Worker still reads is a two-release change.
- **The longer session orders its two objectives, and the order is
  load-bearing: most people first, then longest.** A poll that traded a
  person for an extra half hour would be choosing a longer session with fewer
  players. `bestWindowSpan` fixes coverage to what a minimum-length block can
  achieve, then stretches; it stays `O(grid x N log N)` because for a given
  start, the latest end `c` people can reach is just the `c`-th largest
  `endAt` among those who begin by then — no search over pairs.

`event_window_availability` moved to `(option_id, user_id)` in migration
0021, which is what lets one person answer about each candidate separately;
existing window polls were converted to single-candidate polls first so their
submissions had something to point at. Multi-winner composed as predicted,
with one wrinkle worth recording: confirming a *windowed* candidate has to
narrow its row from the window to the span that won, since unlike a fixed
slot it does not know its own session time until it resolves.

### 39. The availability grid shows one candidate day, and a fixed 8am-2am slice of it — shipped in v0.4.5

Reported while creating a real multi-option poll (Aug 2026): "can't see all
the availabilities at all the times." Both halves are real, and they are
different bugs.

**It only ever shows the first candidate.** `SchedulingAssistant` takes a
single `date` prop, and `EventFormPage` binds it to
`pollSlots[0]?.date` for an options poll. So a poll offering 25th, 26th and
30th August shows availability for the 25th and nothing else — and gives no
sign that the other two exist. The whole point of a multi-candidate poll is
comparing candidates, which is the one thing this cannot do.

**And it shows a fixed slice of that day.** `dayStartHour = 8`,
`dayEndHour = 26` are defaults nothing overrides, so the grid is always
8am-2am. Anyone busy at 7am reads as free, and a candidate slot proposed
outside that range has no column to appear in. The 2am end was a deliberate
choice ("sessions routinely run past midnight") and is fine; the 8am start is
the arbitrary half.

Fix shape, roughly: the assistant takes a *list* of ranges rather than one
date, renders a row per candidate, and derives its time axis from the
candidates themselves rather than from a constant — with the fixed axis kept
only as the fallback for a fixed-time event, which genuinely has one day.

Worth noting what this does *not* need: the `/guilds/:id/free-busy` endpoint
already takes an arbitrary `from`/`to` and returns opaque ranges, so this is
a frontend change. The cost to watch is one request per candidate day rather
than one — `MAX_POLL_OPTIONS` is 20, so it wants batching into a single
from/to spanning the candidates and slicing client-side, not a loop.

**Done in v0.4.5.** `SchedulingAssistant` takes a list of slots and draws one
strip per candidate, each scaled to its own span plus 90 minutes either side
so near misses are visible rather than clipped, with ticks that scale instead
of a fixed two-hour interval. One batched request across every candidate, not
one per candidate. Both halves of the complaint came from the same mistake and
went the same way: the view was built around a *day* and is now built around
what is being proposed.

### 41. A poll shows up on its deadline date, not on the days it might actually happen — shipped in v0.4.5

Asked (Aug 2026): "I'd also like to see pending events on the calendar."

They are on it — but not where you would look. `lib/calendar.ts` returns an
unresolved single-winner poll only when its **`poll_deadline_at`** falls in
the queried range, so it renders as one "Poll open" chip on the day voting
closes. The candidate days it is actually proposing — the whole content of
the poll — put nothing on the calendar at all. A poll offering the 25th, 26th
and 30th is invisible on all three.

(Multi-winner polls are different again: any active one is returned, and its
*confirmed* options render on their own days. Its unconfirmed options are the
same gap.)

So the ask is really: **render each candidate slot as a provisional chip on
its own day**, marked as not-yet-confirmed.

**The visual language is already half-built, and the suggestion fits it
exactly.** `EventChip` has two "not happening" treatments and keeps them
deliberately apart: opacity means *past* (item 27), strike-through means
*cancelled*, and the comment there explains that fading a cancelled event
would collapse the two into one indistinct grey. Pending is a third,
orthogonal state, so it needs a third mark rather than a shade — dashed
border or a diagonal hatch, as asked. It also has to compose: a candidate day
that has already gone by is both past *and* pending.

The cost to design rather than discover: **fan-out**. `MAX_POLL_OPTIONS` is
20, so one poll can put twenty provisional chips across a month, and
`MonthCalendarGrid` already caps a cell at three with a "+N more". A poll
with many candidates could bury real events under its own maybes. Worth a
rule — perhaps provisional chips lose to confirmed ones for the three slots,
or a poll contributes at most one chip per day.

**Done in v0.4.5.** The calendar query now also loads a poll whose candidate
slots fall in range, and emits one provisional occurrence per candidate,
capped at six per poll so twenty maybes cannot bury a month of real events.
The treatment is the one suggested here — a dashed outline in the group's own
hue over a faint fill — and it composes with past, so a candidate day already
gone by renders as both.

Two things caught building it, neither visible to the type checker: the
pending swatch was first assembled at the call site by string surgery on the
palette, which Tailwind never sees and therefore never emits (the chip would
have had no background and a grey border); and "Maybe · 7:30 PM" does not fit
a month cell, so `EventChip` gained `compact` and the month grid shows the
word while the agenda keeps the time.

### 42. A month-grid chip has room for the time or the title, and spends it all on the time — shipped in v0.4.5

Asked in the same breath, and it is a layout bug rather than missing data.
`EventChip` renders `{time} {title}` — the title is already there. But the
chip is a single `truncate` line in a seventh-of-a-grid cell, and "7:30 PM "
eats the whole width, so what renders is `7:30 PM …` with the title cut to
nothing. Every chip in a month therefore looks identical except for colour.

Fix shape: two lines rather than one — time small and dim on top, title
below, each truncating independently. The cell is `min-h-20` and caps at
three chips, so there is vertical room at the usual density; the trade is
that a very busy day hits "+N more" sooner. Worth also asking whether the
time needs the space it takes: `7:30 PM` is seven characters where `7:30p`
is five, and the leading zero-padded `h:mm a` format is the widest option
available.

The game is the other half of the ask ("nothing to show the event name or
game"), and — correcting this entry's first draft — it is **already on the
occurrence**: `mapOccurrence` sets `game: event.game` and `EventOccurrence`
types it. So it needs no payload change either; it is the same problem as
the title, one step further along. A month cell has no room for a third
line, so it belongs in the tooltip beside the server name, which is where
the colour-encoded group information already lives.

**Done in v0.4.5.** Two lines: time small and dim above, title below, each
truncating on its own. The game went to the tooltip — and, correcting this
entry's first draft, it was already on the occurrence and needed no payload
change.

### 44. The agenda's per-group colour gutter has never rendered — shipped in v0.4.5

Found while checking v0.4.5's own work: `AgendaList` colours each row's
left-hand time gutter with its group's hue, via
`palette.ring.replace('ring-', 'border-')`. Tailwind generates CSS by scanning
source text for class names, so a class assembled at runtime is never seen and
never emitted. Before v0.4.5 `colors.ts` contained exactly **one** literal
`border-[#…]` — so seven of the eight group colours produced no rule at all,
and every agenda gutter has quietly been the default border colour since the
agenda shipped.

**It started working in v0.4.5 by accident**, which is the part worth
recording. Item 41's `pending` swatch happens to contain the same literals
(`border-[<ring hex>]` for all eight), so adding it made the agenda's
long-broken gutter render for the first time. A bug fixed by coincidence is
one commit away from breaking again.

Fixed properly in the same release: `Swatch` gains a literal `border` field
and `AgendaList` uses it. Also marked the agenda's provisional rows while
there — see below.

**This is the second instance of the same mistake in two days**, and the first
was mine an hour earlier (item 41's first draft did exactly this, caught only
because the compiled stylesheet was checked). The rule worth writing down:
**a Tailwind class must exist as literal text somewhere the scanner reads.**
Anything built with a template string, a `.replace()`, or a lookup is not a
class — it is a string that looks like one. Worth a lint rule if it happens a
third time.

### 45. A Discord button press is not subject to the policy re-acceptance gate — shipped in v0.5

Found while building the interactions endpoint (v0.5, `specs/0010`), and it
is a consequence of the endpoint's own design rather than an oversight in it.

`requirePolicyAcceptance` (spec 0012) is middleware mounted on the
authenticated route groups, and it works by refusing with a machine-readable
403 that the frontend recognises and turns into the acceptance screen. The
interactions endpoint sits outside every one of those groups, because an
interaction carries no JWT and no session — so someone who has not agreed to
a new Terms can still record an RSVP or a poll vote by pressing a button in
a DM, while the same person is gated out of the website.

**Deliberate for now, and the reasoning should be checked rather than
assumed.** A consent gate works by *showing someone the documents and
letting them agree*, and a button press in a DM has nowhere to show them:
the honest options are to record the answer, or to refuse it with an
ephemeral "go and agree first". Refusing is defensible; silently recording
is what happens today.

What makes this worth deciding properly rather than leaving implicit:
- The gate exists because agreement should precede *use*, and recording an
  RSVP is use.
- But the DM was sent before the policy moved, so the button is an artifact
  of a world where they had agreed — closer to "finishing something already
  started" than to a fresh action.
- And the buttons only exist at all on messages the bot sent, so the blast
  radius is bounded to people who were already invited.

Worth answering alongside the components-on-DMs half of v0.5, since that is
what will make these buttons exist in the first place. An ephemeral "the
Terms changed, agree on the site and this button will work again" is cheap
and is probably the right answer.

**Decided and built the same day it was captured (v0.5).** A press from
someone behind on the current policy version is refused with an ephemeral
"the Terms have changed -- agree on the site and this button will work
again", carrying the link. Nothing is recorded.

The argument that settled it is the one in the third bullet above, read the
other way round: a consent gate works by *showing someone the documents and
letting them agree*, and a DM has nowhere to show them. Recording the answer
anyway would leave spec 0012's gate with a hole nothing in that spec
acknowledges, while refusing costs the person almost nothing -- the message
and its buttons are still sitting in their DMs once they have agreed.

The check is a version comparison on the row the handler already reads to
confirm the account still exists, so it costs no extra statement.

### 22. The calendar can only ever show this month and next month — shipped in v0.5

`CalendarPage` holds `tab: 0 | 1` and `monthWindow(monthsFromNow: 0 | 1,
zone)` takes that literal type, so there is no arbitrary month paging
anywhere in the app — you cannot look at December from August, and you
cannot look backwards at all. `fullWindow()` fetches exactly those two
months, so it's a data limit as well as a UI one.

Noticed while writing `specs/0008`, where it matters twice: it makes
idea 20's "does the sidebar follow the calendar or stay anchored to now"
much cheaper than it looked (the grid moves by one month, once, not to
"arbitrary months" as that entry assumed), and pitch C's value partly
rests on the ceiling being *invisible* rather than raised.

**It has a consequence now that it did not have before** (`specs/0014`,
Aug 2026). Attendance became per occurrence, and the decision there was that
someone may answer for any occurrence *the calendar shows* — so the window
this item is about is no longer only a navigation limit, it is the horizon
over which attendance rows can exist. Resolving 22 with real unbounded paging
would therefore mean unbounded attendance rows, which is a different
conversation from "let me look at December". The two want deciding together
if this one is picked up first.

Deliberately left out of v0.4: it's a behaviour change, not a design one.
Worth deciding whether the fix is a real month pager (prev/next without
bound, which means `/me/events` gets asked for arbitrary windows and the
query bound that made spec 0006 cheap needs re-checking) or simply a
wider fixed window. Also worth asking whether looking *backwards* at past
sessions is wanted — nothing in the app offers that today.

**Shipped (v0.5): a real pager, unbounded in both directions.** The entry
asked whether the fix was arbitrary paging or a wider fixed window, and
whether looking backwards was even wanted. Michael answered all of it at
once — all months, and yes, backwards too.

`monthWindow` took a `0 | 1` literal type, which is what made this a
compile-time ceiling rather than a preference; it now takes any integer. The
two tabs are a `‹ month ›` pager with a *Today* button that appears only when
it would do something.

**The query bound this entry worried about turned out not to exist.**
`GET /me/events` has always taken arbitrary `from`/`to`, capped at
`MAX_QUERY_RANGE_MS` (~366 days) — so the ceiling was entirely in the
frontend and the worker needed no change at all. What spec 0006 made cheap
was the *shape* of the query, not its range.

Two things came out of doing it that the entry did not predict:

- **The rail needed its own query, exactly as spec 0009 said it would.** That
  spec assumed the "anchored to now" horizon list would cost a second,
  smaller request, and it did not — because the two-month fetch always
  covered now. Removing the ceiling makes the prediction come true: a grid
  showing next March has nothing to say about what is on this week. The two
  fetches are independent, so paging does not re-fetch the horizon and a
  failed horizon does not take the calendar down.
- **The old fetch had an off-by-one-month bug at its far edge.** It asked for
  the start of this month to the end of next, but the grid pads with days
  from adjacent months — so the *next-month* grid's trailing days, up to six
  days into the month after, were always drawn empty whatever was scheduled
  on them. Asking for the grid's range rather than the month's removes the
  class rather than the instance.

Verified in a real browser against a local Worker and D1 seeded with one
event a month from two months back to three ahead: each month renders its own
event, forwards past the old ceiling and backwards past zero, and the rail
holds the two sessions inside its 60-day horizon while the grid sits in
November.

### 19. Make the bot interactive, not just a megaphone — shipped in v0.5

Today the bot is outbound-DM-only: it sends invites, reminders, poll results
and voice nudges, and has no way to receive anything back. Everything it
sends is a dead end that says "go to the website." Adding a Discord
**interactions endpoint** (Discord POSTs to the Worker, Ed25519-signed;
3-second response deadline with deferred replies for anything slower)
is one new inbound surface that unlocks all of the following:

- **Respond without leaving Discord**, tiered to the event type,
  because one widget does not fit all three:
  - *Fixed-time event* → three buttons (I'm in / Maybe / Can't), mapping
    straight onto `event_invites.rsvp_status`. Full fidelity.
  - *Options poll* → one multi-select menu of the candidate slots.
    Discord caps a select at 25 options and `MAX_POLL_OPTIONS` is 20, so
    it already fits. Chosen → `yes` per option; unchosen → no vote at
    all, which is exactly how `getOptionTallies`'s LEFT JOIN already
    treats absence, so it degrades gracefully. The yes/maybe/no nuance
    stays available on the site.
  - *Window poll* → a link button to the site, deliberately. Picking a
    continuous sub-range at 15-minute granularity (now potentially
    across several days, post-idea-6) has no honest Discord primitive:
    two dropdowns break past 25 steps, and a text modal means parsing
    free text.
- **Edit the original message when a poll resolves** — swap the vote
  control for the confirmed time and RSVP buttons. Cheap, since the
  message id is already in hand.
- **Slash commands** (`/schedule`, `/whos-free`, `/my-events`).
- **Discord Scheduled Events sync** — create the guild's native
  scheduled event when an Uncle Owen event confirms, which gets
  Discord's own calendar UI, notifications and interested-list for free.
- **Rich embeds instead of plain-text DMs** — pure formatting, but a
  large part of why the current DMs "read like spam/scam" (see idea 3).

**Explicitly ruled out (Aug 2026): posting event announcements to a
server channel.** It was considered as a way to make invites feel less
like unsolicited DMs, and rejected: a channel post is visible to
everyone with read access to that channel, including people who have
never used Uncle Owen, which breaks the model where an event is visible
to its organizer and invitees only. Everything above stays DM-and-site
scoped, and should remain so.

**Shipped (v0.5), as `specs/0010`.** One inbound endpoint turned the bot from
a megaphone into something you can answer: `POST /discord/interactions`,
authenticated by Ed25519 signature alone because an interaction carries no
cookie, no session and no header of ours.

What the capture got right: the tiering. Three event shapes really do want
three different controls, and the reason a window poll gets a link rather
than a widget is the one this entry guessed — there is no honest Discord
primitive for "any two and a half hours in this range".

What it got wrong is recorded as item 32, which turned out to be a schema
change rather than a freebie, and it got two more: the app's `custom_id`
needs a version in it (messages live in DMs indefinitely, and a button
pressed a year from now must be recognisably old rather than
misinterpreted), and a select's answer has to *clear* the candidates it
leaves out, or deselecting a night you previously said yes to leaves the old
yes standing.

Embeds, which spec 0010 scoped into this release, are the one part that did
not ship. The reason is in the spec: making them survive a retry costs a
third durable column, and not doing so makes a retried DM look different
from everyone else's. That is a decision to take with a Discord client open.

### 32. `sendBotDm` throws the sent message's id away, so idea 19's "edit the original message" is not the cheap sub-item it is written up as — shipped in v0.5

Idea 19 says editing a poll DM in place when the poll resolves is "cheap,
since the message id is already in hand". It isn't in hand anywhere:
`worker/src/lib/discord.ts`'s `sendBotDm` reads Discord's message-create
response only for `ok`/`status`/`retry_after`, never parses the body, and
returns `{ result, channelId }` — the id in that body is discarded at the
moment it arrives. Nothing in `migrations/*.sql` stores a message id either
(no column anywhere matches `message_id`), and `notification_log` dedupes on
its own key rather than on anything Discord returned.

So the sub-item costs: parsing the create response, widening
`DmSendResult`, a migration to persist `(notification, message id,
channel id)`, and a decision about what happens when the row is missing
because the DM predates the change or was sent by a different bot
application (production and sandbox are separate Discord apps, and a
message id is only editable by the application that sent it).

None of that is large, but it is a schema change inside a release that
was otherwise scoped as "one new inbound endpoint", and it is exactly the
kind of one-line-with-a-day-of-consequences item that idea 26's audit
turned out to be. It should be priced into spec 0010 rather than
discovered during it.

Found while surveying the worker for v0.5 readiness, Aug 2026.

**Half paid, Aug 2026 (v0.5 in progress).** `sendBotDm` now parses the
create response and returns the message id, `deliverThroughOutbox` records
it, and migration 0022 gives `notification_log` the column. The recording
costs the cron nothing: the id rides along in the `UPDATE ... SET
delivered_at` statement that was already being issued, which mattered more
than it sounds -- an extra write per delivery is precisely the unbudgeted
spend the Pass 9 review found.

Two things were decided while building it. The column went on
`notification_log` alone, not on the other two outbox tables, because
nothing edits a group nudge or a change-request DM and an unread column
goes stale unnoticed; `deliverThroughOutbox` therefore writes it
conditionally, which has its own test. And a 2xx whose body we cannot read
records *no* id rather than a guessed one, because the edit path reads "no
id" as "leave that message alone" -- the safe outcome -- while a wrong id
would edit an arbitrary message.

**Stays open** until the thing the id exists for -- editing the DM when the
poll resolves -- is actually built, along with the budget decision spec 0010
records for it (the edit is lower priority than the notification itself).

**And it turned out to have a sibling nobody had priced** (v0.5, migration
0023). The same argument that makes a message id worth storing makes a
message's *components* worth storing: migration 0014 exists because a retry
cannot re-derive what the source sweep rendered, and an options poll's select
lists the candidates as they were when the DM was written. Without that
column a retried invite would have arrived with its text and no buttons --
worse than the delivery it replaced, and only for the people whose first
attempt failed, which is the kind of difference nobody would ever notice.

**Fully paid (v0.5).** Migration 0022 gave `notification_log` the column,
`sendBotDm` parses the create response for the id, and `deliverThroughOutbox`
records it in the `UPDATE` it was already issuing — so the recording itself
costs the cron nothing.

And the thing the id existed for now uses it: `editSettledPollDms` rewrites
the vote DM when a poll settles. Migration 0024 records that the edit
happened, which is not bookkeeping for its own sake — without it the sweep
redoes the edit every fifteen minutes for as long as the poll stays in its
recency window, one Discord call per recipient per tick.

The entry's warning was right in substance and understated in scope: it
predicted a migration, and there were three (0022 for the id, 0023 for the
components a retry cannot re-derive, 0024 for the edit marker). "One line
with a day of consequences" is exactly what it was.

### 47. A confirmed multi-winner poll day gets no reminders at all — shipped in v0.5

Found while designing the reminder ladder (item 48, `specs/0014`), and it is
a live bug rather than a design gap.

`markResolved` is the only thing that sets `events.start_at`, and it runs for
`single_winner` polls only. A `multi_winner` poll confirms individual days by
setting `confirmed_at` on each `event_poll_options` row and never touches the
parent event's start time — deliberately, because the event stays active and
keeps collecting votes on other days.

But `sweepReminders` selects `WHERE start_at IS NOT NULL`. So a confirmed
multi-winner day gets exactly one DM — `sweepConfirmedMultiWinnerOptions`'s
"this day is confirmed" — and then nothing. No 24-hour reminder, no 1-hour
reminder, ever. Every other event shape in the app gets both.

Nobody has reported it, which is its own lesson: a notification that never
arrives leaves no trace anywhere, and the sweep that should have sent it
reports success because it correctly found nothing to do.

Two ways to fix it, and they are not the same size:
- **Now, small:** teach the reminder sweep to select confirmed
  `event_poll_options` rows alongside events with a `start_at`. Contained,
  and it does not wait for anything.
- **Later, structural:** `specs/0014`'s fan-out, where a confirmed day
  becomes a real event and every reminder path works on it with no special
  case at all.

The first does not block the second and should probably just be done.

**Fixed (v0.5), and where it went is the interesting part.** The reminder
now rides along in `sweepConfirmedMultiWinnerOptions`, which already scans
every confirmed multi-winner day, rather than in a sweep of its own.

The first attempt *was* a sweep of its own, and measuring it turned up
something worth keeping: one extra fixed query per tick did not merely slow
the tick down, it stopped `sweepPurgeTerminalHistory` running **at all** —
not at 40 ticks, not at 200. A cursored sweep costs one query on every tick
forever whether or not it finds anything, and the tick's usable allowance
after `RESERVED_QUERIES` was exactly enough that one more left the purge
permanently short of the budget it needs to start.

So the rule this leaves behind: **a new cursored sweep is not free, and its
cost is paid by whatever runs last.** Folding work into a scan that already
visits the right rows costs nothing fixed at all. `test/pass6.test.ts` is
what caught it, and it now says so.

### 50. An invite DM is still sent for a poll that has already resolved — shipped in v0.5.1

Found by accident, Aug 2026, while testing v0.5: the resolve fixture's poll
was voted on *in the app* before its invitation DM had gone out, which left
an invite queued for a poll that was already settled.

`sweepNewInvites` filters on `e.status != 'cancelled'` and nothing else, so a
resolved event is still an event people get invited to. For a fixed-time
event that is correct — "you're invited to this thing on Thursday" is true
whatever the event's status. For a *poll* it is not: the DM says "you've been
invited to vote on X" about a question that has an answer.

**Pre-existing, and v0.5 is what made it visible.** Before, that DM was text
ending in a link, and following the link showed a resolved poll — mildly
odd, easy to miss. Now it carries a select of candidates, and pressing it
answers "Voting is closed for this event", which is a control that exists
only to refuse.

It half-heals itself, which is its own trap. Within a tick the sweeps run in
this order: `sweepSingleWinnerPollNotifications` (which now performs
edit-on-resolve) comes *before* `sweepNewInvites`. So tick N sends the stale
invite and records its message id; tick N+1's edit finds that id and rewrites
the message into "is settled: …" with RSVP buttons. The wrong DM therefore
exists for about fifteen minutes and then quietly becomes the right one —
which means anyone who looks later sees nothing wrong.

Options, roughly in order of honesty:
- **Don't invite anyone to vote on a settled poll.** Add `AND NOT (e.event_type
  = 'poll' AND e.status <> 'active')` to the sweep. One predicate, and it
  stops the wrong message being sent rather than fixing it afterwards.
- **Send it, but as the settled message.** More code, and it duplicates what
  edit-on-resolve already renders.
- **Leave it**, on the grounds that the edit tidies up within a tick. Rejected
  in advance: a DM that says the wrong thing for fifteen minutes is a DM that
  says the wrong thing, and "it fixes itself before most people look" is the
  reasoning that let item 47 hide for a whole release.

Worth doing with idea 46, since both are about a DM whose contents no longer
match the state behind it.

**How it shipped.** One predicate, as the capture predicted:
`AND NOT (e.event_type = 'poll' AND e.status != 'active')` in
`sweepNewInvites` — the "don't send it" option, since "send it as the settled
message" duplicates what edit-on-resolve already renders.

Worth keeping the note on why it hid. The resolve sweep runs *before* the
invite sweep, so tick N sent the wrong DM and tick N+1 rewrote it into the
right one: fifteen minutes of wrongness that leaves no trace afterwards. Same
shape as item 47, and both were found by watching a tick happen rather than
by reading the code.

### 51. A resolved poll's RSVP is recorded but never read — shipped in v0.5.1

Found while testing v0.5 (Aug 2026), one layer under item 50 and sharper.

v0.5 puts RSVP buttons on a poll's DM once it settles — edit-on-resolve
rewrites the vote message into "is settled: Thursday" with *I'm in / Maybe /
Can't make it*, and the poll_resolved notification carries them too. Pressing
one writes `event_invites.rsvp_status`, and the event page shows it back.

But **nothing about a poll's attendance reads that column.**
`getConfirmedAttendeeIds` answers "who is coming" from the yes-votes (or, for
a windowed poll, from availability covering the resolved span). `rsvp_status`
enters only through `ORGANIZER_UNLESS_DECLINED`, which applies to the
organizer alone.

So on a resolved poll: an invitee who presses *Can't make it* is still in the
confirmed set, still gets the voice-channel DM, still counts as attending. A
vote cast a week ago outranks an answer given a minute ago, and the app shows
no sign of the disagreement.

**This is a data-model question, not a bug to patch.** A poll's vote and an
event's RSVP are two different statements — "that night works for me" and "I
am coming" — and the app has quietly used the first as a proxy for the second
since polls existed. That was fine while the second did not exist for polls.
v0.5 created it.

Three ways it could go:
- **Once resolved, a poll is an event**: attendance comes from `rsvp_status`,
  and the winning votes seed it (everyone who voted yes starts as accepted).
  Clean, and it is a migration plus a rule about which votes convert.
- **RSVP overrides the vote where one exists**, votes fill in the rest. No
  migration, one `LEFT JOIN`, and a confirmed-set query that is harder to
  read.
- **Take the buttons off a resolved poll.** Honest, and it gives up the thing
  v0.5 was for.

Wants deciding with `specs/0014`, whose fan-out makes a confirmed poll day
into a real event — at which point the first option is what happens anyway
and this stops being a question.

Related: item 50 (a settled poll still invites people to vote) and the
comment in `sweepConfirmedMultiWinnerOptions` explaining why a multi-winner
day's reminder carries no buttons at all.

**How it shipped: option 2, the interim.** An RSVP overrides the vote where
one exists; votes fill in the rest. `tentative` overrides too and lands
outside the confirmed set — not a judgement about maybes, just the reading a
fixed-time event already gives them. A `pending` row, or no row at all, is
not an answer and falls through to the vote, which is what stops the change
emptying every poll nobody has pressed anything on.

Option 1 — once resolved, a poll is an event — remains the endgame, and
arrives as a consequence of `specs/0014`'s fan-out rather than as work of its
own. The interim went first because this was a wrong answer live in
production rather than a missing feature.

**What it deliberately did not touch:** the sibling confirmed-set query in
`sweepConfirmedMultiWinnerOptions`. No invitee to a multi-winner poll can
have an `rsvp_status` other than `pending` today — those DMs carry no buttons
and the website offers RSVP controls only for a fixed-time event — so the
join would cost a correlated lookup per candidate per tick to read a
constant, against a budget already measured starving another sweep. The
asymmetry is written down in both files rather than left to be rediscovered.
