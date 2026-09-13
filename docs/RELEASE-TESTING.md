# Release testing plan — v1.0 candidate

**Status: not started.** Written 13 September 2026 against
`claude/practical-ptolemy-xqv8nj`, after the Pass-23 acceptance review passed
all six release gates.

## Why this exists

Twenty-three review passes, 841 worker tests, 131 frontend tests, a reviewer
running headless Edge against a loopback harness — and **not one human has
opened this app in a browser against a deployed environment during the entire
cycle**. Every frontend claim in every review package is test-and-typecheck
evidence. That is the gap this plan closes, and nothing here should be skipped
on the grounds that a test already covers it; the tests are why we know the
*logic* is right, not the *product*.

One fix in particular could not be verified at all from a cloud session: the
RG-01/RG-02 remount (`frontend/src/App.tsx`). It is reasoned from React's
reconciliation rule. **Phase 1a is where we find out.**

## How to record results

Work through in order. For each step write one of:

- **PASS**
- **FAIL** — what happened instead, and a screenshot if it is visual
- **ODD** — it worked but felt wrong, confusing or ugly

`ODD` is not a lesser `FAIL`. Most of what a first real walkthrough is *for* is
the ODDs, and this project has no way of discovering them otherwise.

Stop and report immediately on any FAIL in Phase 0 or 1 — those block
everything after them. Elsewhere, note it and carry on.

---

## Prerequisites — read before starting, this is where it derails

**The sandbox has its own Discord application.** It is a *different bot* from
production, with its own token and its own public key. So:

- [ ] The **sandbox bot** must be installed in a Discord server that contains
      **both** your main account and your alt.
- [ ] That server must be allow-listed in the sandbox database.
- [ ] Both accounts must actually be members of it.

If DMs never arrive in Phase 4, this is almost always why.

**The Worker is on a custom domain now, and that happened *before* this
walkthrough on purpose.** Item 92 moved into 1.0, so the sandbox Worker answers
on `api-sandbox.uncleowen.space` as well as its old `*.workers.dev` URL (both
work — the move is additive; see `docs/SETUP.md`). Test against the **custom
domain**, because that is the shape production ships in:

- [ ] The sandbox Discord application has the new callback URIs registered and
      its Interactions Endpoint repointed. If login redirects to a Discord
      error page, this is why.
- [ ] `VITE_API_BASE_URL=https://api-sandbox.uncleowen.space`, not the
      `workers.dev` URL.

**The sandbox frontend runs on your machine only.** `FRONTEND_URL` for the
sandbox Worker is `http://localhost:5173`, and that single value drives both
the CORS origin and where Discord's OAuth callback returns to. So:

- [ ] Both accounts are tested from **your machine**, in **two browser
      profiles** (or one normal + one private window). Separate profiles matter:
      the session token lives in `localStorage`, so one profile per account.
- [ ] `--port 5173` is not a default and not optional. `vite preview` defaults
      to 4173, and on 4173 login and the Google connect flow both break in ways
      that look like app bugs.

**Cloudflare credentials**, in a PowerShell window `cd`'d into
`C:\Users\Michael\Documents\GitHub\Jedi-Party-Scheduler\worker`:

```powershell
$env:CLOUDFLARE_API_TOKEN  = [Environment]::GetEnvironmentVariable("CF_TOKEN_UNCLEOWEN", "User")
$env:CLOUDFLARE_ACCOUNT_ID = [Environment]::GetEnvironmentVariable("CF_ACCOUNT_UNCLEOWEN", "User")
```

**The cron runs every 15 minutes** (`*/15 * * * *`) and there is no manual
trigger. Anything involving a DM, a poll resolving, or a fan-out waits for a
tick. Phase 4 is deliberately structured to fire everything off at once and
then do other work while it cooks.

Keep `npx wrangler tail --env sandbox` running in a second terminal throughout.
When something does not happen, that window is the answer.

