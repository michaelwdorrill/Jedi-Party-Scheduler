import { DateTime } from 'luxon';
import { buildMonthGrid } from '../lib/datetime';
import type { EventOccurrence } from '../types';
import EventChip from './EventChip';

const WEEKDAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export default function MonthCalendarGrid({
  monthStart,
  occurrences,
  zone,
  onDayClick,
}: {
  monthStart: DateTime;
  occurrences: EventOccurrence[];
  zone: string;
  onDayClick?: (day: DateTime) => void;
}) {
  const days = buildMonthGrid(monthStart);
  const today = DateTime.now().setZone(zone).startOf('day');

  const byDay = new Map<string, EventOccurrence[]>();
  for (const occ of occurrences) {
    if (occ.startAt == null) continue;
    const key = DateTime.fromMillis(occ.startAt).setZone(zone).toISODate()!;
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key)!.push(occ);
  }

  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900 p-3">
      <div className="mb-2 text-center font-semibold">{monthStart.toFormat('MMMM yyyy')}</div>
      <div className="grid grid-cols-7 gap-1 text-xs text-slate-500">
        {WEEKDAY_LABELS.map((d) => (
          <div key={d} className="p-1 text-center">
            {d}
          </div>
        ))}
      </div>
      <div className="grid grid-cols-7 gap-1">
        {days.map((day) => {
          const key = day.toISODate()!;
          const inMonth = day.hasSame(monthStart, 'month');
          const isToday = day.equals(today);
          const dayEvents = (byDay.get(key) ?? []).sort((a, b) => (a.startAt! - b.startAt!));

          return (
            <button
              key={key}
              onClick={() => onDayClick?.(day)}
              className={`min-h-20 rounded border p-1 text-left align-top text-xs ${
                inMonth ? 'border-slate-800' : 'border-slate-900 opacity-40'
              } ${isToday ? 'ring-1 ring-indigo-500' : ''} hover:bg-slate-800`}
            >
              <div className="mb-1 text-right text-slate-400">{day.day}</div>
              <div className="space-y-0.5">
                {dayEvents.slice(0, 3).map((occ) => (
                  <EventChip key={occ.occurrenceId} occurrence={occ} zone={zone} />
                ))}
                {dayEvents.length > 3 && (
                  <div className="text-slate-500">+{dayEvents.length - 3} more</div>
                )}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
