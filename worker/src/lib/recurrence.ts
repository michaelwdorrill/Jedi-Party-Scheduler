import { DateTime } from 'luxon';
import type { Env } from '../env';
import type { EventRow, OverrideRow } from './events';

// Shape-agnostic recurrence rule. Guild events store this in
// event_recurrence_rules; personal events store the same fields inline on
// personal_events. Both feed the one expander below.
export interface RecurrenceRule {
  freq: 'DAILY' | 'WEEKLY' | 'MONTHLY';
  interval: number;
  byWeekday: string | null; // CSV, 0=Mon..6=Sun
  byMonthDay: number | null;
  startDate: string; // ISO date, local to `zone`
  startTime: string; // 'HH:MM'
  durationMinutes: number;
  endType: 'never' | 'on_date' | 'after_count';
  endDate: string | null;
  endCount: number | null;
}

export interface OccurrenceOverride {
  occurrence_date: string;
  is_cancelled: number;
  override_start_at: number | null;
  override_end_at: number | null;
}

export interface ExpandedOccurrence {
  date: string; // ISO date of this occurrence (pre-override)
  startAt: number; // unix ms, after any override applied
  endAt: number;
}

// Hard ceiling on how many candidate dates we'll walk through in one call,
// regardless of the rule -- protects Workers' bounded CPU time from a
// pathological rule (e.g. "never"-ending daily event created years ago).
const MAX_ITERATIONS = 3000;

