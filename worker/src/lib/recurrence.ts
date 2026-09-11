import { DateTime } from 'luxon';
import type { Env } from '../env';
import { chunkIds, placeholders } from './d1';
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

const MINUTES_PER_DAY = 24 * 60;

// How many whole periods the fast-forward has to step back before the window
// so that every occurrence still overlapping it is actually generated.
//
// Pass-12 review (P12-14). This used to be the literal 1 in each arm, with the
// comment "step back one period to be safe against partial-day rounding at the
// boundary" -- slack measured in intervals, with no reference to how long an
// occurrence lasts. An occurrence longer than one interval therefore begins
// before the step-back point, is never generated at all, and so is never
// tested for overlap: a seven-day daily occurrence starting 1 September was
// returned by a 1-8 September query and vanished from a 5-6 September one.
//
// That is worse than a missing row. The narrower window is a subset of one
// that returned it, so the calendar and the free/busy assistant report a
// genuinely occupied interval as free, and the more precise the question the
// likelier they are to. MAX_EVENT_DURATION_MS allows a year, so this is well
// inside what the app accepts rather than a pathological input.
//
// One period of the original rounding slack, plus however many periods the
// duration itself spans. MAX_ITERATIONS still bounds the walk.
//
// What this does not cover -- and what Pass 12 wrongly described as a narrower
// separate problem -- is an override that MOVES an occurrence away from its
// nominal date. No lookback can, in either direction: the move is unbounded
// and unrelated to the rule. That is handled after the walk instead, by the
// override pass at the end of expandOccurrences (P13-14 / F-34).
function lookbackPeriods(rule: RecurrenceRule, periodMinutes: number): number {
  return 1 + Math.ceil(Math.max(0, rule.durationMinutes) / Math.max(1, periodMinutes));
}

// Is `dateKey` a date this rule actually produces?
//
// Pass-14 review (P14-13 / F-39). The override pass below used to accept any
// override whose date sat between seriesStart and endDate, which is not the
// same question: it says nothing about interval, weekday, month-day or
// end_count. A stored override outside the pattern was therefore emitted as a
// real occurrence -- reachable by ordinary use, because a rule edit rewrites
// event_recurrence_rules and never touches event_occurrence_overrides, so
// changing a Monday series to Tuesdays or shortening its count orphans every
// override keyed to a date the new rule does not produce.
//
// Answered by running the walk itself over a one-day window with NO overrides
// rather than by re-deriving the pattern arithmetically. That is deliberate:
// the walk is the one definition of series membership in this codebase, it
// already handles end_count through its occurrence index -- which arithmetic
// on the date alone cannot -- and a second implementation would be a second
// thing to keep in agreement. It is also what routes/events.ts's RSVP path
// already does to validate an occurrence date.
//
// No recursion hazard: the inner call passes an empty override list, so its
// own override pass iterates nothing.
export function isSeriesOccurrence(rule: RecurrenceRule, zone: string, dateKey: string): boolean {
  const day = DateTime.fromISO(dateKey, { zone });
  if (!day.isValid) return false;
  const nominal = expandOccurrences(rule, zone, day.startOf('day').toMillis(), day.endOf('day').toMillis(), []);
  return nominal.some((o) => o.date === dateKey);
}

