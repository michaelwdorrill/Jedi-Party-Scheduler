import type { Env } from '../env';
import { MEMBERSHIP_GRACE_MS } from './db';
import type { EventRow } from './events';
import {
  PENDING_NOTIFICATION_JOIN,
  PENDING_NOTIFICATION_WHERE,
  pendingNotificationJoinBinds,
  pendingNotificationWhereBinds,
} from './outbox';

export interface AttendeeRow {
  id: string;
  notifications_enabled: number;
  dm_channel_id: string | null;
  timezone: string;
}

// Identifies which notification the caller is about to send, so the queries
// below can exclude anyone already settled for it in the same statement
// rather than paying for a second, unbudgeted lookup afterwards. `limit`
// bounds the returned rows to what the tick can actually afford to deliver.
export interface PendingFor {
  notificationType: string;
  occurrenceDate: string;
  limit: number;
}

// Same reasoning as reminders.ts's getEventParticipants: this runs inside the
// 15-minute cron sweep, so it must not make a live Discord call per attendee.
// It requires cached active guild membership *confirmed within the grace
// window* -- enough to stop DMing someone who left (or whose guild was
// deactivated) since the event was created, including the organizer, who
// isn't exempt from having left. The background revalidation sweep is what
// keeps rows inside that window.
function membershipJoin(idsSubquery: string): string {
  return `SELECT u.id, u.notifications_enabled, u.dm_channel_id, u.timezone
          FROM users u
          JOIN user_guild_membership m
            ON m.user_id = u.id AND m.guild_id = ? AND m.is_member = 1 AND m.verified_at >= ?
          JOIN guilds g ON g.id = m.guild_id AND g.is_active = 1
          ${PENDING_NOTIFICATION_JOIN}
          WHERE u.id IN (${idsSubquery})
            AND ${PENDING_NOTIFICATION_WHERE}
          ORDER BY u.id
          LIMIT ?`;
}

// Bind order matches the SQL text above: guild/cutoff for the membership
// join, then the notification key for the pending join, then the caller's own
// id-subquery parameters, then the pending predicate's, then the limit.
function attendeeBinds(
  event: EventRow,
  pending: PendingFor,
  subqueryBinds: unknown[],
): unknown[] {
  return [
    event.guild_id,
    membershipCutoff(),
    ...pendingNotificationJoinBinds(event.id, pending.notificationType, pending.occurrenceDate),
    ...subqueryBinds,
    ...pendingNotificationWhereBinds(),
    pending.limit,
  ];
}

function membershipCutoff(): number {
  return Date.now() - MEMBERSHIP_GRACE_MS;
}

// The organizer is folded into every one of the three subqueries below by a
// `UNION SELECT <organizer>`, which used to be unconditional: the model had no
// `event_invites` row for them, so there was nothing else to read.
//
// Idea 26 gives them a real row, which makes an unconditional union actively
// wrong -- an organizer who declined their own session would be put straight
// back into the confirmed set and sent the voice-channel DM anyway, silently
// overriding the answer the new row exists to let them give.
//
// So: the organizer still counts unless they have explicitly declined. Not
// "unless they have a row", because a poll's organizer has no vote to read and
// a single event's organizer may sit at 'pending' or 'tentative'; in both of
// those the old behaviour (they are running it, they are there) is still the
// right reading. Only an actual decline overturns it. Written as NOT EXISTS
// rather than a join so events predating the backfill -- with no organizer row
// at all -- behave exactly as they did before.
const ORGANIZER_UNLESS_DECLINED = `UNION
       SELECT ? WHERE NOT EXISTS (
         SELECT 1 FROM event_invites
         WHERE event_id = ? AND user_id = ? AND rsvp_status = 'declined'
       )`;

// Who actually committed to a given occurrence -- the organizer counts unless
// they declined, plus (for single events) accepted invitees, or (for polls)
// whoever voted yes on the winning option / submitted availability covering
// the resolved window. Used to scope the voice-channel-invite DM to people who
// said they'd be there, not everyone who was ever invited.
export async function getConfirmedAttendeeIds(
  env: Env,
  event: EventRow,
  optionId: string | null,
  pending: PendingFor,
): Promise<AttendeeRow[]> {
  if (pending.limit <= 0) return [];

  if (event.event_type === 'poll' && event.poll_mode === 'window') {
    // Window-mode resolution doesn't produce a real event_poll_options row
    // (resolved_option_id is the literal string 'window'), so "confirmed"
    // here means: submitted a window availability range covering the
    // resolved start/end.
    if (event.start_at == null || event.end_at == null) return [];
    const { results } = await env.DB.prepare(
      membershipJoin(
        `SELECT user_id FROM event_window_availability WHERE event_id = ? AND avail_start_at <= ? AND avail_end_at >= ?
         ${ORGANIZER_UNLESS_DECLINED}`,
      ),
    )
      .bind(
        ...attendeeBinds(event, pending, [
          event.id,
          event.start_at,
          event.end_at,
          event.organizer_id,
          event.id,
          event.organizer_id,
        ]),
      )
      .all<AttendeeRow>();
    return results;
  }

  if (event.event_type === 'poll') {
    if (!optionId) return [];
    const { results } = await env.DB.prepare(
      membershipJoin(
        `SELECT user_id FROM event_poll_votes WHERE option_id = ? AND vote = 'yes'
         ${ORGANIZER_UNLESS_DECLINED}`,
      ),
    )
      .bind(
        ...attendeeBinds(event, pending, [optionId, event.organizer_id, event.id, event.organizer_id]),
      )
      .all<AttendeeRow>();
    return results;
  }

  const { results } = await env.DB.prepare(
    membershipJoin(
      `SELECT user_id FROM event_invites WHERE event_id = ? AND rsvp_status = 'accepted'
       ${ORGANIZER_UNLESS_DECLINED}`,
    ),
  )
    .bind(
      ...attendeeBinds(event, pending, [event.id, event.organizer_id, event.id, event.organizer_id]),
    )
    .all<AttendeeRow>();
  return results;
}
