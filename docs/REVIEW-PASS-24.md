# Review package — Pass 24, the 1.0 candidate's late changes

**For:** Astra, as the executing reviewer.
**Prepared:** 9 November 2026, on `claude/practical-ptolemy-xqv8nj`.
**Asked for:** an executing review of six changes made *after* Pass 23 cleared
the release gates, against the release bar in `docs/ROADMAP.md` ("What release
ready means"). Your call on each decides whether it ships in 1.0.

## Read this first

**Why this pass exists.** Pass 23 passed all six release gates on 12 September.
Everything below landed afterwards: one item the bar itself required (92), and
five found by the first human browser walkthrough (22 October and 8 November).
The project's own record says late write paths added after acceptance are
where its regressions have come from, so none of this ships on the author's
word.

**The standard, restated from ROADMAP.** Release clearance follows the
executing reviewer. *Only a reproduction is evidence, in either direction* — a
surface declared clean is not evidence it is, and a finding is not one until
it reproduces. Findings in categories 1 and 2 block; everything else is
scheduled. The line, verbatim: a wrong write reachable on the ordinary path, or
under a race no faster than a person, blocks; a wrong write that needs a
concurrent actor inside a request-length window is scheduled. Clause 4: every
destructive action's confirmation states what it does **not** undo.

**What the author already did, so you can spend your time elsewhere.** Every
guard below was revert-checked — the fix removed, the named test watched
failing with the predicted symptom, the fix restored — and the tests that pass
either way are labelled as invariant guards rather than counted. A browser
walkthrough against the sandbox then passed every step that exercises these
items (dates and step numbers in each section). What has **not** happened is
any review by someone other than the author. Treat the walkthrough as evidence
the happy paths render, not that the edges are right.

## Coordinates

| | |
|---|---|
| Repository | `michaelwdorrill/Jedi-Party-Scheduler` |
| Branch | `claude/practical-ptolemy-xqv8nj` |
| Base (Pass 23 cleared) | `2133fb5` |
| Head | the branch tip (this file's commit or later) |
| Code diff | `git diff 2133fb5 HEAD -- worker/src frontend/src worker/wrangler.toml worker/scripts worker/migrations` |
| Sandbox Worker | `https://jedi-party-scheduler-worker-sandbox.uncleowen.workers.dev` (deployed from the `sandbox` branch, same `worker/` tree as head) |
| Frontend | local only: `VITE_API_BASE_URL=<sandbox worker> npm run build && npx vite preview --port 5173 --strictPort` in `frontend/` |
| Tests | `cd worker && npx vitest run` (878), `cd frontend && npx vitest run` (153) |

`--port 5173` matters: it is the sandbox Worker's `FRONTEND_URL`, which drives
both CORS and the OAuth redirect. `CLAUDE.md` has the rest of the sandbox
mechanics.

## Outcome (9 November 2026)

Both reviews are in (Astra on the policy; a Fable model on the policy and this
package). On this package's code: **P24-01** (category 2: an accepted change
request brought back a date the organizer had cancelled, including through the
72-hour sweep) and **P24-02** (an organizer's pre-fan-out "no" shown as "yes"
and counted) are fixed and revert-verified; **P24-03** and **P24-04** are
1.0.1 (IDEAS 101). Items 92, 94, 95, 96 and 99 cleared on a static read; 92
was then reworked (the binding never refused live), and the D1 counter was
seen refusing live on 10 Nov (0.0b: 20 allowed, 21–25 refused). The reviewers' own limit stands: neither executed the code,
so the walkthrough steps (2.28–2.31, 3.22, 5.15–5.18, 6.3/6.3b,
6.5b, 6.6) are where "clears" becomes evidence.

## Scope at a glance

| Item | What | Main code | Tests | Walkthrough |
|---|---|---|---|---|
| **92** | OAuth callbacks rate-limited (bar clause 3) — **reworked 9 Nov**: the Cloudflare binding never refused, now an exact count in D1 | `worker/src/lib/rateLimit.ts:91`, three callers, migration 0048, cron prune | `rateLimit.test.ts` (12) | 0.0b / timetable R92 — binding **failed live**; the D1 counter **passed live** 10 Nov (20 allowed, 21–25 refused) |
| **94** | Organizer moves one occurrence of a series | `routes/events.ts:546`, `lib/events.ts:313`, `MoveOccurrenceForm.tsx` | `occurrenceMove.test.ts` (11) | 2.21–2.27, 3.20 |
| **95** | A sole invitee's time change waits for the organizer; organizer can't vote | `lib/changeRequests.ts:203`, `:298`, `cron/reminders.ts:857` | `changeRequests.test.ts` (+5, one replaced) | 3.9–3.11, 3.21 |
| **96** | Moving a start moves the end by the same elapsed time | `frontend/src/lib/timeRange.ts:76`, five forms | `timeRange.test.ts` (+6) | 2.28–2.31 |
| **97** | A confirmed multi-winner day that drops below threshold is called off | `cron/reminders.ts:1775`, `lib/polls.ts:201`, `:782`, `routes/events.ts:29`, `:207`, `callOff.ts`, `PollOptionRow.tsx` | `confirmedDayThreshold.test.ts` (7), `callOff.test.ts` | 5.10–5.14 (8 Nov) |
| **99** | Cancelling a multi-winner poll leaves its scheduled days on, and says so | `cron/reminders.ts:1645`, `callOff.ts:43` | `pollCancelNotice.test.ts` (3), `callOff.test.ts` (+3) | 5.15–5.16 (**not yet run**) |
| — | The organizer stopped being treated as an invitee of their own event | `EventDetailPage.tsx:483`, `changeRequests.ts:298`, reminders CTE | in 95's | 2.27, 3.21 |

The last row is not a numbered item but changed behaviour in three places; it
was the root cause of two of the walkthrough's findings (idea 26 gave every
organizer an `event_invites` row, and three checks read "has an invite row" as
"is an invitee").

