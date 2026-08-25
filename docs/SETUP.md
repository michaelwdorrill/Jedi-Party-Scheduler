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
7. Under **General Information**, fill in the two policy links. Discord
   requires both before an app can be verified, and its Developer Terms
   require users to have an accessible way to ask for their data to be
   modified or deleted. These pages ship with the app:
   - Terms of Service URL: `https://uncleowen.space/#/terms`
   - Privacy Policy URL: `https://uncleowen.space/#/privacy`

   If you have not set up the custom domain yet (section 4), use the default
   Pages URL for now -- `https://<your-username>.github.io/Jedi-Party-Scheduler/#/terms`
   and `.../#/privacy` -- and come back and change these once the domain is
   live. Discord does not re-check them, so a stale link here stays stale.

   **Before publishing them**, open `frontend/src/lib/legal.ts` and replace
   `REPLACE_WITH_YOUR_CONTACT_EMAIL` with an address you actually monitor.
   Both documents cite it as the fallback route for data requests from anyone
   who can no longer sign in.
8. Decide which Discord server(s) (guilds) you want the app to support —
   you'll add their server IDs to the allow-list in step 2.15 below. To get a
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
   These only last for the current PowerShell window. To persist them, see
   **Working with more than one Cloudflare account** below — don't `setx`
   `CLOUDFLARE_API_TOKEN` directly if you have (or will have) a second
   account, because there is only one of that variable and whichever account
   owns it becomes a silent default for every project on the machine.

   On macOS/Linux, use `export CLOUDFLARE_API_TOKEN=...`.
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
   ```
   npm run db:migrate:remote
   ```
   Safe to run at any time, including repeatedly. Wrangler records every
   migration it has applied in a `d1_migrations` table on the database
   itself, so this only ever runs the files that are new to *that* database
   — there is no list of filenames to keep in step with, and nothing to
   remember about where you got to last time. To see what it would do
   without doing it:
   ```
   npm run db:migrate:status
   ```
   `worker/migrations/` is the source of truth for what exists; the
   `d1_migrations` table is the source of truth for what has run.

   Then confirm the real schema actually matches, rather than trusting that
   table alone (see "Never edit a migration file..." below for why that
   distinction matters):
   ```
   npm run db:verify -- --remote
   ```

   **This is also automated.** Once the repo secrets in
   "Auto-deploy the Worker from GitHub Actions" (below) are set, every push
   to `main` that touches `worker/` applies new migrations and then deploys.
   You only need to run the command by hand for a database CI does not
   deploy to, or to fix something up.
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
   - `FRONTEND_URL`: the site's public URL, no trailing slash. With the
     custom domain that is `https://uncleowen.space`; without one it is
     `https://<your-username>.github.io/Jedi-Party-Scheduler`. This has to
     match what browsers actually use -- it is where OAuth redirects land and
     what every DM's event link points at, so a stale value sends people to a
     dead page after login.
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
    Log out and back in afterward so your membership cache picks up the
    newly allow-listed server (guild membership is re-synced on every login).

### Working with more than one Cloudflare account

Wrangler reads exactly one set of credentials: `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID` if they are set, otherwise whatever `wrangler login`
last stored in `~/.wrangler/config/default.toml`. Both are machine-wide
singletons, so with two accounts the question is never "am I authenticated?"
but "authenticated as *whom*, right now?"

Rather than swapping the single default back and forth, give each account its
own permanent pair and copy the right one into the variables Wrangler reads.

**Once per account** (PowerShell; `setx` writes it permanently):

```powershell
setx CF_TOKEN_UNCLEOWEN  "token-for-the-uncle-owen-account"
setx CF_ACCOUNT_UNCLEOWEN "f22e4f3ece3f69c4bd0da97be4f7a3b6"

setx CF_TOKEN_HOMEBASE   "token-for-the-home-base-account"
setx CF_ACCOUNT_HOMEBASE "4423ae7ab29989bc318c47c9a9723608"
```

