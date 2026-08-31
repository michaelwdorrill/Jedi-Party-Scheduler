# Working in this repo

## The user's local clone

Michael's local clone of this repo lives at
`C:\Users\Michael\Documents\GitHub\Jedi-Party-Scheduler` on Windows
(PowerShell). Anything that has to run against his real Cloudflare
credentials — `npm run deploy:sandbox`, `db:migrate:remote:sandbox`,
`wrangler tail`, etc. — has to run in a PowerShell terminal `cd`'d into that
folder (or `worker`/`frontend` beneath it, per the command), **not** in a
Claude Code cloud/remote session, which has no access to his local
`wrangler`/Cloudflare auth. When walking him through such a command, give
the `cd` step explicitly rather than assuming he's already in the right
directory.

## Cloudflare account and credentials

This project deploys into the **`uncleowen`** Cloudflare account — not any
other account whose credentials might also be on this machine. Every
`wrangler` command (deploy, `d1 migrations apply`, `d1 execute`, `secret
put`) needs that account's credentials active in the current terminal
first, and a fresh terminal window does **not** inherit them from another
one — this has to be redone per session/window.

**Give him this form, which works whether or not anything is set up on the
machine** (values come from wherever the user stores them — never ask for or
accept the raw token/account-id in chat, and never write them to a file in
this repo):
```powershell
$env:CLOUDFLARE_API_TOKEN  = [Environment]::GetEnvironmentVariable("CF_TOKEN_UNCLEOWEN", "User")
$env:CLOUDFLARE_ACCOUNT_ID = [Environment]::GetEnvironmentVariable("CF_ACCOUNT_UNCLEOWEN", "User")
```

There is also a `Use-CF uncleowen` shorthand, and **it is a convenience, not
the instruction** — `Use-CF` is not a PowerShell cmdlet, it exists only if
the function in `docs/SETUP.md` has been saved into `$PROFILE` on the machine
you are talking about, and on Michael's it repeatedly has not been. This
entry used to lead with it, conditioned on an "if it's set up" that neither
side ever checked, which meant sessions opened by handing him a command that
errors:

```
Use-CF : The term 'Use-CF' is not recognized as the name of a cmdlet...
```

So: lead with the two `$env:` lines. Offer `Use-CF` only after he has
confirmed it exists (`Get-Command Use-CF`), or when helping him install it.

