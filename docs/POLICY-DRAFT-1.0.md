# Privacy Policy and Terms — 1.0 draft for review

**Status: DRAFT. Not live.** The pages in the app (`frontend/src/pages/PrivacyPage.tsx`,
`TermsPage.tsx`) and the policy version (`worker/src/lib/policy.ts`,
`CURRENT_POLICY_VERSION = 5`) are unchanged. They change once, after review,
together with the version bump to 6 — which is what makes everyone agree again
(spec 0012).

**Prepared:** 9 November 2026, against branch `claude/practical-ptolemy-xqv8nj`.
**Draft 2, same day,** after both reviews (Astra; a Fable model's report,
`REVIEW-1.0-POLICY-AND-PASS-24.md`). Every finding was re-checked against the
code at the current head before anything here changed.

### What changed in draft 2

| Finding | What it said | Done |
|---|---|---|
| D-01 | Sessions' "last used" was never updated after creation | **Code** (Michael: make it true) — updated at most every 5 min; text says "roughly … to within a few minutes" |
| D-02 | Pre-noticeboard events are not off it "permanently" | Text |
| D-03 | Browsers load profile pictures from Discord's CDN | Text (Discord bullet; fonts sentence) |
| D-04 | Open time-change requests are shown to all invitees, with the message | Text |
| D-05 | Bot-add requests need an existing account | Terms text |
| D-06, D-23 | Google's deletion caveat and import details were lost | Google section written out in full (F3 still decides keep/remove) |
| D-07 / A5 / Astra | The export was not "everything" | **Code** (Michael: extend) — and a schema-coverage test |
| D-09 | Deletion dialog didn't say what it does to invitees | **Code** — one shared dialog, Settings and policy gate |
| D-10 | Resend bullet had no content | Text (conditional on F4) |
| D-11 / Astra | Logs may be kept; a refused stranger's ID was logged | **Code** (ID dropped); disclosure conditional on F8 |
| D-12, D-13, D-14, D-16–D-20, D-22 | Incomplete or slightly-off statements | Text |
| D-21 / Astra | Legal bases dropped | Restored, short (Michael: keep) |
| Astra | Absolute "doesn't collect" vs hosts; deletion vs recovery copies; "is told" vs delivery; email identity; Terms' noticeboard | Text |
| D-15 | Cloudflare sees your IP | Already fixed with item 92's rework |

Not changed, with reasons: Fable's suggestion to trim the email **stub** log —
both deployed environments run `stub`, so production cannot be told apart, and
its contents are already stored and on the admin page; it is disclosed instead.

## For the reviewers (Astra, and a Fable model)

You are asked two things about the draft below, separately:

1. **Is every statement true** of what the code does? Check it against the
   **claims ledger** (Part D), which names where each claim is made true. A
   ledger entry is the author's claim, not evidence; please reproduce or read
   the code yourself for anything you doubt.
2. **Does it leave anything out?** The **data inventory** (Part E) lists every
   table and column the database holds, every browser storage key, every
   outside service, and every automatic action. Anything there that a person
   would want to know and the draft doesn't tell them is a gap.

Please write suggested changes as: *the sentence or section* → *what's wrong
(untrue / missing / misleading / unclear)* → *your proposed wording* → *the
evidence (file:line or a reproduction)*. Michael decides; the author applies
the agreed changes to the app.

Two cautions. This is a hobby service run by one person, not a company, and
the draft is written in plain language on purpose — a suggestion that adds
legal boilerplate should say what it protects. And neither the author nor the
reviewers are lawyers: where a statement depends on law rather than on the
code (legal bases, which laws apply, transfer mechanisms), the draft says so
and Part F lists it as Michael's call.

---

## Part A — what the audit of version 5 found

Version 5 (10 September 2026) is already unusually specific. Checked against
the code as it stands for 1.0, these statements are **untrue or out of date**:

| # | Version 5 says | What is actually true | Draft |
|---|---|---|---|
| A1 | Resend "sends the one email this service generates" to the operator | Production runs with `EMAIL_MODE = "stub"` (`worker/wrangler.toml`): no email is sent and Resend receives nothing. (The `worker/src/lib/email.ts` comment that said production is `live` is corrected in draft 2.) | Resend described as used **only if** owner email is switched on — see F4 |
| A2 | The Google Calendar connection is described as available | Production runs with `GOOGLE_SYNC_MODE = "off"`; every Google route answers 503 and the sync never runs (`isGoogleConfigured`, `worker/src/lib/googleCalendar.ts:102`) | Kept, but marked **not currently offered** — see F3 |
| A3 | "There is no administrative screen in the app for reading other people's data" | The operator has an admin page listing every account: username, display name, notifications on/off, last login, last refused login, and server memberships (`worker/src/routes/admin.ts:28`, `:62`). It shows no event content | States exactly what the operator's screens show |
| A4 | "No soft-delete or grace period" on account deletion | True of the app. But Cloudflare D1 keeps point-in-time recovery ("Time Travel") for a fixed window, so the operator could technically restore a deleted account's data during it | States the window — see F6 to confirm its length |
| A5 | "Download my data" returns "everything the service holds about you" | **Resolved in draft 2 (Michael: extend the export).** It now includes `dm_channel_id`, the remaining session, Google-connection and Google-link columns, `google_pending_connections` and `google_orphaned_inserts` (without credentials), and `group_activity_nudges`; `worker/test/exportCompleteness.test.ts` compares every explicit projection against the live schema | "everything … apart from the encrypted Google credential" |

