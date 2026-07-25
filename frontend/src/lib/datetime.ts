import { DateTime } from 'luxon';

export function monthWindow(monthsFromNow: 0 | 1, zone: string) {
  const base = DateTime.now().setZone(zone).plus({ months: monthsFromNow });
  const start = base.startOf('month');
  const end = base.endOf('month');
  return { start, end };
}

export function fullWindow(zone: string) {
  const thisMonth = monthWindow(0, zone);
  const nextMonth = monthWindow(1, zone);
  return { from: thisMonth.start, to: nextMonth.end };
}

// Builds a 7-column calendar grid (Mon-Sun) covering the whole month, including
// leading/trailing days from adjacent months so every week row is complete.
export function buildMonthGrid(monthStart: DateTime): DateTime[] {
  const firstOfMonth = monthStart.startOf('month');
  const lastOfMonth = monthStart.endOf('month');
  const gridStart = firstOfMonth.minus({ days: (firstOfMonth.weekday - 1) % 7 });
  const gridEnd = lastOfMonth.plus({ days: (7 - lastOfMonth.weekday) % 7 });

  const days: DateTime[] = [];
  let cursor = gridStart.startOf('day');
  while (cursor <= gridEnd) {
    days.push(cursor);
    cursor = cursor.plus({ days: 1 });
  }
  return days;
}

export function formatTimeRange(startMs: number, endMs: number, zone: string): string {
  const start = DateTime.fromMillis(startMs).setZone(zone);
  const end = DateTime.fromMillis(endMs).setZone(zone);
  return `${start.toFormat('h:mm a')} – ${end.toFormat('h:mm a ZZZZ')}`;
}
