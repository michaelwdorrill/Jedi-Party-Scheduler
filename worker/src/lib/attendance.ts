import type { Env } from '../env';
import type { EventRow } from './events';

export interface AttendeeRow {
  id: string;
  notifications_enabled: number;
  dm_channel_id: string | null;
  timezone: string;
}

// Who actually committed to a given occurrence -- the organizer always
// counts, plus (for single events) accepted invitees, or (for polls) whoever
// voted yes on the winning option / submitted availability covering the
// resolved window. Used to scope the voice-channel-invite DM to people who
// said they'd be there, not everyone who was ever invited.
export async function getConfirmedAttendeeIds(
  env: Env,
  event: EventRow,
  optionId: string | null,
): Promise<AttendeeRow[]> {
  if (event.event_type === 'poll' && event.poll_mode === 'window') {
    // Window-mode resolution doesn't produce a real event_poll_options row
    // (resolved_option_id is the literal string 'window'), so "confirmed"
    // here means: submitted a window availability range covering the
    // resolved start/end.
    if (event.start_at == null || event.end_at == null) return [];
    const { results } = await env.DB.prepare(
      `SELECT u.id, u.notifications_enabled, u.dm_channel_id, u.timezone
       FROM event_window_availability ewa JOIN users u ON u.id = ewa.user_id
       WHERE ewa.event_id = ? AND ewa.avail_start_at <= ? AND ewa.avail_end_at >= ?
       UNION
       SELECT id, notifications_enabled, dm_channel_id, timezone FROM users WHERE id = ?`,
    )
      .bind(event.id, event.start_at, event.end_at, event.organizer_id)
      .all<AttendeeRow>();
    return results;
  }

  if (event.event_type === 'poll') {
    if (!optionId) return [];
    const { results } = await env.DB.prepare(
      `SELECT u.id, u.notifications_enabled, u.dm_channel_id, u.timezone
       FROM event_poll_votes epv JOIN users u ON u.id = epv.user_id
       WHERE epv.option_id = ? AND epv.vote = 'yes'
       UNION
       SELECT id, notifications_enabled, dm_channel_id, timezone FROM users WHERE id = ?`,
    )
      .bind(optionId, event.organizer_id)
      .all<AttendeeRow>();
    return results;
  }

  const { results } = await env.DB.prepare(
    `SELECT u.id, u.notifications_enabled, u.dm_channel_id, u.timezone
     FROM event_invites ei JOIN users u ON u.id = ei.user_id
     WHERE ei.event_id = ? AND ei.rsvp_status = 'accepted'
     UNION
     SELECT id, notifications_enabled, dm_channel_id, timezone FROM users WHERE id = ?`,
  )
    .bind(event.id, event.organizer_id)
    .all<AttendeeRow>();
  return results;
}
