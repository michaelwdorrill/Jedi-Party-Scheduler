# Future ideas (the capture surface)

Things written down the moment they're thought of, so they aren't lost —
mostly during the Pass-3/4 security review cycle and after. Deliberately not
designed or scoped here, just captured, and the numbering is chronological
rather than any kind of priority.

**Ordering now lives in `ROADMAP.md`, and design in `specs/`.** An idea is
captured here, scheduled there, specced there, and only then built — a
paragraph in this file is not a design, and nothing should be built straight
out of it. Adding a new idea here does not require touching the roadmap; the
roadmap gets revisited between phases.

1. **A sandbox/staging environment separate from production.** A second
   Cloudflare Worker + D1 database (and possibly a second Discord
   application/bot) to build and test future features against, instead of
   building directly in prod.

2. **Google Calendar sync.** Pull a single chosen Google calendar (not all of
   them — e.g. just "D&D Scheduling", not "Family" or "Fulham FC") in as
   read-only availability on the Uncle Owen calendar, and push events the
   user is part of back out to Google. Flagged as the biggest lift: real
   OAuth-with-Google plumbing, a second set of tokens to store/refresh
   securely, a sync/conflict model, and a new privacy surface (which
   calendar, which direction, what Google sees) that the Privacy Policy would
   need to cover.

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

3. **Manual, event-specific invite links.** A link (not a bot-sent DM) that
   takes a specific person straight to one event, or to the poll/time-options
   for one event, so the organizer can paste it into their own message rather
   than have the bot DM a link that reads as spam/scam.

4. **Calendar weeks should run Sunday–Saturday, not Monday–Sunday.**

5. **Calendar-first, not server-first** (was: "calendar landing view").
   Land on "just your calendar" with no guild-switcher tab up front. Then
   offer views for: a specific server's calendar (showing blocked/busy time
   even for events you're not invited to — i.e. free/busy, not full detail),
   your personal events only, your Uncle Owen game events only, and
   personal+game combined.

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

6. **Poll date/time handling inconsistency.** A fixed-time event lets you set
   separate start and end dates/times. Potential-invite events (both
   candidate-day polls and the time-window mode) currently don't offer that
   same separate start-date/end-date shape — worth revisiting so the two
   creation paths behave consistently.

7. **Pick the server directly on the New Event screen.** Right now which
   server an event belongs to is set by the top-bar guild switcher, and the
   event form just inherits whatever that's currently set to. That's not
   coming across as intuitive — the New Event screen itself should offer a
   server picker rather than relying on a dropdown elsewhere on the page.

8. **Visual design pass.** The app has had zero design attention — it's
   functional, not designed. Wants pitches/options for making the whole
   platform look better (layout, color, typography, general polish) before
   or around release.

9. **Self-service "add this bot to your server" link, gated by owner
   approval.** A public page/link (distinct from the raw Discord OAuth bot-add
   URL, which just adds the bot with no guardrail) that lets someone add the
   bot to their own Discord server. If that server is already on the
   allow-list, it just works. If it isn't, the request queues instead of
   silently granting access, and the site owner gets an email to approve or
   reject it before the server can actually use the app. Needs: an outbound
   email path (nothing in the Worker sends email today — SETUP.md's contact
   address is just a mailto link on the legal pages), a pending-request state
   in D1 distinct from the existing `guilds` allow-list, and an approve/reject
   action (email link with a signed token, or a page under `/admin`) that
   feeds the same allow-list insert the manual `curl`/`wrangler d1 execute`
   step in SETUP.md does today.

10. **Auto-delete accounts that have gone stale.** If someone hasn't logged in
    for a year, warn them by DM at two weeks and one week out, then purge them
    from the system if they still haven't logged back in. Point of it: a
    synced integration (see idea 2, Google Calendar) shouldn't quietly keep
    running forever for someone who's stopped using the site. Needs: a
    last-login timestamp to sweep on (cron, same pattern as the existing
    reminder sweeps), two new DM types, and reusing the account-deletion path
    `SettingsPage.tsx`'s type-to-confirm delete already exercises — minus the
    user initiating it. Worth deciding whether "logged in" should also count
    as "used" for someone who stays signed in and never opens the site, and
    whether organizing/being invited to a future event should suppress the
    purge even if login is stale.

