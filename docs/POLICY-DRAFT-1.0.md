# Privacy Policy and Terms — 1.0 draft for review

**Status: DRAFT. Not live.** The pages in the app (`frontend/src/pages/PrivacyPage.tsx`,
`TermsPage.tsx`) and the policy version (`worker/src/lib/policy.ts`,
`CURRENT_POLICY_VERSION = 5`) are unchanged. They change once, after review,
together with the version bump to 6 — which is what makes everyone agree again
(spec 0012).

**Prepared:** 9 November 2026, against branch `claude/practical-ptolemy-xqv8nj`.

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
| A1 | Resend "sends the one email this service generates" to the operator | Production runs with `EMAIL_MODE = "stub"` (`worker/wrangler.toml`): no email is sent and Resend receives nothing. (A comment in `worker/src/lib/email.ts` says production is `live`; the config disagrees.) | Resend described as used **only if** owner email is switched on — see F4 |
| A2 | The Google Calendar connection is described as available | Production runs with `GOOGLE_SYNC_MODE = "off"`; every Google route answers 503 and the sync never runs (`isGoogleConfigured`, `worker/src/lib/googleCalendar.ts:102`) | Kept, but marked **not currently offered** — see F3 |
| A3 | "There is no administrative screen in the app for reading other people's data" | The operator has an admin page listing every account: username, display name, notifications on/off, last login, last refused login, and server memberships (`worker/src/routes/admin.ts:28`, `:62`). It shows no event content | States exactly what the operator's screens show |
| A4 | "No soft-delete or grace period" on account deletion | True of the app. But Cloudflare D1 keeps point-in-time recovery ("Time Travel") for a fixed window, so the operator could technically restore a deleted account's data during it | States the window — see F6 to confirm its length |
| A5 | "Download my data" returns "everything the service holds about you" | Nearly everything. Not included: the Discord DM channel id (`users.dm_channel_id`), two short-lived Google bookkeeping tables (`google_pending_connections`, `google_orphaned_inserts`, the latter holding a Google account email) | Either add them to the export or qualify the claim — see F5 |

And these things the code does are **not mentioned at all**:

| # | Missing | Where it lives |
|---|---|---|
| A6 | **Your IP address is used for rate-limiting** the three login/connect callbacks (item 92). It is the key of Cloudflare's rate-limit counter for about a minute and is never written to the database | `worker/src/lib/rateLimit.ts` |
| A7 | **The full text of every DM sent to you is kept**, not just a record that it was sent (`content` in five log tables), for as long as the event it was about exists | `notification_log`, `change_request_log`, `organizer_rsvp_notice_log`, `group_nudge_log`, `account_purge_warnings` |
| A8 | **Change requests**: proposed times, free-text messages, the organizer's decision note, and votes on them. Who sees them is asymmetric (requesters see their own; the organizer sees all with tallies, never who voted how) | `event_change_requests`, `event_change_request_votes`; spec 0003 |
| A9 | **Your answers are visible to the other invitees**: RSVPs, poll votes (with your name), submitted availability ranges. Version 5 says event details are visible to invitees, but not that your *answers* are | `worker/src/routes/events.ts` (poll voters, invite list) |
| A10 | **Group membership is visible** to the group's other members, with the group's name, game and owner | `worker/src/routes/groups.ts:62` |
| A11 | **Past events are kept indefinitely** — only cancelled events and finished polls are deleted, after 90 days. A normal past event stays until its organizer's account is deleted | `TERMINAL_HISTORY_RETENTION_MS`, `worker/src/cron/reminders.ts:192` |
| A12 | **Concrete retention periods** generally: sessions 7 days, cancelled/finished history 90 days, inactivity deletion at 365 days with warnings at 351 and 358 | `sessions.ts:10`, `reminders.ts:192`, `:3081` |
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
doesn't collect it.

### Who is responsible

*[OPERATOR NAME]* runs Uncle Owen and is responsible for the information
described here (the "data controller", in data-protection terms). Contact:
**JediParty@proton.me**.

### What is collected, and why