And these things the code does are **not mentioned at all**:

| # | Missing | Where it lives |
|---|---|---|
| A6 | **Your IP address is used for rate-limiting** the three login/connect callbacks (item 92). A keyed one-way code made from it (HMAC-SHA256 under a server secret, truncated; never the address) is written to the database table `oauth_callback_counts` with a per-minute count, linked to no account, and deleted within about fifteen minutes. *(Changed 9 Nov: the first version used Cloudflare's rate-limit binding and wrote nothing; that binding was shown never to refuse and was replaced.)* **For the reviewers:** the code is pseudonymous, not anonymous -- whoever holds the key could recover an IPv4 address by trying all four billion -- so the draft treats it as personal data and states its retention. Like all data, it also sits in D1's recovery copies for the Time Travel window (F6). | `worker/src/lib/rateLimit.ts`; `worker/migrations/0048_oauth_callback_counts.sql` |
| A7 | **The full text of every DM sent to you is kept**, not just a record that it was sent (`content` in five log tables), for as long as the event it was about exists | `notification_log`, `change_request_log`, `organizer_rsvp_notice_log`, `group_nudge_log`, `account_purge_warnings` |
| A8 | **Change requests**: proposed times, free-text messages, the organizer's decision note, and votes on them. Who sees them is asymmetric (requesters see their own; the organizer sees all with tallies, never who voted how) | `event_change_requests`, `event_change_request_votes`; spec 0003 |
| A9 | **Your answers are visible to the other invitees**: RSVPs, poll votes (with your name), submitted availability ranges. Version 5 says event details are visible to invitees, but not that your *answers* are | `worker/src/routes/events.ts` (poll voters, invite list) |
| A10 | **Group membership is visible** to the group's other members, with the group's name, game and owner | `worker/src/routes/groups.ts:62` |
| A11 | **Past events are kept indefinitely** — only cancelled events and finished polls are deleted, after 90 days. A normal past event stays until its organizer's account is deleted | `TERMINAL_HISTORY_RETENTION_MS`, `worker/src/cron/reminders.ts:192` |
| A12 | **Concrete retention periods** generally: sessions 7 days, cancelled/finished history 90 days, inactivity deletion at 365 days with warnings at 351 and 358 | `sessions.ts:10`, `reminders.ts:193`, `:3096` |
| A13 | **Automatic actions taken on people's behalf**: an event below its minimum can cancel itself (organizer's choice); a confirmed poll day that drops below its threshold is called off (item 97); your "I'm in" on a confirmed poll day counts as your answer for that day's event | `attendance.ts` `recordRsvp`; `reminders.ts` `createFannedOutEvent` |
| A14 | **What deleting your account does to other people**: events you organised disappear for everyone invited, with everyone's answers, and no cancellation message is sent | `worker/src/lib/db.ts` `deleteUserCompletely` |
| A15 | **Browser storage**: what the site keeps in your browser and the three short-lived sign-in cookies | Part E |
| A16 | **The noticeboard shows the game** as well as title, time and invitees | `worker/src/lib/noticeboard.ts:418` |
| A17 | **Policy changes**: version 5 says "continuing to use means you accept". The app actually asks everyone to agree again and shows nothing else until they do (export and delete stay available) | spec 0012; `worker/src/routes/me.ts:15` |
| A18 | **Who the controller is**: "the operator of Uncle Owen" doesn't identify anyone | `frontend/src/lib/legal.ts` — see F1 |

---

## Part B — Privacy Policy (draft)

> **Uncle Owen — Privacy Policy**
> Version 6 · Last updated: *[date it goes live]*

**The short version.** Uncle Owen is a free scheduling tool for private Discord
friend groups, run by one person as a hobby. It stores what it needs to
schedule sessions and remind people about them, and nothing for advertising,
analytics or sale. You can download everything it holds about you, or delete
your account, from Settings at any time. The rest of this page is the detail,
and it is meant to be complete: if something isn't listed here, the service
doesn't collect it. (The companies that host it also handle ordinary technical
information about each request, such as your IP address, in order to deliver
it — see "Who it is shared with".)

### Who is responsible

*[OPERATOR NAME]* runs Uncle Owen and is responsible for the information
described here (the "data controller", in data-protection terms). Contact:
**JediParty@proton.me**.

### What is collected, and why

**When you log in with Discord.** Uncle Owen asks Discord only for the
`identify` and `guilds` permissions. From those it keeps:
- your Discord user ID, username, display name and avatar reference;
- which of your Discord servers are on this app's allow-list, when that was
  last checked, and — if you leave one — that you used to be in it. The rest
  of your server list is used once, to make that check, and never stored.

It never asks for your email address, and it never sees your Discord messages
or your password. The bot can list a server's voice channels, to offer one for
an event, and checks from time to time that you are still a member of the
servers you use here; it cannot read messages.

**What you create.** Your timezone and settings; events (title, description,
game, time, voice channel, and options such as a minimum number of
attendees); polls and their candidate times; groups; invitations; your
answers — RSVPs, poll votes, and the availability ranges you submit; requests
to change an event (a proposed time or person to add, an optional message,
and votes on them); and personal time blocks.

