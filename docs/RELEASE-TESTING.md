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
- [ ] **The alt also needs Discord open, not just the website.** Phase 4 has
      the alt receiving bot DMs and pressing their buttons, and the Discord
      desktop app shows one account at a time. Sign the alt into Discord in its
      own browser profile at `discord.com/app`, or on a phone. Without this,
      4.4–4.7 cannot be run, and nothing else in this list would have told you.
- [ ] **A second computer is optional, and if used it runs its own frontend.**
      Nothing here needs one. If the alt is on a laptop, that laptop must
      clone the repo and run `npm run build` + `npx vite preview --port 5173 --strictPort`
      itself, because the sandbox only accepts `http://localhost:5173` and on
      the laptop `localhost` is the laptop — browsing to the main machine's
      address fails CORS, and Discord's login redirects back to the laptop's
      own `localhost` regardless. It needs git and Node 22, and **no
      Cloudflare credentials**: the frontend never touches `wrangler`.
- [ ] `--port 5173` is not a default and not optional. `vite preview` defaults
      to 4173, and on 4173 login and the Google connect flow both break in ways
      that look like app bugs.
- [ ] **`--strictPort` with it, every time.** If 5173 is already taken — a
      `npm run dev` from earlier, a previous preview — `--port 5173` alone
      quietly starts on 5174, and the tab on 5173 keeps showing the old app.
      `--strictPort` makes it fail with *Port 5173 is already in use*. Stop
      the old server (Ctrl+C in its window) and run it again.

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
- [ ] **0.0c** **Your local clone is the candidate.** `git branch --show-current`
      prints `claude/practical-ptolemy-xqv8nj`; `git log --oneline -1` matches the
      newest commit on that branch on GitHub; and after building,
      `Select-String -Path dist\assets\*.js -Pattern "Move this occurrence" -List`
      in `frontend\` prints a file. *(Added 22 Oct: the first walkthrough ran a
      morning of checks on a 10 September branch, 83 commits behind, because a
      locally changed `worker/package-lock.json` blocked `git checkout` and
      nothing asked whether it had worked. The sandbox Worker is deployed by CI
      and is always current; the frontend is whatever your clone builds. If the
      checkout is blocked, `git stash push worker/package-lock.json`, check out
      again, then `npm ci` in `worker\` and `frontend\`.)*
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
npx vite preview --port 5173 --strictPort
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
> **2.12 and 2.13 were retired on 22 Oct 2026 and their intent moved to
> 3.14–3.16.** As written they asked the organizer to move one occurrence, and
> the organizer cannot: spec 0014 gives each occurrence *Cancel this
> occurrence* beside the series-level *Edit*, never *Edit this occurrence*,
> and the change-request path refuses the organizer outright. The only route
> that moves one occurrence is an invitee's time-change request, accepted —
> which needs two accounts, so it lives in Phase 3. Found on the first real
> run: the step failed because the control it described does not exist. The
> product gap behind it is IDEAS 94 — **built the same day**, so the
> organizer's own move is now tested directly by 2.21–2.26.
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

### Moving one date — new on 22 Oct, built after the walkthrough found it missing

IDEAS 94. The newest and least-reviewed code in the build: route tests are
revert-verified, but nothing has seen it in a browser and the reviewer has not
read it. **Rebuild the frontend before these** (`git pull`, then
`npm run build` + `npx vite preview --port 5173 --strictPort`) — the sandbox Worker
deploys itself, the frontend you run locally does not.

- [ ] **2.21** Open one date of the recurring series from 2.2 *from the
      calendar*, so the page is about that date. → **Move this occurrence**
      sits beside **Cancel this occurrence**. Press it. → A form opens with
      that session's own start and end already filled in.
- [ ] **2.22** Move it later **the same day** and press *Move this date*. → The
      page stays put and shows the new time. The calendar shows that date at
      the new time; next week's is untouched.
- [ ] **2.23** Move a different date **onto the next day**. → The calendar shows
      it on the new day, not the old one. Open it from there
      and **reload** — the moved time, not a 404 and not the old date. *(What
      2.12 and 2.13 were trying to test, now that the organizer can.)*
- [ ] **2.24** Edit the **series** title. → Both moved dates keep their moved
      times and take the new title.
- [ ] **2.25** Open the Move form on one date, then go to a *different* date
      from the calendar. → The form is **not** open there. *(The page has kept
      one date's state while showing another's once before — P19-04.)*
- [ ] **2.26** Read the form's text as a user. It says answers carry over,
      nobody gets a message, and reminders still to come will show the new
      time. **Is that what you'd want to know, and is any of it surprising?**
- [ ] **2.27** On your own event, the **Change requests** section offers you
      **no** *Ask to move this* or *Suggest someone* — those are for invitees,
      and the server refuses them from the organizer. *(Found on the first
      walkthrough: the page treated the organizer as an invitee, because idea
      26 gave every organizer an invite row.)*

### Moving a start takes the end with it

Asked for on the first walkthrough, and applied to **every** start/end picker
so they all behave one way. The rule: the end keeps the range's *length*. If
the range has no length yet (an end not typed, or an end before the start),
nothing is rewritten beyond the old nudge of an end date up to the start date.

- [ ] **2.28** Create-event form: start 7:00 pm, end 11:00 pm. Change the
      start **time** to 9:30 pm. → End reads **1:30 am the next day**. Then
      change the start **date** forward two days. → End date moves two days
      too, still 1:30 am.
- [ ] **2.29** The same on a **poll option row** (a fixed-slot poll), and on a
      **personal time block**. → Each row's end follows its own start; moving
      one row's start leaves the other rows alone.
- [ ] **2.30** Open **Move this occurrence** (2.22) and change the start time.
      → End follows. *(The invitee's request form uses the same fields — 3.9
      sees it from the other side.)*
- [ ] **2.31** Now type an end **earlier** than the start, then change the
      start. → The end is **not** silently fixed for you, and the form still
      says the end must be after the start. *(Deliberate: with no length to
      keep, rewriting it would be a guess.)*

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

- [ ] **3.9** Alt requests a **time change** on the one-off event (the alt
      is its only invitee). While filling the form in, change the start —
      the end follows (2.28). → After sending, the request **stays pending**
      under the alt's *My requests*. It does **not** resolve on the alt's own
      say-so. *(Before 22 Oct a sole invitee's request was carried instantly
      by their own implicit yes, so there was nothing for main to accept —
      which is how the first walkthrough found it. Now the organizer decides
      whenever there is only one invitee, and no deadline auto-resolves it.)*
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

### A moved occurrence — the only route there is

3.9–3.11 move a **one-off** event, which rewrites the event row. Moving one
occurrence of a **series** is a different code path entirely — it writes an
override that the recurrence expander has to apply on every read — and before
these steps the walkthrough never reached it. Invite the alt to the recurring
event from 2.2 first.

- [ ] **3.14** As the alt, open **one occurrence** of the recurring event from
      the calendar (so the page is about that date), and request a time change
      for it — the form's *Which occurrence?* field should already hold that
      date. Main accepts. → **That one date moves**, for both accounts. Every
      other occurrence stays where it was.
- [ ] **3.15** Main edits the **series** title. → The moved occurrence keeps
      its **moved** time and picks up the new title; the others are untouched.
      *(This is what 2.12 was trying to test.)*
- [ ] **3.16** Open the moved occurrence from the calendar, then **reload** the
      page. → It shows the moved time — not a 404, and not the original date.
      *(This is what 2.13 was trying to test.)*

### Access removal — several findings, one observable behaviour

The rule these all restate: **access is checked when something is sent or
opened, not when it was queued or linked.**

- [ ] **3.17** Main **removes the alt** from an event they were invited to. →
      The alt no longer sees it anywhere, and **no further DM about it
      arrives** on the next tick or the one after. *(Check this against Phase
      4 — a queued DM must not outlive the access that justified it.)*
- [ ] **3.18** While logged in as the alt, paste the URL of the event they were
      just removed from. → Refused. Knowing the id is not permission.
- [ ] **3.19** On the noticeboard, an event's organiser shows as **attending**,
      the same as in every other view.

### The organizer's move, seen from the other side

- [ ] **3.20** The alt answers **Accepted** for one date of the series. Main
      moves that date (2.22's control). → As the alt, that date shows the new
      time and **still shows Accepted**. No DM about the move arrives — that is
      by design, and the form told main so.

### The organizer decides; they do not vote

- [ ] **3.21** With the alt's time-change request pending, main sees **Accept**
      and **Decline** only — **no vote buttons**. *(Unreachable on the first
      walkthrough, because the sole-invitee request had already resolved
      itself; 3.9 now leaves it pending, so this can be checked.)* *(The same idea-26 cause as
      2.27. Before the fix the server also counted an organizer's vote toward a
      threshold computed without them, so one invitee plus the organizer could
      carry a request.)*

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

### A confirmed day that loses people — new on 22 Oct (IDEAS 97)

Found on the first walkthrough: "Can't make it" on a confirmed multi-winner
day left it confirmed, and once the day had become its own event the answer
reached nothing. Now a day that drops below the poll's threshold is called off.
Use a multi-winner poll with a threshold of **2**, main and the alt both
invited.

- [ ] **5.10** Both say **I'm in** on one day. → Confirmed. Within a cron tick
      (15 min) the row gains *"This day is now its own event — open it"*, and
      that event is on the calendar with **both** of you already showing as in
      — not asked again — and the line *"Called off automatically if fewer than
      2 people are in."*
- [ ] **5.11** As main, press **Can't make it** on that row. → A confirmation
      first, saying it will be called off for everyone and can't be put back.
      **Cancel it** once: nothing changes. Then do it for real. → The row reads
      **Called off**, struck through, with no buttons.
- [ ] **5.12** As the alt, on the next tick or two: a DM saying the event was
      cancelled because attendance dropped below the minimum. **Main gets no
      such DM** — they made the decision.
- [ ] **5.13** Same setup on a fresh day, but switch to **Can't make it**
      *before* the row shows "now its own event" (straight after confirming).
      → It simply goes back to "1 in", no confirmation, no DM — nobody had been
      told yet. Say **I'm in** again and it re-confirms.
- [ ] **5.14** With a threshold of 2 and **three** people in, one drops out.
      → No warning, and the day stays on.

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

**What the sandbox adds over the test suite, stated honestly.** 870 worker
tests and 150 frontend tests cover most of the *logic* below, and each fix was
revert-verified — the test was watched failing before the fix and passing
after, so these are not tests that pass vacuously. What no test can see is:

- **The frontend.** 150 tests against a component tree, and until this
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
| **Recurrence** | Expansion seeded by overrides, not only nominal dates; moved occurrences findable and ordered | **3.14–3.16** | Good logic coverage |
| **Recurrence** | Series count their own occurrences; long occurrences found in narrow windows | **2.2, 2.3, 2.11** | Good |
| **Recurrence** | Stored overrides bounded at every writer | **3.14** | Good |
| **Recurrence** | **New:** the organizer moves one occurrence (IDEAS 94) — shares its write with the accept path | **2.21–2.26, 3.20** | **Route only.** 11 tests, revert-verified; never seen, not yet reviewed |
| **Noticeboard** | P17-07/P19-01/P20-03 — three consecutive regressions, finally fixed by deleting the pager for a single snapshot | **3.6, 2.14** | Medium. **The most-rewritten file in the codebase** — look hard |
| **Noticeboard** | Finished series no longer empty it; resolved polls appear; organiser shows as attending | **2.14, 3.19, 5.7** | Good |
| **Polls** | Editing a poll deleted the votes cast on it | **5.6** | Good |
| **Polls** | A private multi-winner poll fanned out public events | **5.7** | Good |
| **Polls** | Threshold higher than the invitee count | **5.8** | Good |
| **Polls** | RSVP on a resolved poll; the invitee cap counts the whole event | **5.9, 3.3** | Good |
| **Polls** | P21-05 + RG-05 — the advertised deadline held at all three submission paths, including clearing an answer | **5.3, 5.4** | Good. RG-05 is the half missed first time |
| **Polls** | Window polls; multi-winner confirmation | **5.1, 5.2** | Good |
| **Access** | A removed invitee stops receiving DMs; a queued DM does not outlive the access | **3.17** | Good logic, **DMs are stubbed** |
| **Access** | Every outgoing message re-checks current access, editing included | **3.17, 4.x** | Good logic, DMs stubbed |
| **Access** | An id you know is not permission to use it | **3.18** | Good |
| **Access** | P21-03 — the roster write bound to current ownership | **3.7, 3.8** | Good |
| **Access** | Private events stay private | **3.6** | Good |
| **Change requests** | The recovery arm that re-admitted removed guests was **deleted** | **3.9–3.13** | Good |
| **Change requests** | Resolution prices its branches and reserves before claiming; the accept path stops acting on stale reads | **3.10, 3.11** | Good. **P21-09 is still open** — see the warning at 3.10 |
| **Change requests** | **New (22 Oct):** a sole invitee's time change waits for the organizer instead of carrying itself; the organizer is refused a vote and no longer DMed to vote | **3.9, 3.10, 3.21** | Revert-verified; **not yet reviewed** |
| **Polls** | **New (22 Oct):** a confirmed multi-winner day that drops below its threshold is called off; its own event inherits the threshold as a minimum and starts with the yes-voters counted | **5.10–5.14** | Worker revert-verified; **not yet reviewed**; real DMs untested |
| **Forms** | **New (22 Oct):** moving a start takes the end with it, in every start/end picker | **2.28–2.31, 3.9** | Logic revert-verified; **wiring is browser-only** |
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

### The six to do first if you only have an hour

Ranked by (no automated coverage) × (how bad it is if broken):

1. **1.1–1.6** — the remount. Unverified by anything, and it corrupts saved data.
2. **2.16** — the 30-minute session refresh. Nothing has ever run it in a browser, and it breaks for everyone at once.
3. **2.17/2.18** — two tabs. A whole class of bug that only exists in a browser.
4. **4.12** — the Discord cancel on a converted series. The one Discord check testing a real fix, and its failure destroys a series.
5. **3.17** — a removed invitee still getting DMs. Logic is covered; the delivery path is entirely stubbed.
6. **2.21–2.25** — moving one date. Built on 22 Oct, after everything else here was reviewed: the newest code in the build and the least looked at.

## What this plan does not cover, deliberately

- **Google Calendar sync.** `GOOGLE_SYNC_MODE` is `off` in production and the
  accepted release scope is Google-disabled. Turning it on is its own decision
  with its own findings still open (F60-A/B, P21-11, P21-12).
- **Load or abuse testing.** Related to IDEAS 92 and not a friend-group
  concern.
- **Anything already covered by the 870 worker and 150 frontend tests.** This
  plan is for what those cannot see: whether the product makes sense to a
  person using it.
