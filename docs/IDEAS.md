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

3. **Manual, event-specific invite links.** A link (not a bot-sent DM) that
   takes a specific person straight to one event, or to the poll/time-options
   for one event, so the organizer can paste it into their own message rather
   than have the bot DM a link that reads as spam/scam.

4. **Calendar weeks should run Sunday–Saturday, not Monday–Sunday.**

5. **Calendar landing view.** Land on "just your calendar" with no
   guild-switcher tab up front. Then offer views for: a specific server's
   calendar (showing blocked/busy time even for events you're not invited to
   — i.e. free/busy, not full detail), your personal events only, your Uncle
   Owen game events only, and personal+game combined.

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
