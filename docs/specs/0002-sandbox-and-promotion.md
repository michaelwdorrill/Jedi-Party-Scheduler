# 0002 — Sandbox environment, and promotion to production

**Status:** Built
**Covers:** `IDEAS.md` items 1 and 14 · **Phase:** 1

One piece of work in two halves. The first half is a second Worker + D1 +
Discord application to build against. The second is a promotion path from it
to production that doesn't depend on anyone remembering anything — because a
sandbox that costs extra effort at exactly the moment you're in a hurry is a
sandbox you stop using.

## What "done" means

- Every change is exercised against a real Worker, a real D1 database and a
  real Discord bot before production sees it, without touching production
  data or DMing a real user.
- Promoting a verified change to production is: merge the commit to `main`.
  No hand-run `wrangler`, no copied secrets, no "which database has this
  migration?".
- If the sandbox and production configurations diverge, CI says so — the
  divergence does not first show up as a production incident.

## The three things that differ per environment

| | Production | Sandbox |
|---|---|---|
| Worker | `jedi-party-scheduler-worker` | `jedi-party-scheduler-worker-sandbox` |
| D1 | `jedi-party-scheduler-db` | `jedi-party-scheduler-db-sandbox` |
| Discord app | the real application + bot | a second application + bot |
| Frontend | GitHub Pages, `uncleowen.space` | local Vite dev server |
| Allow-listed guilds | the real servers | one throwaway test server |

### Worker and D1

A `[env.sandbox]` block in `worker/wrangler.toml` with its own `name`,
`[[env.sandbox.d1_databases]]` and `[env.sandbox.vars]`, deployed with
`wrangler deploy --env sandbox` and migrated with
`wrangler d1 migrations apply jedi-party-scheduler-db-sandbox --remote --env sandbox`.
The trailing `--env sandbox` is required, not optional -- `d1 migrations
apply`/`d1 execute` resolve a database name against the config for the given
environment, and a binding declared under `[[env.sandbox.d1_databases]]`
simply isn't visible without it. The same non-inheritance rule as `[vars]`,
just discovered one command at a time the first time each was actually run
against a live database.

Same Cloudflare account, not a second one. SETUP.md's "Working with more than
one Cloudflare account" section exists because juggling accounts was already
painful once; the isolation that actually matters here is the *data* and the
*bot*, and a separate D1 database plus a separate Discord application gives
both. The cost of sharing an account is that account-level daily D1 limits
are shared — worth knowing, not worth a second account for a friend group's
scheduler.

**The footgun, stated up front:** Wrangler does *not* inherit top-level
`[vars]` into a named environment. Adding a var to `[vars]` and forgetting
`[env.sandbox.vars]` leaves the sandbox Worker running without it — and
`WORKERS_PLAN` in particular would then silently fall back to a different
budget than production's, which is precisely the class of difference that
makes a sandbox lie to you. See "Guardrail 1" below.

### Discord application

A second application, with its own client id, client secret and bot token,
its own OAuth redirect (pointing at the sandbox Worker), and its own bot
invited only to a throwaway test server.

This is not optional convenience. The bot token exists for exactly one
purpose — sending DMs — and most of the complexity worth testing lives in the
notification path. Testing that against the production application means real
people get DMs from the real bot every time a sweep is exercised.

Secrets go in with `wrangler secret put --env sandbox`, and are listed in
SETUP.md alongside the production ones so there is one checklist, not two
half-remembered ones.

### Frontend

The sandbox frontend is `npm run dev` with `VITE_API_BASE_URL` pointed at the
sandbox Worker. No second Pages site.

That works because of how the auth flow is already built, which is worth
spelling out since it looks like it shouldn't: the Worker is the OAuth
redirect target, and it redirects back to its own `FRONTEND_URL` after minting
the JWT (`ARCHITECTURE.md`, auth section). Set the sandbox Worker's
`FRONTEND_URL` to `http://localhost:5173` and both the login redirect and the
CORS origin (`router.ts` derives it from `FRONTEND_URL`) follow automatically.
The Discord application's redirect URI must list the sandbox Worker's URL.

If a shareable sandbox URL is wanted later, a Cloudflare Pages project is the
natural addition — GitHub Pages serves one site per repo, so it isn't the
place for a second one. Not in scope here.

### Data

**No production data is ever copied into the sandbox.** Event content is
visible only to an organiser and invitees by design, and a dump into a second
database with looser access is a straightforward violation of that. The
sandbox gets synthetic data from a seed script (`worker/scripts/seed-sandbox.ts`
or a `wrangler d1 execute --file`), checked into the repo, with fake users and
a fake guild.

### Cron

The sandbox keeps the `*/15 * * * *` trigger. The cron is where the budget,
the cursors and the outbox all live — it's the part most worth de-risking, and
a sandbox that can't exercise it de-risks the wrong half of the app. Its cost
is bounded by the same budget as production's, against a database with a
handful of synthetic rows.

