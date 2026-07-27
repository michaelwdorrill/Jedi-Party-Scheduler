import { Link } from 'react-router-dom';
import { DateTime } from 'luxon';
import type { EventOccurrence } from '../types';
import { groupColor, PERSONAL_COLOR, UNGROUPED_COLOR } from '../lib/colors';

export default function EventChip({
  occurrence,
  zone,
}: {
  occurrence: EventOccurrence;
  zone: string;
}) {
  const palette = occurrence.isPersonal
    ? PERSONAL_COLOR
    : occurrence.groupId
      ? groupColor(occurrence.groupId)
      : UNGROUPED_COLOR;

  const cancelled = occurrence.status === 'cancelled';
  const color = cancelled ? 'bg-slate-700 line-through opacity-60' : palette.bg;

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

  return (
    <Link
      to={to}
      className={`block truncate rounded px-1.5 py-0.5 text-xs text-white ${color} hover:opacity-90`}
      title={`${occurrence.title}${occurrence.isPersonal ? ' (personal)' : ''}`}
    >
      <span className="font-medium">{time}</span> {occurrence.title}
    </Link>
  );
}