**The trap if he is installing it:** PowerShell 5.1 and PowerShell 7 read
different `$PROFILE` paths (`WindowsPowerShell\` vs `PowerShell\`), so a
function added under one host is invisible from the other, with exactly the
error above and no hint as to why. Have him print `$PROFILE` from the shell
that is actually failing before pasting anything into it.

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

## Promoting sandbox work to production — sandbox first, every time

**The default route to production is: feature branch → sandbox → verify →
merge to `main`. Not "feature branch → merge to `main`".** This holds for a
cloud/remote Claude Code session exactly as much as it does for Michael at
his own machine, and it holds even when he has already said "push it to
prod" — that authorises the *destination*, not a shortcut past the
sandbox. If a release is genuinely urgent enough to skip the sandbox, say
so out loud and get a yes for *that specific release* first.

1. Push the feature branch, then push it into the `sandbox` branch
   (`git push -u origin HEAD:sandbox`, or `--force-with-lease` if `sandbox`
   holds an older feature). Alternatively run the **Deploy Sandbox** GitHub
   Actions workflow manually (Actions tab → Deploy Sandbox → Run workflow)
   against any branch.
2. Verify it against the deployed sandbox Worker — log in, exercise the
   feature, check `wrangler tail --env sandbox` if something's off.
3. Only then merge the branch to `main`. `deploy-worker.yml` rebuilds and
   redeploys the **same commit**, nothing rebuilt differently for
   production except which vars/secrets apply.

**A remote session has no excuse here.** `deploy-sandbox.yml` triggers on a
push to the `sandbox` branch and authenticates with *repository secrets*,
not with Michael's local Cloudflare credentials. So a cloud session can
deploy to the sandbox on its own — it just can't click around the deployed
result, which is what step 2 needs Michael for. "I couldn't reach the
sandbox from here" is not true; it was true of `npm run deploy:sandbox` and
that is a different thing.

**The sandbox is the Worker only — there is no sandbox frontend, and
pushing a frontend-only change to `sandbox` does nothing at all.** Every
step in `deploy-sandbox.yml` runs with `working-directory: worker`, and its
push trigger carries `paths: ['worker/**', '.github/workflows/deploy-sandbox.yml']`
— so a branch that touches only `frontend/` produces no workflow run
whatsoever, and the Actions tab shows nothing rather than showing a
failure. That path filter is correct (redeploying an unchanged Worker
achieves nothing), which is what makes this a gap in the route rather than
a bug to fix.

So, plainly: **frontend-only changes are verified locally, not on the
sandbox.** The route is `VITE_API_BASE_URL=<sandbox worker url> npm run dev`
in `frontend/`, run by Michael, against the deployed sandbox Worker. A
remote session cannot do that step and should say so specifically —
"this is frontend-only, so it needs a local run against the sandbox
Worker" — rather than reporting a sandbox deploy that never happened.

Two related traps worth knowing before assuming a push ran something:
`ci.yml` triggers on `push` to `main` and on `pull_request`, so a feature
branch with no PR open gets **no CI either** — a frontend branch has zero
automated verification until a PR exists. And a *mixed* branch (worker and
frontend) pushed to `sandbox` deploys the worker half only, which is the
more confusing case of the two, because something does run.

Whether to close this properly — a second Pages project for the sandbox, or
a downloadable preview bundle from CI — is IDEAS.md item 23, still open.

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
  the Worker being deployed was run on the sandbox first. It is deliberately
  advisory — see `deploy-worker.yml` for why — and that call is still right.

  **As of v0.4.2 this note means something; before that it did not.** It
  used to ask the Deployments API for `sha=${{ github.sha }}`, which on a
  push to `main` is the *merge commit* — a commit that by construction never
  existed when the sandbox was deployed from the feature branch's head — so
  it reported "no matching sandbox deployment" identically whether or not
  the sandbox had been used, and it did that on every release from v0.3 to
  v0.4.1. It now resolves each recorded sandbox deployment to its `worker/`
  subtree and compares that against the tree being deployed, which is
  immune to merge commits, rebases and squashes alike, and ignores frontend
  and docs commits that landed on main in between. Verified against the case
  that used to fail: v0.4.1's sandbox commit `692eb89` and its merge
  `ec8b33d` have the same `worker/` tree, so the new predicate matches where
  the old one warned.

  So a warning from this step is now evidence, and worth stopping for. What
  it still cannot speak to is a sandbox deploy of a branch that was never
  merged and has since been deleted — those commits are unreachable from the
  production checkout, and the step says how many it had to skip.

- A freshness note on the *sandbox* deploy saying how far behind `main` the
  branch being deployed is, and how many of those commits touch `worker/`.
  This is the one that would have saved the long detour behind IDEAS item
  24, where a sandbox Worker predating v0.3 had no `/me/events` route and
  the frontend reported the 404 as an empty calendar.

There is also a local guardrail that fires at the moment of the mistake
rather than after it: `.claude/hooks/block-push-to-main.mjs`, wired up as a
`PreToolUse` hook in `.claude/settings.json`. Any Bash command that would
push to `main` (including `HEAD:main`, a force push, or a bare `git push`
while on `main`) turns into a permission prompt carrying the sandbox-first
rule as its reason. It *asks* rather than denies, because the rule is
"sandbox first unless this specific release is agreed to skip it", and a
prompt is that conversation. For an override already agreed with Michael:
`UO_ALLOW_MAIN_PUSH=1 git push origin main`. Tests:
`node .claude/hooks/block-push-to-main.test.mjs`.

The real enforcement is GitHub branch protection on `main` — the hook is
repo-local and advisory by design.

## Before starting new work

Check `docs/IDEAS.md` (captured backlog), `docs/ROADMAP.md` (what order and
why), and `docs/specs/` (designs for anything actually being built) before
assuming something hasn't been thought about yet. `docs/specs/README.md`
explains how the three fit together. Log anything discovered along the way
— a bug, a gap, a UX trap — into `IDEAS.md` even if it's out of scope for
the current task; that's the whole point of it being a low-friction capture
surface.
