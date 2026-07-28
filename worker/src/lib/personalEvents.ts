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

// Pure: expands one already-loaded row. No DB access, so both the
// single-user and bulk multi-user paths below share this rather than
// duplicating the recurring/non-recurring branching.
function expandPersonalEventRow(
  event: PersonalEventRow,
  fromMs: number,
  toMs: number,
  overrides: OccurrenceOverride[],
): PersonalOccurrence[] {
  if (!event.is_recurring) {
    if (event.start_at != null && event.start_at <= toMs && (event.end_at ?? event.start_at) >= fromMs) {
      return [
        {
          event,
          occurrenceId: event.id,
          date: new Date(event.start_at).toISOString().slice(0, 10),
          startAt: event.start_at,
          endAt: event.end_at ?? event.start_at,
        },
      ];
    }
    return [];
  }

  if (!event.freq || !event.rule_start_date || !event.rule_start_time || event.duration_minutes == null) return [];

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
    overrides,
  );
  return expanded.map((occ) => ({ event, occurrenceId: `${event.id}::${occ.date}`, ...occ }));
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
    out.push(...expandPersonalEventRow(event, fromMs, toMs, overridesById.get(event.id) ?? []));
  }
  return out;
}

// Same expansion, but for many users in one pass -- used by the free/busy
// scheduling assistant, which previously ran expandPersonalOccurrences()
// (one events query + one chunked overrides query) once per requested user.
// Personal events store their recurrence rule inline on the row itself (no
// separate rules table), so unlike guild events there was never a per-event
// recurrence query here -- only the per-user *event list* query needed
// bulking, which this does with one chunked IN query for the whole request.
export interface BulkPersonalOptions {
  // Restrict to one availability class. Free/busy only ever uses 'busy', and
  // pushing that into SQL rather than filtering after expansion is the
  // difference between loading a user's genuinely blocking commitments and
  // loading (and expanding) every personal note they've ever written.
  availability?: PersonalEventRow['availability'];
  // Hard ceiling on expanded occurrences across all users, so a set of
  // individually-legal recurring rules can't multiply into unbounded work.
  maxOccurrences?: number;
}

export async function expandPersonalOccurrencesForUsers(
  env: Env,
  userIds: string[],
  fromMs: number,
  toMs: number,
  options: BulkPersonalOptions = {},
): Promise<Map<string, PersonalOccurrence[]>> {
  const out = new Map<string, PersonalOccurrence[]>();
  if (userIds.length === 0) return out;

  // Both filters below are in SQL rather than applied to the loaded rows: a
  // one-off event outside the requested window can never contribute an
  // occurrence to it, so loading it (and paying for its overrides, and
  // running it through the expander) is pure waste. Recurring rows have to be
  // loaded regardless -- whether they land in the window is only knowable
  // after expansion.
  const events: PersonalEventRow[] = [];
  for (const chunk of chunkIds(userIds, 3)) {
    const { results } = await env.DB.prepare(
      `SELECT * FROM personal_events
       WHERE status = 'active'
         AND user_id IN (${placeholders(chunk.length)})
         ${options.availability ? 'AND availability = ?' : ''}
         AND (
           is_recurring = 1
           OR (start_at IS NOT NULL AND start_at <= ? AND COALESCE(end_at, start_at) >= ?)
         )`,
    )
      .bind(...chunk, ...(options.availability ? [options.availability] : []), toMs, fromMs)
      .all<PersonalEventRow>();
    events.push(...results);
  }
  if (events.length === 0) return out;

  const overridesById = await loadOverrides(env, events.map((e) => e.id));
  let remaining = options.maxOccurrences ?? Number.POSITIVE_INFINITY;

  for (const event of events) {
    const occurrences = expandPersonalEventRow(event, fromMs, toMs, overridesById.get(event.id) ?? []);
    if (occurrences.length === 0) continue;
    remaining -= occurrences.length;
    if (remaining <= 0) {
      console.warn('personal-event occurrence budget exhausted; returning partial availability');
      break;
    }
    if (!out.has(event.user_id)) out.set(event.user_id, []);
    out.get(event.user_id)!.push(...occurrences);
  }
  return out;
}