---

## 92 — the OAuth callbacks are rate-limited

**Why.** Bar clause 3: every unauthenticated endpoint that spends a metered
third-party resource is bounded. Each OAuth callback, once its signed state
verifies, spends a token exchange (Discord's, or Google's for
`/google/callback`). F-59 made a forged state cost an HMAC; it did not bound
the rate.

**What happened first.** This shipped as Cloudflare's Workers rate-limiting
binding (`OAUTH_CALLBACK_LIMITER`, 20 per 60 s), with seven tests against a
fake binding that counted exactly. The walkthrough's first live run of the
loop (R92, 9 Nov) drove 25, then 60 at one a second, then 25 real callbacks at
the sandbox: **every one reached Discord's token exchange**. A temporary log in
`wrangler tail` showed every call sharing one key and the binding answering
`success: true` to all of them. The binding is removed (commit `6775e54`);
IDEAS 92 has the account and the lesson (a test double for a platform service
tests the use of its contract, not the contract).

**What.** An exact count in D1. Migration 0048 adds
`oauth_callback_counts(bucket PK, window_start, count)`.
`oauthCallbackAllowed` (`rateLimit.ts:91`) derives the bucket as an
HMAC-SHA256 of `CF-Connecting-IP` under `JWT_SIGNING_KEY`, truncated to 16
bytes (`:63`) — the address is never stored and the row has no user column.
It deletes earlier minutes' rows, then does one atomic
`INSERT … ON CONFLICT(bucket) DO UPDATE … RETURNING count`, and refuses above
20 per calendar minute. Called in all three callbacks **after** the signature
check and **before** the exchange (`auth.ts:176`, `google.ts:208`,
`guildRequests.ts:103`). Refusal: 429 with *"Too many login attempts from this
address…"* on Discord's two; a redirect to `?google=rate_limited` on Google's,
with a matching message in `ConnectedCalendars`. The cron tick also prunes
earlier minutes (`pruneOAuthCallbackCounts`, `rateLimit.ts:136`, called at
`cron/reminders.ts:3635`), so a row outlives its minute by at most one
fifteen-minute tick even when nobody logs in — the privacy draft states that
figure. The binding is gone from `wrangler.toml`, `env.ts` and
`check-env-parity.mjs`.

