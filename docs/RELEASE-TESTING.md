# Release testing plan — v1.0 candidate

**Status: not started.** Written 13 September 2026 against
`claude/practical-ptolemy-xqv8nj`, after the Pass-23 acceptance review passed
all six release gates.

## Why this exists

Twenty-three review passes, 848 worker tests, 131 frontend tests, a reviewer
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

**If you want the other view of this document** — every change the review cycle
made, mapped to the step that would catch it regressing, with an honest note on
how much automated coverage each already has — that is **Appendix A** at the
end. It also ranks the five steps to do first if time is short.

---

## Prerequisites — read before starting, this is where it derails

**The sandbox has its own Discord application.** It is a *different bot* from
production, with its own token and its own public key. So:

- [ ] The **sandbox bot** must be installed in a Discord server that contains
      **both** your main account and your alt.
- [ ] That server must be allow-listed in the sandbox database.
- [ ] Both accounts must actually be members of it.

If DMs never arrive in Phase 4, this is almost always why.

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
- [ ] **0.0b** The OAuth callback rate limiter is live (item 92). There is
      nothing to click — it is a Worker binding and Cloudflare does not surface
      bindings in the dashboard. Deploy Sandbox run #72 succeeding is the proof
      the plan accepts it. To watch it actually refuse: with
      `wrangler tail --env sandbox` running, log out and back in about
      twenty-five times inside a minute. Somewhere past the twentieth you get
      *"Too many login attempts from this address"* and the tail shows no
      Discord token call for it. **Then wait a full minute before continuing**,
      or the next few steps will look broken.

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

### Recurrence, in the depth the review cycle changed it

Five separate findings landed in the expander and the series writers, and the
steps above only scratch it. These are the ones that would catch a regression.

- [ ] **2.11** Edit the **series** (not one occurrence): change its title. →
      Every occurrence shows the new title, and **not one date has moved**.
      *(Editing a recurring event used to rewrite its schedule.)*
- [ ] **2.12** Move a **single occurrence** to a different day. Then edit the
      series title again. → The moved occurrence keeps its **moved** date and
      picks up the new title; the others are untouched.
- [ ] **2.13** Open that moved occurrence on its own — its own link — and
      reload the page. → It resolves to the moved occurrence, not to a 404 and
      not to the nominal date.
