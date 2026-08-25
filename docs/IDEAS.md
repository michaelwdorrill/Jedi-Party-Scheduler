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

### 19. Make the bot interactive, not just a megaphone

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

### 22. The calendar can only ever show this month and next month

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

Deliberately left out of v0.4: it's a behaviour change, not a design one.
Worth deciding whether the fix is a real month pager (prev/next without
bound, which means `/me/events` gets asked for arbitrary windows and the
query bound that made spec 0006 cheap needs re-checking) or simply a
wider fixed window. Also worth asking whether looking *backwards* at past
sessions is wanted — nothing in the app offers that today.

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

### 32. `sendBotDm` throws the sent message's id away, so idea 19's "edit the original message" is not the cheap sub-item it is written up as

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

### 33. The ground and the vaporators lost their positioning in v0.4 and have been unpinned ever since

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

### 34. A server member can see every group in that server, including ones they are not in — and every group's full member list

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

### 35. Show Discord avatars where people are listed

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

### 37. Updating the Privacy Policy or Terms should force everyone to re-agree

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

**Four calls this needs before it is built:**
- **What happens if someone declines.** They cannot use the app; the honest
  paths are "stay logged out" and "delete my account" (`DELETE /me` already
  exists and already does a full erase). The screen should offer both rather
  than trapping them on a wall.
- **Do the bot's DMs keep going to someone who has not re-agreed?** The cron
  does not read sessions at all, so by default: yes. Arguably right — they
  are still an invitee and the reminder is the service working — and
  arguably not, if the policy change is about what we do with their data.
  Needs an answer, not a default.
- **Does every edit bump the version?** Fixing a typo should not log out the
  world. So the version is bumped deliberately, like `APP_VERSION` is, and is
  not derived from the file's contents or its `LAST_UPDATED` string.
- **Terms and Policy: one version or two?** One is simpler and over-fires;
  two is honest and doubles the bookkeeping. Leaning one, on the grounds that
  this app changes both rarely and usually together.

**Considered and not chosen: a soft in-app gate with no logout.** Blocking
the API until acceptance would achieve consent without discarding sessions or
forcing an OAuth round trip, which is gentler and equally enforceable. The
ask was specifically for a logout, and there is a real argument for it — a
logout is unambiguous, and it puts the login page (which links both
documents) in front of the person rather than a dialog they can learn to
dismiss. Recording both here so the choice is visible rather than assumed.

**Why this is worth doing before the next policy change rather than after.**
Two scheduled items rewrite the Privacy Policy:
`specs/0007-server-noticeboard.md` (blocked on it) and
`specs/0011-groups-without-servers.md` (changes what a group is). Both would
ship a materially different policy to people who agreed to the old one, with
no mechanism to notice. That is this roadmap's Rule 1 — a change to how we
ship comes before the things it would ship — applied to policy rather than
to code.

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
