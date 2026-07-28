# Future ideas (backlog, not scheduled)

Logged during the Pass-3/4 security review cycle so they aren't lost, not
because any of them are being worked on yet. Deliberately not designed or
scoped here — just captured. Revisit once the app is release-ready and the
custom domain (F-03) is sorted.

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
