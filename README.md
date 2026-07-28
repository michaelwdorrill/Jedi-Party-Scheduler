# Jedi Party Scheduler

A scheduling site for a Discord friend group. Log in with Discord, see the
calendar for the servers you and the site's owner have both allow-listed, and
create/RSVP to gaming sessions with your friends.

## How it works

- **Login**: Discord OAuth2. Only members of allow-listed Discord servers can
  use the app for that server.
- **Calendar**: shows the current month and next month for a chosen server.
  Create one-off or recurring events, invite individuals or saved groups
  (e.g. "the raid team"), or propose several candidate time slots as a
  "potential invite" poll that resolves once enough people are in or a
  deadline passes.
- **Notifications**: a Discord bot DMs invitees when they're invited and
  reminds participants before a session starts.

## Repo layout

- `frontend/` — static site (Vite + React + TypeScript), deployed to GitHub
  Pages.
- `worker/` — Cloudflare Worker (TypeScript, Hono, D1) that handles Discord
  OAuth, all the app's data, and a cron job that sends Discord DM
  notifications.
- `docs/SETUP.md` — manual setup checklist (Discord app/bot, Cloudflare
  account, GitHub Pages) required before this runs for real.
- `docs/ARCHITECTURE.md` — architecture notes.

## Local development

```bash
# Worker (needs Node 22+ -- the pinned Wrangler declares engines >=22, and
# the test harness uses the built-in node:sqlite module)
cd worker
npm install
npm run dev

# Frontend
cd frontend
npm install
npm run dev
```

See `docs/SETUP.md` for the one-time provisioning steps (Discord application,
Cloudflare D1 database and secrets, GitHub Pages configuration) needed before
this works end-to-end with real Discord accounts.