11. **Owner-only view of everyone signed up.** A page (or endpoint) restricted
    to the site owner — same `OWNER_DISCORD_ID` check `worker/src/routes/admin.ts`
    already uses for the guild allow-list — listing every user across all
    servers: who they are, which guilds they're in, last login. No one else
    would be able to see it. Mostly needs a frontend page; the owner-only
    check and the underlying `users` table already exist.

12. **Stop an end date/time before the start from being enterable at all in
    the New Event form.** `worker/src/lib/validate.ts` already rejects
    `endAt <= startAt` server-side, but `EventFormPage.tsx` has no client-side
    guard, so the only feedback right now is a rejected submit. Found while
    testing after the schema-drift fix (see SETUP.md) — the form let you set
    an end date/time before the start with no warning until you tried to
    save. Worth deciding the exact UX: disable the Save button and show an
    inline message, or auto-push the end forward as you change the start.
    Applies to the single-event start/end fields; the poll slot rows and the
    time-window mode have their own start/end pairs and would need the same
    treatment.

13. **Let invitees ask the organizer for a change.** Two requests, same shape:
    "can we move this?" (with a proposed new time) and "can we also invite
    this person?" (naming someone). Today the only way an invitee can push
    back on a time is to decline, which loses the information — the organizer
    sees a "no" and not "no, but Thursday works" — and there is no in-app path
    at all to suggest another guest; that conversation currently happens in
    Discord and never reaches the event. Deliberately a *request*, not an
    edit: the organizer stays the only person who can change the event, and
    accepting a request is what applies it. Needs a new table for the pending
    requests, two new notification types on the existing outbox (organizer
    gets "someone asked for X", requester gets the accept/decline back), and
    a decision about what happens to an open request when the organizer edits
    the event out from under it — `events.revision` (migration 0013) already
    gives us a token to detect exactly that. Also worth deciding whether the
    "invite this person" flavour can name someone the requester can see but
    the organizer can't, and whether a request count needs bounding the way
    every other per-event surface is.

14. **Promotion from sandbox to prod should be one boring step.** The
    companion to idea 1: standing up a second Worker + D1 is only half of it,
    and the half that doesn't decide whether the sandbox actually gets used.
    If shipping a change that has been verified in the sandbox means hand-run
    `wrangler` commands, hand-copied secrets, or remembering which of the two
    databases a migration has been applied to, the sandbox becomes the thing
    you skip when you're in a hurry — which is precisely when you shouldn't.
    The target is: merge to `main` and prod gets what the sandbox already
    proved, with no step that depends on remembering anything. Notably this
    is not a from-scratch build — `.github/workflows/deploy-worker.yml` and
    `deploy-pages.yml` already typecheck, test, migrate and deploy on push to
    `main`; what's missing is a second environment for them to target first,
    and a promotion path between the two that can't silently diverge. The
    schema-drift incidents in SETUP.md are the argument for care here: the
    failure mode isn't "the deploy errors", it's "the deploy reports success
    against a database that doesn't match the code".

15. **The owner-only user list can't tell "never a member" apart from "was a
    member, later marked departed."** Found while diagnosing why a Discord
    server member showed zero servers on `/admin/users` despite genuinely
    being in one of them: `user_guild_membership` rows aren't deleted when
    someone leaves (or is recorded as having left) a server — `is_member`
    just flips to 0, either via `syncGuildMembership` (an OAuth login's own
    fresh guild list came back without that guild) or the cron's
    `revalidateStaleMemberships` (a periodic bot-API recheck said
    `not_member`). The admin endpoint's `WHERE ugm.is_member = 1` filter
    (`worker/src/routes/admin.ts`) makes both of those look identical to
    "this person has never been in that server" — the only way to tell them
    apart today turned out to be a raw SQL query against
    `user_guild_membership` for one specific user. Worth either showing
    departed memberships greyed-out/labeled on the same page, or exposing
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

