import type { Env } from '../env';
import type { EventRow } from './events';

export interface AttendeeRow {
  id: string;
  notifications_enabled: number;
  dm_channel_id: string | null;
  timezone: string;
}

// Same cache-only reasoning as reminders.ts's getEventParticipants: this runs
// inside the 15-minute cron sweep, so it must not make a live Discord call
// per attendee. Requiring cached active guild membership is enough to stop
// DMing someone who left (or whose guild was deactivated) since the event
// was created -- including the organizer, who isn't exempt from having left.
function membershipJoin(idsSubquery: string): string {
  return `SELECT u.id, u.notifications_enabled, u.dm_channel_id, u.timezone
          FROM users u
          JOIN user_guild_membership m ON m.user_id = u.id AND m.guild_id = ? AND m.is_member = 1
          JOIN guilds g ON g.id = m.guild_id AND g.is_active = 1
          WHERE u.id IN (${idsSubquery})`;
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
      membershipJoin(
        `SELECT user_id FROM event_window_availability WHERE event_id = ? AND avail_start_at <= ? AND avail_end_at >= ?
         UNION SELECT ?`,
      ),
    )
      .bind(event.guild_id, event.id, event.start_at, event.end_at, event.organizer_id)
      .all<AttendeeRow>();
    return results;
  }

  if (event.event_type === 'poll') {
    if (!optionId) return [];
    const { results } = await env.DB.prepare(
      membershipJoin(`SELECT user_id FROM event_poll_votes WHERE option_id = ? AND vote = 'yes' UNION SELECT ?`),
    )
      .bind(event.guild_id, optionId, event.organizer_id)
      .all<AttendeeRow>();
    return results;
  }

  const { results } = await env.DB.prepare(
    membershipJoin(`SELECT user_id FROM event_invites WHERE event_id = ? AND rsvp_status = 'accepted' UNION SELECT ?`),
  )
    .bind(event.guild_id, event.id, event.organizer_id)
    .all<AttendeeRow>();
  return results;
}
