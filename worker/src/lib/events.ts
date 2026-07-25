import type { Env } from '../env';

export interface EventRow {
  id: string;
  guild_id: string;
  organizer_id: string;
  title: string;
  description: string | null;
  game: string | null;
  event_type: 'single' | 'poll';
  timezone: string;
  start_at: number | null;
  end_at: number | null;
  status: 'active' | 'cancelled' | 'resolved';
  poll_strategy: 'threshold' | 'most_votes' | null;
  poll_threshold_count: number | null;
  poll_deadline_at: number | null;
  resolved_option_id: string | null;
  is_recurring: number;
  created_at: number;
  updated_at: number;
}

export interface OverrideRow {
  event_id: string;
  occurrence_date: string;
  is_cancelled: number;
  override_start_at: number | null;
  override_end_at: number | null;
}

export async function loadOverridesForEvents(
  env: Env,
  eventIds: string[],
): Promise<Map<string, OverrideRow[]>> {
  const map = new Map<string, OverrideRow[]>();
  if (eventIds.length === 0) return map;
  const placeholders = eventIds.map(() => '?').join(',');
  const { results } = await env.DB.prepare(
    `SELECT event_id, occurrence_date, is_cancelled, override_start_at, override_end_at
     FROM event_occurrence_overrides WHERE event_id IN (${placeholders})`,
  )
    .bind(...eventIds)
    .all<OverrideRow>();
  for (const row of results) {
    if (!map.has(row.event_id)) map.set(row.event_id, []);
    map.get(row.event_id)!.push(row);
  }
  return map;
}

export async function loadMyRsvpForEvents(
  env: Env,
  eventIds: string[],
  userId: string,
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (eventIds.length === 0) return map;
  const placeholders = eventIds.map(() => '?').join(',');
  const { results } = await env.DB.prepare(
    `SELECT event_id, rsvp_status FROM event_invites
     WHERE user_id = ? AND event_id IN (${placeholders})`,
  )
    .bind(userId, ...eventIds)
    .all<{ event_id: string; rsvp_status: string }>();
  for (const row of results) map.set(row.event_id, row.rsvp_status);
  return map;
}

export function mapOccurrence(
  event: EventRow,
  occurrenceId: string,
  startAt: number | null,
  endAt: number | null,
  myRsvpStatus: string | null,
) {
  return {
    occurrenceId,
    eventId: event.id,
    title: event.title,
    description: event.description,
    game: event.game,
    eventType: event.event_type,
    status: event.status,
    timezone: event.timezone,
    startAt,
    endAt,
    isRecurring: !!event.is_recurring,
    organizerId: event.organizer_id,
    myRsvpStatus: (myRsvpStatus as 'pending' | 'accepted' | 'declined' | 'tentative' | null) ?? null,
    pollDeadlineAt: event.poll_deadline_at,
  };
}