**Records the service keeps to work properly.**
- **Messages it has sent you.** The text of each Discord direct message, when
  it was sent, and whether it was delivered — so that nothing is sent to you
  twice, and so that a message can be updated later (for example to show the
  answer you pressed). Also the ID of the direct-message channel between you
  and the bot, recorded the first time it messages you.
- **Login sessions.** When each was created, roughly when it was last used (to
  within a few minutes), when it expires, which version of this policy it was
  issued under, and whether it was revoked or replaced. Replaced sessions are kept until they
  would have expired anyway, which is how the service notices a copied
  session being reused.
- **Which version of this policy you agreed to, and when.**
- **When you last logged in**, and when a login was last refused (for example
  because you no longer share a server with the app).

**Your IP address, briefly.** The three places where signing in or connecting
an account costs the service a request to Discord or Google are
rate-limited, so a script can't hammer them. To count attempts, Uncle Owen
turns your IP address into a scrambled code that can't be turned back into the
address without a secret key only the service holds, and keeps that code with a
count for the current minute. It is not linked to your account, and it is
deleted within about fifteen minutes. Your IP address itself is never written to
Uncle Owen's database, and is never used for anything else.

**If you ask to add the bot to a server.** That server's ID and name, your
Discord user ID, and when the request was made and decided. The request
repeats the Discord permission check above for that server, to confirm you
administer it.

**Google Calendar — not currently offered.** The code for connecting a Google
calendar exists but is switched off; nothing is sent to or read from Google.
*[F3: keep the section below, or remove it until the feature is switched on.
If it is kept, it must keep everything in it — the reviewers found the first
draft's placeholder would have lost version 5's deletion caveat.]*

> **If Google Calendar is switched on, and you connect it** (optional, off
> unless you choose it, and disconnectable at any time): connecting asks Google
> for permission to manage events and to read your calendar list. Uncle Owen
> stores an encrypted long-lived Google credential (never shown to anyone, and
> never included in "Download my data"), the email address of the Google
> account, which calendar you chose, and a record of which sessions it has
> written there. It writes only sessions you are committed to — title, times,
> the server's name and a link back; **never descriptions**, poll proposals,
> declined events or your personal time.
>
> You can also choose **one** calendar to be read, so people can see when you
> are busy. Every event on it is then copied into your own Uncle Owen calendar
> as personal time **with its title, time and description**, visible only to
> you; others still see only plain busy blocks. Google's permission covers all
> your calendars, not just that one — that only one is read is enforced by
> Uncle Owen's own code.
>
> **Disconnecting** removes the upcoming entries Uncle Owen wrote and revokes
> its access. **Deleting your account revokes access too, but does not remove
> entries already written to your Google calendar** — disconnect first if you
> want them gone.

### What is deliberately not collected

Your email address, your Discord messages, your Discord password or login
tokens (used once during sign-in, in memory, then discarded), payment details,
location, device fingerprints, advertising identifiers, or analytics of any
kind. There are no third-party trackers, ad networks or tracking cookies.

### What the site keeps in your browser

- **Your sign-in**, in your browser's local storage, so you stay logged in, plus
  a marker of which account is signed in so that several tabs agree.
- **A short-lived login check** while you sign in, and a list of sign-outs
  waiting to be sent if you logged out while offline.
- **Small preferences**: the server you last selected, your calendar view, and
  the background scenery.
- **Three cookies, each lasting ten minutes**, set only while you sign in, ask to
  add the bot, or connect Google. They hold a one-time check value, are
  readable only by Uncle Owen's server, and are not used for tracking.

Nothing here is shared with anyone. Logging out removes your sign-in.

### Who can see what

Access is checked by the server on every request, not just hidden in the
page.

- **An event's full details**, including its description, are visible to its
  organizer and the people invited.
- **Your answers are visible to the other people invited** to the same event:
  your RSVP, your poll votes with your name, and the availability ranges you
  submit.
- **The server noticeboard.** Other members of a server can see a limited view
  of its events even if they weren't invited: the title, game, when it is, and
  who is invited with their answers. Never the description. An organizer can
  keep any event off the noticeboard; events created before the noticeboard
  existed were made private when it arrived, and stay off it unless their
  organizer later chooses to show them.
- **Change requests.** If you ask to change an event, the organizer sees your
  request and its message. A request to move the time is also shown to the
  other invitees while it is open — with your name and your message — so they
  can vote on it; everyone sees the running total, and nobody sees who voted
  which way. Once it is decided, only you and the organizer can see it. A
  request to add someone is seen only by you and the organizer.
- **Groups.** A group's members can see its name, game, owner and member list.
- **Personal time blocks** are visible only to you.
- **Free/busy.** Other members of a server you share can see when you are busy,
  as plain blocks of time with no title or detail. A block comes from an event
  you organize, an event you're invited to and haven't declined, a confirmed
  poll day you said yes to, or personal time marked "Busy" ("Considering" and
  "Free" never show). For a repeating event, a date you've declined can still
  show as busy. You can switch all of this off in Settings, and then they see
  nothing.
- **Your Discord profile** (username, display name, avatar) is shown to other
  signed-in members of servers you share, so people can find who to invite, and
  to the other members of any group you are in, even after you stop sharing a
  server with them.
