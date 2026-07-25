import { Link } from 'react-router-dom';
import { DateTime } from 'luxon';
import type { EventOccurrence } from '../types';

const statusColor: Record<string, string> = {
  active: 'bg-indigo-600',
  resolved: 'bg-emerald-600',
  cancelled: 'bg-slate-600 line-through opacity-60',
};

export default function EventChip({
  occurrence,
  zone,
}: {
  occurrence: EventOccurrence;
  zone: string;
}) {
  const color = statusColor[occurrence.status] ?? 'bg-indigo-600';
  const time = occurrence.startAt
    ? DateTime.fromMillis(occurrence.startAt).setZone(zone).toFormat('h:mm a')
    : 'Poll open';

  const occurrenceDate =
    occurrence.isRecurring && occurrence.occurrenceId.includes('::')
      ? occurrence.occurrenceId.split('::')[1]
      : null;
  const to = occurrenceDate
    ? `/events/${occurrence.eventId}?occurrence=${occurrenceDate}`
    : `/events/${occurrence.eventId}`;

  return (
    <Link
      to={to}
      className={`block truncate rounded px-1.5 py-0.5 text-xs text-white ${color} hover:opacity-90`}
      title={occurrence.title}
    >
      <span className="font-medium">{time}</span> {occurrence.title}
    </Link>
  );
}
