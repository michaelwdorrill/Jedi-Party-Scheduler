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
9. Apply the schema to the real (remote) database. On a **brand-new**
   database, one command runs every migration in order:
   ```
   npm run db:migrate:remote
   ```
   Each migration only needs to be run once, ever. On a database that is
   already partway up to date, run **only the new files** — the command above
   would re-run everything from the beginning, and while several migrations
   are safe to repeat, some are not. Either apply them one at a time:
   ```
   npx wrangler d1 execute jedi-party-scheduler-db --remote --file=./migrations/0009_notification_leases.sql
   ```
   ...or start from a given file with:
   ```
   npm run db:migrate:remote -- --from=0009_notification_leases.sql
   ```
   The full set, oldest first, is:
   ```
   0001_init.sql
   0002_group_game.sql
   0003_poll_modes_and_idle_groups.sql
   0004_personal_events_and_free_busy.sql
   0005_considering_and_voice_channels.sql
   0006_sessions.sql
   0007_notification_outbox.sql
   0008_backfill_notification_outbox.sql
   0009_notification_leases.sql
   0010_cron_cursors.sql
   0011_keyset_cron_cursors.sql
   ```
   (This list has drifted before. `worker/migrations/` is the source of
   truth — `npm run db:migrate:remote -- --from=<file>` reads the directory,
   so it applies everything from that file onward whether or not the file is
   named here.)
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

**Once, in your PowerShell profile** (`notepad $PROFILE`):

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
`setx` takes effect immediately without opening a new terminal.

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
the active credentials don't match it, Wrangler refuses with
`Authentication error [code: 10000]` rather than touching the wrong
database. That error almost always means "wrong `Use-CF`", not "bad token".

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

### Optional: auto-deploy the Worker from GitHub Actions

By default you deploy the Worker yourself with `npm run deploy` whenever
`worker/` changes. If you'd rather have CI do it, uncomment the job in
`.github/workflows/deploy-worker.yml` and add two repo secrets:
`CLOUDFLARE_API_TOKEN` (the same scoped token from step 2.3 works — it
already has the Workers Scripts:Edit permission this needs) and
`CLOUDFLARE_ACCOUNT_ID` (the same value from step 2.4).

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

`worker/test/pass4.test.ts` and `worker/test/pass5.test.ts` assert this with
an actual query counter (see `worker/test/d1shim.ts`'s `queryCount`), not just
that the request succeeds — run `npm test` in `worker/` to see them pass. If
you raise any of the `LIMITS` in `worker/src/lib/validate.ts` significantly,
re-run those files and check the counts still clear 50; if they don't, either
lower the limit back down or move to the Paid plan.

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
