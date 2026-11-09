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

## Demo video shot list (unlisted YouTube, 3–5 minutes, English, no narration required but captions help)

Google wants to see the consent screen showing the app name **and the OAuth
client ID in the browser's address bar**, then each scope actually being used.

1. Open **https://uncleowen.space** (the home page with its description and Privacy link). Click the Privacy link and scroll to the Google section.
2. Log in with Discord. Go to **Settings → Connected calendars → Connect Google**.
3. On Google's consent screen, **pause and zoom on the address bar** so `client_id=767835704577-…` is readable, then on the app name "Uncle Owen" and the two permissions listed. Grant them.
4. Back in Settings: open the **"Calendar to write to"** list (that's `calendar.readonly` listing calendars). Pick one; tick **Sync my sessions**.
5. In Uncle Owen, show an event you're going to. Then show **Google Calendar** with that session written there: title, time, server name, link. *(Sync runs about hourly, so record this part after it has run.)*
6. **Move the session's time** in Uncle Owen, wait for the sync, and show the Google entry updated. Then **cancel** it and show it removed.
7. In Settings choose a calendar under **"Read my busy times from"**. Show its events appearing in **your** Uncle Owen calendar as read-only personal time. Then, as a second account (SchedulerTest), show the scheduling view where you appear only as **blank busy blocks**.
8. **Disconnect** in Settings and show the upcoming Uncle Owen entries gone from Google Calendar.

## Submitting

Google Auth Platform → **Verification Center** → start verification. It asks
for the home page, privacy URL, the scope justifications, and the video link,
and may ask follow-up questions by email to the developer contact
(JediParty@proton.me). Sensitive-scope reviews typically take a few business
days, sometimes a couple of rounds. While it's pending, the warning stays and
the 100-user lifetime cap applies.
