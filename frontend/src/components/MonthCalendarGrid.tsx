import { DateTime } from 'luxon';
import { buildMonthGrid } from '../lib/datetime';
import type { EventOccurrence } from '../types';
import EventChip from './EventChip';
import { focusRing } from './ui/styles';
import { cardClass } from './ui';

const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

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

  // An occurrence lands on every day it overlaps, not just its start day, so
  // overnight sessions and multi-day blocks (travel, holidays) show across the
  // whole span. Iteration is clamped to the visible grid so a very long block
  // can't spin here.
  const gridStart = days[0];
  const gridEnd = days[days.length - 1];
  const byDay = new Map<string, EventOccurrence[]>();
  for (const occ of occurrences) {
    if (occ.startAt == null) continue;
    const start = DateTime.fromMillis(occ.startAt).setZone(zone).startOf('day');
    const end = DateTime.fromMillis(occ.endAt ?? occ.startAt).setZone(zone).startOf('day');
    let cursor = start < gridStart ? gridStart : start;
    const last = end > gridEnd ? gridEnd : end;
    while (cursor <= last) {
      const key = cursor.toISODate()!;
      if (!byDay.has(key)) byDay.set(key, []);
      byDay.get(key)!.push(occ);
      cursor = cursor.plus({ days: 1 });
    }
  }

  return (
    <div className={cardClass('sm')}>
      <div className="mb-2 text-center font-semibold">{monthStart.toFormat('MMMM yyyy')}</div>
      <div className="grid grid-cols-7 gap-1 text-xs text-faint">
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
          // ring-accent-hover, not ring-accent: today's ring was indigo-500 while
          // buttons were indigo-600, and this branch preserves that difference
          // rather than quietly closing it. 0009 unifies them on --tatoo-i.
          const dayEvents = (byDay.get(key) ?? []).sort((a, b) => (a.startAt! - b.startAt!));

          // The cell is a container, not a control. It used to be a <button>
          // with the day's EventChips -- which render <Link>, i.e. <a> --
          // nested inside it: invalid HTML, one ambiguous control for keyboard
          // and screen-reader users, and a live bug, because a click on a chip
          // bubbled to the cell's handler and navigated to the New Event form
          // instead of opening the event.
          //
          // The date itself carries "new event on this day" now. It is already
          // on screen, so nothing is added to a dense grid, and there is
          // exactly one control per interactive thing.
          return (
            <div
              key={key}
              className={`min-h-20 rounded border p-1 text-left align-top text-xs ${
                inMonth ? 'border-edge' : 'border-surface opacity-40'
              } ${isToday ? 'ring-1 ring-accent-hover' : ''}`}
            >
              <div className="mb-1 text-right">
                {onDayClick ? (
                  <button
                    type="button"
                    onClick={() => onDayClick(day)}
                    aria-label={`New event on ${day.toFormat('cccc d LLLL yyyy')}`}
                    className={`rounded px-1 hover:bg-raised hover:text-ink ${focusRing} ${
                      isToday ? 'font-semibold text-accent-text' : 'text-muted'
                    }`}
                  >
                    {day.day}
                  </button>
                ) : (
                  <span className={isToday ? 'font-semibold text-accent-text' : 'text-muted'}>
                    {day.day}
                  </span>
                )}
              </div>
              <div className="space-y-0.5">
                {dayEvents.slice(0, 3).map((occ) => (
                  <EventChip key={occ.occurrenceId} occurrence={occ} zone={zone} />
                ))}
                {dayEvents.length > 3 && (
                  <div className="text-faint">+{dayEvents.length - 3} more</div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