16. **A group's creator can never be counted as a member of their own
    group.** Found in production: the "Spacebros" idle-group nudge fired
    correctly (`sweepIdleGroups`, `worker/src/cron/reminders.ts` — right on
    schedule, to the second) but the creator never got it, because they were
    never in `group_members` to begin with. That's not an oversight in one
    save — it's structural, and it's a closed loop:

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

17. ~~Two frontend dependency majors deliberately sitting behind `npm
    audit`.~~ **Done.** Both cleared: `react-router-dom` 6→7.18.2 and
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

18. **A multi-day window poll's availability slider shows only times, no
    dates, once submissions can span more than one day.** Found while
    building idea 6 (poll date/time consistency): `WindowAvailabilityPicker.tsx`
    was already generic over the window's full millisecond span (it never
    assumed a single day), so letting the organizer's form propose a
    multi-day window (e.g. "Friday evening through Sunday night") needed no
    change there. But its labels (`fmt()`, `h:mm a` only) and the
    submission-bar tooltips show a bare time-of-day — fine when the whole
    window fits in one day, ambiguous once it doesn't ("6:00 PM" on which of
    the window's days?). Fix shape: switch `fmt()` to include the date
    whenever `windowEndAt - windowStartAt` exceeds 24h, mirroring how
    `formatTimeRange` already leads with the date for exactly this reason.
    **Done** — shipped in v0.2.

19. **Make the bot interactive, not just a megaphone.** Today the bot is
    outbound-DM-only: it sends invites, reminders, poll results and voice
    nudges, and has no way to receive anything back. Everything it sends is
    a dead end that says "go to the website." Adding a Discord
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

20. **Merge the Dashboard into the Calendar as one landing page.** Two
    top-level tabs currently split what is one question. `/` is the
    Dashboard — a "Welcome back" header, the New Event / Personal time
    buttons, and an "Upcoming sessions" list — and `/calendar` is the grid.
    The itinerary would work better as a **right sidebar alongside the
    calendar** than as a separate tab you have to go to first.

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

21. **Clicking an event chip on the month calendar opens the New Event form
    instead of the event.** `MonthCalendarGrid` renders each day cell as
    `<button onClick={() => onDayClick(day)}>` and nests the day's
    `EventChip`s inside it — and `EventChip` renders a react-router `<Link>`,
    i.e. an `<a href>`. So a click on a chip triggers the chip's own
    navigation *and* bubbles to the day cell's handler, which
    `navigate('/events/new?date=…')`. The day-cell handler runs second and
    wins, so the event you clicked never opens.

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

22. **The calendar can only ever show this month and next month.**
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

23. **The sandbox has no frontend, so the sandbox-first rule has a blind spot
    for frontend-only changes.** `deploy-sandbox.yml` is worker-only — every
    step runs with `working-directory: worker` — and `deploy-pages.yml`
    publishes the frontend from `main` and nowhere else. So pushing a
    frontend-only branch to `sandbox` deploys a Worker that didn't change and
    puts the actual diff nowhere anyone can click.

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

24. **A failed API call is displayed as "you have nothing scheduled".**
    `CalendarPage` does
    `api.get(...).then(setOccurrences).finally(() => setLoading(false))` —
    no `.catch`. `api.get` *does* throw an `ApiError` on a non-ok response
    (`client.ts`), so the rejection goes unhandled, `occurrences` stays `[]`,
    `loading` flips to false, and the user is shown the cheerful empty state:
    "Nothing scheduled in this window yet."

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

25. **CI actions are on a deprecated Node runtime.** Every workflow pins
    `actions/checkout@v4` and `actions/setup-node@v4` — ten call sites across
    `ci.yml`, `deploy-pages.yml`, `deploy-sandbox.yml` and
    `deploy-worker.yml`. GitHub now forces those onto Node 24 and emits a
    deprecation warning on every run (seen on Deploy Sandbox #1).

    Advisory today, a broken deploy whenever GitHub stops forcing the
    substitution. Bumping both to `@v5` is a ten-line change with no logic in
    it — the kind of thing that is trivial now and an emergency later, on the
    day a release is already blocked.

    Worth pairing with a decision about whether to pin action versions by
    major at all, since this will recur every couple of years.
