import { Link } from 'react-router-dom';
import { DateTime } from 'luxon';
import type { EventOccurrence } from '../types';
import { groupColor, PERSONAL_COLOR, UNGROUPED_COLOR } from '../lib/colors';
import { focusRingInset } from './ui/styles';

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
  const color = cancelled ? 'bg-raised-hi line-through opacity-60' : palette.bg;

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
  return (
    <Link
      to={to}
      className={`block truncate rounded px-1.5 py-0.5 text-xs text-white ${color} hover:opacity-90 ${focusRingInset}`}
      title={`${occurrence.title}${occurrence.isPersonal ? ' (personal time)' : occurrence.guildName ? ` — ${occurrence.guildName}` : ''}`}
    >
      <span className="font-medium">{time}</span> {occurrence.title}
    </Link>
  );
}