**When you log in with Discord.** Uncle Owen asks Discord only for the
`identify` and `guilds` permissions. From those it keeps:
- your Discord user ID, username, display name and avatar reference;
- which of your Discord servers are on this app's allow-list, and when that
  was last checked. The rest of your server list is used once, to make that
  check, and never stored.

It never asks for your email address, and it never sees your Discord messages
or your password.

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
  and the bot.
- **Login sessions.** When each was created, last used and expires, and
  whether it was revoked or replaced. Replaced sessions are kept until they
  would have expired anyway, which is how the service notices a copied
  session being reused.
- **Which version of this policy you agreed to, and when.**
- **When you last logged in**, and when a login was last refused (for example
  because you no longer share a server with the app).

**Your IP address, briefly.** The three places where signing in or connecting
an account costs the service a request to Discord or Google are
rate-limited, so a script can't hammer them. Your IP address is the key for
that limit: Cloudflare counts requests from it for about a minute. Uncle Owen
never writes your IP address to its database, and never uses it for anything
else.

**If you ask to add the bot to a server.** That server's ID and name, your
Discord user ID, and when the request was made and decided. The request
repeats the Discord permission check above for that server, to confirm you
administer it.

**Google Calendar — not currently offered.** The code for connecting a Google
calendar exists but is switched off; nothing is sent to or read from Google.
*[Keep the full Google section from version 5 here, unchanged, under a heading
saying it applies only once the feature is switched on — or remove it until
then. See F3.]*

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
  keep any event off the noticeboard, and events created before the noticeboard
  existed are kept off it permanently.
- **Change requests.** If you ask to change an event, the organizer sees your
  request and its message. Other invitees can vote on time changes; the
  organizer sees the total, never who voted how. You see your own requests.
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
  signed-in members of servers you share, so people can find who to invite.
- **The operator** has an admin page listing every account with its username,
  display name, whether notifications are on, when it last logged in, and which
  servers it belongs to; and the requests to add the bot. There is no admin
  page showing anyone's events, answers or personal time. The operator can
  technically query the database directly, as with any service someone hosts:
  content is not end-to-end encrypted. The operator will only do so to fix a
  fault or where the law requires it.

### Things the service does automatically

So that nothing happens to your plans without you knowing it can:
- **An organizer can set a minimum number of attendees.** If they choose to,
  the event cancels itself when it falls below that, and everyone still coming
  is told.
- **On a poll where each day is confirmed separately,** a confirmed day becomes
  its own event, and your "I'm in" counts as your answer for it. If that day
  later falls below the number of people the poll needed, it is called off and
  everyone still coming is told.
- **An account that hasn't logged in for 365 days is deleted**, exactly as if
  you'd pressed "Delete my account". You'll be sent a Discord message two weeks
  and one week before (if Discord accepts messages from the bot). It is paused
  while you're organizing, or invited to and haven't declined, anything still
  to come.

None of this involves profiling or decisions about you beyond these rules.

### Who it is shared with

Never sold, rented or shared for advertising. It is processed only by the
services needed to run Uncle Owen:
- **Cloudflare** runs the application and its database, and keeps the
  rate-limit counters described above.
- **GitHub** serves the website's files. Like any web host, it receives your
  IP address when your browser loads the site.
- **Discord** handles login and delivers the messages you get from the bot,
  including their text.
- *[Resend — only if owner email is switched on; see F4.]*
- *[Google — only once Google Calendar is switched on; see F3.]*

The site's fonts are served from Uncle Owen's own site, so visiting it does not
contact Google or any font service.

Information may also be disclosed if the law requires it, or where you ask for
it to be shared.

### How long it is kept

| What | Kept until |
|---|---|
| Your account, settings, groups and personal time | You delete your account, or 365 days without logging in |
| Events you organize, and everyone's answers on them | You delete your account (past events are not removed on their own) |
| Cancelled events and finished polls | 90 days after they ended or were cancelled |
| Messages the bot sent you (text and delivery record) | The event they were about is removed, or your account is deleted |
| Login sessions | 7 days after they start, or sooner if you log out |
| Your IP address in the rate-limit counter | About one minute; never stored by Uncle Owen |
| Sign-in cookies | 10 minutes |
| Database recovery copies (Cloudflare D1 "Time Travel") | *[7]* days, after which deleted data cannot be restored — see F6 |