**Choices to examine.**
- **Fails open** if the database can't be written (logged). The argument:
  login writes D1 too (user upsert, membership sync), so an outage that
  disables the limiter has already disabled what it protects. Is that the
  right side to fail on?
- **A missing `RETURNING` row is a fault, not zero.** The first draft read it as
  zero against the test shim and allowed everything silently.
- **No header → one shared bucket** (`'no-connecting-ip'`), never an
  unlimited one.
- **Fixed calendar-minute window**: a burst straddling a boundary can reach 40.
  The `CASE` reset inside the upsert is backed up by the `DELETE`, so it is not
  separately testable; the code comment says so.
- **IPv6 keyed on the full address**, so a caller with a prefix can rotate.
- **Pseudonymous, not anonymous**: with the key, an IPv4 bucket can be reversed
  by trying all four billion. The policy draft treats it as personal data.
- **One more uncharged statement per cron tick** for the prune; `pass9`'s
  empty-tick bound went 32 → 33, the full-tick ≤50 ceiling and pass6's purge
  fit still pass.
- The edge alternative (a WAF rule) needs a Cloudflare zone; the domain is on
  Namecheap/GitHub Pages. `docs/SETUP.md` has the comparison.

**Evidence so far.** Twelve tests driving the real counter through the SQLite
shim, revert-checked: never refusing fails six; ignoring the address, storing
it, skipping the callback's clean-up, and dropping the cron prune each fail
their own. **Observed live on 10 November 2026** (walkthrough 0.0b / R92): 25
real callbacks from one machine against the sandbox, the first 20 reached
Discord's token exchange and the 21st to 25th were refused with the 429 text.

**Please look at:** whether anything other than these three routes spends a
provider token unauthenticated (the bar says *every* such endpoint); whether
the limiter's position after signature verification can be used to burn a
real user's allowance (it cannot without a valid state, which `/auth/login`
issues to anyone — so: can a caller exhaust *someone else's* bucket? only from
their IP, which is the design).

---

## 94 — the organizer can move one occurrence

**Why.** The walkthrough found an invitee could get one date of a series
moved (a change request the organizer accepts) and the organizer could not.
Nobody decided that; it fell between specs 0003 and 0014.

