import type { Env } from '../env';
import { chunkIds, placeholders } from './d1';

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
  // Consecutive failed deadline-resolution attempts. Read by the deadline
  // sweep's ordering so a persistently failing poll cannot hold a place in
  // the page ahead of healthy ones -- see migration 0012. Optional because
  // rows selected before this column existed (and some narrower test
  // fixtures) will not carry it.
  poll_resolution_failures?: number;
  resolved_option_id: string | null;
  poll_mode: 'options' | 'window';
  poll_resolution_mode: 'single_winner' | 'multi_winner';
  window_start_at: number | null;
  window_end_at: number | null;
  window_block_minutes: number | null;
  is_recurring: number;
  voice_channel_id: string | null;
  voice_channel_name: string | null;
  created_at: number;
  updated_at: number;
  // Optimistic-concurrency token, bumped by every successful updateEvent.
  // Optional because narrower test fixtures and rows selected before
  // migration 0013 will not carry it; treated as 0 when absent.
  revision?: number;
}

export interface OverrideRow {
  event_id: string;
  occurrence_date: string;
  is_cancelled: number;
  override_start_at: number | null;
  override_end_at: number | null;
}

// These three helpers each take "every event the caller can see", which is
// unbounded from the caller's point of view -- one guild member creating
// enough events that another member's calendar crosses D1's bound-parameter
// ceiling was a persistent, cross-user denial of service, since the records
// stay and every subsequent calendar load fails the same way. Chunking is
// what makes the list size irrelevant.
export async function loadOverridesForEvents(
  env: Env,
  eventIds: string[],
): Promise<Map<string, OverrideRow[]>> {
  const map = new Map<string, OverrideRow[]>();
  for (const chunk of chunkIds(eventIds)) {
    const { results } = await env.DB.prepare(
      `SELECT event_id, occurrence_date, is_cancelled, override_start_at, override_end_at
       FROM event_occurrence_overrides WHERE event_id IN (${placeholders(chunk.length)})`,
    )
      .bind(...chunk)
      .all<OverrideRow>();
    for (const row of results) {
      if (!map.has(row.event_id)) map.set(row.event_id, []);
      map.get(row.event_id)!.push(row);
    }
  }
  return map;
}

// Keyed `${eventId}::${occurrenceDate}` -- '' for a non-recurring event's
// only occurrence -- rather than by event id alone (specs/0014). A recurring
// event's occurrences aren't rows here; they're computed by
// expandOccurrencesForEvent, so the caller looks up one key per expanded
// occurrence instead of once per event, which is the fix for the bug this
// replaces: every occurrence of a recurring event used to be stamped with
// the same single event-wide answer.
export async function loadMyAttendanceForEvents(
  env: Env,
  eventIds: string[],
  userId: string,
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (const chunk of chunkIds(eventIds, 1)) {
    const { results } = await env.DB.prepare(
      `SELECT event_id, occurrence_date, rsvp_status FROM event_attendance
       WHERE user_id = ? AND event_id IN (${placeholders(chunk.length)})`,
    )
      .bind(userId, ...chunk)
      .all<{ event_id: string; occurrence_date: string; rsvp_status: string }>();
    for (const row of results) map.set(`${row.event_id}::${row.occurrence_date}`, row.rsvp_status);
  }
  return map;
}

export function mapOccurrence(
  event: EventRow,
  occurrenceId: string,
  startAt: number | null,
  endAt: number | null,
  myRsvpStatus: string | null,
  groupId: string | null = null,
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
    isPersonal: false,
    // A candidate slot on a poll that has not resolved: a day this event
    // *might* happen, not one it will (idea 41). The calendar draws these
    // differently -- opacity already means "past" and strike-through means
    // "cancelled", so pending needs a mark of its own rather than a third
    // shade. Defaults false; only the poll-candidate path sets it.
    isProvisional: false,
    organizerId: event.organizer_id,
    myRsvpStatus: (myRsvpStatus as 'pending' | 'accepted' | 'declined' | 'tentative' | null) ?? null,
    pollDeadlineAt: event.poll_deadline_at,
    // Which saved group this event was invited through, if any. Drives stable
    // per-group colouring on the calendar; null for ad-hoc individual invites.
    groupId,
  };
}

// Loads the group each event was invited through, so the calendar can colour
// a group's sessions consistently. An event invited via multiple groups just
// takes the lowest-id one -- arbitrary but stable, which is all colouring needs.
export async function loadPrimaryGroupForEvents(
  env: Env,
  eventIds: string[],
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (const chunk of chunkIds(eventIds)) {
    const { results } = await env.DB.prepare(
      `SELECT event_id, MIN(source_group_id) AS group_id FROM event_invites
       WHERE event_id IN (${placeholders(chunk.length)}) AND source_group_id IS NOT NULL
       GROUP BY event_id`,
    )
      .bind(...chunk)
      .all<{ event_id: string; group_id: string }>();
    for (const row of results) map.set(row.event_id, row.group_id);
  }
  return map;
}

export interface ConfirmedPollOptionRow {
  id: string;
  event_id: string;
  start_at: number;
  end_at: number;
}

// Candidate slots on a poll that has not resolved -- the days a poll is
// *proposing*, as opposed to the ones it has settled on (idea 41).
//
// Bounded the same way the confirmed loader is (chunked, and the caller only
// ever passes events it already loaded), plus a range filter, so a poll whose
// candidates all sit outside the month being viewed costs nothing to skip.
export async function loadPendingOptionsForEvents(
  env: Env,
  eventIds: string[],
  from: number,
  to: number,
): Promise<Map<string, ConfirmedPollOptionRow[]>> {
  const map = new Map<string, ConfirmedPollOptionRow[]>();
  for (const chunk of chunkIds(eventIds, 2)) {
    const { results } = await env.DB.prepare(
      `SELECT id, event_id, start_at, end_at FROM event_poll_options
       WHERE event_id IN (${placeholders(chunk.length)}) AND confirmed_at IS NULL
         AND start_at <= ? AND end_at >= ?
       ORDER BY start_at`,
    )
      .bind(...chunk, to, from)
      .all<ConfirmedPollOptionRow>();
    for (const row of results) {
      if (!map.has(row.event_id)) map.set(row.event_id, []);
      map.get(row.event_id)!.push(row);
    }
  }
  return map;
}

// Bulk-loads confirmed options for many multi-winner polls at once. Loading
// this per-poll (one query per poll in the visible list) was the other half
// of the calendar route's N+1 -- a guild with many multi-winner polls paid
// one query per poll on every single calendar load regardless of date range.
export async function loadConfirmedOptionsForEvents(
  env: Env,
  eventIds: string[],
): Promise<Map<string, ConfirmedPollOptionRow[]>> {
  const map = new Map<string, ConfirmedPollOptionRow[]>();
  for (const chunk of chunkIds(eventIds)) {
    const { results } = await env.DB.prepare(
      `SELECT id, event_id, start_at, end_at FROM event_poll_options
       WHERE event_id IN (${placeholders(chunk.length)}) AND confirmed_at IS NOT NULL`,
    )
      .bind(...chunk)
      .all<ConfirmedPollOptionRow>();
    for (const row of results) {
      if (!map.has(row.event_id)) map.set(row.event_id, []);
      map.get(row.event_id)!.push(row);
    }
  }
  return map;
}
