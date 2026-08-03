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

// Builds a 7-column calendar grid (Sun-Sat) covering the whole month, including
// leading/trailing days from adjacent months so every week row is complete.
//
// Luxon's `weekday` is 1=Mon..7=Sun. `weekday % 7` remaps that to 0=Sun..6=Sat
// so the arithmetic below steps back to the preceding Sunday and forward to
// the following Saturday.
export function buildMonthGrid(monthStart: DateTime): DateTime[] {
  const firstOfMonth = monthStart.startOf('month');
  const lastOfMonth = monthStart.endOf('month');
  const gridStart = firstOfMonth.minus({ days: firstOfMonth.weekday % 7 });
  const gridEnd = lastOfMonth.plus({ days: (6 - (lastOfMonth.weekday % 7)) % 7 });

  const days: DateTime[] = [];
  let cursor = gridStart.startOf('day');
  while (cursor <= gridEnd) {
    days.push(cursor);
    cursor = cursor.plus({ days: 1 });
  }
  return days;
}

// Compares the resolved instants, not the wall-clock times, so a 7:30 PM ->
// 1:00 AM *next-day* range is valid and a 7:30 PM -> 1:00 AM *same-day* range
// is not. Equal instants are invalid, matching the server's `endAt <= startAt`
// rejection in worker/src/lib/validate.ts -- this is a UX guard that mirrors
// that check, not a replacement for it.
export function isValidRange(
  startDate: string,
  startTime: string,
  endDate: string,
  endTime: string,
  zone: string,
): boolean {
  const start = DateTime.fromISO(`${startDate}T${startTime}`, { zone });
  const end = DateTime.fromISO(`${endDate}T${endTime}`, { zone });
  if (!start.isValid || !end.isValid) return true; // incomplete input, not this guard's job
  return end > start;
}

// Always leads with the date -- a time-only range ("7:30 PM - 1:00 AM") reads
// fine for something happening today, but gives no way to tell one candidate
// poll option from another, or today's session from one three weeks out.
export function formatTimeRange(startMs: number, endMs: number, zone: string): string {
  const start = DateTime.fromMillis(startMs).setZone(zone);
  const end = DateTime.fromMillis(endMs).setZone(zone);
  const startDate = start.toFormat('ccc, LLL d');
  const startTime = start.toFormat('h:mm a');
  const endTime = end.toFormat('h:mm a ZZZZ');
  if (start.hasSame(end, 'day')) {
    return `${startDate} · ${startTime} – ${endTime}`;
  }
  // Spans midnight (or further): the end date matters too, or "1:00 AM" reads
  // as the same day it started.
  return `${startDate} ${startTime} – ${end.toFormat('ccc, LLL d')} ${endTime}`;
}
