# Setup checklist

This app is two halves: a static frontend on GitHub Pages, and a Cloudflare
Worker + D1 backend. The coding agent that built this repo could write all
the code, SQL, and config, but it cannot create your Discord application,
your Cloudflare account/database, or configure your GitHub repo's settings —
those require your own credentials. Do these steps yourself, in order.

## 1. Discord Developer Portal

1. Go to https://discord.com/developers/applications and create a **New
   Application** (e.g. "Jedi Party Scheduler").
2. Under **OAuth2 → General**, note the **Client ID** and **Client Secret**
   (you'll need both later).
3. Still under **OAuth2 → General**, add a **Redirect URI**:
   `https://<your-worker-subdomain>.workers.dev/auth/callback`
   (you'll get the exact `workers.dev` URL in step 2.7 below — you can come
   back and add it once you have it, or add it now with a placeholder and
   fix it after deploying).
4. Go to the **Bot** tab, click **Add Bot**, and copy the **Bot Token** (you
   won't be able to see it again — regenerate it if you lose it).
5. Under **Bot**, you don't need any privileged gateway intents — the bot
   only ever sends DMs via the REST API, it never maintains a live gateway
   connection.
6. Go to **OAuth2 → URL Generator**, check the `bot` scope, and under bot
   permissions check at least **View Channels**. Copy the generated URL,
   open it, and add the bot to **every** Discord server you want this app to
   support (the bot must share a server with a user for DMs to work
   reliably).
7. Decide which Discord server(s) (guilds) you want the app to support —
   you'll add their server IDs to the allow-list in step 4 below. To get a
   server's ID, enable Developer Mode in Discord (User Settings → Advanced),
   then right-click the server icon → **Copy Server ID**.

## 2. Cloudflare (Workers + D1)

Do this from a terminal with the `worker/` directory as your working
directory — i.e. after cloning this repo, `cd Jedi-Party-Scheduler/worker`
(running `npm install` from your home directory, with no `package.json`
there, is what `ENOENT ... package.json` means).

**Use a scoped API token instead of `wrangler login`.** The interactive
`login` flow always requests every permission Wrangler could ever need
across all Cloudflare products (Workers, Pages, AI, email routing, and so
on) — there's no way to narrow what that flow asks for. An API token you
create yourself can be limited to exactly the two things this project
needs: editing Workers scripts and editing D1 databases.

1. Create the new Cloudflare account you mentioned wanting to use for this
   project, if you haven't already.
2. Install dependencies if you haven't: `npm install`.
3. Create a scoped token:
   - Go to https://dash.cloudflare.com/profile/api-tokens
   - Click **Create Token → Custom token** (not one of the templates)
   - Add two permissions: **Account / Workers Scripts / Edit** and
     **Account / D1 / Edit**. (Optional third: **Account / Workers Tail /
     Read**, only if you want to run `npx wrangler tail` to watch live
     logs.)
   - Under **Account Resources**, scope it to the one Cloudflare account you
     just created, not "All accounts".
   - Leave Zone Resources alone (this project doesn't touch zones/DNS).
   - Create it and copy the token — you won't see it again.
4. Find your **Account ID**: it's on the right sidebar of the Cloudflare
   dashboard's overview page (any page under dash.cloudflare.com shows it).
5. Set both as environment variables in your terminal. In Windows
   PowerShell:
   ```powershell
   $env:CLOUDFLARE_API_TOKEN = "paste-your-token-here"
   $env:CLOUDFLARE_ACCOUNT_ID = "paste-your-account-id-here"
   ```
   These only last for the current PowerShell window. If you'd rather not
   retype them every session, set them permanently with `setx` instead (open
   a **new** terminal afterward for it to take effect):
   ```powershell
   setx CLOUDFLARE_API_TOKEN "paste-your-token-here"
   setx CLOUDFLARE_ACCOUNT_ID "paste-your-account-id-here"
   ```
   On macOS/Linux, use `export CLOUDFLARE_API_TOKEN=...` (add to your shell
   profile to persist it).
6. Open `worker/wrangler.toml` and replace `account_id = "REPLACE_ME"` near
   the top with your real account ID too (belt-and-suspenders with the env
   var — this avoids Wrangler needing to *list* your accounts, which the
   scoped token above deliberately can't do).
7. Create the D1 database: `npx wrangler d1 create jedi-party-scheduler-db`.
   This prints a `database_id` — copy it.
8. In `worker/wrangler.toml`, replace
   `REPLACE_ME_AFTER_WRANGLER_D1_CREATE` under `[[d1_databases]]` with that
   `database_id`.
9. Apply the schema to the real (remote) database:
   `npm run db:migrate:remote`
   (this runs `wrangler d1 execute jedi-party-scheduler-db --remote --file=./migrations/0001_init.sql`).
10. Set the three secrets (you'll be prompted to paste each value):
   ```
   npx wrangler secret put DISCORD_CLIENT_SECRET
   npx wrangler secret put DISCORD_BOT_TOKEN
   npx wrangler secret put JWT_SIGNING_KEY
   ```
   For `JWT_SIGNING_KEY`, generate a random value yourself — on Windows,
   PowerShell's `[System.Convert]::ToBase64String((1..32|%{Get-Random -Max 256}))`
   works, or just mash the keyboard for 40+ random characters. (macOS/Linux:
   `openssl rand -base64 32`.) `wrangler secret put` also works fine with the
   API token from step 3 — no extra permission needed for it.
11. Edit the `[vars]` block in `worker/wrangler.toml`:
   - `DISCORD_CLIENT_ID`: the Client ID from step 1.2.
   - `FRONTEND_URL`: your GitHub Pages URL, e.g.
     `https://michaelwdorrill.github.io/Jedi-Party-Scheduler` (no trailing
     slash).
   - `OWNER_DISCORD_ID`: your own Discord user ID (enable Developer Mode,
     right-click your own name → **Copy User ID**). This is who's allowed to
     call the `/admin/*` endpoints to manage the server allow-list.
12. Deploy: `npm run deploy`. Note the `https://*.workers.dev` URL it prints.
13. Go back to the Discord Developer Portal (step 1.3) and make sure the
    redirect URI exactly matches `<that workers.dev URL>/auth/callback`.
14. The cron trigger (`*/15 * * * *`, in `wrangler.toml`) takes effect
    automatically on deploy — no extra step needed.
15. Seed the server allow-list. Easiest way: log into the site once (once the
    frontend is deployed, see below) so your own user exists in the `users`
    table, then call the admin endpoint with your JWT, e.g.:
    ```
    curl -X POST https://<your-worker>.workers.dev/admin/guilds \
      -H "Authorization: Bearer <your JWT>" \
      -H "Content-Type: application/json" \
      -d '{"id": "<discord server id>", "name": "Jedi Party"}'
    ```
    (Or insert directly: `npx wrangler d1 execute jedi-party-scheduler-db --remote --command "INSERT INTO guilds (id, name, is_active, added_at) VALUES ('<id>', 'Jedi Party', 1, <unix ms>);"`.)
    Log out and back in (or call `POST /auth/sync-guilds`) afterward so your
    membership cache picks up the newly allow-listed server.

## 3. GitHub Pages (frontend)

1. In the repo settings, go to **Settings → Pages** and set **Source** to
   **GitHub Actions**.
2. Go to **Settings → Secrets and variables → Actions** and add a repo
   **variable** (not secret, since it ends up in a public static bundle
   anyway) named `VITE_API_BASE_URL` set to your Worker's URL from step 2.12
   (e.g. `https://jedi-party-scheduler-worker.<you>.workers.dev`).
3. Push to `main` (or manually run the "Deploy Pages" workflow from the
   Actions tab) — `.github/workflows/deploy-pages.yml` builds `frontend/`
   and publishes it.
4. Visit `https://<your-username>.github.io/Jedi-Party-Scheduler/` and log
   in with Discord.

### Optional: auto-deploy the Worker from GitHub Actions

By default you deploy the Worker yourself with `npm run deploy` whenever
`worker/` changes. If you'd rather have CI do it, uncomment the job in
`.github/workflows/deploy-worker.yml` and add two repo secrets:
`CLOUDFLARE_API_TOKEN` (the same scoped token from step 2.3 works — it
already has the Workers Scripts:Edit permission this needs) and
`CLOUDFLARE_ACCOUNT_ID` (the same value from step 2.4).

## Verifying it actually works

None of the above can be exercised without your real Discord app and
Cloudflare project, so after finishing steps 1–3:

- Log in with Discord from the deployed site and confirm you land on the
  dashboard (not an error page).
- Confirm the server you allow-listed shows up in the guild switcher.
- Create a one-off event, then a recurring one, and check they both show up
  correctly across "This Month"/"Next Month".
- Have a friend log in (they need to already share an allow-listed Discord
  server with you) and confirm they appear as a "friend" you can invite.
- Invite them to something and confirm they get a Discord DM within about 15
  minutes (the cron cadence) — check the Worker's logs
  (`npx wrangler tail`) if it doesn't show up.
