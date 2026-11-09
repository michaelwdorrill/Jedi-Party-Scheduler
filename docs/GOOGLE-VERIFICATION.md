# Google OAuth verification — the plan (IDEAS 64, un-parked 9 Nov 2026)

Goal: remove the "Google hasn't verified this app" screen anyone connecting a
Google calendar meets. Only Google's verification does that. Both scopes are
**sensitive**, not restricted: a review of the app and its documentation, with
no fee and no third-party security assessment.

## Where we stand (9 Nov 2026, after the 1.0 launch)

| Requirement | Status |
|---|---|
| Production Google Cloud project, External, published "In production" | ✅ ("Uncle Owen") |
| Domain ownership (Search Console, DNS TXT on uncleowen.space) | ✅ |
| Branding verified and published; support email JediParty@proton.me | ✅ |
| Privacy Policy discloses Google data use, with the Limited Use statement in Google's wording | ✅ policy v6 (`frontend/src/pages/PrivacyPage.tsx`) |
| Home page linked to the Privacy Policy | ✅ (login page, Terms + Privacy links) |
| **Home page explains what the app does, including its Google use** | ❌ 1.0.1, code (A below) |
| **Privacy Policy and Terms at plain URLs** (no `#`), readable by Google's crawler | ❌ 1.0.1, code (B below) |
| Scope justifications | ✍️ drafted below, for Michael to adjust |
| Demo video | 🎬 shot list below, for Michael to record |
| Submission in Google Auth Platform → Verification Center | ⏳ after A and B ship |

## The code half (1.0.1)

**A. Home page.** Add a short public description to the login page: what Uncle
Owen is (a scheduler for private Discord friend groups); that you can
optionally connect Google Calendar to have your sessions written to a calendar
you choose and, if you want, one calendar read so others see when you're busy
(as blank blocks); and a sentence linking the Privacy Policy for how Google
data is used. Keep it visible without logging in.

**B. Plain-path legal pages.** The site uses a HashRouter, so the policy lives
at `/#/privacy`. Google's reviewers and crawler can treat that as the home page
with no policy on it. Fix: at build time, render `PrivacyPage` and `TermsPage`
to static HTML (`react-dom/server` inside a `MemoryRouter`) and write them as
`dist/privacy/index.html` and `dist/terms/index.html`, so
`https://uncleowen.space/privacy` and `/terms` serve real HTML with no
JavaScript needed. The `#/` routes stay for the app. Then change the consent
screen's Privacy and Terms links to the plain URLs. (Re-verifying branding may
be needed after that edit; it was quick the first time.)

## Scope justifications (paste into the Data Access / verification form)

**`https://www.googleapis.com/auth/calendar.events`**
> Uncle Owen schedules gaming sessions for private Discord friend groups. When
> a user connects Google Calendar, Uncle Owen writes the sessions they organize
> or are invited to (and haven't declined) onto one calendar the user chooses:
> title, start and end time, the Discord server's name and a link back to the
> session. It updates those entries when a session moves, removes them when a
> session is cancelled or the user declines, and removes upcoming entries when
> the user disconnects. It only ever changes events it created itself. A
> narrower scope would not let it create, update and delete events on an
> existing calendar the user picks. `calendar.app.created` would force every
> session onto a separate secondary calendar, which defeats the purpose:
> users want their game nights in their main calendar, in one place with
> everything else they have going on, so conflicts are visible and reminders
> arrive through the phone notifications they already use. The user chooses
> the calendar, and anyone who prefers a dedicated one can create it and
> pick that instead.

**`https://www.googleapis.com/auth/calendar.readonly`**
> Used for two things. First, to list the user's calendars so they can choose
> which one Uncle Owen writes to, and optionally which one it reads. Second,
> only if the user turns it on, to read upcoming events (about two months
> ahead, at most 40) from that one chosen calendar. Those events are shown to
> the user themselves as read-only personal time. Other members of their
> Discord server see only blank "busy" blocks, never titles or details. Nothing
> read is shared, sold or used for anything else (see the Privacy Policy's
> Limited Use statement).

*Both approved by Michael, 9 Nov 2026. The main-calendar reasoning is his:
everything in one place, and phone notifications that already work, with
the choice left to the user.*

## Demo video: the script

**Record after 1.0.1 ships** (home page description, plain `/privacy`), so
Scene 1 shows the final versions.

### Tools
- **Snipping Tool** (Windows 11): Win+Shift+R, or the video-camera icon, drag
  a box around the browser window, then Start. One MP4 per clip.
- **Clipchamp** (built into Windows 11, free): join the four clips, add the
  caption text below as on-screen titles, export **1080p MP4**.
- Then YouTube, **Unlisted**, title "Uncle Owen — Google Calendar
  integration (OAuth verification demo)".

### Before recording (once)
1. **Chrome profile:** the new profile signed in to the **Demo Google
   account**, with **Discord's website signed in as DM MD** (so login is one
   click). Close every tab except Uncle Owen. Hide the bookmarks bar
   (Ctrl+Shift+B). Normal window, not full-screen, so the **address bar
   shows**. Zoom **125%**.
2. **Windows:** turn on **Do Not Disturb** (Win+N, the bell) so no
   notification pops up mid-shot.
