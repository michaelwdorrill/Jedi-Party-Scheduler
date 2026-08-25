# 0010 — An interactive bot

**Status:** Part built (v0.5 in progress)
**Covers:** `IDEAS.md` item 19, and item 32 (which is a cost inside it)
**Phase:** 3.75 → **v0.5**

## The problem

The bot is outbound-only. It sends invites, reminders, poll results and voice
nudges, and it cannot receive anything back: every DM it sends ends in "go to
the website". That is a real cost on the shortest paths in the app — saying
"I'm in", or picking which evening works — because those are decisions people
make while already reading Discord, and we make them leave to record it.

One new inbound surface fixes the whole class: a Discord **interactions
endpoint**, which Discord POSTs to (Ed25519-signed) whenever someone presses
a component the bot attached to one of its own messages.

## What ships in v0.5, and what does not

Idea 19 lists five things the endpoint unlocks. They are not one release.

**In:**

1. The interactions endpoint itself, with signature verification.
2. **Respond without leaving Discord**, tiered by event type (below).
3. **Edit the message when the poll resolves** — swap the vote control for the
   confirmed time and the RSVP buttons.
4. **Rich embeds** on the DMs that grow components, and only those.

**Out, deliberately, and each for its own reason:**

- **Slash commands** (`/schedule`, `/whos-free`, `/my-events`). A different
  surface with a different permission model: commands are invoked in a guild
  channel by anyone who can see it, including people with no Uncle Owen
  account and no invite to anything, so every one of them needs its own
  visibility answer before it can be written. They also need command
  registration as a deploy step, which is a second thing that can drift
  between sandbox and production. Worth doing; not worth entangling with the
  endpoint's first release.
- **Discord Scheduled Events sync.** This is a two-way sync against a resource
  we do not own, with the same conflict questions as idea 2 (who wins when
  both sides moved, what happens when someone deletes the Discord side) and a
  new permission requirement on every guild. It is idea 2's problem shape at a
  smaller scale, and it should get idea 2's treatment: its own spec.
- **Embeds everywhere.** Only the DMs that gain components get embeds in this
  release. Restyling every notification is a content change with no dependency
  on this endpoint, and doing it here would put the whole notification catalogue
  in the blast radius of a release whose risk is concentrated in one route.

## What changes for the user

Three event shapes, three widgets, because one does not fit all three. This
tiering is idea 19's own, and it survives contact with the code:

- **Fixed-time event** → three buttons, *I'm in* / *Maybe* / *Can't make it*,
  mapping exactly onto `event_invites.rsvp_status`
  (`accepted`/`tentative`/`declined`). Full fidelity — there is nothing the
  website can record here that a button cannot.
- **Options poll** → one string select of the candidate slots, `min_values: 0`,
  `max_values: MAX_POLL_OPTIONS`. Discord caps a select at 25 options and
  `validate.ts` caps `MAX_POLL_OPTIONS` at 20, so it fits with room. Chosen
  options are recorded as `yes`; unchosen ones record **no vote at all**,
  which is exactly how `getOptionTallies`'s LEFT JOIN already treats absence.
  The yes/**maybe**/no distinction is not expressible in a select and stays a
  website-only nuance; the DM says so in one line rather than silently losing
  it.
- **Window poll** → a link button to the site, and nothing else. Picking a
  continuous sub-range at 15-minute granularity, now possibly spanning several
  days after idea 6, has no honest Discord primitive: two dropdowns break past
  25 steps and a modal means parsing free text. A link button that admits this
  is better than a control that mangles it.

After any of these, the bot **edits its own message in place** so the DM shows
what was recorded. There is no second "thanks!" message, and no ephemeral
confirmation to dismiss.

## The endpoint

`POST /discord/interactions`, mounted in `router.ts` **outside** every
`requireAuth` group. This is the app's first route whose caller is not a
browser holding one of our JWTs, and that is the single most important fact
about it.

### Verification

Discord signs each request with Ed25519 over `timestamp + rawBody` and sends
`X-Signature-Ed25519` / `X-Signature-Timestamp`. The endpoint must:

1. Read the **raw body text** before any JSON parsing, and verify against
   that exact byte sequence. Re-serialising parsed JSON changes the bytes and
   the signature will never match again.
