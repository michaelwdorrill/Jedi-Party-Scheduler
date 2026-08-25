import { Link } from 'react-router-dom';
import { DateTime } from 'luxon';
import type { EventOccurrence } from '../types';
import { groupColor, PERSONAL_COLOR, UNGROUPED_COLOR } from '../lib/colors';

export default function EventChip({
  occurrence,
  zone,
  past = false,
}: {
  occurrence: EventOccurrence;
  zone: string;
  // Whether to draw this as already over. A prop rather than something worked
  // out here, because it is a per-view decision -- see MonthCalendarGrid,
  // which is the only caller that passes it (idea 27).
  past?: boolean;
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
  const color = cancelled
    ? 'bg-raised-hi line-through opacity-60'
    : past
      ? `${palette.bg} opacity-45`
      : palette.bg;

  const time = occurrence.startAt
    ? DateTime.fromMillis(occurrence.startAt).setZone(zone).toFormat('h:mm a')
    : 'Poll open';

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
      title={`${occurrence.title}${occurrence.game ? ` — ${occurrence.game}` : ''}${occurrence.isPersonal ? ' (personal time)' : occurrence.guildName ? ` — ${occurrence.guildName}` : ''}`}
    >
      <span className="block truncate text-[0.65rem] opacity-75">{time}</span>
      <span className="block truncate font-medium">{occurrence.title}</span>
    </Link>
  );
}
