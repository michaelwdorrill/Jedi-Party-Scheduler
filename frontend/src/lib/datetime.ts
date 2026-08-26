import { DateTime } from 'luxon';

// Any month, forwards or back (IDEAS item 22). This took a `0 | 1` until
// v0.5: the calendar could show this month and next and nothing else, which
// was a data limit as much as a UI one, and it quietly became load-bearing --
// specs/0014 had to decide how far ahead someone may answer for a recurring
// session, and the honest answer was "as far as the calendar goes".
export function monthWindow(monthsFromNow: number, zone: string) {
  const base = DateTime.now().setZone(zone).plus({ months: monthsFromNow });
  const start = base.startOf('month');
  const end = base.endOf('month');
  return { start, end };
}

// The month offset that lands on a given month and year — the inverse of
// `monthWindow`, so a dropdown can set the same state the arrows do rather
// than introducing a second source of truth for "which month am I looking
// at".
export function offsetForMonth(year: number, month: number, zone: string): number {
  const now = DateTime.now().setZone(zone);
  return (year - now.year) * 12 + (month - now.month);
}

// The years a picker offers. Bounded because a dropdown has to be, while the
// arrows stay unbounded — so the viewed year is always included even when it
// is outside the range, or a select would sit blank on a month its own arrows
// reached.
export const YEAR_RANGE_BACK = 3;
export const YEAR_RANGE_FORWARD = 5;

export function yearOptions(viewedYear: number, zone: string): number[] {
  const thisYear = DateTime.now().setZone(zone).year;
  const years = new Set<number>();
  for (let y = thisYear - YEAR_RANGE_BACK; y <= thisYear + YEAR_RANGE_FORWARD; y++) years.add(y);
  years.add(viewedYear);
  return [...years].sort((a, b) => a - b);
}

// The range the *grid* covers, which is not the same as the month.
// buildMonthGrid pads with leading and trailing days from the adjacent months
// so every week row is complete, and those days have to show their events like
// any other.
//
// The old two-month fetch got this wrong at one edge and nobody noticed: it
// asked for the start of this month to the end of next, so the "next month"
// grid's trailing days -- up to six days into the month after -- were always
// drawn empty, whatever was actually scheduled on them. Asking for the grid
// rather than the month removes the class of bug rather than that instance.
export function gridWindow(monthStart: DateTime) {
  const days = buildMonthGrid(monthStart);
  return { from: days[0].startOf('day'), to: days[days.length - 1].endOf('day') };
}

// How far "on the horizon" looks. The rail is anchored to now rather than to
// whatever month is on screen, so it needs its own range: paging to December
// must not empty the list of what is coming up this week.
//
// Sixty days is the Dashboard's old query, from before spec 0009 merged it
// into this page.
export const HORIZON_DAYS = 60;

export function horizonWindow(zone: string) {
  const now = DateTime.now().setZone(zone);
  return { from: now, to: now.plus({ days: HORIZON_DAYS }) };
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

// A minimum session length, said the way someone would say it: "2.5 hours",
// "90 minutes", "3 hours". Minutes are what the API stores (specs/0013's
// window_block_minutes), and "150 minutes" is not how anyone describes an
// evening.
export function formatDuration(minutes: number): string {
  if (minutes < 60) return `${minutes} minutes`;
  const hours = minutes / 60;
  const rounded = Math.round(hours * 10) / 10;
  return `${rounded} ${rounded === 1 ? 'hour' : 'hours'}`;
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

// Has this occurrence already finished? (Idea 27.)
//
// Deliberately *ended*, not *started*: a session that is running right now is
// the single most current thing on the calendar, and fading it would be
// exactly backwards. So an occurrence is past only once its end has gone by --
// and where there is no end (a poll with no resolved time), its start stands
// in, since that is all there is to judge it by.
export function hasEnded(
  occurrence: { startAt: number | null; endAt: number | null },
  now: number = Date.now(),
): boolean {
  const finish = occurrence.endAt ?? occurrence.startAt;
  return finish != null && finish <= now;
}

// Is a form's chosen start already behind us? (Idea 28.)
//
// Used for a warning, never for a block. Nothing breaks when an event is dated
// in the past -- every reminder query in the worker's cron bounds on
// `start_at >= now`, so a past event is simply never picked up: no overdue
// DMs, no stuck outbox rows. And there are good reasons to do it, from logging
// a session that already happened to fixing a mistyped year. Contrast idea 12,
// which *does* hard-block an end before its start: block the incoherent, warn
// on the merely unusual.
export function startsInPast(
  startDate: string,
  startTime: string,
  zone: string,
  now: number = Date.now(),
): boolean {
  const start = DateTime.fromISO(`${startDate}T${startTime}`, { zone });
  if (!start.isValid) return false; // incomplete input, not this guard's job
  return start.toMillis() < now;
}