2. Reject with **401** on a missing or bad signature, and do it before
   touching D1. Discord actively probes this: it sends deliberately invalid
   signatures when you save the endpoint URL, and refuses to accept an
   endpoint that answers them with anything but a 401.
3. Reject a `X-Signature-Timestamp` more than **five minutes** from now,
   either direction. The signature alone makes a captured request replayable
   forever otherwise.
4. Answer `type: 1` (PING) with `{ type: 1 }`. This is what Discord's
   "Save Changes" on the endpoint URL actually tests.

The verifying key is Discord's **application public key**, which is per
application — so production and sandbox have different ones. It is not a
secret (it verifies, it does not sign), so it belongs in `[vars]`, not
`wrangler secret put`:

```toml
[vars]
DISCORD_PUBLIC_KEY = "..."       # production application
[env.sandbox.vars]
DISCORD_PUBLIC_KEY = "..."       # sandbox application
```

`check:env-parity` fails CI if a key exists in one block and not the other, so
adding it to only one is caught before it is deployed rather than after.

**One platform question to answer first, on the sandbox, before anything else
is built:** whether `crypto.subtle.importKey('raw', key, { name: 'Ed25519' },
false, ['verify'])` works under this Worker's `compatibility_date`
(`2024-09-25`). Workers grew native `Ed25519` after an earlier
`NODE-ED25519`-named implementation, and which one a given compatibility date
gets is the sort of thing to find out from a deployed Worker rather than from
a doc page. If neither is available the fallback is a small userland verify,
which is a materially different amount of work — so this is the first thing to
put on the sandbox, as a ten-line route, before the rest of the release is
planned around it.

**Answered (Aug 2026), by the probe route this asks for.** `GET
/discord/ed25519-probe` (`worker/src/routes/discordProbe.ts`) reports native
`Ed25519` importing a raw public key, verifying a valid signature and
rejecting a tampered one, under workerd 1.20260722.1 at this Worker's
`compatibility_date`. So verification is `crypto.subtle` and nothing more,
and the userland fallback this paragraph priced is not needed. The legacy
`NODE-ED25519` works too, once asked for in its own shape — it was specified
as an elliptic curve, so it wants a `namedCurve` beside the name and rejects
the bare `{ name }` the native algorithm takes — which means nothing in this
release depends on which of the two a given compatibility date gets.

**Confirmed on the deployed sandbox Worker**, 25 Aug 2026, which is what this
section asked for and what local workerd could only stand in for:

```
curl.exe https://jedi-party-scheduler-worker-sandbox.<you>.workers.dev/discord/ed25519-probe
{"usable":"Ed25519","results":[{"algorithm":"Ed25519","imported":true,
"acceptsValidSignature":true,"rejectsTamperedSignature":true,"error":null},
{"algorithm":"NODE-ED25519","imported":true,"acceptsValidSignature":true,
"rejectsTamperedSignature":true,"error":null}]}
```

The edge runtime agrees with the local one exactly, on both algorithms and
on both halves of each. Two notes for whoever runs the probe again: it is
`curl.exe`, not `curl`, in PowerShell — the bare name is an alias for
`Invoke-WebRequest`, which HTML-parses the response and interrupts with a
script-execution warning that has nothing to do with this endpoint. And the
probe reads no env, no secrets and no D1, so it is inert wherever it runs;
it still goes away with the release it exists to size.

### The three-second deadline

Discord requires a response within 3 seconds. Two ways to meet it, and this
spec picks the first wherever it fits:

- **Answer synchronously with `type: 7` (UPDATE_MESSAGE)**, which both
  acknowledges the interaction *and* rewrites the DM in one response. An RSVP
  is one UPDATE plus one or two reads; a vote is an upsert plus
  `checkThresholdAndResolve`. Both are comfortably inside 3s, and this needs
  no follow-up call at all.
- **Defer (`type: 6`) and PATCH the original message** via
  `/webhooks/{app_id}/{token}/messages/@original`, only where the work is
  genuinely unbounded. The one place that could be is a vote that resolves a
  poll, since `checkThresholdAndResolve` can fan out. Measure it on the
  sandbox; defer only if the measurement says to.

Do not use `ctx.waitUntil` to do the work and answer early: the interaction
token is valid for 15 minutes, but a `waitUntil` that fails leaves the user
looking at a DM that never changes and no record that anything went wrong.

### Who the caller is