// Pure: expands a recurrence rule into concrete occurrences overlapping
// [windowFromMs, windowToMs]. No DB access, so it's equally usable for guild
// events, personal events, and unit-style checks.
export function expandOccurrences(
  rule: RecurrenceRule,
  zone: string,
  windowFromMs: number,
  windowToMs: number,
  overrides: OccurrenceOverride[],
): ExpandedOccurrence[] {
  const overrideByDate = new Map(overrides.map((o) => [o.occurrence_date, o]));
  const seriesStart = DateTime.fromISO(rule.startDate, { zone });
  const windowStart = DateTime.fromMillis(windowFromMs).setZone(zone);
  const windowEnd = DateTime.fromMillis(windowToMs).setZone(zone);
  const endDate = rule.endType === 'on_date' && rule.endDate ? DateTime.fromISO(rule.endDate, { zone }) : null;
  const endCount = rule.endType === 'after_count' ? rule.endCount ?? Infinity : Infinity;

  const [startHour, startMinute] = rule.startTime.split(':').map(Number);
  const interval = Math.max(1, rule.interval);

  const results: ExpandedOccurrence[] = [];

  function withinSeriesEnd(candidate: DateTime, seriesIndex: number): boolean {
    if (endDate && candidate > endDate) return false;
    if (seriesIndex >= endCount) return false;
    return true;
  }

  function pushIfInWindow(candidateDate: DateTime, seriesIndex: number): boolean {
    if (!withinSeriesEnd(candidateDate, seriesIndex)) return false;
    if (candidateDate < seriesStart) return true; // keep iterating, not yet at start
    if (candidateDate > windowEnd) return false; // signal caller to stop

    const dateKey = candidateDate.toISODate()!;
    const override = overrideByDate.get(dateKey);
    if (override?.is_cancelled) return true;

    const naiveStart = candidateDate.set({ hour: startHour, minute: startMinute, second: 0, millisecond: 0 });
    const naiveEnd = naiveStart.plus({ minutes: rule.durationMinutes });
    const startAt = override?.override_start_at ?? naiveStart.toMillis();
    const endAt = override?.override_end_at ?? naiveEnd.toMillis();

    if (endAt >= windowFromMs && startAt <= windowToMs) {
      results.push({ date: dateKey, startAt, endAt });
    }
    return true;
  }

  if (rule.freq === 'DAILY') {
    const daysSinceStart = Math.max(0, Math.floor(windowStart.diff(seriesStart, 'days').days));
    // Step back one period to be safe against partial-day rounding at the boundary.
    let k = Math.max(0, Math.floor(daysSinceStart / interval) - 1);

    for (let i = 0; i < MAX_ITERATIONS; i++) {
      const candidate = seriesStart.plus({ days: k * interval });
      if (!pushIfInWindow(candidate, k)) break;
      if (candidate > windowEnd) break;
      k++;
    }
  } else if (rule.freq === 'WEEKLY') {
    // Write-time validation (see validate.ts) is supposed to keep this to at
    // most 7 unique 0-6 values, but this expander is the actual place CPU
    // gets spent -- the inner loop below runs once per entry, per outer
    // iteration, so an unvalidated/legacy row with thousands of duplicate
    // entries would multiply MAX_ITERATIONS by that count. Dedupe, filter to
    // the valid domain, and cap here too as the real defense.
    const parsed = rule.byWeekday
      ? [...new Set(rule.byWeekday.split(',').map(Number))]
          .filter((n) => Number.isInteger(n) && n >= 0 && n <= 6)
          .slice(0, 7)
      : [];
    const weekdays = (parsed.length > 0 ? parsed : [seriesStart.weekday - 1]).sort((a, b) => a - b); // Luxon weekday: 1=Mon..7=Sun -> 0-indexed

    const seriesStartWeek = seriesStart.startOf('week'); // Luxon weeks start Monday
    const weeksSinceStart = Math.max(0, Math.floor(windowStart.diff(seriesStartWeek, 'weeks').weeks));
    let weekIndex = Math.max(0, Math.floor(weeksSinceStart / interval) - 1);

    // Occurrences elapsed before the week we fast-forwarded to, so `end_count`
    // is measured against the true series position rather than the window.
    let seriesIndex = weekIndex * weekdays.length;

    outer: for (let i = 0; i < MAX_ITERATIONS; i++) {
      const weekStart = seriesStartWeek.plus({ weeks: weekIndex * interval });
      for (const wd of weekdays) {
        const candidate = weekStart.plus({ days: wd });
        if (candidate < seriesStart) {
          continue; // before the series' own start date -- not a real occurrence
        }
        if (!pushIfInWindow(candidate, seriesIndex)) break outer;
        seriesIndex++;
        if (candidate > windowEnd) break outer;
      }
      weekIndex++;
    }
  } else {
    // MONTHLY
    const day = rule.byMonthDay ?? seriesStart.day;
    const seriesStartMonth = seriesStart.startOf('month');
    const monthsSinceStart = Math.max(0, Math.floor(windowStart.diff(seriesStartMonth, 'months').months));
    let monthIndex = Math.max(0, Math.floor(monthsSinceStart / interval) - 1);

    for (let i = 0; i < MAX_ITERATIONS; i++) {
      const monthStart = seriesStartMonth.plus({ months: monthIndex * interval });
      if (day <= (monthStart.daysInMonth ?? 0)) {
        const candidate = monthStart.set({ day });
        if (!pushIfInWindow(candidate, monthIndex)) break;
        if (candidate > windowEnd) break;
      } else if (monthStart > windowEnd) {
        break;
      }
      monthIndex++;
    }
  }

  return results;
}

// Loads a guild event's rule from event_recurrence_rules and expands it.
export async function expandOccurrencesForEvent(
  env: Env,
  event: EventRow,
  windowFromMs: number,
  windowToMs: number,
  overrides: OverrideRow[],
): Promise<ExpandedOccurrence[]> {
  const row = await env.DB.prepare(
    `SELECT freq, interval, by_weekday, by_month_day, start_date, start_time,
            duration_minutes, end_type, end_date, end_count
     FROM event_recurrence_rules WHERE event_id = ?`,
  )
    .bind(event.id)
    .first<{
      freq: 'DAILY' | 'WEEKLY' | 'MONTHLY';
      interval: number;
      by_weekday: string | null;
      by_month_day: number | null;
      start_date: string;
      start_time: string;
      duration_minutes: number;
      end_type: 'never' | 'on_date' | 'after_count';
      end_date: string | null;
      end_count: number | null;
    }>();
  if (!row) return [];

  return expandOccurrences(
    {
      freq: row.freq,
      interval: row.interval,
      byWeekday: row.by_weekday,
      byMonthDay: row.by_month_day,
      startDate: row.start_date,
      startTime: row.start_time,
      durationMinutes: row.duration_minutes,
      endType: row.end_type,
      endDate: row.end_date,
      endCount: row.end_count,
    },
    event.timezone,
    windowFromMs,
    windowToMs,
    overrides,
  );
}