A third account is two more variables and no other changes.

**Naming rule: one pair per Cloudflare *account*, named for what the account
is for — never for the email that owns it, and never for an individual
project.** `homebase` is a shared account holding several projects
(auth/SSO plus its tenant apps); every one of them uses
`CF_TOKEN_HOMEBASE`, not a token of its own. `uncleowen` is this project's
own account, used only here. A new personal tool added to Home Base reuses
`CF_TOKEN_HOMEBASE` — it does not get a new pair. A genuinely new Cloudflare
account (a different outward-facing project, say) gets its own pair, named
for that account's purpose.

This repo can't write to another project's files, so propagating the
convention there is manual: drop something like this into that project's
`CLAUDE.md` —

```markdown
## Cloudflare credentials

This project deploys into the **<account-name>** Cloudflare account.
Run `Use-CF <account-name>` before any `wrangler` command — never rely on
an ambient/default login, since this machine holds credentials for more
than one Cloudflare account. `Use-CF` and the `CF_TOKEN_*`/`CF_ACCOUNT_*`
variables are defined in the PowerShell profile, not in any one repo.
```

**Once, in your PowerShell profile.** This step is easy to skip past without
noticing — `Use-CF` is not a real PowerShell cmdlet, it only exists once the
function below is actually saved into your profile and that profile has been
reloaded. Check first:

```powershell
Get-Command Use-CF -ErrorAction SilentlyContinue
```

Nothing printed means it isn't defined yet. Open the profile and add the
function:

```powershell
notepad $PROFILE
```

(If `$PROFILE` doesn't exist yet, `notepad` will offer to create it — accept
that.)

```powershell
function Use-CF {
    param([Parameter(Mandatory)][string]$Account)

    $key   = $Account.ToUpper()
    $token = [Environment]::GetEnvironmentVariable("CF_TOKEN_$key", 'User')
    $id    = [Environment]::GetEnvironmentVariable("CF_ACCOUNT_$key", 'User')

    if (-not $token -or -not $id) {
        Write-Host "No stored credentials for '$Account'." -ForegroundColor Red
        Write-Host "Expected CF_TOKEN_$key and CF_ACCOUNT_$key."
        return
    }

    $env:CLOUDFLARE_API_TOKEN  = $token
    $env:CLOUDFLARE_ACCOUNT_ID = $id
    Write-Host "Cloudflare: $Account ($id)" -ForegroundColor Green

    # If this directory is a Worker project, check it belongs to that account.
    $toml = Join-Path (Get-Location) 'wrangler.toml'
    if (Test-Path $toml) {
        $m = Select-String -Path $toml -Pattern '^\s*account_id\s*=\s*"([^"]+)"' |
             Select-Object -First 1
        if ($m -and $m.Matches[0].Groups[1].Value -ne $id) {
            Write-Host ("WARNING: wrangler.toml here belongs to account " +
                        $m.Matches[0].Groups[1].Value + ", not this one.") -ForegroundColor Yellow
        }
    }
}
```

It reads the persisted values directly rather than through `$env:`, so a
`setx` takes effect immediately without opening a new terminal. The function
itself does need one of the two below before it's usable in your current
shell, since saving `$PROFILE` doesn't re-run it:

```powershell
. $PROFILE          # reload the profile in this window, or...
```
...or just close and reopen the terminal. Confirm it worked with the same
`Get-Command Use-CF` check from above — it should now print the function.

**Every session, before any `wrangler` command:**

```powershell
Use-CF uncleowen
```

This project only ever uses `uncleowen` — it is a single, standalone
Cloudflare account with nothing else deployed to it.

Finally, run `npx wrangler logout` once. That removes the stored OAuth
credentials, which exist only as a fallback — and a fallback is precisely
what makes a wrong-account command succeed quietly instead of failing. With
no default, forgetting `Use-CF` is an error rather than a deploy into
somebody else's account.

