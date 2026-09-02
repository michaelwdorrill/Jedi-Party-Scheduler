import type { Env } from '../env';
import { MEMBERSHIP_GRACE_MS, requireActiveGuildMember } from './db';
import type { EventRow } from './events';
import { newId } from './ids';
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
// a single event's organizer may have no answer on record yet; in both of
// those the old behaviour (they are running it, they are there) is still the
// right reading. Only an actual decline overturns it -- and specs/0014 makes
// that per occurrence: declining the 10/14 session doesn't decline the
// 10/21 one. Written as NOT EXISTS rather than a join so an occurrence
// nobody has answered for -- which is every occurrence, for an
// organizer who has never pressed anything -- behaves exactly like "there".
const ORGANIZER_UNLESS_DECLINED = `UNION
       SELECT ? WHERE NOT EXISTS (
         SELECT 1 FROM event_attendance
         WHERE event_id = ? AND occurrence_date = ? AND user_id = ? AND rsvp_status = 'declined'
       )`;

// IDEAS item 51, and the interim half of it (its option 2; option 1 arrives
// with specs/0014's fan-out, which makes a confirmed poll day a real event and
// this rule redundant).
//
// v0.5 put RSVP buttons on a poll's DM once it settles -- edit-on-resolve
// rewrites the vote message into "is settled: Thursday" with I'm in / Maybe /
// Can't make it, and the poll_resolved DM carries them too. Pressing one
// writes an event_attendance row. Nothing about a poll's attendance read
// that table before v0.5.1's interim fix, so an invitee who pressed *Can't
// make it* stayed in the confirmed set and still got the voice-channel DM: a
// vote cast a week ago outranked an answer given a minute ago, and the app
// showed no sign of the disagreement.
//
// The rule: **an RSVP overrides the vote where one exists; votes fill in the
// rest.** A vote and an RSVP are two different statements -- "that night works
// for me" and "I am coming" -- and the app used the first as a proxy for the
// second because the second did not exist for polls until v0.5 created it.
//
// 'tentative' overrides too, and lands outside the confirmed set. That is not
// a judgement about maybes; it is the same reading a fixed-time event already
// gives them, where the confirmed query is `rsvp_status = 'accepted'`.
// No row at all is not an answer and falls through to the vote -- which is
// what keeps this from silently emptying every poll that nobody has pressed
// anything on.
//
// The limitation to know about is multi-winner, where one occurrence_date
// ('', specs/0014's convention -- a poll has no real occurrences of its own
// until stage 3's fan-out) covers an event with several confirmed days: a
// decline there can only mean "none of them", because there is nowhere yet
// to record "out for Thursday, in for Saturday". Nothing can set it today --
// a multi-winner day's DM carries no buttons (see
// sweepConfirmedMultiWinnerOptions) and the website offers RSVP controls
// only for `eventType === 'single'` -- so this is defensive rather than
// active, and specs/0014's fan-out is what makes the question go away by
// giving each day its own event and its own answer.
function rsvpOverridesVote(voteTable: string): string {
  return `AND NOT EXISTS (
           SELECT 1 FROM event_attendance ovr
           WHERE ovr.event_id = ? AND ovr.occurrence_date = ? AND ovr.user_id = ${voteTable}.user_id
             AND ovr.rsvp_status IN ('declined','tentative')
         )`;
}

// The other half of the same rule: someone who never voted but pressed *I'm
// in* on the settled DM is coming, whatever the tallies say.
const RSVP_ACCEPTED = `UNION
       SELECT user_id FROM event_attendance WHERE event_id = ? AND occurrence_date = ? AND rsvp_status = 'accepted'`;

// Who actually committed to a given occurrence -- the organizer counts unless
// they declined, plus (for single events) accepted invitees, or (for polls)
// whoever voted yes on the winning option / submitted availability covering
// the resolved window, minus anyone whose RSVP has since overridden that.
// Used to scope the voice-channel-invite DM to people who said they'd be
// there, not everyone who was ever invited.
//
// occurrenceDate is the event_attendance key, separate from
// pending.occurrenceDate (the notification_log dedupe key -- at the
// multi-winner call site that's a poll-option id, not a date). Both poll
// branches always pass '': a poll has no occurrences of its own until
// specs/0014's stage-3 fan-out. The fixed-time branch passes whatever the
// caller passes -- '' for a non-recurring event, the occurrence date for a
// recurring one.
export async function getConfirmedAttendeeIds(
  env: Env,
  event: EventRow,
  optionId: string | null,
  occurrenceDate: string,
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
          occurrenceDate,
          event.id,
          occurrenceDate,
          event.organizer_id,
          event.id,
          occurrenceDate,
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
          occurrenceDate,
          event.id,
          occurrenceDate,
          event.organizer_id,
          event.id,
          occurrenceDate,
          event.organizer_id,
        ]),
      )
      .all<AttendeeRow>();
    return results;
  }

  const { results } = await env.DB.prepare(
    membershipJoin(
      `SELECT user_id FROM event_attendance WHERE event_id = ? AND occurrence_date = ? AND rsvp_status = 'accepted'
       ${ORGANIZER_UNLESS_DECLINED}`,
    ),
  )
    .bind(
      ...attendeeBinds(event, pending, [
        event.id,
        occurrenceDate,
        event.organizer_id,
        event.id,
        occurrenceDate,
        event.organizer_id,
      ]),
    )
    .all<AttendeeRow>();
  return results;
}