// Pure: expands a recurrence rule into concrete occurrences overlapping
// [windowFromMs, windowToMs]. No DB access, so it's equally usable for guild
// events, personal events, and unit-style checks.
//
// Output is ordered by effective start time (Pass-14 review, P14-15 / F-38).
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
    let k = Math.max(0, Math.floor(daysSinceStart / interval) - lookbackPeriods(rule, interval * MINUTES_PER_DAY));

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
    let weekIndex = Math.max(
      0,
      Math.floor(weeksSinceStart / interval) - lookbackPeriods(rule, interval * 7 * MINUTES_PER_DAY),
    );

    // Occurrences elapsed before the week we fast-forwarded to, so `end_count`
    // is measured against the true series position rather than the window.
    //
    // Pass-11 review (R22): the first week is partial whenever the series
    // starts on anything but its earliest selected weekday, and those earlier
    // slots are not occurrences -- the loop below skips them with `continue`
    // without counting them. The fast-forward has to skip them too, or every
    // occurrence after the first week is numbered one too high per missed
    // slot, and an `after_count` series ends early. Worse, it ended early by a
    // different amount depending on how far the fast-forward jumped, so the
    // same series expanded over two overlapping windows disagreed about which
    // dates exist -- a whole-month view showing an occurrence that vanished
    // when the range was narrowed.
    const slotsBeforeSeriesStart = weekdays.filter(
      (wd) => seriesStartWeek.plus({ days: wd }) < seriesStart,
    ).length;
    let seriesIndex = weekIndex === 0 ? 0 : weekIndex * weekdays.length - slotsBeforeSeriesStart;

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
    // 28 days is the shortest month, so pricing a period at 28 days can only
    // ever step back further than needed, never less far.
    let monthIndex = Math.max(
      0,
      Math.floor(monthsSinceStart / interval) - lookbackPeriods(rule, interval * 28 * MINUTES_PER_DAY),
    );

    // Pass-11 review (R22): months are not occurrences. A rule on day 31 has
    // no occurrence in February, April, June, September or November, but the
    // old code passed `monthIndex` straight to the end_count check -- so those
    // empty months were counted as though they had produced something and an
    // `after_count` series stopped early. "The 31st of every month, three
    // times" starting 31 January yielded 31 January and 31 March and then
    // gave up, because by May the month counter already read 4.
    //
    // Counted here rather than derived, for the months the fast-forward
    // skipped over: only day 29-31 rules can miss a month at all, so for
    // everything else this is exactly monthIndex, and the loop runs at most
    // once per month the series has existed.
    // Pass-12 review (P12-13): `candidate >= seriesStart` here and in the loop
    // below. R22 taught this arm that an empty month is not an occurrence; the
    // remaining case is a month whose day falls *before the series' own start
    // date*, which only the start month can produce and only when byMonthDay
    // precedes the day the series begins on.
    //
    // pushIfInWindow already refuses to emit such a candidate -- it returns
    // early for anything before seriesStart -- but the loop counted it anyway,
    // so it consumed one of the occurrences an after_count series is allowed.
    // "The 1st of the month, three times" starting 15 January produced
    // 1 February and 1 March and then stopped, because 1 January had already
    // spent the third. The WEEKLY arm has always skipped these with a
    // `continue` that does not count; this is the same rule.
    //
    // Only reachable through the API directly: the form sets byMonthDay from
    // the start date, so the two always agree there.
    let occurrenceIndex = 0;
    for (let m = 0; m < monthIndex; m++) {
      const monthStart = seriesStartMonth.plus({ months: m * interval });
      if (day > (monthStart.daysInMonth ?? 0)) continue;
      if (monthStart.set({ day }) < seriesStart) continue;
      occurrenceIndex++;
    }

    for (let i = 0; i < MAX_ITERATIONS; i++) {
      const monthStart = seriesStartMonth.plus({ months: monthIndex * interval });
      if (day <= (monthStart.daysInMonth ?? 0)) {
        const candidate = monthStart.set({ day });
        if (candidate >= seriesStart) {
          if (!pushIfInWindow(candidate, occurrenceIndex)) break;
          occurrenceIndex++;
          if (candidate > windowEnd) break;
        }
      } else if (monthStart > windowEnd) {
        break;
      }
      monthIndex++;
    }
  }

  // Pass-13 review (P13-14 / F-34). A second, window-driven pass over the
  // overrides, because the walk above is driven by NOMINAL dates and an
  // override can move an occurrence arbitrarily far from its own.
  //
  // P12-14 widened the fast-forward so a LONG occurrence starting before the
  // window is still generated. That was the smaller half. The general problem
  // is that a moved occurrence is only ever considered if the walk happens to
  // reach its original date -- and pushIfInWindow returns `false` (stop) for a
  // candidate past windowEnd *before* it looks the override up, so the forward
  // walk cannot reach a rule date beyond the window whose override pulls the
  // occurrence back into it. Both directions, any distance: an accepted
  // time_change validates only that the proposed time is a sane future range,
  // so moving next Monday's game three weeks out is an ordinary use of the
  // feature and three weeks is far outside any lookback.
  //
  // Everything downstream reads this function -- the reminder sweeps,
  // free/busy, the calendar, the noticeboard, the Google push -- so a moved
  // night got no reminder, showed its people as free, and was missing from the
  // calendar for any window that did not span its original date.
  //
  // Cheap, because loadOverridesForEvents already hands over every override
  // for the event: no query, no dependence on the window, and the walk above
  // stays as the fast path for the ordinary case. Emitted only for overrides
  // the walk did not already produce, so a moved occurrence appears once.
  const emitted = new Set(results.map((r) => r.date));
  for (const override of overrides) {
    if (override.is_cancelled) continue;
    if (override.override_start_at == null || override.override_end_at == null) continue;
    if (emitted.has(override.occurrence_date)) continue;
    if (override.override_end_at < windowFromMs || override.override_start_at > windowToMs) continue;

    // Still has to be an occurrence of this series. The first version of this
    // checked only seriesStart and endDate, which let an override orphaned by
    // a rule edit -- a changed weekday, a shortened count -- come back as a
    // live occurrence (P14-13 / F-39). isSeriesOccurrence asks the walk.
    if (!isSeriesOccurrence(rule, zone, override.occurrence_date)) continue;

    results.push({
      date: override.occurrence_date,
      startAt: override.override_start_at,
      endAt: override.override_end_at,
    });
  }

  // Pass-14 review (P14-15 / F-38). Sorted by effective start, because
  // nothing else in this function is.
  //
  // pushIfInWindow emits at the RULE's position carrying the OVERRIDE's
  // times, so a moved occurrence was already out of order before the override
  // pass existed; that pass then appends the far-moved ones at the very end.
  // Three callers take results[0] as "the next occurrence" -- the date the
  // new-invite DM announces, the ladder's activeOccurrence (whose comment
  // asserts that checking [0] is sufficient, true only if sorted), and event
  // detail's next occurrence. So pulling an occurrence earlier, the case the
  // override pass was written to make visible, left the reminder ladder
  // firing for the wrong slot and the detail page naming the wrong night.
  //
  // Safe after the dedupe rather than before it: the dedupe is keyed by date,
  // and nothing downstream consumes rule order -- freeBusy and noticeboard
  // sort their own output already.
  results.sort((a, b) => a.startAt - b.startAt || a.date.localeCompare(b.date));

  return results;
}