The `account_id` pinned in each project's `wrangler.toml` is the backstop: if
the active credentials don't match it, Wrangler refuses rather than touching
the wrong database. The exact error varies by command and isn't one fixed
code — `wrangler deploy` tends to say `Authentication error [code: 10000]`,
while `wrangler d1 execute`/`d1 migrations` against a database outside the
current account has been observed to say `The given account is not valid or
is not authorized to access this service [code: 7403]`. Both mean the same
thing here: the active account doesn't own the resource you're pointing at.
If you hit either, the fix is the same — re-run `Use-CF <account-name>` for
the account that actually owns it (check `npx wrangler whoami`'s Account ID
against the `account_id` in `wrangler.toml`) — not "get a new token".

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
   in with Discord. (Once section 4's custom domain is live, that becomes
   `https://uncleowen.space/`.)

## 4. Custom domain (optional, but this install uses one)

The site is served at `https://uncleowen.space`. Moving from the default
`*.github.io/Jedi-Party-Scheduler/` path to a domain root is not just a DNS
change -- three other things have to move with it or the site breaks in ways
that look unrelated.

### 4.1 Why `frontend/public/CNAME` is not enough

The usual GitHub Pages advice is "commit a `CNAME` file". That advice assumes
Pages is publishing from a branch. This repo publishes from a **GitHub Actions
workflow**, and in that mode the custom domain is configuration stored in the
repository settings -- the `CNAME` file is not what sets it.

The file is still committed, and still needed: each Actions deploy replaces
the published site wholesale, and without `CNAME` in the build output the
domain setting can be cleared on deploy. So you need **both**: the repo
setting (4.3) and the file (already present at `frontend/public/CNAME`).

### 4.2 DNS at your registrar

For an apex domain like `uncleowen.space`, add four A records and one CNAME:

| Type  | Host  | Value                                    |
|-------|-------|------------------------------------------|
| A     | `@`   | `185.199.108.153`                        |
| A     | `@`   | `185.199.109.153`                        |
| A     | `@`   | `185.199.110.153`                        |
| A     | `@`   | `185.199.111.153`                        |
| CNAME | `www` | `<your-username>.github.io.`             |

On Namecheap these go under **Domain List → Manage → Advanced DNS**. Delete
the default "parking page" URL-redirect record first -- if it stays, it
shadows the A records and you get the registrar's placeholder instead of the
site. Propagation is usually minutes, occasionally an hour.

### 4.3 Repo settings

**Settings → Pages → Custom domain**: enter `uncleowen.space` and save. Wait
for "DNS check successful", then tick **Enforce HTTPS** (it is greyed out
until the certificate is issued, which can take up to an hour).

Optionally, **Settings → Pages → verified domains** lets you verify ownership
so nobody else can point their Pages site at your domain if it ever lapses.

### 4.4 The two things that break if you skip them

1. **Vite's `base` must be `/`.** On the default Pages URL the site is served
   from `/Jedi-Party-Scheduler/`, so `frontend/vite.config.ts` set `base` to
   match. On a custom domain the site is served from the **root**, and that
   `base` makes every asset URL point at a path that does not exist -- the
   page loads, every script 404s, and you get a pure white screen with no
   error visible unless you open DevTools. `base` is now `'/'`; if you ever
   revert to the `github.io` URL, it has to go back.

2. **`FRONTEND_URL` in `worker/wrangler.toml` must match**, and the Worker
   must be redeployed (`npm run deploy`) after changing it. It is where the
   OAuth callback redirects to and what every notification DM links to. A
   mismatch means logging in dumps you on the old URL.

### 4.5 Revoke sessions at cutover

Sessions issued before the cutover were stored in the *old* origin's
`localStorage`, which the browser keys per origin -- they are not readable
from the new domain, so everyone is signed out anyway. What matters is the
server side: those sessions are still live and revocable until they expire.
Clear them so the only sessions in existence are ones issued against the
domain you are actually running:

```
npx wrangler d1 execute jedi-party-scheduler-db --remote --command "DELETE FROM sessions;"
```