**What.** `POST /events/:eventId/occurrences/:date/move` (`routes/events.ts:546`):
date and body validated, then owned + active, then recurring, then
`isSeriesOccurrence` (only real dates of the series), then
`writeOccurrenceMove` (`lib/events.ts:313`) — the accept path's override
write, **extracted unchanged** so there is one way an occurrence moves. Its
admission check (`OVERRIDE_ADMISSION_SQL`, P15-06) travels inside the
statement. The page: *Move this occurrence* beside *Cancel this occurrence*,
gated on active + recurring + `?occurrence=`; the form is keyed per date
(P19-04's lesson) and says answers carry over, nobody is messaged, and
reminders still to come show the new time.

**Choices to examine.**
- **Nobody is notified of a move.** The form says so to the organizer. Is
  that enough under clause 4, given invitees who already answered for that
  date see a new time with no message?
- **Moving a cancelled date brings it back.** `writeOccurrenceMove` sets
  `is_cancelled = 0` on conflict, as the accept path always has. The page
  cannot reach it: a cancelled date resolves to `startAt: null`
  (`resolveOccurrence` expands without it) and *Move* is gated on `startAt`.
  What remains is the owner calling the route directly, and — older than this
  item — an invitee's change request filed for a date that is cancelled
  before it is accepted. Does accepting that request bring the cancelled
  session back without telling anyone?
- Overrides are keyed on the *nominal* date; attendance and reminder dedupe
  key on it too. A move that crosses midnight, or lands on another
  occurrence's date, should still be one session — worth one reproduction.
- A move into the past is accepted (`assertTimeRange` checks order and
  length, not "future"). Intended?

---

## 95 — a sole invitee's time change waits for the organizer

**Why.** Spec 0003 set the threshold at `floor(n/2)+1` with the requester's
implicit yes. With one invitee that is 1, so the request carried itself and
the organizer's event moved without them. Reversed by Michael; the spec
records the reversal.

**What.** `createChangeRequest` (`changeRequests.ts:203`): with ≤1 invitee, a
time change gets no threshold and no deadline, and `tryAutoResolve` is
skipped; the deadline sweep keys on the deadline and so never resolves it.
Alongside, two organizer-as-invitee fixes: `voteOnChangeRequest` refuses the
organizer (`:298` — before, their vote counted toward a threshold computed
without them, so requester + organizer carried a three-invitee request), and
the "a request is open for your vote" reminder no longer goes to the organizer
(`reminders.ts:857`, the `opened_recipients` CTE).

**Known and left:** someone invited after a solo request is filed sees it as
open for their vote; the vote is recorded, shows in the organizer's tally, and
cannot resolve anything. Logged as 1.0.1 in IDEAS 95.

**Please look at:** the invitee count used for "sole" — taken at filing time.
What happens to a pending solo request when a second invitee is added (still
organizer-decides, by design) or the sole invitee is removed?

---

## 96 — moving a start takes the end with it

**What.** `endFollowingStart` (`timeRange.ts:76`) keeps the range's **elapsed**
length; a four-hour session moved onto a DST night stays four hours. A range
with no positive length (half-typed, or end before start) keeps only the old
date-level nudge, so nothing mid-typing is rewritten. Wired into
`TimeRangeFields` (change-request form and *Move this occurrence*),
`EventFormPage` (event times and each poll option row), and
`PersonalEventPage`.

**Evidence:** the logic is unit-tested and revert-checked (three of six new
tests fail without it; three are invariant guards). **The wiring into five
forms has no component test** — that is what walkthrough 2.28–2.31 are for,
and those were marked very quickly on 22 October. A real reproduction of each
form would be worth more here than a code read.

---

## 97 — a confirmed poll day that drops below threshold is called off

The largest and newest write path in this package. **Please weight your time
here.**

**Why.** On a multi-winner poll, *Can't make it* on a confirmed day left it
confirmed — and once the day had become its own event (spec 0014's fan-out,
within one cron tick), the answer reached nothing: the poll row recorded it
and the real session went on counting the person.

**What, in two halves:**
1. **Before fan-out** (at most a tick): `checkThresholdAndResolve` clears
   `confirmed_at` when the yes count falls below the threshold
   (`unconfirmOption`, `polls.ts:201`), guarded on `NOT EXISTS` a fanned-out
   event and on the poll's revision. Nobody has been told; it can confirm again.
2. **After fan-out:** the day's event inherits the poll threshold as
   `minimum_attendees` with auto-cancel on, and the yes-voters start out
   `accepted` (`createFannedOutEvent`, `reminders.ts:1775`). The existing,
   reviewed minimum-attendees cascade in `recordRsvp` is what calls the day
   off, and its existing notice tells everyone still coming. A vote on the
   poll row for a fanned-out day is recorded as an RSVP on the day's event
   (`polls.ts:782`) and kept on the poll as history; a called-off day refuses
   later answers. `GET /events/:id` reads each day's going list, the viewer's
   answer and per-voter overrides from the day's event (`routes/events.ts:207`,
   `sessionAnswer` at `:29`).

The page: a called-off row is struck through with no buttons; a fanned-out row
links to its event; *Can't make it* that would call a day off is confirmed
first, saying it cannot be put back (clause 4). The same check now guards any
one-off event with a minimum and auto-cancel on, which had always cancelled on
that decline without warning (`callOff.ts:13`, `:24`).