// specs/0014 stage 2's ladder needs a *per-row* status -- unanswered /
// tentative / accepted -- rather than a set of confirmed ids, because a
// single event's recipients can each be due a different rung on the same
// tick. This reproduces ORGANIZER_UNLESS_DECLINED's policy (the organizer
// counts unless they explicitly declined this occurrence) and the window
// poll's "covers the resolved span" rule from getConfirmedAttendeeIds above,
// but through a per-row CASE against an already-joined event_attendance row
// rather than those two functions' UNION-into-a-candidate-set shape -- the
// two shapes can't share literal SQL text, so if the override or
// window-coverage policy ever changes, both this and
// ORGANIZER_UNLESS_DECLINED/the window-poll branch above need the same
// change made twice.
//
// Callers join `event_attendance AS att` themselves (`ON att.event_id = ?
// AND att.occurrence_date = ? AND att.user_id = u.id`, aliased `u` for the
// recipient) before splicing this in -- the same "caller owns the join,
// fragment owns the predicate" split PENDING_NOTIFICATION_JOIN uses.
// `isWindowed` decides whether the fourth branch (and its three binds) is
// present at all, since the EXISTS it runs only makes sense for a window
// poll and every other event shape should not pay for an irrelevant
// subquery.
//
// Never writes anything -- this is a read-time computation, same as the
// spec's explicit rejection of writing 'accepted' for window-poll coverage:
// "Do not write accepted on their behalf... Compute it instead."
export function ladderStatusCase(isWindowed: boolean): string {
  const windowedBranch = isWindowed
    ? `WHEN EXISTS (
         SELECT 1 FROM event_window_availability ewa
         WHERE ewa.event_id = ? AND ewa.user_id = u.id
           AND ewa.avail_start_at <= ? AND ewa.avail_end_at >= ?
       ) THEN 'accepted'`
    : '';
  return `CASE
    WHEN att.rsvp_status = 'tentative' THEN 'tentative'
    WHEN att.rsvp_status = 'accepted' THEN 'accepted'
    WHEN att.rsvp_status IS NULL AND u.id = ? THEN 'accepted'
    ${windowedBranch}
    ELSE 'unanswered'
  END`;
}

// Bind order matches ladderStatusCase's text: organizer id for the third
// branch, then (only when isWindowed) event id / resolved start / resolved
// end for the fourth. `event.start_at`/`end_at` are the *resolved* span for
// a window poll -- null for anything unresolved, which callers must not
// reach this with (an unresolved poll has no per-occurrence ladder to run:
// sweepReminders only ever calls this for events with a real start_at).
export function ladderStatusCaseBinds(
  organizerId: string,
  isWindowed: boolean,
  event?: { id: string; start_at: number | null; end_at: number | null },
): unknown[] {
  if (!isWindowed) return [organizerId];
  return [organizerId, event!.id, event!.start_at, event!.end_at];
}

