# Review: Uncle Owen 1.0 Privacy Policy and Terms, version 6 (final text)

For Astra and the Fable model that reviewed the draft at `d945a36`. This is the
second pass: the text is no longer a draft in a markdown file. It is the
version that ships with 1.0, in the app, with every one of the owner's
decisions applied. Nothing has reached production yet. Production still runs
0.7.2 with policy version 2, so these documents are what every user will be
asked to agree to.

## What you are asked

1. **Is every statement in the two documents true of the code and
   configuration at this commit?** The documents are
   `frontend/src/pages/PrivacyPage.tsx` and `frontend/src/pages/TermsPage.tsx`.
   Plain-text renderings, taken from the built site, are beside this file in
   the review bundle. The values they interpolate are in
   `frontend/src/lib/legal.ts`: operator, contact, recovery days, log days.
2. **Does anything the service does, or stores, go unmentioned?**
3. **Were your own first-pass findings dealt with correctly?** Your reports
   are in the bundle under `prior-reviews/`. The disposition of each is in
   `docs/POLICY-DRAFT-1.0.md`, "What changed in draft 2". Say if a fix missed
   the point.

Format as before: *sentence/section* → *what's wrong* (untrue / missing /
misleading / unclear) → *proposed wording* → *evidence* (file:line, or a
reproduction). Mark each finding **blocking for 1.0**, **should fix**, or
**optional**. Under the project's release bar, a statement that is untrue
today is blocking.

## What changed since you last looked

| Area | Then (`d945a36`) | Now |
|---|---|---|
| Operator | `[OPERATOR NAME]` | "Michael", with JediParty@proton.me (F1) |
| Governing law | placeholder | Commonwealth of Virginia, with a carve-out for protections people can't waive where they live (F2) |
| Google Calendar | off in production; the section was marked "not currently offered" | **on in production at 1.0** (F3). It has its own Google Cloud project, published "In production" and unverified, so users see Google's unverified-app screen. The section is written as live, with the Limited Use statement. Config: `worker/wrangler.toml` `[vars]` `GOOGLE_SYNC_MODE = "live"` and `GOOGLE_CLIENT_ID`; the secrets are in Cloudflare |
| Resend (owner email) | stub in both environments | **live in production** (F4), in region us-east-1. Sent to JediParty@proton.me from `bot@uncleowen.space`. The sandbox stays stub |
| Recovery copies (D1 Time Travel) | `[7]` placeholder | 7 days. The owner confirmed the account is on Workers Free (F6) |
| Transfers | placeholder | UK, EU **and Canada**. The owner has users in the EU and Canada. Adds "accessible to authorities under local law" (F7) |
| Logs | conditional on the dashboard | `[observability] enabled = true` stated in `wrangler.toml`, and **`invocation_logs = false`**, so Cloudflare stores only the app's own `console.*` lines and not its per-request records. Retention is stated as 3 days (F8) |
| Session "last used" | written once and never updated (your D-01) | now updated on use, at most every 5 minutes: `worker/src/lib/sessions.ts` `isSessionActive`, `SESSION_TOUCH_INTERVAL_MS` |
| Export | several omissions (your D-07, Astra's first finding) | extended: `worker/src/routes/me.ts` `GET /export`. `test/exportCompleteness.test.ts` compares every projection against the live schema, so a column can't be silently left out |
| **New since your review: the 1.0 launch announcement** | — | One Discord DM with a picture to everyone with notifications on who is still in an allow-listed server (new table `announcement_log`, migration 0049), plus a one-time in-app pop-up (new column `users.announcement_seen`). It is launch-only and is removed in 1.1 (`docs/IDEAS.md` item 105). Disclosed in "Records", retention, legal bases, and the Terms' message list (F10). Code: `worker/src/lib/launchAnnouncement.ts`, `sweepLaunchAnnouncement` in `worker/src/cron/reminders.ts`, and `frontend/src/components/LaunchAnnouncement.tsx` |
| Policy version | 5 | **6** (`worker/src/lib/policy.ts` and `worker/policy-version.txt`) |

The owner's decisions, F1–F10, are recorded in `docs/POLICY-DRAFT-1.0.md`
Part F.

## Where to look hardest

These are the places the author is least sure of, ranked:

1. **The logs paragraph** ("Who it is shared with" → Cloudflare, and the
   retention list). It claims the stored logs "can include Discord user and
   server IDs and error details; they don't include event titles,
   descriptions or message text". Check every `console.*` in `worker/src`,
   including what an `err` object prints. Check too that `invocation_logs =
   false` does what the text says; it's the Workers Logs setting for the
   automatic per-request entries. The **3-day** retention can't be verified
   from the code. Say if you know otherwise for Workers Free.
2. **The launch announcement's disclosure.** Is it complete: the DM, its
   stored text, the "seen" record, export, deletion, and retention ("stays until
   your account is deleted")? Do its legal-basis line and its respect for the
   notifications setting match `sweepLaunchAnnouncement`'s query?
3. **Google, now live.** Is the Limited Use sentence adequate as written? Is
   the description of what is written and read still accurate (two-month read
   window, 40-event cap, revocation on disconnect and on deletion, entries left
   behind on deletion)? Is the unverified-app sentence fair?
4. **Resend's bullet.** "It contains that person's Discord display name,
   username and ID, and the server's name and ID. Nothing else ever triggers
   an email." Check this against `worker/src/lib/email.ts` and its callers.
5. **The transfers paragraph** with Canada added. Separately, as a question
   rather than a finding: with EU users, does Article 27 (an EU
   representative) plausibly apply to a free hobby service like this, or does
   the "occasional, unlikely to result in a risk" exemption cover it? The owner
   has been told the exemption probably applies and is not appointing one.
6. **The governing-law clause.** Is the carve-out worded so it doesn't
   overreach?
7. **The changelog** (`frontend/src/lib/changelog.ts`, rendered in the bundle)
   is optional to review. It folds 0.8 and 0.8.1, which never reached
   production, into one 1.0 entry. Flag only claims that are untrue.

## Things only the owner can confirm, and what he has said

| Item | Status |
|---|---|
| Workers plan | Free (owner) → 7-day Time Travel |
| Workers Logs retention | 3 days stated; the owner has not yet read it off the dashboard |
| Google Cloud project | separate production project, External, published "In production", unverified, 0/100 user cap used; branding verified and published (owner's screenshots) |
| Resend | domain `uncleowen.space` verified, region us-east-1 (owner's screenshot) |
| Secrets | `GOOGLE_CLIENT_SECRET`, `GOOGLE_TOKEN_ENCRYPTION_KEY`, `RESEND_API_KEY` set on the production Worker. None are in the repository |

## Running things

Node 22. In each of `worker/` and `frontend/`: `npm ci`, then `npm test`.
Worker: 924 tests; frontend: 163. The worker tests run against an in-memory
SQLite copy of the schema built from `worker/migrations/*.sql`, so no
Cloudflare account is needed. To read the pages as users see them:
`npm run build` and `npx vite preview` in `frontend/`, then open `#/privacy`
and `#/terms`. They're public routes, so no login is needed.

Send findings back to Michael. He decides; agreed changes are applied before
the 1.0 merge.
