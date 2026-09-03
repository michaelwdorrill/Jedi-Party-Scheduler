import { Link } from 'react-router-dom';
import { DateTime } from 'luxon';
import type { EventOccurrence } from '../types';
import { groupColor, PERSONAL_COLOR, UNGROUPED_COLOR } from '../lib/colors';

export default function EventChip({
  occurrence,
  zone,
  past = false,
  compact = false,
}: {
  occurrence: EventOccurrence;
  zone: string;
  // Whether to draw this as already over. A prop rather than something worked
  // out here, because it is a per-view decision -- see MonthCalendarGrid,
  // which is the only caller that passes it (idea 27).
  past?: boolean;
  // A month cell is a seventh of a grid; an agenda row is the width of the
  // page. Same per-view reasoning as `past`: the month grid cannot afford
  // "Maybe · 7:30 PM" on one line and truncates the time away, so there it
  // shows the qualifier that matters most for a day that might not happen.
  compact?: boolean;
}) {
  const palette = occurrence.isPersonal
    ? PERSONAL_COLOR
    : occurrence.groupId
      ? groupColor(occurrence.groupId)
      : UNGROUPED_COLOR;

  // Two states that both mean "not happening", kept apart on purpose. The
  // strike-through is what says *cancelled*; past is opacity alone. Fading a
  // cancelled event further would collapse the two into one indistinct grey,
  // so cancelled wins outright where an event is both.
  const cancelled = occurrence.status === 'cancelled';
  // A third state, and deliberately a different *kind* of mark rather than a
  // third shade (idea 41). A candidate day on an open poll is a day this
  // might happen -- so it gets its hue as a dashed outline over a faint fill
  // (`palette.pending`), which composes with "past" (a candidate day already
  // gone by is both) in a way another opacity step could not.
  const provisional = !cancelled && occurrence.isProvisional === true;
  // idea 52: the chip never said what *you* answered, for any event type --
  // only cancelled/provisional ever changed how it looked. `tentative`
  // shares provisional's dashed-outline mark rather than inventing a fourth
  // treatment, on the theory that both mean "this might not happen, from
  // where you're standing" and read the same way at a glance. `declined`
  // gets its own, heavier fade instead of hiding the chip outright -- "I'm
  // not going" is still useful to see on your own calendar (a reminder you
  // said no, not just an absence), and hiding it would make a declined
  // occurrence indistinguishable from one that was never on the calendar at
  // all. Neither state is checked once `provisional` is already true: a poll
  // candidate is voted on, not RSVP'd to, so myRsvpStatus is not meaningful
  // on one yet.
  const tentative = !cancelled && !provisional && occurrence.myRsvpStatus === 'tentative';
  const declined = !cancelled && !provisional && occurrence.myRsvpStatus === 'declined';
  const color = cancelled
    ? 'bg-raised-hi line-through opacity-60'
    : declined
      ? `${palette.bg} opacity-30`
      : provisional || tentative
        ? `${palette.pending}${past ? ' opacity-45' : ''}`
        : past
          ? `${palette.bg} opacity-45`
          : palette.bg;

  const time = occurrence.startAt
    ? DateTime.fromMillis(occurrence.startAt).setZone(zone).toFormat('h:mm a')
    : 'Poll open';
  // Said in words as well as in the outline/fade: a visual mark is a hint,
  // and each of these is too important to leave to one. Where there is no
  // room for both, the word wins over the time -- both are in the tooltip
  // and the agenda regardless.
  const qualifier = provisional
    ? compact
      ? 'Maybe'
      : `Maybe · ${time}`
    : tentative
      ? compact
        ? 'Tentative'
        : `Tentative · ${time}`
      : declined
        ? 'Declined'
        : time;

  const occurrenceDate =
    occurrence.isRecurring && occurrence.occurrenceId.includes('::')
      ? occurrence.occurrenceId.split('::')[1]
      : null;

  const to = occurrence.isPersonal
    ? `/personal/${occurrence.eventId}`
    : occurrenceDate
      ? `/events/${occurrence.eventId}?occurrence=${occurrenceDate}`
      : `/events/${occurrence.eventId}`;

  // The server goes in the tooltip rather than the chip body: on a
  // cross-guild calendar you need to be able to tell two servers' events
  // apart, but a month grid cell has no room to spend on a label that is the
  // same for most of what's in it. Colour already separates groups; this
  // answers "which server is this one?" on demand.
  // Two lines, not one. On one line the time consumed the whole width of a
  // seventh-of-a-grid cell and `truncate` ate the title entirely, so every
  // chip in a month rendered as "7:30 PM …" and the only thing telling two
  // events apart was their colour (idea 42). The title is what someone is
  // actually looking for; the time is the qualifier, so it goes above in a
  // smaller, dimmer weight and each line truncates on its own.
  return (
    <Link
      to={to}
      className={`block rounded px-1.5 py-0.5 text-xs leading-tight ${color} hover:opacity-90 focus-inset`}
      title={`${provisional ? 'Proposed: ' : tentative ? 'Tentative: ' : declined ? 'Declined: ' : ''}${occurrence.title}${occurrence.game ? ` — ${occurrence.game}` : ''}${occurrence.isPersonal ? ' (personal time)' : occurrence.guildName ? ` — ${occurrence.guildName}` : ''}`}
    >
      <span className="block truncate text-[0.65rem] opacity-75">
        {qualifier}
      </span>
      <span className="block truncate font-medium">{occurrence.title}</span>
    </Link>
  );
}