interface RecurrenceRuleRow {
  event_id: string;
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
}

function mapRuleRow(row: RecurrenceRuleRow): RecurrenceRule {
  return {
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
  };
}

// Bulk-loads recurrence rules for many events in one chunked pass, so a
// caller expanding a whole page of recurring events (the guild calendar,
// free/busy, a cron page) issues a handful of queries instead of one per
// event -- that per-event query was the single largest contributor to a
// valid, in-quota calendar request crossing D1's per-invocation query limit.
export async function loadRecurrenceRulesForEvents(
  env: Env,
  eventIds: string[],
): Promise<Map<string, RecurrenceRule>> {
  const map = new Map<string, RecurrenceRule>();
  for (const chunk of chunkIds(eventIds)) {
    const { results } = await env.DB.prepare(
      `SELECT event_id, freq, interval, by_weekday, by_month_day, start_date, start_time,
              duration_minutes, end_type, end_date, end_count
       FROM event_recurrence_rules WHERE event_id IN (${placeholders(chunk.length)})`,
    )
      .bind(...chunk)
      .all<RecurrenceRuleRow>();
    for (const row of results) map.set(row.event_id, mapRuleRow(row));
  }
  return map;
}

// Expands a guild event's occurrences. Pass `preloadedRule` (from
// loadRecurrenceRulesForEvents) whenever expanding more than one event in the
// same request -- omitting it falls back to a per-event query, which is fine
// for the handful of call sites that only ever handle one event at a time
// (e.g. validating a single occurrence-cancel request) but must not be used
// in a loop over a whole event list.
export async function expandOccurrencesForEvent(
  env: Env,
  event: EventRow,
  windowFromMs: number,
  windowToMs: number,
  overrides: OverrideRow[],
  preloadedRule?: RecurrenceRule,
): Promise<ExpandedOccurrence[]> {
  const rule =
    preloadedRule ??
    (await env.DB.prepare(
      `SELECT event_id, freq, interval, by_weekday, by_month_day, start_date, start_time,
              duration_minutes, end_type, end_date, end_count
       FROM event_recurrence_rules WHERE event_id = ?`,
    )
      .bind(event.id)
      .first<RecurrenceRuleRow>()
      .then((row) => (row ? mapRuleRow(row) : null)));
  if (!rule) return [];

  return expandOccurrences(rule, event.timezone, windowFromMs, windowToMs, overrides);
}
