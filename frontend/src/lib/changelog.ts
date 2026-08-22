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
