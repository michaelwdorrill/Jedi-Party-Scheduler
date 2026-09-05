// The user-facing release history.
//
// Hand-maintained alongside APP_VERSION/PUBLISHED_AT in lib/legal.ts, and for
// the same reason: this is a record of *releases*, not of commits. Generating
// it from git history would list every internal refactor and every docs
// change, which is noise to the people reading this page -- they want to know
// what changed for them.
//
// Newest first. When cutting a release: add an entry here, bump APP_VERSION
// and PUBLISHED_AT in lib/legal.ts, and keep the three consistent.

export interface ChangelogEntry {
  version: string;
  date: string;
  // A one-line summary of the release's theme, shown under the heading.
  summary: string;
  added?: string[];
  changed?: string[];
  fixed?: string[];
}

export const CHANGELOG: ChangelogEntry[] = [
  {
    version: '0.7.2',
    date: '5 September 2026',
    summary: 'Groups work across every server their members share, not just the one they were made on.',
    added: [
      'A group is no longer tied to the single server it happened to be created on — it now works on any server every one of its members is currently in. Creating one narrows the people you can add as you go, so you never end up with someone who doesn’t actually share a server with the rest.',
      'An event with a minimum number of attendees can now be given a real deadline — a specific date and time for a one-off session, or a certain number of hours before each session for a recurring one — instead of only ever reacting the instant someone declines. You’ll get a heads-up a day before it decides, and for a recurring event, only the sessions that are actually short get cancelled — the rest of the series carries on.',
      'As the organizer, you now hear about it every time someone answers one of your invitations, not just at reminder time.',
      'A server you already administer now shows up on the “add the bot” page even if it’s already been added, instead of quietly disappearing from the list.',
    ],
    changed: [
      'The calendar shows your own answer on an event you’ve responded to — a declined or “maybe’d” session used to look the same as one you’d never answered.',
      'Creating an event now asks who you’re inviting before which server it’s on. The server narrows down on its own to wherever everyone you’ve picked actually overlaps, instead of you picking blind up front.',
      'An event’s own page now says which server it’s on.',
    ],
    fixed: [
      'Cancelling an event now tells the people invited to it. It used to just quietly change status with nothing said to anyone.',
      'Editing an event no longer shows everyone invited to it as “busy” for the exact time you’re editing — that busy block was always just the event itself.',
    ],
  },
  {
    version: '0.7.1',
    date: '3 September 2026',
    summary: 'Server admins can now ask to add the bot themselves, instead of asking the operator directly.',
    added: [
      'A server administrator can request the bot for their own server from Settings. If the server isn\'t already approved, the request goes to the operator to approve or reject before it can be used — the same review that used to happen over chat, now with a record of who asked and when.',
    ],
  },
  {
    version: '0.7',
    date: '2 September 2026',
    summary: 'An account that goes quiet for a year is warned, then removed.',
    added: [
      "If you haven't logged in for close to a year, you'll get a DM at two weeks and again at one week before your account and everything in it is deleted. Organizing or invited to something coming up? The deletion waits until that's no longer true, checked fresh each time.",
    ],
  },
  {
    version: '0.6.2',
    date: '1 September 2026',
    summary: 'A confirmed poll night is a real event now, and a session that loses too many people can cancel itself.',
    added: [
      'A day confirmed on a multi-winner poll is now its own event, with its own invite list, its own reminders, and its own "I\'m in / Maybe / Can\'t make it" buttons — the same as any other night. It used to be a line on the poll with a one-time "you\'re confirmed" DM and nothing after.',
      'An event can be given a minimum number of attendees. If declines drop it below that, you get a DM asking whether to cancel — or, if you\'d rather it handle itself, tick "cancel automatically" and it will, telling everyone still coming the moment it does.',
      'A poll now shows everyone\'s answer on every option, not just the ones that got enough votes to confirm — the same as a fixed-time event already shows who\'s in. Once a poll settles, an answer given since is shown alongside the original vote when the two disagree.',
    ],
    fixed: [
      'Editing an event only re-asks everyone if the session actually moves to a different day. Nudging the time by half an hour, or fixing a timezone that was wrong from the start, no longer wipes out answers that still apply.',
    ],
  },
  {
    version: '0.6.1',
    date: '1 September 2026',
    summary: 'Reminders now match what you already said, and offer only the answers that still make sense.',
    changed: [
      "Reminder DMs now depend on your own answer, not just the clock. Haven't answered yet? You get one at 96 hours out and another at 48. Said maybe? 72 hours and 24. Said you're in? Just the usual 24-hour and 1-hour heads-up. Said you can't make it, and you hear nothing more — that answer was final.",
      'Each reminder only offers the buttons that make sense from where you are. An unanswered invite still offers all three; once you’ve said maybe, the reminder only asks "in, or out?"; once you’ve said yes, it only offers "can’t make it after all."',
      "Answering a poll with your free hours, and getting a time outside them anyway, now gets a DM saying so — instead of just quietly leaving you off the confirmed list with no explanation.",
    ],
  },
  {
    version: '0.6',
    date: '31 August 2026',
    summary: 'Answering for a recurring session now answers for that session alone.',
    changed: [
      'Accepting, declining or saying maybe to a recurring event now applies to that one session, not the whole series. Say yes to this Thursday and no to the next without either answer touching the other.',
      'Because there is no honest way to know which session an old, series-wide answer meant, this release does not carry any of them forward. Everyone starts unanswered on every recurring event — including anyone who had already said they could not make it, who may be asked again for a session they thought they had settled. That is a one-time, deliberate reset rather than a bug.',
    ],
  },
  {
    version: '0.5.1',
    date: '31 August 2026',
    summary: 'The bot\u2019s messages look like messages, and stop asking questions they already answered.',
    changed: [
      'A DM that can be answered now arrives as a card rather than a wall of text \u2014 the same words, set off by a colour, with the buttons under them. Only the messages you can actually do something with get it; a plain notice stays plain.',
    ],
    fixed: [
      'A poll that has already been decided no longer invites you to vote on it. That invitation still went out if the poll settled before the DM did, and since the DM started carrying a dropdown, the only thing pressing it could say was \u201cvoting is closed\u201d \u2014 a control that existed only to refuse.',
      'Saying \u201cCan\u2019t make it\u201d on a poll that has settled now means it. The buttons on a settled poll\u2019s DM recorded your answer and showed it back on the site, but nothing that worked out who was coming ever read it: an old vote for the night outranked what you had just said, so you stayed on the list and still got the voice-channel nudge. \u201cMaybe\u201d counts the same way it does everywhere else \u2014 as not yet a yes.',
    ],
  },
  {
    version: '0.5',
    date: '26 August 2026',
    summary: 'The bot can be answered. Press a button in Discord instead of coming here.',
    added: [
      'Invitations and reminders now carry buttons. \u201cI\u2019m in\u201d, \u201cMaybe\u201d or \u201cCan\u2019t make it\u201d, answered in the DM \u2014 the message rewrites itself to show what was recorded, and that is the whole interaction. No link to follow, no page to load.',
      'A poll\u2019s invitation carries the nights themselves. Pick every one that works from a dropdown in Discord; picking none is a valid answer too. What a dropdown cannot say is \u201cmaybe\u201d, so the DM says plainly that a night you did not pick is left blank rather than refused \u2014 marking a maybe is still a job for the site.',
      'When a poll settles, the DM that asked you to vote stops asking. It becomes the confirmed time, with the RSVP buttons for the question that replaced it: not \u201cwhich night\u201d any more, but \u201care you coming\u201d.',
      'The calendar goes to any month, forwards and back, by arrows or by picking a month and year. It could only ever show this month and next before.',
    ],
    changed: [
      'The agenda is the next two weeks rather than a calendar month, so it stops at a fortnight instead of at whatever the grid happened to be showing.',
      'A window poll gets a link rather than a control. Choosing \u201cany two and a half hours in this range\u201d has no honest Discord widget \u2014 a dropdown would mangle it \u2014 so that one still opens the site.',
    ],
    fixed: [
      'A confirmed day on a multi-day poll now gets its reminders. Those days have never had a 24-hour or 1-hour reminder in the app\u2019s history: only the single-date polls set a time on the event itself, and the reminders looked at nothing else. Nobody reported it, because a notification that never arrives leaves no trace.',
      'An event on the first days of a month now appears in the previous month\u2019s calendar, in the trailing days the grid draws. It was always blank there, whatever was scheduled.',
    ],
  },
  {
    version: '0.4.6',
    date: '25 August 2026',
    summary: 'A poll can ask "any two and a half hours in these" instead of only "this or this".',
    added: [
      'A poll\u2019s options can now be windows rather than fixed times. Tick \u201cthese are windows\u201d, set a minimum session length, and each option becomes a range to find a session inside \u2014 \u201cWednesday evening, Thursday evening, or any time Saturday; two and a half hours at least\u201d is one poll.',
      'If everyone can stay longer than the minimum, the session gets longer. The minimum is a floor, not a length: five people free all Saturday afternoon get the whole afternoon, not two and a half hours of it.',
    ],
    changed: [
      'The two kinds of poll are now one. \u201cCandidate days/times\u201d and \u201ctime window\u201d were never really different \u2014 a time window was one option with a minimum \u2014 so they are one tab with a checkbox on it. Existing polls of either kind are unaffected and behave exactly as before.',
      'Invitees answer each window separately, so a poll offering three of them asks three questions instead of one.',
      'More people always beats a longer session. If four of you could play for five hours but five of you could play for two and a half, the poll picks the one with everyone in it.',
      'The \u201cit\u2019s on\u201d message for a windowed poll now says how long the session is, not just when it starts.',
      'The \u201cpotential invite (poll)\u201d tab on the new-event form is now called \u201cPotential Options\u201d, and matches the \u201cFixed Time\u201d tab beside it.',
    ],
    fixed: [
      'Dragging one end of your availability past the other used to stop the slider dead with nothing on screen saying why. It now moves the other end out of the way \u2014 drag the start from 6:00 to 6:30 on a 6:00\u20138:30 selection and the end follows to 9:00.',
    ],
  },
  {
    version: '0.4.5',
    date: '25 August 2026',
    summary: 'The calendar and the availability view stop hiding what a poll is asking.',
    added: [
      'A poll\u2019s candidate days now appear on the calendar, outlined and marked \u201cMaybe\u201d. Previously an open poll showed up once, on the day voting closed, and the nights it was actually proposing appeared nowhere \u2014 so the calendar could not tell you what you were being asked about.',
    ],
    changed: [
      'The availability view shows every option you are proposing, one strip each, instead of only the first. Each strip is scaled to its own slot, so a two-hour evening and a ten-hour Saturday are both readable.',
      'It also stops assuming the day runs 8am to 2am. Someone busy at 7am used to look free, and a slot outside those hours had nowhere to appear.',
      'The agenda marks a poll\u2019s candidate nights as \u201cMaybe\u201d too, so they no longer read as settled plans there.',
      'Each agenda entry\u2019s coloured edge now actually shows its group\u2019s colour \u2014 it had been rendering as plain grey for every group since the agenda was added.',
      'Calendar entries show the event name. They were a single line, and the time used all of it \u2014 so every entry in a month read the same and you had to hover to tell them apart. The game now shows in the tooltip too.',
    ],
  },
  {
    version: '0.4.4',
    date: '25 August 2026',
    summary: 'Changes to the Terms or Privacy Policy now ask you to agree again.',
    added: [
      'When the Terms of Service or Privacy Policy change in a way that matters, you will be signed out and asked to read and agree to them before carrying on. Until now, logging in counted as agreeing \u2014 which meant an updated policy quietly applied to people who had only ever agreed to the previous one.',
      'If you decide not to agree, you can still download everything we hold about you, or delete your account, from that same screen. You are never locked out of your own data by declining.',
    ],
    changed: [
      'Nothing changes for you today. This release only puts the mechanism in place \u2014 no one is signed out, and no one is asked to agree to anything, because the documents have not changed. It takes effect the next time they do.',
    ],
  },
  {
    version: '0.4.3',
    date: '25 August 2026',
    summary: 'Faces on the names, and groups stop being visible to the whole server.',
    changed: [
      'You now only see the groups you are actually in. Previously anyone in a server could see every group in it, and every one of those groups\u2019 members.',
      'Because of that, you can no longer invite a group you are not part of \u2014 the New Event form now offers the groups you are in. Inviting people individually is unchanged.',
      'People\u2019s Discord profile pictures now appear next to their names when you are choosing who to invite and when you are looking at a group.',
    ],
    fixed: [
      'The moisture vaporators stand on the ground again. They had come loose from it in v0.4 and were floating near the top of the screen, which was most noticeable on a short window.',
    ],
  },
  {
    version: '0.4.1',
    date: '24 August 2026',
    summary: 'The things v0.4 turned up while it was being built.',
    fixed: [
      'When something goes wrong loading a page, the app now says so. It used to show the same cheerful “nothing scheduled” as a genuinely empty calendar, whether the problem was a dropped connection, an expired session or a server fault.',
      'If the app can’t reach the server on startup, it now says that, with a Try again button. It used to send you to the login page as though you had been logged out — you hadn’t been, and a reload would have put you straight back in.',
      'If you organise an event, you can RSVP to it. “I’m in / Maybe / Can’t make it” used to do nothing at all on your own events — you were never actually on your own invite list — unless you happened to invite a group you were in.',
      'Buttons that fail now tell you why instead of appearing to do nothing. Cancelling an event, saving a group, voting on a poll and copying an invite link all used to fail silently.',
      'Saving an edit no longer closes the form and discards your work if the save is refused.',
    ],
    changed: [
      'Sessions that have already finished are faded on the month calendar, so what is still ahead stands out. Cancelled ones keep their strike-through — the two mean different things.',
      'Creating an event with a start date in the past now shows a note saying reminders won’t be sent for it. It is still allowed: logging a session that already happened is a perfectly reasonable thing to want.',
      'You appear on your own event’s invite list, marked as the organizer, with whatever answer you have given.',
    ],
  },
  {
    version: '0.4',
    date: '23 August 2026',
    summary: 'Uncle Owen looks like Tatooine, and the calendar is the whole app.',
    added: [
      'A visual identity taken from the app\u2019s own name: a binary sunset behind everything, twin suns, and the ground always at the bottom of your screen whatever size the window is.',
      'The Dashboard and the Calendar are one page now. Your month sits beside what\u2019s coming up, rather than being a separate tab you had to visit first.',
      'Switch that page between a month grid and an agenda list, whichever suits you. Phones get the agenda by default, because a month grid and a sidebar don\u2019t fit side by side on one.',
      'Settings \u2192 Scenery turns the desert down to just the twin-sun mark if the full treatment is too much \u2014 and it turns itself down automatically if your device asks for higher contrast.',
    ],
    changed: [
      'Every colour in the app moved from cold slate and indigo to warm sand and brass. Group colours were re-picked to sit on that ground and to stay properly distinct from one another.',
      'Waiting for something to load now shows the two suns rather than the word \u201cLoading\u201d.',
      'Every button, field and link now shows a clear outline when you reach it with the keyboard \u2014 previously the app relied entirely on whatever your browser drew.',
    ],
    fixed: [
      'Clicking an event on the calendar opens that event. It used to take you to the New Event form instead.',
      'The calendar grid no longer nests a link inside a button, which made each day a single ambiguous control for keyboard and screen-reader users.',
    ],
  },
  {
    version: '0.3',
    date: '22 August 2026',
    summary: 'Uncle Owen is a calendar now, not a server switcher.',
    added: [
      'Your calendar shows everything across every server at once, plus your own personal time. No more switching servers to find out what you have on.',
      'Filter the calendar to game sessions, personal time, or a single server — but "everything" is the default.',
    ],
    changed: [
      'The server switcher is gone from the top bar. A server is now a label on an event and a choice you make when creating one, not a mode the whole app sits in.',
      'Groups from every server appear on one page, each tagged with the server it belongs to.',
      "You're automatically a member of any group you create, and existing groups have been corrected. If you leave a group you own, it passes to whoever has come to the most of its sessions.",
    ],
    fixed: [
      'The owner-only user list can now tell someone who left a server from someone who was never in it, and a real login from a sign-in attempt that was turned away.',
    ],
  },
  {
    version: '0.2',
    date: '22 August 2026',
    summary: 'Invitees can ask for changes, and polls handle multi-day sessions.',
    added: [
      'Ask the organizer to move an event, or to invite someone else — without being able to change the event yourself. A move request is settled by a vote of the invitees, or by the organizer directly.',
      'A "copy invite link" button for organizers, so you can share an event in your own message instead of relying on the bot\'s DM.',
      'This changelog, and a version stamp in the footer.',
    ],
    changed: [
      'Poll candidate slots and time windows can now start and end on different days, matching how fixed-time events have always worked.',
    ],
    fixed: [
      'Availability sliders on a multi-day time window now show the date, not just the time of day.',
    ],
  },
  {
    version: '0.1',
    date: '3 August 2026',
    summary: 'The first tracked release: scheduling, polls, groups and reminders.',
    added: [
      'Fixed-time and recurring sessions, candidate-day polls, multi-winner polls where several days can each confirm, and time-window polls that find the best overlapping block.',
      'Groups, so you can invite the same set of people repeatedly, with a default game per group.',
      'A scheduling assistant showing when invitees are busy — times only, never what they are doing.',
      'Personal time blocks, private to you, that make you look busy without revealing why.',
      'Discord DMs for invites, reminders, poll results, voice-channel nudges and idle groups.',
    ],
  },
];