- **The operator** has an admin page listing every account with its Discord ID,
  username, display name, whether notifications are on, when it last logged in
  and when a login was last refused, and which servers it belongs to or has
  left; and the requests to add the bot. There is no admin
  page showing anyone's events, answers or personal time. The operator can
  technically query the database directly, as with any service someone hosts:
  content is not end-to-end encrypted. The operator will only do so to fix a
  fault or where the law requires it.

### Things the service does automatically

So that nothing happens to your plans without you knowing it can:
- **An organizer can set a minimum number of attendees**, and either a deadline
  by which it must be met or none. If they switch on automatic cancellation,
  the event cancels itself — at the deadline, or as soon as someone's "can't
  make it" takes it below the minimum — and everyone still coming is sent a
  message. Otherwise the organizer is messaged and decides.
- **On a poll where each day is confirmed separately,** a confirmed day becomes
  its own event, and your answer for that day — "I'm in", "can't make it" or
  "maybe" — carries over as your answer for it. If that day later falls below
  the number of people the poll needed, it is called off and everyone still
  coming is sent a message.
- **An account that hasn't logged in for 365 days is deleted**, exactly as if
  you'd pressed "Delete my account". You'll be sent a Discord message two weeks
  and one week before (if Discord accepts messages from the bot). It is paused
  while you're organizing, or invited to and haven't declined, anything still
  to come — which includes any repeating event that hasn't been cancelled, even
  one whose dates have all passed.

Messages are sent through Discord, and the service retries a failed delivery,
but it cannot guarantee you receive one: Discord may refuse it if you block the
bot or don't accept messages from server members, and you may have turned
notifications off.

None of this involves profiling or decisions about you beyond these rules.

### Who it is shared with

Never sold, rented or shared for advertising. It is processed only by the
services needed to run Uncle Owen:
- **Cloudflare** runs the application and its database. Like any host, it
  receives your IP address with each request. *[F8: if the dashboard shows
  Workers Logs on —]* Cloudflare also keeps the application's operational log
  lines for *[N]* days. They can include Discord IDs and usernames, and — when
  someone asks to add the bot — the server's name; they do not include event
  titles, descriptions or messages.
- **GitHub** serves the website's files. Like any web host, it receives your
  IP address when your browser loads the site.
- **Discord** handles login and delivers the messages you get from the bot,
  including their text. Your browser also loads members' profile pictures
  directly from Discord's image servers, which — like any site serving an
  image — see your IP address when it does.
- *[F4 — only while owner email is switched on:]* **Resend** delivers one email
  to the operator when someone asks to add the bot to a server. It contains
  that person's Discord display name, username and ID, and the server's name and
  ID. Nothing else ever triggers an email.
- *[F3 — only once Google Calendar is switched on:]* **Google**, for people who
  connect a calendar, as described above.

The site's fonts are served from Uncle Owen's own site, so visiting it does not
contact Google or any font service. Profile pictures are the one exception to
"everything comes from Uncle Owen's own site", as described under Discord.

Information may also be disclosed if the law requires it, or where you ask for
it to be shared.

### How long it is kept

| What | Kept until |
|---|---|
| Your account, settings, groups and personal time | You delete your account, or 365 days without logging in |
| Events you organize, and everyone's answers on them | You delete your account (past events are not removed on their own) |
| Cancelled events and finished polls | 90 days after they were last changed (normally the cancellation, or the poll closing) |
| Messages the bot sent you (text and delivery record) | The event or group they were about is removed, or your account is deleted. The two warnings before inactivity deletion stay until your account is deleted |
| Login sessions | 7 days after they start, or sooner if you log out |
| The scrambled code made from your IP address, for the login limit | At most about fifteen minutes; the address itself is never stored |
| Sign-in cookies | 10 minutes |
| Database recovery copies (Cloudflare D1 "Time Travel") | *[7]* days, after which deleted data cannot be restored — see F6 |
| *[F8, if on:]* Cloudflare's operational logs | *[N]* days |

### Your rights, and how to use them

Everything below is available to everyone, in Settings, whatever the law where
you live:
- **See and take your data**: "Download my data" gives you a file with
  everything Uncle Owen holds about you, apart from the encrypted Google
  sign-in credential (if you ever connected Google), which is never given out
  to anyone.
- **Delete your account**: "Delete my account" removes your profile, personal
  time, answers, invitations, group memberships, the messages logged as sent to
  you, your login sessions, and the events and groups you created, from Uncle
  Owen's database, immediately. **Events you organised disappear for everyone
  invited, with their answers, and no cancellation message is sent** — tell
  people first if that matters. Cloudflare's recovery copies of the database
  still hold it for the period in the table above, after which it cannot be
  restored. Discord messages already delivered stay in your Discord history,
  under Discord's own rules. If you had connected Google Calendar, entries
  already written there are not removed (see that section).
- **Correct it**: edit your events, groups and settings at any time.
- **Object or limit it**: turn off Discord notifications, or hide your
  free/busy time, in Settings. The warnings before an inactive account is
  deleted are still sent, because they exist to stop that deletion.

If you can't sign in any more, email **JediParty@proton.me** and the same
requests will be handled by hand, normally within a month. An email address
doesn't prove who owns a Discord account, so you may be asked to confirm it is
yours before anything is released or deleted. You may also have the right to complain to your data-protection
authority. Using any of these rights never changes how the service treats you.