### Your rights, and how to use them

Everything below is available to everyone, in Settings, whatever the law where
you live:
- **See and take your data**: "Download my data" gives you a file with what
  Uncle Owen holds about you. *[Make "everything" true, or name the exceptions
  — F5.]*
- **Delete your account**: "Delete my account" removes your profile, personal
  time, answers, invitations, group memberships, the messages logged as sent to
  you, your login sessions, and the events and groups you created. It happens
  immediately. **Events you organised disappear for everyone invited, with
  their answers, and no cancellation message is sent** — tell people first if
  that matters. Discord messages already delivered stay in your Discord
  history, since they live in Discord.
- **Correct it**: edit your events, groups and settings at any time.
- **Object or limit it**: turn off Discord notifications, or hide your
  free/busy time, in Settings. The warnings before an inactive account is
  deleted are still sent, because they exist to stop that deletion.

If you can't sign in any more, email **JediParty@proton.me** from an address
you control and the same requests will be handled by hand, normally within a
month. You may also have the right to complain to your data-protection
authority. Using any of these rights never changes how the service treats you.

### Security

Traffic is encrypted (HTTPS); the database is encrypted at rest by Cloudflare;
secrets are kept outside the code; sign-in sessions are short-lived, revocable,
and replaced each time they renew; Discord login tokens are never stored. This
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
answer from Discord. Anyone who administers a Discord server can ask for the
bot to be added; the operator approves or declines each request.

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
the people you invited and putting it in their messages.

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
| DM channel id kept | `users.dm_channel_id` | schema |
| Sessions: created/last used/expires/revoked/replaced; 7-day expiry; replaced kept until expiry | `worker/src/lib/sessions.ts:10`, `pruneStaleSessions` (`:96`) | read |
| Policy version and time agreed are kept | `users.accepted_policy_version`, `accepted_policy_at` | schema |
| Last login and last refused login kept | `users.last_login_at`, `last_login_attempt_at` (`auth.ts` callback) | schema; read |
| IP used as the rate-limit key, ~60 s, never stored | `worker/src/lib/rateLimit.ts`; `wrangler.toml` `[ratelimits.simple] period = 60`; no IP column anywhere | grep for `CF-Connecting-IP`; schema |
| The three limited routes | `auth.ts:176`, `google.ts:208`, `guildRequests.ts:103` | read; timetable R92 |
| Bot-add request stores server id/name, requester, times | `guild_add_requests` | schema |
| Google is switched off in production | `wrangler.toml` `GOOGLE_SYNC_MODE = "off"`; `googleCalendar.ts:102` | read |
| No trackers/analytics/ad networks | no third-party scripts in `frontend/`; fonts self-hosted (`frontend/src/fonts.css`, `noRemoteAssets.test.ts`) | read; network tab on the site |
| Browser storage keys | `jps_token`, `jps_identity`, `jps_login_verifier`, `jps_pending_revocations`, `jps_selected_guild`, `uo.view`, `uo.scenery` | grep `frontend/src` |
| Three short-lived cookies | `oauth_state` (`auth.ts:14`), `guild_verify_state` (`guildRequests.ts:34`), `google_connect_nonce` (`google.ts:46`) — all HttpOnly, 600 s, scoped to their own path | read `setCookie` options |
| Event details visible to organizer and invitees only | `loadEventIfVisible`, `worker/src/routes/events.ts` | try another account's event id (walkthrough 3.18) |
| Answers visible to other invitees (RSVP, named votes, ranges) | `routes/events.ts` voters query and invite list; window submissions | open an event as an invitee |
| Noticeboard: title, game, time, invitees + answers; no description; opt-out; pre-0038 events private | `worker/src/lib/noticeboard.ts:418`; migration 0038 | walkthrough 3.6, 3.19 |
| Change requests: requester sees own; organizer sees all + tallies, no per-voter | spec 0003; `routes/changeRequests.ts` GET | as each role |
| Groups visible to members: name, game, owner, members | `routes/groups.ts:62` | as a member |
| Personal time private; only "Busy" counts for free/busy; toggle hides all | `routes/personal.ts`; `lib/freeBusy.ts:266`, `:288` | walkthrough 6.2 |
| Free/busy sources: organized, invited-not-declined, confirmed poll yes, personal Busy; a declined date of a repeating event can still show | `lib/freeBusy.ts` (organized/invited queries ~`:109`, and the comment on the `occurrence_date = ''` exclusion) | read |
| Inactivity warnings sent even with notifications off | carried from version 5; `reminders.ts` stale-account sweep (~`:3081`) | **verify**: the sweep selects `notifications_enabled` — check it doesn't filter on it |
| Profile shown to members of shared servers | invite picker / `routes/guilds.ts` | read |
| Operator admin page fields | `worker/src/routes/admin.ts:28`, `:62`, `:142` | read |
| No admin page for events/answers/personal time | `routes/admin.ts` has only users, guilds, guild-requests | read |
| Minimum attendees auto-cancel + notice | `lib/attendance.ts` `recordRsvp`; `reminders.ts` `sendCancelledEventNotice` | walkthrough 4.x |
| Poll day becomes an event; "I'm in" carried; called off below threshold | `reminders.ts:1775`; `lib/polls.ts:201`, `:782` | walkthrough 5.10–5.14 |
| Inactivity deletion at 365 days; warnings at 351/358; paused while organizing/invited to future plans; warnings sent even with notifications off | `reminders.ts:3081`–`:3083`; spec 0016 | read |
| Cancelled events / finished polls deleted after 90 days; ordinary past events kept | `reminders.ts:192`, purge query (`status = 'cancelled' OR resolved poll`) | read |
| Deletion removes the listed data, immediately; organised events go for everyone; no cancellation DM | `worker/src/lib/db.ts` `deleteUserCompletely`; `routes/me.ts` DELETE | walkthrough 6.6/6.7 |
| Export contents | `worker/src/routes/me.ts:108`–`:205` | download it; compare with Part E |
| Policy change → agree again; only export/delete/accept available until then | spec 0012; `routes/me.ts:15`; sessions pruned on version change | walkthrough 6.3b |
| Fonts don't contact Google | `frontend/src/fonts.css`; `noRemoteAssets.test.ts` | network tab |