3. **Demo Google account:** in Google Calendar, create a **second calendar**
   called "Personal" and add two made-up events in the next week (e.g.
   "Dentist", "Dinner with Sam"). The **primary** calendar stays empty; that's
   where Uncle Owen will write.
4. **Uncle Owen (production, as DM MD), in your DM MD server:** create two
   events in the next week, e.g. **"Demo game night"** and **"Demo board
   games"**, unticking the noticeboard so they stay private. Leave the rest of
   your calendar as it is, but **check that no friend's event or name shows**
   on the calendar month you'll be filming.
5. **Settings (as DM MD):** "Let people I share a server with see when I'm
   busy" **on**. **Disconnect** your real Gmail.
6. **SchedulerTest:** invite it to your **DM MD** server, then log in to
   production Uncle Owen once as SchedulerTest in an **Incognito window** (or
   another profile), agree to the policy, and close the pop-up. You'll film it
   in Clip C.
7. Log **out** of Uncle Owen in the recording profile.

### Clip A: discovery, consent, setup (about 2 minutes)

| # | Do | Caption | Hold |
|---|---|---|---|
| A1 | Open **https://uncleowen.space**. Let the home page sit; point at the description with the mouse | "Uncle Owen: a free scheduler for private Discord friend groups" | 4 s |
| A2 | Click **Privacy Policy**; scroll to **"If you connect a Google calendar"** and the **Limited Use** sentence | "How Google data is used, and the Limited Use statement" | 5 s |
| A3 | Back to the home page, **Log in with Discord** → Discord's authorize page → **Authorize** | "Sign-in is with Discord" | 3 s |
| A4 | **Settings → Connected calendars → Connect Google** | "Connecting Google Calendar is optional" | 2 s |
| A5 | Google: choose the **Demo** account. On **"Google hasn't verified this app"**: **Advanced → Go to Uncle Owen** | "(This warning is what verification removes)" | 3 s |
| A6 | **Consent screen. Click into the address bar, press End, and scroll until `client_id=767835704577-…` is visible. Hold.** Then show the app name "Uncle Owen" and the two permissions listed | "OAuth client ID 767835704577-…; the two permissions requested" | **5 s each** |
| A7 | **Allow**. Back in Settings: open **"Calendar to write to"** to show the list, pick the **primary** calendar, tick **Sync my sessions** | "calendar.readonly: listing calendars so you can choose" | 4 s |
| A8 | Open **"Read my busy times from"**, choose **Personal** | "Optional: one calendar read, so others see when you're busy" | 3 s |

Stop recording. **Wait about 15 minutes** (the first sync of a new connection
is on the next 15-minute run).

### Clip B: writing and reading (about 1 minute)

| # | Do | Caption | Hold |
|---|---|---|---|
| B1 | Open **Google Calendar** (Demo account, primary): both **Demo** sessions are there. Open one: title, time, server name, link back | "calendar.events: your sessions, written to the calendar you chose" | 5 s |
| B2 | Back in **Uncle Owen**'s calendar: the two **"Personal"** events appear as your own read-only personal time | "calendar.readonly: your chosen calendar, shown only to you" | 4 s |
| B3 | In Uncle Owen: **move "Demo game night"** to a different time, then **cancel "Demo board games"** | "Changes and cancellations are kept in sync" | 3 s |

Stop. **Wait about an hour** (the next sync for this connection).

### Clip C: updates, and what others see (about 1 minute)

| # | Do | Caption | Hold |
|---|---|---|---|
| C1 | Google Calendar: **"Demo game night"** is at its **new time**, and **"Demo board games" is gone** | "Updated and removed automatically" | 5 s |
| C2 | Switch to the **Incognito window, logged in as SchedulerTest**: start a **New Event** in the DM MD server, invite **DM MD**, and show the scheduling view's **blank busy blocks** for DM MD's "Personal" times, with no titles | "Other people see only that you're busy, never details" | 5 s |

### Clip D: disconnecting (about 30 seconds plus a wait)

| # | Do | Caption | Hold |
|---|---|---|---|
| D1 | Back as DM MD: **Settings → Disconnect** | "Disconnect at any time" | 3 s |
| D2 | *(Wait for the next 15-minute run.)* Google Calendar: the upcoming Uncle Owen entries are **gone** | "Disconnecting removes what Uncle Owen wrote and revokes access" | 5 s |

Afterwards: reconnect your **real Gmail** in Settings, and remove
SchedulerTest from the DM MD server if you don't want it there.

### What not to show
- The **Discord app or discord.com** (servers, DMs, friends). Discord's
  authorize page during login is fine.
- Your **real Gmail** or real calendar. Everything Google-side is the Demo
  account.
- Any **friend's** events or names in Uncle Owen. Only the two Demo events
  and SchedulerTest.

## Submitting

Google Auth Platform → **Verification Center** → start verification. It asks
for the home page, privacy URL, the scope justifications, and the video link,
and may ask follow-up questions by email to the developer contact
(JediParty@proton.me). Sensitive-scope reviews typically take a few business
days, sometimes a couple of rounds. While it's pending, the warning stays and
the 100-user lifetime cap applies.