### Why it is stored (legal bases)

Where UK or EU data-protection law applies, the legal bases are:
- **Performance of a contract** — storing your account, events, polls, groups,
  invitations, answers, change requests and personal time, and sending the
  messages you've chosen to get, is the service you asked for by signing in.
- **Legitimate interests** — keeping a record of messages sent so you aren't
  messaged twice; keeping replaced login sessions until they expire so a copied
  session can be detected; the login rate limit and its short-lived counts;
  checking that you still belong to the servers you use here; the warnings
  before an inactive account is deleted; and basic security and fault-finding.
- **Legal obligation** — where the law requires information to be disclosed.

Discord notifications can be turned off at any time in Settings. *[Neither the
author nor the reviewers are lawyers — see F9.]*

### Security

Traffic is encrypted (HTTPS); the database is encrypted at rest by Cloudflare;
secrets are kept outside the code; sign-in sessions are short-lived, revocable,
and replaced when they renew; Discord login tokens are never stored. This
is a hobby project run by one person, not a company with a security team — no
system is perfectly secure, so please weigh that before putting anything
sensitive in it.

### Age

Uncle Owen needs a Discord account and is not aimed at children. You must meet
Discord's minimum age in your country (13 in most places, older in some).

### Where it is processed

Cloudflare, GitHub and Discord operate in the United States and elsewhere, so
your information may be processed outside your country. *[Transfer safeguards
— F7.]*

### Changes to this policy

When this policy changes in a way that matters, its version number goes up and
the app asks everyone to read and agree to it before carrying on. Until you
agree, the app shows only that request — though "Download my data" and "Delete
my account" stay available, so you can leave instead. Small corrections that
change nothing about your information update the date without asking again.

---

## Part C — Terms of Service (draft)

> **Uncle Owen — Terms of Service**
> Version 6 · Last updated: *[date it goes live]*

**What this is.** Uncle Owen is a free, non-commercial scheduling tool for
private Discord friend groups, run by *[OPERATOR NAME]*. By signing in you agree
to these terms and to the Privacy Policy. If you don't agree, don't use it.

**What it does.** Members of allow-listed Discord servers can create events and
polls, invite people individually or by group, answer and vote, ask an
organizer to change an event, block out personal time, see when others are
busy, and get Discord messages about all of this — including buttons to
answer from Discord. Anyone who already has an account here and administers
another Discord server can ask for the bot to be added to it; the operator
approves or declines each request.

**Who can use it.** You need a Discord account in good standing, must meet
Discord's minimum age for your country, and must belong to an allow-listed
server. There is no public sign-up.

**Using it fairly.**
- Follow the law, and Discord's Terms of Service and Community Guidelines.
- Don't use event titles, descriptions, messages, group names or anything else
  others will see to harass, threaten, impersonate or abuse anyone.
- Don't try to get at other people's information, get around access controls
  or rate limits, overload the service, or automate it in ways a person
  wouldn't use it.
- Don't use the notification system to send unwanted messages.
- You're responsible for what you put in, including what the people you invite
  will see.

**When you organize something.** Your choices affect other people. Cancelling,
moving or editing an event changes it for everyone invited. If you set a
minimum number of attendees with automatic cancellation, the service cancels
the event for you when it falls below. Cancelling a poll doesn't cancel days
that have already become their own events. Deleting your account removes the
events you organized for everyone, without telling them.

**Messages from the bot.** Uncle Owen sends Discord messages about invitations,
upcoming sessions, polls, change requests, cancellations and inactive groups.
You can turn them off in Settings, or block the bot in Discord. The warnings
before an inactive account is deleted are sent regardless, because they exist
to stop that deletion.

**Your content.** You own what you create. You let the operator store and show
it only as needed to run the service — for example, showing an event's title to
the people you invited and putting it in their messages, and showing its title,
game, time and invitees on the server noticeboard to other members of that
server, unless you keep the event off it.

**No guarantees.** This is a hobby project, free, with no promise of uptime,
support, or that data will never be lost. It is provided "as is", without
warranties of any kind, including merchantability, fitness for a particular
purpose and non-infringement. Don't rely on it as the only record of anything
important.

**Limits on liability.** As far as the law allows, the operator isn't liable for
indirect, incidental, special, consequential or exemplary damages, or for lost
data, profits or plans, from using or being unable to use the service. Nothing
here limits liability that can't legally be limited.

**Discord.** Uncle Owen is independent and isn't made, endorsed or sponsored by
Discord Inc. "Discord" is a trademark of Discord Inc. Your use of Discord is
governed by Discord's own terms.

**Ending.** You can stop at any time and delete your account in Settings. An
account unused for 365 days is deleted automatically after two warnings, as
the Privacy Policy describes. The operator may suspend or remove anyone who
breaks these terms or puts the service or its users at risk, remove a server
from the allow-list, or shut the service down — with reasonable notice before a
planned shutdown where practical.

**Changes.** When these terms change in a way that matters, their version goes
up and the app asks you to agree again before carrying on; until you do, you
can still download your data or delete your account.

*[Governing law — F2.]*

**Contact.** JediParty@proton.me

---

## Part D — claims ledger

Every factual statement in Parts B and C, and where it is made true.