// specs/0014 stage 3: the minimum-attendees cascade needs a plain count of
// who currently counts as attending a non-recurring, non-poll occurrence --
// not a notification-shaped query. getConfirmedAttendeeIds exists to answer
// "who should receive notification X, excluding whoever already has it",
// and its `pending: PendingFor` argument is load-bearing there: reusing it
// here would silently undercount, since the dedupe it applies would exclude
// anyone already sent some unrelated notification for this occurrence. This
// mirrors only the fixed-time branch of that function's candidate set --
// accepted invitees, plus the organizer unless they declined this
// occurrence -- with no notification dedupe and no LIMIT, because a
// threshold check has to see everyone or it isn't a threshold check.
export async function countConfirmedAttendees(
  env: Env,
  event: { id: string; guild_id: string; organizer_id: string },
  occurrenceDate: string,
): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM (
       SELECT user_id FROM event_attendance WHERE event_id = ? AND occurrence_date = ? AND rsvp_status = 'accepted'
       ${ORGANIZER_UNLESS_DECLINED}
     ) confirmed
     JOIN user_guild_membership m ON m.user_id = confirmed.user_id AND m.guild_id = ? AND m.is_member = 1 AND m.verified_at >= ?
     JOIN guilds g ON g.id = m.guild_id AND g.is_active = 1`,
  )
    .bind(
      event.id,
      occurrenceDate,
      event.organizer_id,
      event.id,
      occurrenceDate,
      event.organizer_id,
      event.guild_id,
      membershipCutoff(),
    )
    .first<{ n: number }>();
  return row?.n ?? 0;
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

export type RsvpOutcome = 'recorded' | 'not_invited' | 'no_such_event' | 'invalid_occurrence' | 'event_not_active';

// occurrenceDate: '' for a non-recurring event, an occurrence date for a
// recurring one -- and it must agree with which the event actually is.
// Under the old model every invitee had an event_invites row from the
// moment they were invited, so the UPDATE that recorded an answer doubled
// as the authorisation check: a 0-row UPDATE meant "not invited." specs/0014
// writes no row until someone answers, so there's nothing to conditionally
// UPDATE against on a first press -- the guard has to be its own clause, and
// the write becomes an upsert (a second press on the same occurrence changes
// the answer rather than adding a row). Both live in one statement rather
// than a separate existence check then a write, so there's no window between
// "confirmed invited" and "recorded" for a concurrent invite removal to land
// in.
export async function recordRsvp(
  env: Env,
  userId: string,
  eventId: string,
  occurrenceDate: string,
  status: RsvpStatus,
): Promise<RsvpOutcome> {
  const event = await env.DB.prepare(
    `SELECT guild_id, organizer_id, is_recurring, status, event_type, minimum_attendees, auto_cancel_below_minimum
     FROM events WHERE id = ?`,
  )
    .bind(eventId)
    .first<{
      guild_id: string;
      organizer_id: string;
      is_recurring: number;
      status: 'active' | 'cancelled' | 'resolved';
      event_type: 'single' | 'poll';
      minimum_attendees: number | null;
      auto_cancel_below_minimum: number;
    }>();
  if (!event) return 'no_such_event';

  // specs/0014 stage 3: a write that lands after the event has already
  // stopped being active must not succeed as if it still meant something.
  // Harmless before this release, since nothing read attendance on a
  // cancelled event -- the minimum-attendees cascade is what makes it
  // load-bearing: an accept recorded after the cascade already cancelled
  // the event, and after sweepCancelledEventNotices already ran, would
  // otherwise never be told the session isn't happening. Checked before the
  // occurrence guard below so the more specific "this event is over" answer
  // wins over "that date doesn't match" whenever both would apply.
  if (event.status !== 'active') return 'event_not_active';

  // A non-recurring event's only occurrence is '' and a recurring one's is
  // never ''. Guarding it here, not just at the callers that construct it,
  // means a bug anywhere upstream produces a rejected write instead of a row
  // getConfirmedAttendeeIds' occurrence-scoped queries will silently never
  // find.
  if ((occurrenceDate !== '') !== !!event.is_recurring) return 'invalid_occurrence';

  if (!(await requireActiveGuildMember(env, userId, event.guild_id))) return 'not_invited';

  const result = await env.DB.prepare(
    `INSERT INTO event_attendance (id, event_id, occurrence_date, user_id, rsvp_status, responded_at)
     SELECT ?, ?, ?, ?, ?, ?
     WHERE EXISTS (SELECT 1 FROM event_invites WHERE event_id = ? AND user_id = ?)
     ON CONFLICT(event_id, occurrence_date, user_id) DO UPDATE SET
       rsvp_status = excluded.rsvp_status, responded_at = excluded.responded_at`,
  )
    .bind(newId(), eventId, occurrenceDate, userId, status, Date.now(), eventId, userId)
    .run();

  if (result.meta.changes === 0) return 'not_invited';

  // The minimum-attendees cascade (decision 4), scoped to exactly what
  // validateEventWriteInput allows minimum_attendees to be set on: a
  // non-recurring, non-poll event -- so event.minimum_attendees != null
  // already implies both of the other two conditions today, and they're
  // still checked explicitly rather than relied on implicitly. Auto-cancel's
  // notice to everyone still coming, and the organizer's own prompt when
  // auto-cancel is off, both go out through the outbox on the next tick
  // (sweepCancelledEventNotices / sweepOrganizerCancelPrompts) -- what
  // happens here is only ever the synchronous half decision 4 asks for:
  // "record the decline and mark the event."
  if (
    status === 'declined' &&
    event.event_type === 'single' &&
    !event.is_recurring &&
    event.minimum_attendees != null
  ) {
    const confirmed = await countConfirmedAttendees(
      env,
      { id: eventId, guild_id: event.guild_id, organizer_id: event.organizer_id },
      occurrenceDate,
    );
    if (confirmed < event.minimum_attendees && event.auto_cancel_below_minimum) {
      // Guarded on status = 'active' so two declines racing below the
      // minimum at the same time still cancel the event exactly once.
      await env.DB.prepare(
        `UPDATE events SET status = 'cancelled', updated_at = ? WHERE id = ? AND status = 'active'`,
      )
        .bind(Date.now(), eventId)
        .run();
    }
  }

  return 'recorded';
}
