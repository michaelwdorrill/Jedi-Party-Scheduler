# 0012 — Re-agreeing to the Policy and Terms

**Status:** Draft
**Covers:** `IDEAS.md` item 37
**Phase:** TBD — before v0.5

## The problem

Nothing in the app records agreement to anything. There is no policy version
server-side, no acceptance column, and no consent check on any route —
**logging in is the implicit agreement**, and the documents' own "last
updated" is `LAST_UPDATED`, a hand-maintained string in
`frontend/src/lib/legal.ts` that no code reads.

So a rewritten Privacy Policy silently applies to people who agreed to the
old one, and there is no mechanism that would notice. Three scheduled items
rewrite it: `specs/0007` (the noticeboard, already blocked on it),
`specs/0011` (what a group is), and **v0.5** — `specs/0010`'s interactions
endpoint makes the policy's *"The bot has no message intents and does not read
any channel. It only sends direct messages"* stop being true, since the bot
starts receiving button presses and editing its own messages.

This is Rule 1 from the roadmap — a change to how we ship comes before the
things it would ship — applied to policy rather than code.

## The mechanism, and why it needs no deploy step

The obvious implementation is "on a version bump, `UPDATE sessions SET
revoked_at = ?`" — a mass write triggered by… something. A deploy step
someone has to remember, or a migration per bump, both of which are the class
of manual step `specs/0002` exists to remove.

**Stamp the session instead.** A session row records the policy version in
force when it was issued; `isSessionActive` requires it to still match. Bumping
the constant then invalidates every outstanding session at once, lazily, on
each holder's next request — no mass write, no deploy step, nothing to
forget, and nothing to run twice.

```sql
-- Migration NNNN
ALTER TABLE sessions ADD COLUMN policy_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE users ADD COLUMN accepted_policy_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE users ADD COLUMN accepted_policy_at INTEGER;
```

Three small changes carry it:

- `createSession` stamps `CURRENT_POLICY_VERSION`.
- `isSessionActive` already selects the row (`user_id, expires_at,
  revoked_at`) — it adds `policy_version` to that select and one comparison.
  **No extra query on any request.**
- `pruneStaleSessions` also deletes rows whose `policy_version` is behind, so
  invalidated sessions don't sit around until their 7-day expiry.

`rotateSession` needs no change: it calls `isSessionActive` first, so a
stale-version session cannot be refreshed.

### The two counters do different jobs

| Column | Question it answers | Effect when behind |
|---|---|---|
| `sessions.policy_version` | Was this session issued under the current policy? | The session is dead — a real logout |
| `users.accepted_policy_version` | Has this person agreed to the current policy? | Logged in, but gated |

Both are needed. The session column produces the logout; without the user
column, logging back in would silently count as agreement again, which is the
thing being fixed.

## The flow

1. `CURRENT_POLICY_VERSION` is bumped and deployed.
2. Everyone's next request fails `isSessionActive` → `requireAuth` returns
   401 → the frontend sends them to the login page, which is public and links
   both documents.
3. They log in. A session is issued, stamped with the new version, so it is
   valid. But `users.accepted_policy_version` is still behind, so the request
   is **gated**.
4. They accept. `POST /me/accept-policy` sets the version and
   `accepted_policy_at`. Everything unlocks.

Logging in stops implying agreement, which is the defect.

### The gate

A `requirePolicyAcceptance` middleware immediately after `requireAuth`, on
every group `router.ts` guards — with four routes deliberately still
reachable:

- `GET /me` — how the frontend learns it needs to show the screen.
- `GET /me/export` — they can take their data.
- `DELETE /me` — they can leave.
- `POST /me/accept-policy` — they can agree.

**Those exemptions are the whole reason this is a gate and not just a
logout.** `DELETE /me` and `GET /me/export` sit behind `requireAuth`, so a
logged-out person cannot leave properly or take their data with them —
"agree or you cannot use the app" has to leave the exit door reachable for
someone who genuinely will not agree.

Refusal is **403** with a machine-readable body, not a bare 403:

```json
{ "error": "policy_acceptance_required", "policyVersion": 2 }
```

The frontend's shared error handling (from item 24's `lib/async.ts` work) can
catch that centrally and render the screen, rather than every call site
learning about consent.

`GET /me` gains `policyVersion` and `acceptedPolicyVersion`, so the app shows
the screen on load rather than after a failed request.

### One caveat on how declining is presented

`deleteUserCompletely` revokes sessions and then deletes **every event that
person organised** — not just their own rows. Deleting an account takes other
people's sessions off their calendars. So "delete my account" must not sit one
click from "I don't agree": the decline screen links to the existing Settings
flow with its confirmation, and offers the export alongside it.

## The version constant

`CURRENT_POLICY_VERSION` is an integer in the **Worker**. Enforcement is
server-side or it is decorative — a client-side check is bypassed by not being
the client — so the Worker owns it and the frontend reads it from `GET /me`
rather than keeping a copy. Two constants in two deployables that must agree
is the drift `check:env-parity` exists to catch elsewhere; this avoids having
the pair at all.

It is **hand-maintained and bumped deliberately**, not derived from the
documents' contents. `legal.ts` already argues this case for `APP_VERSION`: a
derived value makes "published" mean "last redeployed". Derived from a content
hash, this one would log out every user for a typo fix.

A CI guard against the *opposite* mistake — a substantive edit with no bump —
was considered and left out. If it is ever added it has to be able to fail
usefully, with a documented override for non-substantive edits; a check that
cannot distinguish trains you to ignore it, which is what item 31 cost.

**One version covers both documents.** They change rarely and nearly always
together; two counters double the bookkeeping and force the acceptance screen
to explain which document moved. Accepted cost: splitting later needs a
migration.

## The trap that would silently disable all of this

`upsertUser` runs on **every login**, not only on account creation. If
`accepted_policy_version` is added to its `ON CONFLICT DO UPDATE SET` clause,
every login re-stamps the current version and the gate never fires for
anybody — a feature that appears to work and does nothing.

The clause is explicit column-by-column, so the correct change is precise:
add `accepted_policy_version` to the INSERT column list, and **not** to the
`DO UPDATE SET` list. New accounts are stamped at creation — otherwise
someone who has just signed up meets a gate asking them to agree to what they
agreed to on the previous screen — and existing accounts are left alone.

There should be a test named for this, not just a test that covers it.

## Launch values, and why nobody is disturbed on day one

Ship with `CURRENT_POLICY_VERSION = 1` and both migration defaults at `1`.
Nothing is invalidated, nobody is logged out, nobody sees the screen. The
mechanism sits dormant until the first real bump.

**This is deliberate, and it is the one judgement call worth arguing.** The
alternative — default `0`, so everyone re-agrees the moment this deploys —
collects an explicit consent from everybody immediately, which is not nothing.
It was rejected because logging out the entire user base to agree to a policy
that *did not change* is a signal firing when nothing happened, and it teaches
people to click through the screen before the first time it means anything.
The first real bump is imminent regardless: v0.5 needs one, and so does
whichever of 0007/0011 lands first.

## `accepted_policy_at`, and the export

Recording *when* someone agreed is the difference between a consent mechanism
and a flag. It goes into `GET /me/export`'s `profile` columns
(`PROFILE_COLUMNS` in `routes/me.ts`) along with the version, so a data
request returns what they agreed to and when.

## Cross-spec note for v0.5

`specs/0010`'s interactions endpoint has no session and no JWT — the caller
is a signed Discord payload. So the gate cannot apply to it, and the question
is whether a button press by someone who has not re-agreed should be honoured.

**It should.** This spec's decision on DMs is that they keep going: the cron
never reads sessions, and suppressing a reminder makes someone miss a session
because they have not opened the website yet. Sending a DM with buttons that
then refuse would be worse than either — it is the same consent surface as the
DM itself. The interactions endpoint ignores policy state; the website is
where agreement is collected.

## Testing

- A session issued under version 1 is inert once the constant is 2, and the
  401 is indistinguishable from any other dead session.
- A fresh login under version 2 succeeds, and is then gated.
- The four exempt routes work while gated; every other route 403s with the
  machine-readable body.
- Accepting unlocks, sets both columns, and survives a refresh.
- **`upsertUser` on an existing user does not touch
  `accepted_policy_version`** — the named test for the trap above.
- A brand-new account is stamped at creation and is not gated on its first
  request.
- `pruneStaleSessions` removes stale-version rows.
- The cron sends DMs to a gated user unchanged.

## Rollout

Worker and frontend, so a mixed branch: the sandbox deploys the worker half
only and the frontend half is verified locally against the sandbox Worker
(item 23, still open).

1. Migration, then `npm run db:verify -- --remote --env sandbox`.
2. Sandbox: log in, confirm nothing is gated at version 1.
3. Bump the sandbox's constant to 2 by hand, redeploy, confirm the logout
   happens on the next request and the gate appears after logging back in.
   **This is the step that proves the mechanism**, and it is only safe to do
   somewhere with no real users — which is what the sandbox is for.
4. Production ships at version 1, dormant.

## Open questions

1. **Does the acceptance screen show what changed?** A diff is out of scope,
   but "what changed in this version" as a hand-written line per bump is
   cheap and is the difference between informed consent and a speed bump.
   Leaning: one sentence per version, stored beside the constant.
2. **Should a bump be announceable in advance?** The bot could DM everyone
   "the terms are changing on Friday". It costs the cron budget and it is not
   required of a project this size. Leaning no, but worth asking once.
