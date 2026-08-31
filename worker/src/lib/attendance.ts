import type { Env } from '../env';
import { MEMBERSHIP_GRACE_MS, requireActiveGuildMember } from './db';
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

// IDEAS item 51, and the interim half of it (its option 2; option 1 arrives
// with specs/0014's fan-out, which makes a confirmed poll day a real event and
// this rule redundant).
//
// v0.5 put RSVP buttons on a poll's DM once it settles -- edit-on-resolve
// rewrites the vote message into "is settled: Thursday" with I'm in / Maybe /
// Can't make it, and the poll_resolved DM carries them too. Pressing one
// writes event_invites.rsvp_status. Nothing about a poll's attendance read
// that column, so an invitee who pressed *Can't make it* stayed in the
// confirmed set and still got the voice-channel DM: a vote cast a week ago
// outranked an answer given a minute ago, and the app showed no sign of the
// disagreement.
//
// The rule: **an RSVP overrides the vote where one exists; votes fill in the
// rest.** A vote and an RSVP are two different statements -- "that night works
// for me" and "I am coming" -- and the app used the first as a proxy for the
// second because the second did not exist for polls until v0.5 created it.
//
// 'tentative' overrides too, and lands outside the confirmed set. That is not
// a judgement about maybes; it is the same reading a fixed-time event already
// gives them, where the confirmed query is `rsvp_status = 'accepted'`.
// A 'pending' row, or no row at all, is not an answer and falls through to the
// vote -- which is what keeps this from silently emptying every poll that
// nobody has pressed anything on.
//
// The limitation to know about is multi-winner, where one rsvp_status column
// covers an event with several confirmed days: a decline there can only mean
// "none of them", because there is nowhere to record "out for Thursday, in
// for Saturday". Nothing can set it today -- a multi-winner day's DM carries
// no buttons (see sweepConfirmedMultiWinnerOptions) and the website offers
// RSVP controls only for `eventType === 'single'` -- so this is defensive
// rather than active, and specs/0014's fan-out is what makes the question go
// away by giving each day its own event and its own answer.
function rsvpOverridesVote(voteTable: string): string {
  return `AND NOT EXISTS (
           SELECT 1 FROM event_invites ovr
           WHERE ovr.event_id = ? AND ovr.user_id = ${voteTable}.user_id
             AND ovr.rsvp_status IN ('declined','tentative')
         )`;
}

// The other half of the same rule: someone who never voted but pressed *I'm
// in* on the settled DM is coming, whatever the tallies say.
const RSVP_ACCEPTED = `UNION
       SELECT user_id FROM event_invites WHERE event_id = ? AND rsvp_status = 'accepted'`;

// Who actually committed to a given occurrence -- the organizer counts unless
// they declined, plus (for single events) accepted invitees, or (for polls)
// whoever voted yes on the winning option / submitted availability covering
// the resolved window, minus anyone whose RSVP has since overridden that.
// Used to scope the voice-channel-invite DM to people who said they'd be
// there, not everyone who was ever invited.
export async function getConfirmedAttendeeIds(
  env: Env,
  event: EventRow,
  optionId: string | null,
  pending: PendingFor,
): Promise<AttendeeRow[]> {
  if (pending.limit <= 0) return [];

  if (event.event_type === 'poll' && event.window_block_minutes != null) {
    // A windowed poll is answered with a range rather than a yes, so
    // "confirmed" here means: submitted availability covering the span that
    // actually won.
    //
    // Matched on the *event* rather than on the winning candidate, which is
    // deliberate. Before specs/0013 a window poll had no real
    // event_poll_options row at all -- resolved_option_id was the literal
    // string 'window' -- so a poll resolved before that release has no
    // candidate to match on and would silently produce nobody. Candidates
    // within one poll do not overlap in any shape the form can produce, so
    // covering the resolved span is unambiguous either way.
    if (event.start_at == null || event.end_at == null) return [];
    const { results } = await env.DB.prepare(
      membershipJoin(
        `SELECT user_id FROM event_window_availability WHERE event_id = ? AND avail_start_at <= ? AND avail_end_at >= ?
         ${rsvpOverridesVote('event_window_availability')}
         ${RSVP_ACCEPTED}
         ${ORGANIZER_UNLESS_DECLINED}`,
      ),
    )
      .bind(
        ...attendeeBinds(event, pending, [
          event.id,
          event.start_at,
          event.end_at,
          event.id,
          event.id,
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
         ${rsvpOverridesVote('event_poll_votes')}
         ${RSVP_ACCEPTED}
         ${ORGANIZER_UNLESS_DECLINED}`,
      ),
    )
      .bind(
        ...attendeeBinds(event, pending, [
          optionId,
          event.id,
          event.id,
          event.organizer_id,
          event.id,
          event.organizer_id,
        ]),
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

// One person's answer to one event's invitation, extracted out of
// POST /events/:eventId/rsvp so the Discord interactions endpoint can record
// the same thing (specs/0010). The website reaches this with a session; a
// button press reaches it with a signed Discord payload and no session at
// all, so nothing here may read `c.get('userId')` or any other request state.
//
// The permission checks live *inside* this function rather than in the route
// that used to hold them, and that is the whole point of the extraction. If
// they had stayed in the route handler, the interactions path would silently
// have had none -- the same shape as IDEAS.md item 26, where the organizer's
// 403 was invisible because two halves of the app disagreed about who was
// allowed. A DM is a permanent artifact and the state behind it moves: the
// press may arrive after the sender left the server, after the invite was
// withdrawn, or after the event was deleted, so every one of those is
// re-checked from the database on every press rather than inferred from the
// fact that we once sent them a message.
export type RsvpStatus = 'accepted' | 'declined' | 'tentative';

export type RsvpOutcome = 'recorded' | 'not_invited' | 'no_such_event';

export async function recordRsvp(
  env: Env,
  userId: string,
  eventId: string,
  status: RsvpStatus,
): Promise<RsvpOutcome> {
  const event = await env.DB.prepare(`SELECT guild_id FROM events WHERE id = ?`)
    .bind(eventId)
    .first<{ guild_id: string }>();
  if (!event) return 'no_such_event';
  if (!(await requireActiveGuildMember(env, userId, event.guild_id))) return 'not_invited';

  // The UPDATE is the authorisation check as well as the write: it only
  // matches a row that actually invites this user to this event, so an
  // uninvited presser changes nothing and is told so.
  const result = await env.DB.prepare(
    `UPDATE event_invites SET rsvp_status = ?, responded_at = ? WHERE event_id = ? AND user_id = ?`,
  )
    .bind(status, Date.now(), eventId, userId)
    .run();

  return result.meta.changes === 0 ? 'not_invited' : 'recorded';
}
