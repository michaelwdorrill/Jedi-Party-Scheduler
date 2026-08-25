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