| Claim | Where | How to check |
|---|---|---|
| Discord scopes are only `identify guilds` | `worker/src/routes/auth.ts:140`, `guildRequests.ts:81` | read; or inspect the authorize URL at login |
| Non-allow-listed servers are not stored | `auth.ts` callback → `activeAllowListedGuildIds`; only matches reach `user_guild_membership` | log in with an account in an extra server; query the table |
| Email never requested | same scopes; no email column on `users` | schema (Part E) |
| Discord tokens used once, not stored | `auth.ts` callback: `exchangeCodeForToken` result never written | read; no token column on `users` |
| DM text is kept | `content` column on five log tables (Part E) | query `notification_log.content` after a DM |
| DM channel id kept | `users.dm_channel_id`, written by the outbox when Discord first opens a DM channel (`worker/src/lib/outbox.ts:307`), not at login | schema; read |
| Sessions: created, last used (to within five minutes), expires, policy version, revoked/replaced; 7-day expiry; replaced kept until expiry | `sessions.ts:10`; `isSessionActive` writes `last_used_at` once it is `SESSION_TOUCH_INTERVAL_MS` (5 min) old — **draft 2, D-01: before this it was never updated after the insert** | `worker/test/sessionLastUsed.test.ts` |
| Policy version and time agreed are kept | `users.accepted_policy_version`, `accepted_policy_at` | schema |
| Last login and last refused login kept | `users.last_login_at`, `last_login_attempt_at` (`auth.ts` callback) | schema; read |
| IP never stored; a keyed code of it kept with a per-minute count, not linked to an account, deleted within ~15 min | `worker/src/lib/rateLimit.ts:63` (`callbackBucket`: HMAC under `JWT_SIGNING_KEY`), `:91` (deletes earlier minutes on each callback), `:136` + `cron/reminders.ts:3635` (deleted every 15-minute tick); migration 0048 has no IP or user column | `rateLimit.test.ts` "never stores the address", "removes earlier minutes", "the cron tick removes a finished minute"; grep for `CF-Connecting-IP` |
| The three limited routes | `auth.ts:176`, `google.ts:208`, `guildRequests.ts:103` | read; timetable R92 |
| Bot-add request stores server id/name, requester, times | `guild_add_requests` | schema |
| Google is switched off in production | `wrangler.toml` `GOOGLE_SYNC_MODE = "off"`; `googleCalendar.ts:102` | read |
| No trackers/analytics/ad networks | no third-party scripts in `frontend/`; fonts self-hosted (`frontend/src/fonts.css`, `noRemoteAssets.test.ts`) | read; network tab on the site |
| Browser storage keys | `jps_token`, `jps_identity`, `jps_login_verifier`, `jps_pending_revocation:<token>` (one key per pending sign-out, holding the retired token so it can be revoked later; `frontend/src/auth/pendingRevocation.ts:32`) plus the legacy `jps_pending_revocations` array migrated away on read (`:39`), `jps_selected_guild`, `uo.view`, `uo.scenery` | grep `frontend/src` |
| Three short-lived cookies | `oauth_state` (`auth.ts:14`), `guild_verify_state` (`guildRequests.ts:34`), `google_connect_nonce` (`google.ts:46`) — all HttpOnly, 600 s, scoped to their own path | read `setCookie` options |
| Event details visible to organizer and invitees only | `loadEventIfVisible`, `worker/src/routes/events.ts` | try another account's event id (walkthrough 3.18) |
| Answers visible to other invitees (RSVP, named votes, ranges) | `routes/events.ts` voters query and invite list; window submissions | open an event as an invitee |
| Noticeboard: title, game, time, invitees + answers; no description; opt-out; pre-0038 events made private, but an organizer can later show them | `worker/src/lib/noticeboard.ts:418`; migration 0038 backfill (`:30`); the flag is editable (`EventFormPage.tsx:1079`, `eventWrites.ts:1295`) — **draft 2, D-02: "permanently" was untrue** | walkthrough 3.6, 3.19 |
| Change requests: an open time change is shown to every current invitee with requester, proposed time, message and tally; decided ones and add-person requests only to requester + organizer; nobody sees who voted how | `lib/changeRequests.ts` list query (`requester_id = ? OR (kind = 'time_change' AND status = 'pending')`) — **draft 2, D-04** | as each role |
| Groups visible to members: name, game, owner, members — and members' profiles, whether or not they still share a server | `routes/groups.ts:37`–`:77`, `routes/me.ts:272` — **draft 2, D-14** | as a member |
| Personal time private; only "Busy" counts for free/busy; toggle hides all | `routes/personal.ts`; `lib/freeBusy.ts:266`, `:288` | walkthrough 6.2 |
| Free/busy sources: organized, invited-not-declined, confirmed poll yes, personal Busy; a declined date of a repeating event can still show | `lib/freeBusy.ts` (organized/invited queries ~`:109`, and the comment on the `occurrence_date = ''` exclusion) | read |
| Inactivity warnings sent even with notifications off | `reminders.ts` stale-account sweep: the recipient is rebuilt with `notifications_enabled: 1` (`:3243`) and the scan does not filter on it — verified by the Fable review | read |
| Profile shown to members of shared servers, and to fellow group members | invite picker / `routes/guilds.ts`; groups as above | read |
| Operator admin page fields: Discord ID, username, display name, notifications, last login, last refused login, servers incl. ones left | `worker/src/routes/admin.ts:28`–`:88` — **draft 2, D-20** | read |
| No admin page for events/answers/personal time | `routes/admin.ts` has only users, guilds, guild-requests | read |
| Minimum attendees: optional deadline; auto-cancel at the deadline or on the decline that takes it below; otherwise the organizer is messaged | `lib/attendance.ts` `recordRsvp` (~`:523`); `sweepMinimumAttendeesDeadlines`; `sendCancelledEventNotice` — **draft 2, D-17** | walkthrough 4.x |
| Poll day becomes an event; **every** answer carried (yes/no/maybe → accepted/declined/tentative); called off below threshold | `reminders.ts` `createFannedOutEvent`, `VOTE_AS_RSVP` (`lib/polls.ts`) — **draft 2, P24-02: only yes was carried, so an organizer's no showed as yes** | `confirmedDayThreshold.test.ts`; walkthrough 5.10–5.14 |
| Inactivity deletion at 365 days; warnings at 351/358; paused while organizing/invited to future plans **or to any uncancelled repeating event**; warnings sent even with notifications off | `reminders.ts:3096`–`:3098`; stake query `start_at IS NULL OR start_at > ?` (`:3151`), and every series has `start_at IS NULL` — **draft 2, D-16** | read |
| Cancelled events / finished polls deleted 90 days after they were last changed; ordinary past events kept | `reminders.ts:193`; the purge keys on `updated_at` (`:3474`) — **draft 2, D-18** | read |
| Deletion removes the listed data from the live database, immediately; organised events go for everyone; no cancellation DM; Google entries already written stay; recovery copies for the Time Travel window | `worker/src/lib/db.ts` `deleteUserCompletely` (one batch; every FK into `users` handled — verified by the Fable review); Google left at `db.ts:586`; F6 | walkthrough 6.6/6.7 |
| Export: everything held about you except encrypted credentials | `worker/src/routes/me.ts` export; `worker/test/exportCompleteness.test.ts` checks every explicit projection against the schema — **draft 2, D-07** | download it; compare with Part E |
| Policy change → agree again; only export/delete/accept available until then | spec 0012; `routes/me.ts:15`; sessions pruned on version change | walkthrough 6.3b |
| Fonts don't contact Google | `frontend/src/fonts.css`; `noRemoteAssets.test.ts` | network tab |
| Profile pictures load from Discord's CDN | `frontend/src/lib/avatar.ts:7` (`cdn.discordapp.com/avatars/…`); `noRemoteAssets.test.ts` checks only `index.html` and `fonts.css` — **draft 2, D-03** | network tab on the noticeboard |
| Bot-add requests need an existing account | `routes/guildRequests.ts:122`–`:130` (403 without one) — **draft 2, D-05** | read |
| The bot lists voice channels and re-checks membership | `routes/guilds.ts:152`–`:163`; `lib/db.ts:719`–`:779` — **draft 2, D-19** | read |
| Operational logs: Discord IDs and usernames possible; no event titles, descriptions or messages; a refused stranger is not named | `grep console. worker/src`; the email stub logs the whole owner email (`lib/email.ts:40`); `auth.ts` refused-login line carries no id since draft 2 (D-11, `pass11.test.ts` "keeps no profile") | grep |
| Delivery is attempted, not guaranteed | outbox retries; Discord can refuse (blocked bot, closed DMs); notifications can be off | read `lib/outbox.ts` |