`users.id` **is** the Discord user id (`migrations/0001`: `id TEXT PRIMARY KEY
-- discord user id`, written from `discordUser.id` at login). So the
interaction payload's user maps to our user with no lookup table and no new
column. Read it from `interaction.member?.user?.id ?? interaction.user?.id` —
DMs populate the second, guild contexts the first.

Two cases the code must handle rather than assume away:

- **No such user.** Anyone who received a DM from us is by construction a user
  (`event_invites.user_id` references `users`), but accounts can be deleted
  while the DM stays in someone's client forever. Answer ephemerally with a
  link to log in, never with a 500.
- **No longer invited, or the event is gone.** Same thing: a DM is a permanent
  artifact and the state behind it moves. Every handler re-checks
  authorisation from the database on each interaction and never trusts the
  `custom_id` to mean the sender is still allowed.

### `custom_id` design

`custom_id` is 100 characters and is the only state Discord hands back.

```
uo:v1:rsvp:accepted:<eventId>
uo:v1:vote:<eventId>
```

Event ids are `crypto.randomUUID()` (36 chars), so the longest of these is
about 53. Three notes:

- **Version it (`v1`).** Messages live in people's DMs indefinitely; a button
  pressed a year from now must be recognisably old rather than
  misinterpreted. An unknown version answers ephemerally with "this invite is
  out of date, open it on the site".
- **No occurrence date in it.** `event_invites.rsvp_status` is per *event*,
  not per occurrence, so a recurring event's RSVP is one answer — which is
  already how the website behaves. Putting a date in the id would imply a
  per-occurrence model the schema does not have.
- **Never put authorisation in it.** It carries *what was pressed*, never *who
  may press it*; the sender is the signed payload's user and the permission
  check is a database read.

## Reusing the logic that already exists

Today `POST /events/:eventId/rsvp` and `POST /events/:eventId/poll/vote` do
their work inline in the route handler, reading identity from
`c.get('userId')` — which the interactions endpoint has no way to populate,
because there is no JWT and no session.

So both move: the body of each becomes a function in `lib/` taking
`(env, userId, ...)` and returning a result the caller renders. The HTTP route
keeps its shape and calls it; the interaction handler calls the same function.

This is the part of the release most likely to go wrong quietly, and the rule
that prevents it: **the permission checks move with the logic, not with the
route.** `requireActiveGuildMember` and `requireInvitedOrOrganizer` belong
inside the extracted function. If they stay in the route handler, the
interactions path silently has none — the same class of bug as item 26, where
the organizer's 403 was invisible because two halves disagreed about who was
allowed.

## Attaching components, and item 32

`sendBotDm` sends `{ content, allowed_mentions }` and reads the response only
for `ok`/`status`/`retry_after`. Three changes:

1. **Accept optional `components` and `embeds`**, passed through to the
   message-create body. `boundContent`'s 2000-character bound stays; embeds
   have their own limits (4096 description, 6000 total) that need the same
   treatment rather than being trusted.
2. **Parse the create response and return the message id.** This is item 32:
   idea 19 assumed the id was "already in hand" for the edit-on-resolve
   feature, and it is discarded at the moment it arrives.
3. **Persist it.** A migration adds `message_id` and reuses the existing
   `dm_channel_id`, so the resolve path can `PATCH
   /channels/{channel}/messages/{message}` later:

```sql
ALTER TABLE notification_log ADD COLUMN message_id TEXT;
```

`notification_log` is the right home: it already carries the durable `content`
for exactly this reason (migration 0014 — the retry consumer cannot re-derive
what the source sweep rendered), and a message id is the same kind of fact
about a delivery that must survive its source's state moving on.

**A message is only editable by the application that sent it.** Production and
sandbox are different Discord applications, so a `message_id` written by one
is not editable by the other, and rows predating this migration have none at
all. Every edit path therefore treats "no message id, or the edit 404s/403s"
as an ordinary outcome and does nothing, rather than as an error to retry —
the DM stays as it was, which is exactly what happens today.

## What the poll resolution edit costs

The edit happens in the cron, on the path that already notifies everyone that
a poll resolved. That makes it **one additional outbound subrequest per
recipient**, charged to the same per-tick allowance `cron/budget.ts` sizes
from `WORKERS_PLAN` — 50 subrequests on the Free plan, which is what both
production and the sandbox declare.

