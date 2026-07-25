import { DateTime } from 'luxon';
import type { Env } from '../env';
import type { EventRow, OverrideRow } from './events';

interface RecurrenceRuleRow {
  freq: 'DAILY' | 'WEEKLY' | 'MONTHLY';
  interval: number;
  by_weekday: string | null; // CSV, 0=Mon..6=Sun
  by_month_day: number | null;
  start_date: string; // ISO date, local to event.timezone
  start_time: string; // 'HH:MM'
  duration_minutes: number;
  end_type: 'never' | 'on_date' | 'after_count';
  end_date: string | null;
  end_count: number | null;
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

export async function expandOccurrencesForEvent(
  env: Env,
  event: EventRow,
  windowFromMs: number,
  windowToMs: number,
  overrides: OverrideRow[],
): Promise<ExpandedOccurrence[]> {
  const ruleRow = await env.DB.prepare(
    `SELECT freq, interval, by_weekday, by_month_day, start_date, start_time,
            duration_minutes, end_type, end_date, end_count
     FROM event_recurrence_rules WHERE event_id = ?`,
  )
    .bind(event.id)
    .first<RecurrenceRuleRow>();
  if (!ruleRow) return [];
  const rule: RecurrenceRuleRow = ruleRow;

  const overrideByDate = new Map(overrides.map((o) => [o.occurrence_date, o]));
  const zone = event.timezone;
  const seriesStart = DateTime.fromISO(rule.start_date, { zone });
  const windowStart = DateTime.fromMillis(windowFromMs).setZone(zone);
  const windowEnd = DateTime.fromMillis(windowToMs).setZone(zone);
  const endDate = rule.end_type === 'on_date' && rule.end_date ? DateTime.fromISO(rule.end_date, { zone }) : null;
  const endCount = rule.end_type === 'after_count' ? rule.end_count ?? Infinity : Infinity;

  const [startHour, startMinute] = rule.start_time.split(':').map(Number);
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
    const naiveEnd = naiveStart.plus({ minutes: rule.duration_minutes });
    const startAt = override?.override_start_at ?? naiveStart.toMillis();
    const endAt = override?.override_end_at ?? naiveEnd.toMillis();

    if (endAt >= windowFromMs && startAt <= windowToMs) {
      results.push({ date: dateKey, startAt, endAt });
    }
    return true;
  }

  if (rule.freq === 'DAILY') {
    const daysSinceStart = Math.max(0, Math.floor(windowStart.diff(seriesStart, 'days').days));
    let k = Math.max(0, Math.floor(daysSinceStart / interval));
    // Step back one period to be safe against partial-day rounding at the boundary.
    k = Math.max(0, k - 1);

    for (let i = 0; i < MAX_ITERATIONS; i++) {
      const candidate = seriesStart.plus({ days: k * interval });
      if (!pushIfInWindow(candidate, k)) break;
      if (candidate > windowEnd) break;
      k++;
    }
  } else if (rule.freq === 'WEEKLY') {
    const weekdays = rule.by_weekday
      ? rule.by_weekday.split(',').map(Number).sort((a, b) => a - b)
      : [seriesStart.weekday - 1]; // Luxon weekday: 1=Mon..7=Sun -> 0-indexed

    const seriesStartWeek = seriesStart.startOf('week'); // Luxon weeks start Monday
    const weeksSinceStart = Math.max(0, Math.floor(windowStart.diff(seriesStartWeek, 'weeks').weeks));
    let weekIndex = Math.max(0, Math.floor(weeksSinceStart / interval) - 1);

    let seriesIndex = weekIndex * weekdays.length; // approximate; exactness enforced via recount below
    // Recompute an accurate running series index by counting occurrences from series start
    // up to (but not including) weekIndex -- bounded because weekIndex was fast-forwarded.
    seriesIndex = 0;
    for (let w = 0; w < weekIndex; w++) {
      seriesIndex += weekdays.length;
    }

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
    const day = rule.by_month_day ?? seriesStart.day;
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