---

## Part E — data inventory

### Database (every table, from the migrations)

| Table | Holds | About whom | Export | Deleted with account | Other deletion |
|---|---|---|---|---|---|
| `users` | id, username, display name, avatar ref, timezone, notifications on/off, **DM channel id**, created/updated, last login, last refused login, free/busy visible, policy version + time | you | yes, **except `dm_channel_id`** | yes | 365-day inactivity |
| `user_guild_membership` | which allow-listed servers you're in, verified time (`nickname` column exists but nothing writes it) | you | yes | yes | — |
| `sessions` | created, last used, expires, revoked, replaced, family | you | yes | yes | at expiry/revocation/policy change |
| `personal_events` (+ `_overrides`) | your personal time | you | yes | yes | — |
| `events` | title, description, game, times, timezone, voice channel, poll settings, minimum attendees, privacy | organizer | organised: yes | organised: yes | cancelled/finished: 90 days |
| `event_invites`, `event_attendance` | who's invited; answers per date | you + organizer | yes | yes | with the event |
| `event_poll_options`, `event_poll_votes`, `event_window_availability` | candidates; your votes; your ranges | you | yes | yes | with the event |
| `event_recurrence_rules`, `event_occurrence_overrides` | schedules, moved/cancelled dates | organizer | yes | with organised events | with the event |
| `event_change_requests`, `_votes` | requests: proposed time/person, message, decision note; votes | requester, target, organizer | yes (filed, about you, decided, votes) | yes (filed/about you; "decided by" cleared) | with the event |
| `groups`, `group_members`, `group_activity_nudges` | groups, members, idle-reminder state | creator + members | yes | yes | — |
| `guild_add_requests` | server id/name, requester, times | requester | yes | yes | — |
| `guilds` | allow-listed servers | — (servers) | n/a | n/a | operator |
| `notification_log` | **DM text**, sent/delivered, Discord message id, buttons | recipient | yes (all columns) | yes (yours, and those on your events) | with the event |
| `change_request_log`, `organizer_rsvp_notice_log`, `group_nudge_log`, `account_purge_warnings` | **DM text** + delivery state for those kinds | recipient (+ responder for RSVP notices) | yes | yes | with the event/group |
| `google_calendar_connections` | encrypted Google credentials, Google email, chosen calendars, status | you | yes, **never the credential** | yes (and revoked with Google) | — |
| `google_event_links` | which sessions were written to Google | you | yes | yes | — |
| `google_pending_connections` | encrypted credential + Google email, during connect only | you | **no** | yes | expires |
| `google_orphaned_inserts` | Google event ids + **Google email** to clean up | you | **no** | yes | after cleanup |
| `cron_cursors` | internal sweep positions | nobody | n/a | n/a | — |

