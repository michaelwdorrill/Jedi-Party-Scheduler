import type { Env } from '../env';
import { chunkIds, placeholders } from './d1';
import { expandOccurrences, type ExpandedOccurrence, type OccurrenceOverride } from './recurrence';

export interface PersonalEventRow {
  id: string;
  user_id: string;
  title: string;
  description: string | null;
  timezone: string;
  start_at: number | null;
  end_at: number | null;
  status: 'active' | 'cancelled';
  // 'busy' blocks the free/busy view; 'considering' explicitly does not --
  // it means "not committed, could still play" -- and 'free' is a personal
  // note that never affects availability at all.
  availability: 'busy' | 'considering' | 'free';
  is_recurring: number;
  freq: 'DAILY' | 'WEEKLY' | 'MONTHLY' | null;
  interval: number | null;
  by_weekday: string | null;
  by_month_day: number | null;
  rule_start_date: string | null;
  rule_start_time: string | null;
  duration_minutes: number | null;
  end_type: 'never' | 'on_date' | 'after_count' | null;
  rule_end_date: string | null;
  end_count: number | null;
  created_at: number;
  updated_at: number;
}

export function mapPersonalEvent(row: PersonalEventRow) {
  return {
    id: row.id,
    userId: row.user_id,
    title: row.title,
    description: row.description,
    timezone: row.timezone,
    startAt: row.start_at,
    endAt: row.end_at,
    status: row.status,
    availability: row.availability,
    isRecurring: !!row.is_recurring,
    recurrence: row.is_recurring
      ? {
          freq: row.freq,
          interval: row.interval,
          byWeekday: row.by_weekday ? row.by_weekday.split(',').map(Number) : null,
          byMonthDay: row.by_month_day,
          startDate: row.rule_start_date,
          startTime: row.rule_start_time,
          durationMinutes: row.duration_minutes,
          endType: row.end_type,
          endDate: row.rule_end_date,
          endCount: row.end_count,
        }
      : null,
  };
}

async function loadOverrides(env: Env, personalEventIds: string[]): Promise<Map<string, OccurrenceOverride[]>> {
  const map = new Map<string, OccurrenceOverride[]>();
  // Chunked for the same reason as the guild-event helpers: a user is allowed
  // up to MAX_PERSONAL_EVENTS_PER_USER of these, far past D1's per-statement
  // bound-parameter ceiling.
  for (const chunk of chunkIds(personalEventIds)) {
    const { results } = await env.DB.prepare(
      `SELECT personal_event_id, occurrence_date, is_cancelled, override_start_at, override_end_at
       FROM personal_event_overrides WHERE personal_event_id IN (${placeholders(chunk.length)})`,
    )
      .bind(...chunk)
      .all<OccurrenceOverride & { personal_event_id: string }>();
    for (const row of results) {
      if (!map.has(row.personal_event_id)) map.set(row.personal_event_id, []);
      map.get(row.personal_event_id)!.push(row);
    }
  }
  return map;
}

export interface PersonalOccurrence extends ExpandedOccurrence {
  event: PersonalEventRow;
  occurrenceId: string;
}

// Expands every active personal event for `userId` into concrete occurrences
// overlapping the window -- one-off events pass through, recurring ones go
// through the shared recurrence expander.
export async function expandPersonalOccurrences(
  env: Env,
  userId: string,
  fromMs: number,
  toMs: number,
): Promise<PersonalOccurrence[]> {
  const { results: events } = await env.DB.prepare(
    `SELECT * FROM personal_events WHERE user_id = ? AND status = 'active'`,
  )
    .bind(userId)
    .all<PersonalEventRow>();
  if (events.length === 0) return [];

  const overridesById = await loadOverrides(env, events.map((e) => e.id));
  const out: PersonalOccurrence[] = [];

  for (const event of events) {
    if (!event.is_recurring) {
      if (event.start_at != null && event.start_at <= toMs && (event.end_at ?? event.start_at) >= fromMs) {
        out.push({
          event,
          occurrenceId: event.id,
          date: new Date(event.start_at).toISOString().slice(0, 10),
          startAt: event.start_at,
          endAt: event.end_at ?? event.start_at,
        });
      }
      continue;
    }

    if (!event.freq || !event.rule_start_date || !event.rule_start_time || event.duration_minutes == null) continue;

    const expanded = expandOccurrences(
      {
        freq: event.freq,
        interval: event.interval ?? 1,
        byWeekday: event.by_weekday,
        byMonthDay: event.by_month_day,
        startDate: event.rule_start_date,
        startTime: event.rule_start_time,
        durationMinutes: event.duration_minutes,
        endType: event.end_type ?? 'never',
        endDate: event.rule_end_date,
        endCount: event.end_count,
      },
      event.timezone,
      fromMs,
      toMs,
      overridesById.get(event.id) ?? [],
    );
    for (const occ of expanded) {
      out.push({ event, occurrenceId: `${event.id}::${occ.date}`, ...occ });
    }
  }

  return out;
}