- [ ] **2.14** Look at a series whose occurrences have **all finished**
      (backdate one if there isn't one). → The noticeboard and the calendar
      still show everything else. A fully-past series must not empty either.
- [ ] **2.15** Open a blank **New event** form. → It defaults to **7pm–11pm**,
      not 1pm–5pm.

### Sessions — no browser has ever exercised these

A large share of the review cycle went into session rotation, session families
and revocation, and **none of it has been seen in a browser**. A session bug
does not look like a session bug; it looks like being randomly logged out, or
like one tab fighting another.

The access token lasts **30 minutes** and the frontend refreshes it silently,
so the refresh path only runs if you *wait*. Start 2.16 early and come back to
it — it pairs naturally with the Phase 4 cron wait.

- [ ] **2.16** Leave a tab open and idle for **over 30 minutes**, then click
      something that loads data. → It works, with no flicker to a login screen
      and no error. *(This is the refresh path. It is the single most likely
      thing to be broken and the least likely to be noticed.)*
- [ ] **2.17** Two tabs, same account, both logged in. Use both, alternating,
      for a few minutes. → Neither logs the other out.
- [ ] **2.18** **Log out** in one tab. Then click something in the other. →
      The other tab lands on the login screen cleanly. No half-logged-in state
      showing your data with everything failing.
- [ ] **2.19** Log back in. → Straight back to the dashboard, your data intact.
- [ ] **2.20** In a **private window**, paste a URL to one of your events while
      logged out. → Login screen or refusal, never the event.

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

### Access removal — several findings, one observable behaviour

The rule these all restate: **access is checked when something is sent or
opened, not when it was queued or linked.**

- [ ] **3.14** Main **removes the alt** from an event they were invited to. →
      The alt no longer sees it anywhere, and **no further DM about it
      arrives** on the next tick or the one after. *(Check this against Phase
      4 — a queued DM must not outlive the access that justified it.)*
- [ ] **3.15** While logged in as the alt, paste the URL of the event they were
      just removed from. → Refused. Knowing the id is not permission.
- [ ] **3.16** On the noticeboard, an event's organiser shows as **attending**,
      the same as in every other view.

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

- [ ] **5.6** **Edit a poll after votes are cast** — rename it, then add a new
      time option. → Every vote already cast is **still there**. *(Editing a
      poll used to delete them.)*
- [ ] **5.7** Create a **private** multi-winner poll and let it resolve. → The
      sessions it creates are **private**. Check from the alt: they are not on
      the noticeboard. *(A private multi-winner poll used to fan out public
      events.)*
- [ ] **5.8** Try to create a poll whose **threshold is higher than the number
      of people invited**. → Refused at creation, with a message that explains
      it, rather than accepted and never resolvable.
- [ ] **5.9** On a poll that has **already resolved**, the alt RSVPs to the
      resulting session. → It works.

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
  closed in the Worker with Cloudflare's rate-limiting binding, so release-bar
  clause 3 is met by being fixed rather than excepted. The limit is **per
  Cloudflare location rather than global**, which is a real bound and not a
  perfect one; the custom domain that would allow a proper edge rule is now
  ordinary future work, not release work.
- Google sync is **off** in production and out of scope for 1.0.

---


---

## Appendix A — what changed this cycle, and what would catch it

**Why this exists.** The phases above are organised by feature area, which is
the right shape for walking the product but the wrong shape for answering
"did the review cycle break anything?" This appendix is the other view: every
user-observable change across the **98 commits since `main`**, and the step
that would notice if it regressed.

**What the sandbox adds over the test suite, stated honestly.** 848 worker
tests and 131 frontend tests cover most of the *logic* below, and each fix was
revert-verified — the test was watched failing before the fix and passing
after, so these are not tests that pass vacuously. What no test can see is:

- **The frontend.** 131 tests against a component tree, and until this
  walkthrough, zero browser runs of any kind.
- **Real Discord.** Every DM test stubs `fetch`. Nothing has proved a real
  interaction round trip.
- **The real cron, on real timing.** Tests call the tick directly.
- **The rate limiter in the real runtime.** Its tests use a fake binding.
- **Whether any of it makes sense to a person.**

So the **Confidence** column below is not about whether the code is right. It
is about how much of the risk the automated tests have already taken off the
table, and therefore how hard to look here.

| Area | What changed | Step | Confidence before testing |
|---|---|---|---|
| **Forms** | RG-01/RG-02 — two form routes shared a component, so a previous record's draft survived. Fixed by keying on record identity | **1.1–1.6** | **None.** Reasoned from React's reconciliation rule; never run |
| **Forms** | P21-01 — the personal editor's loader set recurrence conditionally, so a fixed block inherited the previous one's repeat rule | **1.4, 1.5** | Low. Unit-tested, never seen |
| **Forms** | P21-02 — create-mode draft overwrite | **1.1, 1.2** | Low |
| **Forms** | New events default to 7pm–11pm | **2.15** | Low, but trivially visible |
| **Sessions** | Rotation on refresh; session families; a refresh coalescing instead of minting; revocation surviving the claim, the prune and the cap | **2.16, 2.19** | Medium logic, **zero browser** |
| **Sessions** | Identity shared across tabs; a stale refresh no longer logs out the new account | **2.17, 2.18** | **Zero browser.** This is a two-tab bug by definition |
| **Sessions** | A login can only be completed by the browser that started it; a refused login leaves no record | **2.19, 2.20** | Good — tested end to end |
| **Sessions** | F-59 signed OAuth state; item 92 rate limit | **0.0b** | Good. 7 tests, revert-verified; fake binding though |
| **Recurrence** | Editing a recurring event rewrote its schedule | **2.11** | Good logic coverage |
| **Recurrence** | Expansion seeded by overrides, not only nominal dates; moved occurrences findable and ordered | **2.12, 2.13** | Good logic coverage |
| **Recurrence** | Series count their own occurrences; long occurrences found in narrow windows | **2.2, 2.3, 2.11** | Good |
| **Recurrence** | Stored overrides bounded at every writer | **2.12** | Good |
| **Noticeboard** | P17-07/P19-01/P20-03 — three consecutive regressions, finally fixed by deleting the pager for a single snapshot | **3.6, 2.14** | Medium. **The most-rewritten file in the codebase** — look hard |
| **Noticeboard** | Finished series no longer empty it; resolved polls appear; organiser shows as attending | **2.14, 3.16, 5.7** | Good |
| **Polls** | Editing a poll deleted the votes cast on it | **5.6** | Good |
| **Polls** | A private multi-winner poll fanned out public events | **5.7** | Good |
| **Polls** | Threshold higher than the invitee count | **5.8** | Good |
| **Polls** | RSVP on a resolved poll; the invitee cap counts the whole event | **5.9, 3.3** | Good |
| **Polls** | P21-05 + RG-05 — the advertised deadline held at all three submission paths, including clearing an answer | **5.3, 5.4** | Good. RG-05 is the half missed first time |
| **Polls** | Window polls; multi-winner confirmation | **5.1, 5.2** | Good |
| **Access** | A removed invitee stops receiving DMs; a queued DM does not outlive the access | **3.14** | Good logic, **DMs are stubbed** |
| **Access** | Every outgoing message re-checks current access, editing included | **3.14, 4.x** | Good logic, DMs stubbed |
| **Access** | An id you know is not permission to use it | **3.15** | Good |
| **Access** | P21-03 — the roster write bound to current ownership | **3.7, 3.8** | Good |
| **Access** | Private events stay private | **3.6** | Good |
| **Change requests** | The recovery arm that re-admitted removed guests was **deleted** | **3.9–3.13** | Good |
| **Change requests** | Resolution prices its branches and reserves before claiming; the accept path stops acting on stale reads | **3.10, 3.11** | Good. **P21-09 is still open** — see the warning at 3.10 |
| **Discord** | P21-04 — a one-session cancel took a converted series with it | **4.12** | Good logic, **never a real button press** |
| **Discord** | A cancel that changed nothing no longer reports success | **4.13** | Good |
| **Discord** | Outbox eligibility on the retry query; a failed organizer RSVP notice retries | **4.10** | Medium. Timing-dependent |
| **Discord** | Cancellations reach everyone | **2.6, 4.13** | Good |
| **Cron** | The deadline sweeps stay inside the Free-plan D1 ceiling and keep moving | **4.9, 4.11** | Good logic, **never run on real timing** |
| **Account** | Deletion no longer fails for anyone who took part in someone else's event | **6.6, 6.7** | Good — and destructive, so it is last |
| **Account** | The export returns everything held about you | **2.10** | Good |
| **Policy** | The Privacy Policy made true; policy version bump and reacceptance | **6.3, 6.3b** | **Text is being rewritten before this runs** |
| **Assets** | Webfonts self-hosted | **0.4** | Visible immediately if broken |
| *(excluded)* | ~20 Google Calendar commits | — | Out of scope: `GOOGLE_SYNC_MODE = "off"` in production |

### The five to do first if you only have an hour

Ranked by (no automated coverage) × (how bad it is if broken):

1. **1.1–1.6** — the remount. Unverified by anything, and it corrupts saved data.
2. **2.16** — the 30-minute session refresh. Nothing has ever run it in a browser, and it breaks for everyone at once.
3. **2.17/2.18** — two tabs. A whole class of bug that only exists in a browser.
4. **4.12** — the Discord cancel on a converted series. The one Discord check testing a real fix, and its failure destroys a series.
5. **3.14** — a removed invitee still getting DMs. Logic is covered; the delivery path is entirely stubbed.

## What this plan does not cover, deliberately

- **Google Calendar sync.** `GOOGLE_SYNC_MODE` is `off` in production and the
  accepted release scope is Google-disabled. Turning it on is its own decision
  with its own findings still open (F60-A/B, P21-11, P21-12).
- **Load or abuse testing.** Related to IDEAS 92 and not a friend-group
  concern.
- **Anything already covered by the 848 worker and 131 frontend tests.** This
  plan is for what those cannot see: whether the product makes sense to a
  person using it.