Everyone signs in again once. Do this *after* the Worker's `FRONTEND_URL` is
updated and deployed, so the fresh logins land on the right origin.

### Auto-deploy the Worker from GitHub Actions

`.github/workflows/deploy-worker.yml` runs on every push to `main` that
touches `worker/`, once two repo secrets are set: `CLOUDFLARE_API_TOKEN`
(the token from step 2.3 — it needs **D1:Edit** as well as Workers
Scripts:Edit, since it now migrates too) and `CLOUDFLARE_ACCOUNT_ID` (the
value from step 2.4). Set them at *Settings → Secrets and variables →
Actions → New repository secret*; the names must match exactly.

It typechecks, runs the test suite, applies any new D1 migrations, and only
then deploys — so it stops before touching production if anything fails.
Without those secrets the migrate step fails and nothing is deployed;
until they're added, run `npm run db:migrate:remote` and `npm run deploy`
by hand.

**Never edit a migration file in `worker/migrations/` once it has been
applied to any real database.** D1's migration tool tracks what it has run
by *filename* in the `d1_migrations` table, not by file contents — so
editing `0002_group_game.sql` after it already ran means that database will
never re-run it, and the edited statements silently never execute there.
This actually happened: `0002_group_game.sql`'s `ALTER TABLE groups ADD
COLUMN game TEXT;` was added to the file after production had already
recorded that migration as applied, so the `groups` table was missing the
`game` column in production for a stretch (`groups.game` errors were the
symptom) while `d1_migrations` insisted everything was up to date. It had
to be applied by hand with a one-off `wrangler d1 execute`. A fix or an
addition after the fact always gets a **new** numbered migration file —
never a change to one that's already shipped.

**This turned out not to be a one-off.** A full audit (dump every table's
actual `CREATE TABLE` from `sqlite_master` and diff it against what all the
migration files together should produce — see the command below) found the
same silent-drift pattern in two more places, even though `d1_migrations`
listed every migration as applied: `cron_cursors` was missing
`cursor_key` (0011) — the serious one, since `worker/src/cron/cursor.ts`
reads/writes it on every single cron tick with nothing catching the error,
so this alone was enough to break the entire 15-minute sweep and stop every
Discord notification, not just one feature — and migration 0005 hadn't
applied *at all*: `personal_events` still had `busy` instead of
`availability` (the free/busy scheduling assistant's 500), `events` was
missing `voice_channel_id`/`voice_channel_name`, and `notification_log`'s
CHECK constraint didn't yet allow `voice_channel_invite`. All three were
fixed by hand the same way as `game` above — `ALTER TABLE ... ADD COLUMN`
run directly against `--remote`, with `notification_log` needing a
rename-copy-drop instead of the migration's original `DROP TABLE` (fine on
an empty dev database, not fine once production has real rows to keep).

**This is now also automated**: `npm run db:verify -- --remote [--env sandbox]`
(`worker/scripts/verify-schema.mjs`) runs as a step in both deploy workflows,
after migrating and before deploying, and fails the deploy outright on any
drift — it applies every file in `worker/migrations/` to a throwaway local
database to work out what the schema *should* be, then diffs that against
what the real database (production or sandbox) actually reports for itself.
That's a stronger check than the hand-run version below, since it compares
every table's exact `CREATE` statement rather than a hand-maintained column
list that can itself go stale. The manual version remains useful as a quick
spot-check without running a full deploy, and as the reference for what
"matches" means if the automated check's output needs a human to interpret.

**After running migrations against a real database — `db:migrate:remote` or
the auto-deploy — spot-check that they actually landed**, rather than
trusting `d1_migrations`/`wrangler d1 migrations list` alone; that table
only proves a filename was processed, not that its statements succeeded.
One command dumps every table's real columns at once:

```
npx wrangler d1 execute jedi-party-scheduler-db --remote --command "SELECT 'groups' t, group_concat(name) c FROM pragma_table_info('groups') UNION ALL SELECT 'events', group_concat(name) FROM pragma_table_info('events') UNION ALL SELECT 'personal_events', group_concat(name) FROM pragma_table_info('personal_events') UNION ALL SELECT 'notification_log', group_concat(name) FROM pragma_table_info('notification_log') UNION ALL SELECT 'cron_cursors', group_concat(name) FROM pragma_table_info('cron_cursors') UNION ALL SELECT 'users', group_concat(name) FROM pragma_table_info('users');"
```

Compare each row against what its table should have once every migration
through the newest one has applied (check `worker/migrations/*.sql` for the
current full list — new `ALTER TABLE ... ADD COLUMN`s added after this was
written won't show up here automatically):

| Table | Expected columns |
|---|---|
| `groups` | `id, guild_id, name, created_by, created_at, game, idle_reminder_days` |
| `events` | `id, guild_id, organizer_id, title, description, game, event_type, timezone, start_at, end_at, status, poll_strategy, poll_threshold_count, poll_deadline_at, resolved_option_id, is_recurring, created_at, updated_at, poll_mode, poll_resolution_mode, window_start_at, window_end_at, window_block_minutes, voice_channel_id, voice_channel_name, poll_resolution_failures, revision, mutation_token` |
| `personal_events` | ...`availability`... and **no** `busy` column |
| `notification_log` | ...`delivered_at, failed_at, claim_token, claimed_until, attempt_count, next_attempt_at, content`, and its `notification_type` CHECK must include `voice_channel_invite` (query `sqlite_master.sql` for that one, `pragma_table_info` won't show a CHECK) |
| `cron_cursors` | `name, position, updated_at, cursor_key` |
| `users` | ...`free_busy_visible`, and **no** `discord_refresh_token`/`discord_token_expires_at` |

A missing column here means exactly what it meant above: apply that one
`ALTER TABLE` by hand against `--remote`, then keep going — don't assume
finding one drifted table means the rest are clean, and don't assume
`db:migrate:remote` reporting success (or `d1_migrations` looking complete)
means the schema actually matches the code.

Migrations run *before* the deploy, which means that for a few seconds the
previously deployed Worker is running against the new schema. Keep
migrations backwards-compatible with the currently live code — adding
columns, tables and indexes is fine. To remove a column, ship one release
that stops reading it and a later one that drops it, rather than relying on
that window.

## 5. Sandbox environment (optional, but recommended before building anything new)

A second, isolated Worker + D1 database + Discord application to build and
test future features against, so new work is exercised against a real
Worker, a real database and a real bot before it reaches production —
without touching production data or DMing a real person. See
`docs/specs/0002-sandbox-and-promotion.md` for the full design; this is the
provisioning checklist.

Same Cloudflare account as production (no second account needed — see
"Working with more than one Cloudflare account" above, which exists for a
different reason: genuinely separate projects, not one project's two
environments). What's actually separate is the *data* and the *bot*.

1. **A second Discord application.** Repeat step 1 above (Discord Developer
   Portal) to create a second application + bot, entirely separate from
   production's. Its OAuth redirect URI will point at the sandbox Worker
   (step 4 below), not the production one.
2. **A second D1 database:**
   ```
   npx wrangler d1 create jedi-party-scheduler-db-sandbox
   ```
   Copy the `database_id` it prints into `worker/wrangler.toml`, replacing
   `REPLACE_WITH_SANDBOX_D1_DATABASE_ID` under `[[env.sandbox.d1_databases]]`.
   Leaving the placeholder in place is caught by CI
   (`npm run check:env-parity` — Guardrail 1), but only once it happens to
   equal *production's* id by accident; get the real id in regardless.
3. **Fill in the sandbox client id.** In `worker/wrangler.toml`, replace
   `REPLACE_WITH_SANDBOX_DISCORD_CLIENT_ID` under `[env.sandbox.vars]` with
   the second application's Client ID from step 1.
4. **Migrate, verify, and set secrets**, same shape as production but with
   `:sandbox` script variants and `--env sandbox`:
   ```
   npm run db:migrate:remote:sandbox
   npm run db:verify -- --remote --env sandbox

   npx wrangler secret put DISCORD_CLIENT_SECRET --env sandbox
   npx wrangler secret put DISCORD_BOT_TOKEN --env sandbox
   npx wrangler secret put JWT_SIGNING_KEY --env sandbox
   ```
   Use a **different** `JWT_SIGNING_KEY` than production's, not the same
   value copied over — a sandbox JWT should never be capable of validating
   against the production Worker even in principle.
5. **Deploy it:**
   ```
   npm run deploy:sandbox
   ```
   Note the `https://jedi-party-scheduler-worker-sandbox.<you>.workers.dev`
   URL it prints, then go back to the second Discord application and set its
   OAuth redirect to `<that URL>/auth/callback`.
6. **Allow-list one throwaway test Discord server**, the same way step 2.15
   does for production, but against the sandbox Worker's `/admin/guilds`
   (`OWNER_DISCORD_ID` is the same account in both environments — see spec
   0002's open question 2 — so your own login works as owner in sandbox too).
   Invite the sandbox bot to that server.
7. **Run the frontend against it.** No second Pages site — the sandbox
   frontend is just `npm run dev` (from `frontend/`) with
   `VITE_API_BASE_URL` pointed at the sandbox Worker:
   PowerShell (which is where Michael's clone lives — the `VAR=value cmd`
   form below it is bash and silently does nothing here):
   ```powershell
   cd C:\Users\Michael\Documents\GitHub\Jedi-Party-Scheduler\frontend
   $env:VITE_API_BASE_URL = "https://jedi-party-scheduler-worker-sandbox.<you>.workers.dev"
   npm run dev
   ```
   bash/zsh:
   ```bash
   VITE_API_BASE_URL=https://jedi-party-scheduler-worker-sandbox.<you>.workers.dev npm run dev
   ```
   This works with no extra plumbing because `FRONTEND_URL` in
   `[env.sandbox.vars]` is already `http://localhost:5173` — the Worker is
   the OAuth redirect target and redirects back to whatever `FRONTEND_URL`
   says (ARCHITECTURE.md's auth section), so login lands back on your local
   dev server automatically.
8. **Seed some synthetic data** to exercise the cron sweep (an event ~1h
   out, one ~24h out, a past-deadline poll, an idle group) instead of
   starting from an empty database:
   ```
   npm run seed:sandbox
   ```
   Safe to re-run any time — see the comment at the top of
   `worker/scripts/seed-sandbox.sql`. **Never point this at production**: it
   deletes anything with a `seed-`-prefixed id before reinserting.

### Day-to-day use

Push a feature branch into a `sandbox` branch (or run the **Deploy Sandbox**
workflow manually from the Actions tab against any branch) to build and
deploy it — `.github/workflows/deploy-sandbox.yml` runs the same
typecheck → test → migrate → verify → deploy sequence production's workflow
does, with `--env sandbox`. Once it looks right there, merging to `main`
promotes it: the production workflow rebuilds and redeploys the *same*
commit, nothing rebuilt differently for prod except which secrets and vars
apply.

That workflow's job declares `environment: sandbox`, which makes GitHub
record a Deployment against the commit it built — this is what
`deploy-worker.yml`'s advisory check reads to note whether a commit reaching
production was sandboxed first. If your repository doesn't already have a
`sandbox` environment under **Settings → Environments**, GitHub normally
creates one automatically the first time the workflow runs with that name;
if it doesn't, create it there (no protection rules needed — this one is
just a label to hang deployment records on, not a gate).

Three automated guardrails exist so sandbox/production drift is caught by CI
rather than found by hand later — all detailed in spec 0002:

1. **Config parity** (`npm run check:env-parity`, runs in `ci.yml` on every
   push/PR): fails if `[vars]` and `[env.sandbox.vars]` in `wrangler.toml`
   ever have different keys, `WORKERS_PLAN` differs between them, or
   `env.sandbox`'s D1 `database_id` ever equals production's.
2. **Schema verification** (`npm run db:verify`, runs in both deploy
   workflows after migrating and before deploying): the automated version of
   the `pragma_table_info` spot-check below — fails the deploy if the real
   schema doesn't match what `worker/migrations/*.sql` should have produced,
   in either environment.
3. **"Was this sandboxed first?"** (advisory only, in `deploy-worker.yml`):
   notes in the production deploy's log and job summary whether the Worker
   being deployed was previously deployed to sandbox. Never blocks the
   deploy. It matches on the `worker/` **subtree hash**, not on the commit
   SHA: the SHA reaching production is a merge commit that by construction
   never existed on the sandbox, which is why the original SHA-matched
   version of this check warned on every release regardless (IDEAS item 31,
   fixed in v0.4.2). The same workflow also reports how far the `sandbox`
   branch has drifted behind the release, and `deploy-sandbox.yml` reports
   how far the branch it is building has drifted behind `main` — so
   "verifying against a sandbox several releases old" is visible before the
   verification instead of being inferred from odd behaviour afterwards
   (IDEAS item 30).

## Running the tests

From `worker/`:

```
npm test          # the adversarial suite
npm run typecheck
```

The suite runs the Worker's real route handlers and SQL against an in-memory
SQLite database built from the migration files in this repo, with two
deliberate differences from plain SQLite:

- **D1's 100-bound-parameter ceiling is enforced.** Exceeding it in production
  is a hard rejection, not a slow query, and several of this app's own limits
  (100 invitees, 200 group members, 300 resolved invitees) sit at or above it.
  Plain SQLite would accept thousands and hide the bug.
- **Foreign keys are ON**, which D1 leaves off. Account deletion's statement
  ordering is only meaningful if something checks it.

CI (`.github/workflows/ci.yml`) runs both on every push and pull request.

## Operations

### Discord membership health

Access to every server-scoped page depends on the bot being able to ask
Discord whether you're still a member. When it can't, users see a **503 with a
"try again in a few minutes" message**, not a permissions error — but only
after the last successful check for that person is more than 24 hours old.
Inside that window a Discord outage is invisible to everyone.

The Worker's logs (`npx wrangler tail`) distinguish the cases, and they need
different responses:

| Log line | What it means | What to do |
|---|---|---|
| `Discord membership check rejected (401)` | The bot token is wrong or was regenerated | `npx wrangler secret put DISCORD_BOT_TOKEN` with the current token |
| `Discord membership check rejected (403)` | The bot is no longer in that server | Re-invite the bot (step 1.6) |
| `Discord membership check unavailable (429/5xx)` | Rate limit or a Discord outage | Nothing — it clears on its own |
| `Membership for user … is Nh stale … denying access` | Someone has actually been locked out by the above | Fix whichever of the first two rows applies |

A 401 or 403 will not fix itself, and after 24 hours it locks everyone out.
Those two are the ones worth alerting on.

### D1 plan limits

The code assumes D1's documented **100 bound parameters per statement**, which
applies on every plan. Queries that build a list of IDs are chunked below that
ceiling, and bulk inserts are folded into multi-row statements, so the app's
configured maxima (see `LIMITS` in `worker/src/lib/validate.ts`) stay inside it
regardless of how large a group or invite list gets.

D1 also caps **queries per Worker invocation** — 50 on Free, 1,000 on Paid.
Unlike the parameter ceiling, this one used to scale with *how much data was
visible*, not just how much one request touched: loading a calendar or a
free/busy check used to run a handful of queries per event or per person, so
a guild that was otherwise entirely within its configured limits could still
push one request over the Free-plan budget. That's fixed by bulk-loading
(chunked `IN` queries instead of one query per record) rather than by raising
the plan — the app is built to stay within the **Free plan's 50-query budget**
at every one of its own configured maxima:

- a calendar request for the maximum 300 active events (100 of them
  recurring, up to 200 as multi-winner polls with confirmed options);
- a free/busy request for the maximum 25 users, each with a recurring
  event;
- a 50-option poll — creating it, reading it, voting on it, editing its
  options, and resolving it at its deadline;
- an invite naming 50 groups of 200 overlapping members; and
- a cron tick for an event at the maximum 300 invitees, including one whose
  terminal-history purge queue is full.

### When free/busy refuses instead of answering

The scheduling assistant has one more limit that behaves differently from the
rest: a ceiling on how many *occurrences* it will expand for a single request
(`MAX_FREE_BUSY_OCCURRENCES`). Its factors multiply — people × events ×
occurrences each — so a request can be inside every individual limit and still
be far too large.

Past that ceiling the endpoint returns **422** and asks for fewer people or a
shorter range. It deliberately does not answer partially. The response is a
list of busy blocks, so a commitment left out of it is indistinguishable from
genuine free time — a partial answer would tell you someone is free at a time
the database says they are busy, and you would schedule over it. A refusal you
can act on is better than a confident wrong answer.

The `pass4`–`pass9` test files in `worker/test/` assert this with an actual
query counter (see `worker/test/d1shim.ts`'s `queryCount`), not just that the
request succeeds — run `npm test` in `worker/` to see them pass. If you raise
any of the `LIMITS` in `worker/src/lib/validate.ts` significantly, re-run
those files and check the counts still clear 50; if they don't, either lower
the limit back down or move to the Paid plan.

Two of those limits exist specifically because everything else in this file
is a *per-guild* quota, and one user can be in many guilds:

- `MAX_FREE_BUSY_SOURCE_EVENTS` caps how many events one free/busy request
  will read before it does any work on them. Without it, "300 events" is a
  fine per-server number that becomes 4,200 for someone in fourteen servers.
- `MAX_RESOLVED_INVITEES` does the same for an invite list assembled from
  overlapping groups.

Both reject with a 422 and a message rather than truncating. A free/busy
answer missing a commitment reads as free time, which is the one outcome
worth failing a request to avoid.

### The cron tick, and what `WORKERS_PLAN` actually changes

Interactive requests fit inside 50 queries at every configured maximum. The
**cron sweep cannot always**, and it is important to be clear about why: it
is not one expensive query, it is that a tick's total work is a *product* of
limits that are each individually fine. One event at 300 invitees needs 300
DMs; at two Discord calls and two or three statements apiece, that is an
order of magnitude past what one Free-plan invocation is allowed, before the
other eleven sweeps have run at all.

So the tick takes an explicit allowance (`worker/src/cron/budget.ts`), spends
it, and stops cleanly when it runs out. Whatever it did not get to stays
pending in the outbox and the next tick — fifteen minutes later, with a fresh
allowance — resumes from a stored cursor. Nothing is dropped; it is delivered
more slowly.

`WORKERS_PLAN` in `worker/wrangler.toml` tells the budget which allowance it
actually has. **It does not change your plan — it describes it.** Set it to
`"paid"` only if the Cloudflare account really is on Workers Paid. Claiming
Paid on a Free account means the tick budgets for twenty times the allowance
it has and gets killed mid-flight by the platform instead of stopping
cleanly; claiming Free on a Paid account just makes notifications slower than
they need to be.

Rough throughput on the Free plan: **~13 DMs per tick, so ~50/hour**, once
recipients' DM channels are cached (the first DM to a given person costs an
extra Discord call and an extra statement). Maintenance work — resolving
expired polls, purging 90-day-old history — draws on the same allowance and
yields to notifications, so on a busy tick it simply waits for a quieter one. That is ample for a friend group.
It is *not* ample for a 300-invitee event needing an hour's notice — those
notifications will take several hours to go out. If that matters, move the
account to Workers Paid and set `WORKERS_PLAN = "paid"`, which raises the
per-invocation allowance to 1,000 and the tick to a few hundred DMs.

Current numbers: https://developers.cloudflare.com/d1/platform/limits/

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