**Behaviour that changed and was true before — please judge each:**
- The yes-voters are carried into the day's event as attendance. Spec 0014
  said a vote and an RSVP are different statements; this treats *I'm in* on a
  confirmed day as the second. Defensible, but a reading of the principle.
- The day's event counts the organizer unless they decline (as every event
  does); the poll's threshold counted them only if they voted. An organizer who
  never voted makes a day survive one more dropout than the poll's arithmetic
  suggests.
- P21-05's "a confirmed candidate stays joinable forever" now means joinable on
  the day's event.

**Races worth a reproduction:** a vote landing while the fan-out sweep is
mid-flight (the routing reads "is there a day event" before writing; the
fan-out seeds from votes); `unconfirmOption` against fan-out on the same tick;
two simultaneous declines at the threshold (the cascade's UPDATE is guarded on
`status = 'active'`).

**Known and left (IDEAS 97):** windowed polls unchanged; the Discord poll
select does not reach a fanned-out day; someone invited to the poll after
fan-out is not on the day's event; a called-off day is final.

**Evidence:** five worker guards revert-checked one by one (pre-fan-out
un-confirm, inherited minimum, carried yes, routing, display); three frontend
guards likewise; 5.10–5.14 run against the sandbox on 8 November with real
Discord DMs.

---

## 99 — cancelling a multi-winner poll leaves its scheduled days on

**Why.** Found cleaning up after the walkthrough: cancelling a multi-winner
poll cancelled only the poll row, the dialog asked only "Cancel this event for
everyone?", and invitees were told either that nobody had been interested or
that days were confirmed. Michael decided the days stay on; this makes both
messages say so.

**What.** The dialog (`cancelEventMessage`, `callOff.ts:43`) names the days
that are their own events, says they will still happen, and says how to cancel
them too. The notice (`pollClosedMessage`, `reminders.ts:1645`) tells an
organizer cancel apart from a deadline one **without new state**: the deadline
sweep never leaves a poll `cancelled` with a confirmed day (it marks those
`resolved`), and the organizer can only cancel an active poll. So
cancelled-with-confirmed is always the organizer; cancelled-with-none is the
organizer if it happened before the deadline. Only *live* day events are
counted — a day confirmed but not yet fanned out never will be (the fan-out
skips cancelled polls) and goes with the poll.

**Please look at:** the inference. The one case read as "deadline" is an
organizer cancel in the minutes between the deadline passing and the sweep
running, with nothing confirmed; the message sent is true either way. Is there
a path that sets a multi-winner poll `cancelled` that this misses?

**Not yet run in a browser** (5.15–5.16).

---

## Outside this package, so you don't spend time on them

- **The Privacy Policy and Terms rewrite** has not happened; it is a separate
  review. Walkthrough 6.3/6.3b wait on it.
- **IDEAS 98** (converting a one-off into a series orphans its answers, and
  old DM buttons then say "looks corrupted") is scheduled for 1.0.1.
- **IDEAS 100** — small things from the 8 November run (a sandbox banner, "1
  people", refusal links to the front page, the default start after 7pm, the
  sandbox bot's voice-channel permission, a prompt deferred a tick by the
  delivery cap, the organizer told of their own cancel).

## The questions, ranked

1. **97's write paths under concurrency**, and whether carrying yes-votes into
   attendance is a correct reading of spec 0014 (category 2 if it writes an
   answer someone did not give).
2. **99's inference** that tells an organizer cancel from a deadline one.
3. **92: the binding failed live and was replaced by a D1 counter.** Check the
   replacement's write (race, window, fail-open) and its privacy claim, confirm
   no other unauthenticated route spends a provider token, and look for the
   live R92 result before clearing it.
4. **96's five wirings**, reproduced rather than read.
5. **94: a change request accepted after its date was cancelled** — does it
   revive the session silently? (The page can't reach this; the accept path
   can, and predates this cycle.) Plus 94's no-notification choice under
   clause 4.
6. **95's** behaviour when the invitee list changes under a pending solo
   request.