That is not a rounding error: it can halve how many resolution notifications a
tick gets through. Two consequences for the build:

- The edit is **charged to the budget explicitly**, like every other outbound
  call, not slipped in beside one. An unbudgeted subrequest is precisely what
  the Pass 9 review found and what the budget exists to prevent.
- The edit is **lower priority than the DM**. If the tick can afford one of
  the two, it sends the new notification and leaves the old message alone: a
  stale vote control next to a fresh "it's confirmed for Thursday" DM is
  survivable, a missing DM is not.

## Testing

The worker suite runs real handlers against an in-memory SQLite built from the
migrations, so the interaction handler is testable end to end without Discord:

- **Signature verification**: a valid signature accepted; a bad one 401'd; a
  timestamp five minutes stale rejected; a PING answered with `{type: 1}`.
  Sign fixtures in the test with a generated key pair and inject the public
  key through `Env`.
- **Authorisation**: a button pressed by a user who is not invited, whose
  invite was revoked after the DM was sent, whose account was deleted, and
  whose event was cancelled — all four answer, none of them 500.
- **Equivalence with the website**: for each of `accepted`/`tentative`/
  `declined`, pressing the button and calling `POST /events/:id/rsvp` leave the
  database in the same state. Same for a select choice versus a `yes` vote.
  This is the test that keeps the extraction honest.
- **Unknown `custom_id` version** answers rather than throwing.
- **Budget**: a resolution sweep with edits enabled does not exceed the Free
  plan's subrequest allowance for a 300-invitee event.

## Rollout

The sandbox is a separate Discord application with its own bot, its own
public key and its own interactions URL, which is what makes this release
safe to develop in the open: a wrong endpoint in the sandbox DMs nobody real.

1. ~~Put the ten-line Ed25519 probe route on the sandbox and settle the
   platform question above.~~ Done — deployed, and confirmed against the
   sandbox Worker itself: native `Ed25519`, so verification is
   `crypto.subtle` and the release is planned around that.
2. Set the sandbox application's **Interactions Endpoint URL** to the sandbox
   Worker's `/discord/interactions` in the Discord developer portal, and save
   — Discord's PING probe must pass before it will accept the URL. This is a
   one-time manual step per application, and it belongs in `SETUP.md`'s
   sandbox section next to the other one-time steps.
3. `npm run seed:sandbox` for an event to press buttons on, then press them.
4. Production gets the same manual step at release time, and it is the one
   part of this release that no CI workflow performs.

## Open questions

1. **Does the fixed-time DM keep its link to the site?** A link button beside
   the three RSVP buttons costs nothing and covers everything the buttons
   can't do (change requests, seeing who else is coming). Leaning yes.
2. **What happens to the buttons after the event starts?** Options: leave them
   (an RSVP to a past event is harmless and the website allows it), or edit
   them away on the reminder sweep that already touches the event. Leaning
   leave them, because the alternative spends budget to prevent something
   benign.
3. **Do reminder DMs get components too, or only the invite?** A reminder is
   where someone realises they can't make it after all, which is the strongest
   argument for buttons anywhere in this release — but it multiplies the
   message ids to track. Undecided, and cheap to add later.

## What is built, and what is left

Written down at the point the endpoint landed, so the gap between this design
and the code is legible rather than remembered.

**Built:**

- `POST /discord/interactions`, mounted outside every `requireAuth` group,
  with Ed25519 verification over `timestamp + rawBody`, a 401 before any D1
  statement, the five-minute replay window, and PING → `{type: 1}`. An unset
  `DISCORD_PUBLIC_KEY` rejects with 401 and logs why, rather than erroring:
  failing closed is the only safe direction for the one route with no session
  behind it.
- Both handlers, answering synchronously with `type: 7` (UPDATE_MESSAGE) as
  this spec preferred. Nothing measured needed a defer.
- The extraction: `recordRsvp` in `lib/attendance.ts`, `recordPollVote` and
  `recordPollSelection` in `lib/polls.ts`, with `requireInvitedOrOrganizer`
  moved out of `routes/polls.ts` so the check travels with the logic rather
  than with the HTTP surface. The routes are now shape-only, and the whole
  366-test suite passed unchanged across the move, which is the evidence that
  the website's behaviour did not shift underneath it.
- Item 32's half: `sendBotDm` returns the message id, `deliverThroughOutbox`
  records it in the statement it was already issuing, migration 0022 adds the
  column.