## Promotion

### Branch model

Unchanged from today, with one addition:

- feature branch → PR → merge to `main` → production deploys (existing
  `deploy-worker.yml` / `deploy-pages.yml`).
- **new:** a `Deploy Sandbox` workflow, triggered by `workflow_dispatch` with
  a branch input, and automatically on push to a `sandbox` branch. It runs the
  same typecheck → test → migrate → deploy sequence as production, with
  `--env sandbox`.

Promotion is therefore "merge the commit that was verified", and the thing
promoted is *the same commit*, built the same way. Nothing is rebuilt
differently for production; only vars and secrets differ.

### Guardrail 1 — configuration parity

A CI check (`scripts/check-env-parity.mjs`, run in `ci.yml`) that parses
`wrangler.toml` and fails if:

- the set of var *keys* under `[vars]` and `[env.sandbox.vars]` differ, or
- `WORKERS_PLAN` differs between them, or
- `[env.sandbox]` points at the production `database_id`.

The first is the Wrangler inheritance footgun. The third is the one that
would be genuinely bad — a sandbox deploy migrating and writing to the
production database — and it's cheap to make impossible.

### Guardrail 2 — schema verification, not schema *reporting*

This is the important one, and it's the reason this spec is more than
"copy the config".

SETUP.md documents three separate incidents where `d1_migrations` reported
every migration applied while the real schema was missing columns — including
`cron_cursors.cursor_key`, whose absence broke every notification the app
sends, silently. The lesson recorded there is that "the deploy succeeded" and
"the schema matches the code" are different facts. Two databases doubles the
number of places that can be true of.

So: `npm run db:verify -- --remote [--env sandbox]`, run as a workflow step
**after** `d1 migrations apply` and **before** `deploy`, failing the deploy if
it doesn't match.

How it establishes the expected schema is the part not to get clever about:
apply every file in `worker/migrations/` in order to a throwaway local SQLite
database — the test harness already does exactly this via `node:sqlite` and
`test/d1shim.ts` — then dump `sqlite_master` from both that and the target D1,
normalise whitespace, and diff. Deriving the expectation from the migration
files means it can't drift from them; a hand-maintained expected-schema file
would become one more thing to forget.

Doing this in the sandbox deploy is what makes it valuable: the drift surfaces
against synthetic data, before the same migration is applied to production.

### Guardrail 3 — did this commit get sandboxed?

The production deploy reports, as a visible step, whether the commit being
deployed was previously deployed to sandbox — via GitHub Deployments on a
`sandbox` environment, matched by SHA.

**Advisory first, not blocking.** A hard gate on a single-maintainer project
is the thing that eventually gets bypassed wholesale, and a bypassed gate
protects nothing. Once the sandbox has been in routine use for a while and
the gate is a formality, tightening it to a required check is a one-line
change.

### Rollback

Worth writing down before it's needed: code rolls back (redeploy the previous
commit, or `wrangler rollback`), **migrations do not**. That asymmetry is
already handled by the existing rule — migrations must stay
backwards-compatible with the currently deployed code, dropping a column takes
two releases — and the sandbox doesn't change it. What the sandbox adds is a
place to find out that a migration *isn't* backwards-compatible before
production is the one to discover it.

## Documentation this must update

- **`SETUP.md`** — a sandbox provisioning section (second Discord app, second
  D1, `--env sandbox` secret list), the new `db:verify` step in the
  post-migrate checklist, and the promotion flow. The existing hand-run
  `pragma_table_info` command stays as the manual fallback; Guardrail 2 is the
  automated version of exactly that command.
- **`ARCHITECTURE.md`** — a short note that there are two deployments of the
  two deployments, and that sandbox holds no real user data.
- **`README.md`** — one line in local development pointing at the sandbox
  Worker as the alternative to `wrangler dev`.

## Open questions

1. **Does the sandbox need its own custom domain?** Assumed no —
   `*.workers.dev` plus localhost is enough, and it keeps the DNS story
   single-headed. Revisit only if a shareable sandbox frontend appears.
2. **Should `OWNER_DISCORD_ID` differ in sandbox?** Keeping it the same is
   simplest and lets owner-only surfaces be tested as the owner. There's an
   argument for a second test account to exercise the *non*-owner path, which
   is really an argument for having two sandbox test users, not two owner ids.
3. **Seed script scope.** Enough synthetic data to exercise the cron
   (an event starting in ~24h, one in ~1h, an open poll past its deadline, an
   idle group) or just enough to log in? The former is more useful and is what
   this spec assumes; it's also the part most likely to rot if the schema
   moves under it, so it should be generated through the same write paths the
   app uses rather than raw INSERTs where practical.