---

## Part E — data inventory

### Database (every table, from the migrations)

| Table | Holds | About whom | Export | Deleted with account | Other deletion |
|---|---|---|---|---|---|
| `users` | id, username, display name, avatar ref, timezone, notifications on/off, **DM channel id** (written the first time the bot messages you), created/updated, last login, last refused login, free/busy visible, policy version + time | you | yes, all columns | yes | 365-day inactivity |
| `user_guild_membership` | which allow-listed servers you're in, verified time (`nickname` column exists but nothing writes it) | you | yes | yes | — |
| `sessions` | id, created, last used (to within 5 min), expires, revoked, replaced, family, successor, policy version | you | yes, all but `user_id` | yes | at expiry/revocation/policy change |
| `personal_events` (+ `_overrides`) | your personal time, **including entries imported from a Google calendar with their title and description** (only if Google is on and you chose a calendar to read) | you | yes | yes | imported ones when reading is switched off |
| `events` | title, description, game, times, timezone, voice channel, poll settings, minimum attendees, privacy | organizer | organised: yes | organised: yes | cancelled/finished: 90 days |
| `event_invites`, `event_attendance` | who's invited; answers per date | you + organizer | yes | yes | with the event |
| `event_poll_options`, `event_poll_votes`, `event_window_availability` | candidates; your votes; your ranges | you | yes | yes | with the event |
| `event_recurrence_rules`, `event_occurrence_overrides` | schedules, moved/cancelled dates | organizer | yes | with organised events | with the event |
| `event_change_requests`, `_votes` | requests: proposed time/person, message, decision note; votes | requester, target, organizer | yes (filed, about you, decided, votes) | yes (filed/about you; "decided by" cleared) | with the event |
| `groups`, `group_members`, `group_activity_nudges` | groups, members, idle-reminder state | creator + members | yes (nudge state for groups you created) | groups you created, with their nudge state; your memberships | — |
| `guild_add_requests` | server id/name, requester, times | requester | yes | yes | — |
| `guilds` | allow-listed servers | — (servers) | n/a | n/a | operator |
| `notification_log` | **DM text**, sent/delivered, Discord message id, buttons | recipient | yes (all columns) | yes (yours, and those on your events) | with the event |
| `change_request_log`, `organizer_rsvp_notice_log`, `group_nudge_log`, `account_purge_warnings` | **DM text** + delivery state for those kinds | recipient (+ responder for RSVP notices) | yes | yes | with the event/group |
| `google_calendar_connections` | encrypted Google credentials, Google email, chosen calendars, status, failure/disconnect bookkeeping | you | yes, **never the credential** | yes (and revoked with Google) | — |
| `google_event_links` | which sessions were written to which Google calendar, with Google's event id | you | yes | yes (the Google entries themselves stay) | — |
| `google_pending_connections` | encrypted credential + Google email, during connect only | you | yes, **never the credential** | yes | expires |
| `google_orphaned_inserts` | Google event ids + **Google email** to clean up | you | yes | yes | after cleanup |
| `oauth_callback_counts` | a keyed one-way code made from a caller's IP address, the current minute, a count (login rate limit, item 92) | a caller, unlinked to any account | no — nothing ties it to you | n/a | every callback and every cron tick delete earlier minutes (≤ ~15 min) |
| `cron_cursors` | internal sweep positions | nobody | n/a | n/a | — |