- `custom_id` exactly as designed above, with `parseCustomId` distinguishing
  "not ours" from "ours but stale".

- **The components themselves**, in `lib/dmComponents.ts` and attached in
  `cron/reminders.ts`: three RSVP buttons on an invite to a fixed-time event,
  a candidate select on an invite to an options poll, a link button on a
  window poll, RSVP buttons on both reminder types and on a poll that has
  resolved into a time, and the candidate select on the deadline nudge. A
  cancelled poll carries nothing, because there is nothing left to answer.
- **Migration 0023**, which was not in this design and should have been. See
  below.
- **Item 45's answer** (`IDEAS.md`): a press from someone behind on the Terms
  is refused ephemerally with a link, not recorded.

**Not built yet:**

- **Embeds.** The DMs that gained components did not gain embeds with them,
  which this spec lists as in-scope for the release. Deliberately deferred:
  an embed is a presentation change to text that cannot be previewed from a
  cloud session, and the components are what make the DMs *answerable*.
  Worth doing with a real Discord client open.
- **The edit when a poll resolves**, and the budget decision this spec
  records for it.
- The manual portal steps (`docs/SETUP.md` 1.8 and 1.9) -- **done for the
  sandbox application**, 25 Aug 2026: key pasted, endpoint URL accepted by
  Discord, which means the deployed Worker passed Discord's own PING and
  bad-signature probes. Production's key is committed and takes effect when
  this reaches `main`; its endpoint URL is still unset.

## What the build added to this design

**Migration 0023, `notification_log.components`.** This spec priced item 32's
message-id column and missed its sibling. Migration 0014's argument -- a retry
cannot re-derive what the source sweep rendered, because by the time a retry
is due the source may no longer produce it -- applies to a message's controls
at least as strongly as to its text: an options poll's select lists that
poll's candidates *as they were when the DM was written*. Without the column,
a retried invite would have arrived with its text and no buttons, silently
worse than the delivery it replaced, and only for the people whose first
attempt happened to fail.

**One query per poll per tick, and what happens when the tick cannot afford
it.** A select needs the candidate list, which the invite sweep's query does
not carry. It is fetched once per poll, cached for that poll's other invitees,
and charged to the budget like everything else. When the budget cannot afford
the lookup, the DM goes out *without* its select rather than not going out:
a notification with no buttons is what this app sent before this release, and
a notification withheld to save a statement is a person not told their poll is
closing.

**Two of the three open questions below are now answered.** Reminder DMs do
get components (question 3) -- a reminder is where someone realises they can't
make it after all, which was the strongest argument in the question itself.
Question 1's link button was not added beside the RSVP buttons: every one of
these DMs already carries the event link in its text, and a fourth control
for the same destination is noise. Question 2 (what happens to the buttons
after the event starts) stands: they are left alone.

**One design point this spec did not settle, decided during the build.** A
select hands back a whole set at once, so `recordPollSelection` *deletes* the
presser's votes on candidates they did not pick, rather than only inserting
the ones they did. Without the delete, deselecting a night you had previously
said yes to would leave the old yes standing, and the DM would show one answer
while the tally counted another. The yes/maybe/no nuance stays website-only as
designed; this much has to agree with what was just pressed.

**And one gap it opened**, captured as `IDEAS.md` item 45: the endpoint is
outside `requirePolicyAcceptance` by construction, so a button press records
an answer from someone the website would gate. A DM has nowhere to show a
consent document, so the options are to record it or to refuse it ephemerally
-- worth deciding with the components work rather than by default.

## Rejected alternatives

- **Posting event announcements to a server channel.** Already ruled out in
  idea 19 for a reason this spec does not reopen: a channel post is visible to
  everyone who can read the channel, including people who have never used
  Uncle Owen, which breaks the model where an event is visible to its
  organizer and invitees only.
- **A modal for the window poll.** Free text parsed into a time range, in a
  scheduling app, is a bug generator. The link button is honest about where
  that interaction belongs.
- **Reusing the JWT.** An interaction has no browser, no cookie and no
  `Authorization` header, and inventing a token to smuggle through
  `custom_id` would put a bearer credential in a string Discord echoes back
  from a message anyone can screenshot.
- **`ctx.waitUntil` for the write, answering instantly.** Fast, and it loses
  the failure. See the deadline section.