### Outside services

| Service | Receives | When |
|---|---|---|
| Cloudflare | everything above (hosting, D1 database), request metadata incl. IP; rate-limit counters keyed on IP | always |
| GitHub (Pages) | site file requests, incl. IP | when the site loads |
| Discord | OAuth (login); DM text; button presses back; server-membership and voice-channel lookups by the bot | always |
| Resend | owner email about a bot-add request | **only if `EMAIL_MODE = "live"`** (production: stub) |
| Google | session titles/times/server name/link; calendar reads | **only if `GOOGLE_SYNC_MODE = "live"`** (production: off) |

No logs are kept by the app itself: `worker/wrangler.toml` enables no
`[observability]`, so `console` output is only visible live (`wrangler tail`).
*[F8: confirm nothing in the Cloudflare dashboard turns persistent Workers Logs
on.]*

### Automatic actions

Inactivity deletion (365 days); minimum-attendee auto-cancel (organizer opt-in);
poll day fan-out, carried "I'm in", and call-off below threshold; 90-day purge
of cancelled/finished history; session expiry; deferred DMs (each 15-minute
tick sends a limited number).

---

## Part F — decisions only Michael can make

| # | Decision | Why it matters | Author's suggestion |
|---|---|---|---|
| F1 | **Who is named as the controller** | Data-protection law expects the controller to be identifiable; "the operator of Uncle Owen" isn't | Your name, or a name you publish under, plus the existing email |
| F2 | **Governing law** | Terms usually say which law applies; version 5 says nothing | Your state/country, or leave it out deliberately |
| F3 | **Google section while Google is off** | Describing an unavailable feature as available is untrue; removing it means another version bump when it's switched on | Keep it, clearly marked "not currently offered", so switching it on later needs no re-agreement |
| F4 | **Resend while email is stub** | Same, for the operator email | Same treatment as F3 — or switch email on |
| F5 | **"Download my data" completeness** | The draft can't say "everything" while three items are left out | Add `dm_channel_id`, `google_pending_connections`, `google_orphaned_inserts` to the export before 1.0 (small code change) |
| F6 | **D1 Time Travel window** | It sets how long deleted data is recoverable | Confirm the plan's window in Cloudflare's docs (believed 7 days on Workers Free, 30 on Paid) |
| F7 | **International transfer safeguards** | Law-dependent; the author can't confirm which mechanisms each provider uses | State plainly that processing happens in the US, and either cite each provider's own published safeguards or leave the general statement |
| F8 | **Cloudflare log settings** | The "no logs kept" statement depends on dashboard settings outside the repo | Check Workers → Logs in the dashboard |
| F9 | **Which privacy laws to name** | The draft offers the rights to everyone rather than claiming any one law applies to a hobby service | Keep it that way unless a reviewer finds a reason not to |
