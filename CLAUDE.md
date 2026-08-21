# Working in this repo

## Cloudflare account and credentials

This project deploys into the **`uncleowen`** Cloudflare account — not any
other account whose credentials might also be on this machine. Every
`wrangler` command (deploy, `d1 migrations apply`, `d1 execute`, `secret
put`) needs that account's credentials active in the current terminal
first, and a fresh terminal window does **not** inherit them from another
one — this has to be redone per session/window.

If a `Use-CF` PowerShell function is set up on the machine:
```powershell
Use-CF uncleowen
```

Otherwise, set the two env vars directly for this session (values come
from wherever the user stores them — never ask for or accept the raw
token/account-id in chat, and never write them to a file in this repo):
```powershell
$env:CLOUDFLARE_API_TOKEN = [Environment]::GetEnvironmentVariable("CF_TOKEN_UNCLEOWEN", "User")
$env:CLOUDFLARE_ACCOUNT_ID = [Environment]::GetEnvironmentVariable("CF_ACCOUNT_UNCLEOWEN", "User")
```
Full setup details: `docs/SETUP.md`, "Working with more than one Cloudflare
account."

## There's a sandbox — use it for anything that isn't a trivial change

A second, isolated Worker + D1 database + Discord application exists for
building and testing against a real deployment before it reaches
production, without touching production data or DMing a real person. Full
design: `docs/specs/0002-sandbox-and-promotion.md`. Provisioning checklist
(already done once, kept here for reference/reprovisioning):
`docs/SETUP.md` section 5.

Key commands, all run from `worker/` with the `uncleowen` credentials
active:
```
npm run deploy:sandbox                  # deploy the sandbox Worker
npm run db:migrate:remote:sandbox       # apply migrations to the sandbox DB
npm run db:verify -- --remote --env sandbox   # confirm schema actually matches migrations
npm run seed:sandbox                    # synthetic data to exercise the cron
```
Local frontend against it: `VITE_API_BASE_URL=<sandbox worker url> npm run dev`
in `frontend/` — no second Pages deployment needed, login works out of the box.

**The gotcha that costs the most back-and-forth:** every `wrangler d1`
command targeting the sandbox database (`migrations apply`, `execute`,
and therefore `db:verify`/`seed:sandbox` under the hood) needs an explicit
`--env sandbox`. Wrangler resolves a database name against the config for
a given environment, and a binding declared under
`[[env.sandbox.d1_databases]]` simply isn't visible without it — the npm
scripts above already have this baked in, so it only matters if invoking
`wrangler` directly.

**Also easy to get wrong:** every one of these commands has to be run with
`worker/` (or `frontend/` for the frontend ones) as the working directory
— not the repo root, not the user's home directory. `npm error ... ENOENT
... package.json` or a wrangler "couldn't find" error is very often just
this.

## Promoting sandbox work to production

1. Push a feature branch into a `sandbox` branch, or run the **Deploy
   Sandbox** GitHub Actions workflow manually (Actions tab → Deploy
   Sandbox → Run workflow) against any branch.
2. Verify it against the deployed sandbox Worker — log in, exercise the
   feature, check `wrangler tail --env sandbox` if something's off.
3. Merge the branch to `main` as normal. `deploy-worker.yml` rebuilds and
   redeploys the **same commit**, nothing rebuilt differently for
   production except which vars/secrets apply.

Three automated guardrails exist so sandbox/production drift is caught by
CI rather than by hand later — don't route around them:
- `check:env-parity` (CI, every push/PR): fails if `[vars]` and
  `[env.sandbox.vars]` in `wrangler.toml` ever diverge, or if
  `env.sandbox`'s D1 `database_id` ever matches production's.
- `db:verify` (both deploy workflows, after migrating, before deploying):
  fails the deploy if the real schema doesn't match
  `worker/migrations/*.sql` -- this is what caught three genuine schema-
  drift incidents in production before this existed (see `docs/SETUP.md`).
- An advisory (non-blocking) note on the production deploy about whether
  the commit was deployed to sandbox first.

## Before starting new work

Check `docs/IDEAS.md` (captured backlog), `docs/ROADMAP.md` (what order and
why), and `docs/specs/` (designs for anything actually being built) before
assuming something hasn't been thought about yet. `docs/specs/README.md`
explains how the three fit together. Log anything discovered along the way
— a bug, a gap, a UX trap — into `IDEAS.md` even if it's out of scope for
the current task; that's the whole point of it being a low-friction capture
surface.