### Outside services

| Service | Receives | When |
|---|---|---|
| Cloudflare | everything above (hosting, D1 database), request metadata incl. IP | always |
| GitHub (Pages) | site file requests, incl. IP | when the site loads |
| Discord | OAuth (login); DM text; button presses back; server-membership and voice-channel lookups by the bot; **your browser's requests for profile pictures** (`cdn.discordapp.com`), with your IP | always |
| Resend | owner email about a bot-add request | **only if `EMAIL_MODE = "live"`** (production: stub) |
| Google | session titles/times/server name/link; calendar reads | **only if `GOOGLE_SYNC_MODE = "live"`** (production: off) |

**Logs — corrected in draft 2.** The first draft said no logs are kept because
`worker/wrangler.toml` enables no `[observability]`. Astra points out that
Cloudflare can have Workers Logs on for a Worker regardless, so that inference
is not evidence: only the dashboard (Workers → the Worker → Logs) says. The
log lines themselves can carry Discord IDs and usernames, and the email stub
writes the whole owner email (requester and server) on every bot-add request;
none writes event titles, descriptions or DM text. The refused-login warning no
longer names the person refused. *[F8: check the setting; Part B's Cloudflare
bullet and retention row carry the disclosure if it is on.]*

### Automatic actions

Inactivity deletion (365 days); minimum-attendee auto-cancel (organizer opt-in);
poll day fan-out, every answer carried, and call-off below threshold; 90-day purge
of cancelled/finished history; session expiry; deferred DMs (each 15-minute
tick sends a limited number).

---

## Part F — decisions only Michael can make

| # | Decision | Why it matters | Author's suggestion |
|---|---|---|---|
| F1 | **Who is named as the controller** | Data-protection law expects the controller to be identifiable; "the operator of Uncle Owen" isn't | Your name, or a name you publish under, plus the existing email |
| F2 | **Governing law** | Terms usually say which law applies; version 5 says nothing | Your state/country, or leave it out deliberately |
| F3 | **Google section while Google is off** | Describing an unavailable feature as available is untrue; removing it means another version bump when it's switched on | Keep it, marked "not currently offered" — draft 2 now carries the full text, including the deletion caveat both reviewers said must not be lost (D-06, D-23) |
| F4 | **Resend while email is stub** | Same, for the operator email | Same treatment as F3 — or switch email on |
| F5 | **"Download my data" completeness** | — | **Decided 9 Nov: extend the export.** Done (A5) |
| F6 | **D1 Time Travel window** | It sets how long deleted data is recoverable | The Fable review confirmed from Cloudflare's docs: always on, **7 days on Workers Free, 30 on Paid**; `wrangler.toml` says `WORKERS_PLAN = "free"`. Confirm the account's actual plan in the dashboard, then fill in the number |
| F7 | **International transfer safeguards** | Law-dependent; the author can't confirm which mechanisms each provider uses | State plainly that processing happens in the US, and either cite each provider's own published safeguards or leave the general statement |
| F8 | **Cloudflare log settings** | Whether Cloudflare keeps the app's log lines, and for how long (see Part E, Logs) | Check Workers → Logs in the dashboard. If on, keep Part B's two bracketed sentences with the retention filled in; if off, delete them |
| F9 | **Which privacy laws to name, and legal bases** | Both reviewers flagged that the first draft dropped version 5's legal-bases paragraph | **Decided 9 Nov: keep a short version** — now in Part B, updated to match what the service actually does. Still offer the rights to everyone rather than claim one law applies |
| F10 | **The 1.0 launch announcement** (IDEAS 105) | A one-off DM to everyone with notifications on, kept in a new `announcement_log` table (text + delivery state, like the other DM logs), and `users.announcement_seen` for the one-time pop-up. Both are exported and deleted with the account. Neither the policy nor the inventory mentions them yet | Add one line to "Messages it has sent you" (a one-off service announcement, 1.0 only, respecting the notifications setting) and the two items to Part E. Removed from the text when 1.1 removes the feature |