---

## Phase 0 — does the deployed thing run at all

Blocking. If any of this fails, stop.

**First, confirm what the sandbox is actually running.** As of writing, the
newest **Deploy Sandbox** run is #71, from `6928537`. The branch head is
`42cbc3f`, one commit later — but that commit touches only `docs/`, so
`deploy-sandbox.yml`'s `paths: ['worker/**', ...]` filter correctly produced no
run, and the two commits have an identical `worker/` tree (`9c8a28d`). The
deployed sandbox Worker **is** the candidate.

- [ ] **0.0** Actions tab → Deploy Sandbox → newest run is green, and its
      commit's `worker/` tree matches the branch you are testing. If you have
      pushed worker changes since, push them to `sandbox`
      (`git push -u origin HEAD:sandbox --force-with-lease`) and wait for the
      run before starting.
- [ ] **0.0b** Both hostnames answer: `https://api-sandbox.uncleowen.space` and
      the old `*.workers.dev` URL. If the `workers.dev` one has gone dead, the
      `workers_dev = true` line is missing from `[env.sandbox]` — SETUP.md's
      trap, not a broken deploy.

```
cd frontend
$env:VITE_API_BASE_URL = "<sandbox worker url>"
npm run dev
```

- [ ] **0.1** The app loads at the dev URL without a blank page or console
      errors.
- [ ] **0.2** Log in with Discord (main account). You land on the dashboard,
      not an error page.
- [ ] **0.3** The allow-listed server appears in the guild switcher.

Then the build users actually get — **this is a separate test, not a
formality**:

```
npm run build
npx vite preview --port 5173
```

- [ ] **0.4** The built app loads.
- [ ] **0.5** Log in again from the built app. Works.
- [ ] **0.6** Watch the network tab briefly. Requests fire **once** each.

> Why 0.6 matters: `npm run dev` runs React StrictMode, which double-invokes
> every effect. v0.8's verification watched every request fire twice and that
> was StrictMode, invisible in production. If you see doubles *here*, in the
> built app, that is real.

**Everything from here on runs against the built app on port 5173.**

---

## Phase 1 — the things I changed that nobody has ever looked at

These are the highest-value checks in the document, because they are the ones
where there is no evidence at all beyond my reasoning.

### 1a. The remount fix (RG-01 / RG-02) — the single most important step

The bug: two form pages were reached by two routes rendering the same
component, so React reused the instance and the previous record's draft
survived. Fixed by keying on record identity. **Unverified in a browser.**

- [ ] **1.1** Open an existing event → **Edit**. Let it fully load. Now
      navigate to **New event**. → The form is **blank**: no title, no notes,
      default times. Not the event you were just editing.
- [ ] **1.2** From that blank create form, make an event with a title and
      *no* description. Open it. → Description is empty. It has not inherited
      the notes from 1.1's event.
- [ ] **1.3** Edit event A, let it load, then navigate straight to editing
      event B. → B's own title, notes and time. Save. → **B** changes; A is
      untouched.
- [ ] **1.4** Same three checks for a **personal time block**: edit one →
      "new" → blank; edit one → edit another → correct one saves.
- [ ] **1.5** Edit a **recurring** personal block, then go to create a new
      one. → "Repeats" is **unticked** and the recurrence fields are back to
      defaults.

> 1.5 is the one that bit a real user: a fixed block inherited the previous
> block's recurrence and a one-off silently became three daily occurrences.

- [ ] **1.6** Create an event from a calendar day cell (if that is how prefill
      works). → The date is prefilled correctly. Remounting must not have
      broken deliberate prefill.

### 1b. Copy nobody has read in context

Every sentence below was written this cycle and has never been seen on screen.
Judge them as a user: is it clear, is it in the right place, is it *true*?

- [ ] **1.7** Noticeboard with nothing scheduled → *"Nothing on the board"*.
- [ ] **1.8** Save button while a form is still loading → reads **"Loading…"**
      and is disabled.
- [ ] **1.9** Google: with a calendar connected, try to connect a *different*
      Google account. → Refused, with a message telling you to disconnect
      first. *(Only if you turn Google on in the sandbox — it is off in
      production and out of the accepted release scope. Skip otherwise.)*

---

## Phase 2 — core flows, main account

- [ ] **2.1** Create a one-off event. Appears on the calendar on the right day.
- [ ] **2.2** Create a recurring event. Appears on every expected date.
- [ ] **2.3** Page between months. Events appear where they should; paging
      quickly does not leave a stale month on screen.
- [ ] **2.4** Edit the one-off: change title and time. Both stick.
- [ ] **2.5** Convert the one-off into a recurring series. Occurrences appear.
- [ ] **2.6** Cancel a single occurrence of a series. That date only goes;
      the rest survive.
- [ ] **2.7** Create a **private** event. Note its name for 3.6.
- [ ] **2.8** Create a personal time block. Shows as busy on your own view.
- [ ] **2.9** Create a group, add nobody yet. Open it.
- [ ] **2.10** Settings → export your data. The file downloads and contains
      your events.

---

## Phase 3 — two accounts

Second browser profile, alt account, log in.

- [ ] **3.1** Alt lands on the dashboard and sees the shared server.
- [ ] **3.2** From main: the alt appears as someone you can invite.
- [ ] **3.3** Invite the alt to the one-off event.
- [ ] **3.4** Alt sees the invitation and RSVPs **accepted**.
- [ ] **3.5** Main sees the alt's answer on the event.
- [ ] **3.6** Alt opens the **noticeboard**. → Sees the public events. **Does
      not** see the private event from 2.7. Opening it directly gives a refusal,
      not the contents.
- [ ] **3.7** Main adds the alt to the group from 2.9. Alt sees the group.
- [ ] **3.8** Main removes the alt from the group. Alt no longer sees it.

> **Known gap — expect it, do not report it as new:** the alt cannot leave the
> group themselves. Only the owner can remove them (IDEAS 87). Worth noticing
> how annoying it actually is.

### Change requests — brief yourself first

- [ ] **3.9** Alt requests a **time change** on the one-off event.
- [ ] **3.10** Main sees the request and **accepts** it.
- [ ] **3.11** The event has actually moved, for both accounts.

> **If 3.10 shows an error (a 500), check 3.11 carefully before continuing.**
> This is P21-09, known and scheduled for 1.0.1: acceptance is several writes,
> and an interruption between them can leave the request reading "accepted"
> while the event never moved. The requester is told accepted either way. If
> you hit it, record it — it means the window is wider in practice than we
> think.

- [ ] **3.12** Alt requests **adding another invitee**. Main accepts. They are
      added.
- [ ] **3.13** Main **declines** a request. Alt sees it declined.

---

## Phase 4 — Discord, and the 15-minute wait

Do **all** the triggering actions first, then go do Phase 5 while the cron
catches up.

**Fire these off:**

- [ ] **4.1** Invite the alt to a new event (triggers an invite DM).
- [ ] **4.2** Create a poll with two or three fixed time slots and invite the
      alt.
- [ ] **4.3** Create an event with a **minimum attendees** requirement.

**Then, after a tick or two:**

- [ ] **4.4** Alt receives an invite DM from the bot.
- [ ] **4.5** Alt RSVPs **from the DM buttons**. The website reflects it.
- [ ] **4.6** The DM updates to show the answer on record.
- [ ] **4.7** Alt receives the poll DM and votes from it.
- [ ] **4.8** Main sees the vote on the poll page.
- [ ] **4.9** Poll resolves once the threshold is met — or at its deadline —
      and the winning time becomes a real session.
- [ ] **4.10** Organiser gets a DM when the alt answers.
- [ ] **4.11** A "coming up" reminder DM arrives for a session that is close.

### The one that needs care

- [ ] **4.12** Take an event that is **one-off**, wait for its cancel DM
      button to exist, then **convert it to a recurring series**, then press
      the old **"Cancel this session"** button in the DM. → It **refuses**,
      says it is a repeating event now, and points you at the site. **All
      dates survive.**

> This was P21-04: that button used to cancel the whole series. It is the only
> Discord check here that is testing a real fix rather than a feature.

- [ ] **4.13** Cancel a genuinely one-off event from its DM button. → It
      cancels, and says so.

---

## Phase 5 — polls in depth, while Phase 4 cooks

- [ ] **5.1** Create a **window** poll (a span, not fixed slots). Both accounts
      submit availability. A common window is found.
- [ ] **5.2** Create a **multi-winner** poll. Confirm two days independently.
      Both become sessions.
- [ ] **5.3** Set a poll deadline a few minutes out. After it passes, the alt
      tries to vote. → **Refused**, before the cron has resolved anything.
- [ ] **5.4** Same, but the alt tries to **clear** an answer they already gave
      after the deadline. → Also refused.

> 5.3 and 5.4 are P21-05, closed in the last two passes. 5.4 in particular is
> the half that was missed the first time.

- [ ] **5.5** The scheduling assistant / availability grid shows both accounts'
      busy time from their personal blocks.

---

## Phase 6 — settings, policy, and the destructive ones last

- [ ] **6.1** Change your timezone. Events redisplay correctly.
- [ ] **6.2** Turn off free/busy visibility on the alt. Main can no longer see
      the alt's busy time.
- [ ] **6.3** Read the Privacy Policy page end to end. **Is every sentence
      true of what you just saw the app do?** It was rewritten for 1.0, which
      is why that rewrite is sequenced *before* this walkthrough rather than
      after — reading text that is about to be replaced tests nothing.
- [ ] **6.3b** The rewrite bumps the policy version, so **the reacceptance
      prompt is a code path this walkthrough has to exercise**: the alt account
      is asked to agree again on next load, cannot proceed without doing so,
      and is not asked twice afterwards.
- [ ] **6.4** Read the Terms and the changelog page.
- [ ] **6.5** `/add-bot` — the self-service flow lists servers you administer.

**Last, and in this order:**

- [ ] **6.6** Delete the **alt** account. Read the confirmation dialog first —
      does it tell the truth about what it leaves behind?
- [ ] **6.7** After deletion: main's events survive, the alt's own events are
      gone, and nothing in the app 500s where the alt used to be.

> Do not delete your main account. 6.6 is on the alt only.

---

## Phase 7 — the soft launch

Only after Phases 0–6 are clean and anything they turned up is fixed.

Production, the real friend group, deliberately small. Tell them it is new and
that you want to hear when something is confusing rather than only when it
breaks. The ODDs are the point.

Brief yourself on these before anyone else is involved:

- If accepting a change request errors, **check the event actually moved**
  (P21-09, 1.0.1).
- Nobody can leave a group; you have to remove them (IDEAS 87).
- The OAuth callbacks **are** bounded now — item 92 was pulled into 1.0 and
  closed by moving the Worker onto the zone and adding the rule, so release-bar
  clause 3 is met by being fixed rather than excepted. Worth confirming the
  rule is actually live on the `uncleowen.space` zone before you invite anyone.
- Google sync is **off** in production and out of scope for 1.0.

---

## What this plan does not cover, deliberately

- **Google Calendar sync.** `GOOGLE_SYNC_MODE` is `off` in production and the
  accepted release scope is Google-disabled. Turning it on is its own decision
  with its own findings still open (F60-A/B, P21-11, P21-12).
- **Load or abuse testing.** Related to IDEAS 92 and not a friend-group
  concern.
- **Anything already covered by the 841 worker and 131 frontend tests.** This
  plan is for what those cannot see: whether the product makes sense to a
  person using it.
