import { Hono } from 'hono';
import { DateTime } from 'luxon';
import type { AppEnv } from '../lib/authMiddleware';
import type { Env } from '../env';
import type { EventRow } from '../lib/events';
import { loadOverridesForEvents } from '../lib/events';
import { expandOccurrencesForEvent } from '../lib/recurrence';
import { requireActiveGuildMember } from '../lib/db';
import { recordRsvp, type RsvpStatus } from '../lib/attendance';
import { newId } from '../lib/ids';
import { addInvitesToEvent, updateEvent, type EventWriteInput } from '../lib/eventWrites';
import { assertIsoDate, assertOneOf, assertStringArray, LIMITS, readJsonBody, ValidationError } from '../lib/validate';

export const eventRoutes = new Hono<AppEnv>();

export async function loadEventIfVisible(env: Env, eventId: string, userId: string): Promise<EventRow | null> {
  const event = await env.DB.prepare(`SELECT * FROM events WHERE id = ?`).bind(eventId).first<EventRow>();
  if (!event) return null;
  // A former member holding a stale invite (or even the organizer, if they
  // left/were removed) must not keep visibility -- current active membership
  // in the event's guild is required regardless of how they're connected to it.
  if (!(await requireActiveGuildMember(env, userId, event.guild_id))) return null;
  if (event.organizer_id === userId) return event;
  const invite = await env.DB
    .prepare(`SELECT 1 FROM event_invites WHERE event_id = ? AND user_id = ?`)
    .bind(eventId, userId)
    .first();
  return invite ? event : null;
}

// Organizer-only mutations all share this: load the event, confirm it
// exists, confirm the requester organizes it, AND confirm they're still a
// current active member of its guild (leaving/removal revokes control too,
// not just visibility).
export async function loadOwnedActiveEvent(env: Env, eventId: string, userId: string): Promise<EventRow | null> {
  const event = await env.DB.prepare(`SELECT * FROM events WHERE id = ?`).bind(eventId).first<EventRow>();
  if (!event) return null;
  if (event.organizer_id !== userId) return null;
  if (!(await requireActiveGuildMember(env, userId, event.guild_id))) return null;
  return event;
}

// A recurring event's own row has no start_at/end_at at all -- events.ts's
// EventRow carries them NULL for every recurring event, always, by design
// (createEventWithInvites writes isRecurring ? null : input.startAt): the
// real times live in event_recurrence_rules and are computed per occurrence.
// GET /:eventId used to just echo those NULLs regardless of ?occurrence=,
// which is a pre-existing gap this route never closed before -- it happened
// not to matter until decision 6 made "each occurrence gets its own page"
// the thing this route is actually for. Resolving a real startAt/endAt here
// is what lets the page show a time at all, which is also what
// EventDetailPage.tsx's `event.startAt && event.endAt` RSVP-button gate has
// silently depended on since before this release.
//
// requestedDate present -> resolve that exact occurrence (decision 2: any
// occurrence at all, not just ones near "now"). requestedDate absent ->
// decision 6b's next-upcoming default. Both go through
// expandOccurrencesForEvent so overrides (a moved time, a cancellation) are
// honoured identically to every other read of this event's occurrences.
async function resolveOccurrence(
  env: Env,
  event: EventRow,
  requestedDate: string | null,
): Promise<{ date: string; startAt: number | null; endAt: number | null }> {
  const overridesByEvent = await loadOverridesForEvents(env, [event.id]);
  const overrides = overridesByEvent.get(event.id) ?? [];

  if (requestedDate) {
    // A day-wide window in the event's own timezone, not a point in time --
    // expandOccurrences filters by ms overlap, and the occurrence's actual
    // start/end (after any override) has to fall inside it to be found.
    const zone = event.timezone;
    const dayStart = DateTime.fromISO(requestedDate, { zone }).startOf('day').toMillis();
    const dayEnd = DateTime.fromISO(requestedDate, { zone }).endOf('day').toMillis();
    const occurrences = await expandOccurrencesForEvent(env, event, dayStart, dayEnd, overrides);
    const occ = occurrences.find((o) => o.date === requestedDate);
    // No match means either a cancelled occurrence (expandOccurrences omits
    // those entirely) or a date the rule never produces -- either way,
    // nothing honest to show as a time, so this is the same harmless '' the
    // rest of this route already treats as "no answer, matches no row".
    return occ ? occ : { date: requestedDate, startAt: null, endAt: null };
  }

  const now = Date.now();
  const horizon = now + 366 * 24 * 60 * 60 * 1000;
  const occurrences = await expandOccurrencesForEvent(env, event, now, horizon, overrides);
  const occ = occurrences[0];
  return occ ? occ : { date: '', startAt: null, endAt: null };
}

eventRoutes.get('/:eventId', async (c) => {
  const userId = c.get('userId');
  const eventId = c.req.param('eventId');
  const event = await loadEventIfVisible(c.env, eventId, userId);
  if (!event) return c.text('Not found', 404);

  const requestedOccurrence = c.req.query('occurrence');
  const resolved = event.is_recurring
    ? await resolveOccurrence(
        c.env,
        event,
        requestedOccurrence ? assertIsoDate(requestedOccurrence, 'occurrence') : null,
      )
    : { date: '', startAt: event.start_at, endAt: event.end_at };
  const occurrenceDate = resolved.date;

  const recurrence = event.is_recurring
    ? await c.env.DB.prepare(
        `SELECT freq, interval, by_weekday, by_month_day, start_date, start_time,
                duration_minutes, end_type, end_date, end_count
         FROM event_recurrence_rules WHERE event_id = ?`,
      )
        .bind(eventId)
        .first<{
          freq: string;
          interval: number;
          by_weekday: string | null;
          by_month_day: number | null;
          start_date: string;
          start_time: string;
          duration_minutes: number;
          end_type: string;
          end_date: string | null;
          end_count: number | null;
        }>()
    : null;

  const { results: inviteRows } = await c.env.DB.prepare(
    `SELECT i.user_id, u.username, u.global_name, i.invited_via, i.source_group_id, a.rsvp_status
     FROM event_invites i
     JOIN users u ON u.id = i.user_id
     LEFT JOIN event_attendance a ON a.event_id = i.event_id AND a.occurrence_date = ? AND a.user_id = i.user_id
     WHERE i.event_id = ? ORDER BY u.username`,
  )
    .bind(occurrenceDate, eventId)
    .all<{
      user_id: string;
      username: string;
      global_name: string | null;
      invited_via: string;
      source_group_id: string | null;
      rsvp_status: string | null;
    }>();

  const organizer = await c.env.DB.prepare(`SELECT username, global_name FROM users WHERE id = ?`)
    .bind(event.organizer_id)
    .first<{ username: string; global_name: string | null }>();

  // specs/0011 / IDEAS item 36: a group can now be offered across several
  // servers, so which one a given event actually landed on is no longer
  // something the viewer can just assume from context the way it was when
  // groups belonged to exactly one guild.
  const guild = await c.env.DB.prepare(`SELECT name FROM guilds WHERE id = ?`)
    .bind(event.guild_id)
    .first<{ name: string }>();

  // Every poll has candidates now, windowed or not (specs/0013), so this no
  // longer branches on poll_mode -- a migrated window poll has exactly one.
  let pollOptions = null;
  if (event.event_type === 'poll') {
    const { results: options } = await c.env.DB.prepare(
      `SELECT id, start_at, end_at, display_order, confirmed_at FROM event_poll_options
       WHERE event_id = ? ORDER BY display_order`,
    )
      .bind(eventId)
      .all<{ id: string; start_at: number; end_at: number; display_order: number; confirmed_at: number | null }>();

    // Three fixed queries for the whole option set, not one per option.
    //
    // The old shape issued a vote query per option, so a poll at the
    // configured 50-option maximum cost 50 statements here -- on top of the
    // session, event, membership, invite and option-list reads, that is 55
    // for one page view, past the Free plan's entire 50-statement
    // per-invocation allowance. `getOptionTallies()` was fixed for this in an
    // earlier pass, but this route never used it and kept its own loop.
    //
    // Split into three rather than folded into one join because row volume
    // matters as much as statement count here: "every vote on every option"
    // is options x invitees, which at the configured maxima (50 x 300) is
    // 15,000 rows to compute counts from. Each query below returns only what
    // the response actually carries -- at most 3 rows per option for the
    // tallies, one per option for the viewer's own votes, and named users
    // only for options that are actually confirmed.
    const [{ results: tallyRows }, { results: myVoteRows }, { results: confirmedRows }, { results: voterRows }] =
      await Promise.all([
      c.env.DB.prepare(
        `SELECT ev.option_id, ev.vote, COUNT(*) AS n FROM event_poll_votes ev
         JOIN event_poll_options o ON o.id = ev.option_id
         WHERE o.event_id = ? GROUP BY ev.option_id, ev.vote`,
      )
        .bind(eventId)
        .all<{ option_id: string; vote: string; n: number }>(),
      c.env.DB.prepare(
        `SELECT ev.option_id, ev.vote FROM event_poll_votes ev
         JOIN event_poll_options o ON o.id = ev.option_id
         WHERE o.event_id = ? AND ev.user_id = ?`,
      )
        .bind(eventId, userId)
        .all<{ option_id: string; vote: string }>(),
      // Only confirmed options display their attendee list, so the join
      // filters on confirmed_at rather than loading every yes-voter and
      // discarding most of them.
      c.env.DB.prepare(
        `SELECT ev.option_id, ev.user_id, u.username, u.global_name FROM event_poll_votes ev
         JOIN event_poll_options o ON o.id = ev.option_id
         JOIN users u ON u.id = ev.user_id
         WHERE o.event_id = ? AND o.confirmed_at IS NOT NULL AND ev.vote = 'yes'
         ORDER BY u.username`,
      )
        .bind(eventId)
        .all<{ option_id: string; user_id: string; username: string; global_name: string | null }>(),
      // IDEAS item 49: every voter on every option, not just the confirmed
      // yes-voters above -- "who voted for what" while the poll is still
      // open, which today only fixed-time events and window polls show.
      // currentRsvpStatus is the item-51-shaped override: once an option
      // resolves, an RSVP recorded since can disagree with the vote cast
      // before it (rsvpOverridesVote's rule in lib/attendance.ts), and the
      // vote alone would silently show the wrong answer. Read here as a
      // plain per-voter LEFT JOIN -- "what is this one person's current
      // answer" -- rather than attendance.ts's aggregate confirmed-set
      // shape, which answers a different question ("who is in the set")
      // that this per-row display does not need.
      c.env.DB.prepare(
        `SELECT ev.option_id, ev.user_id, ev.vote, u.username, u.global_name, att.rsvp_status AS current_rsvp_status
         FROM event_poll_votes ev
         JOIN event_poll_options o ON o.id = ev.option_id
         JOIN users u ON u.id = ev.user_id
         LEFT JOIN event_attendance att ON att.event_id = o.event_id AND att.occurrence_date = '' AND att.user_id = ev.user_id
         WHERE o.event_id = ?
         ORDER BY u.username`,
      )
        .bind(eventId)
        .all<{
          option_id: string;
          user_id: string;
          vote: string;
          username: string;
          global_name: string | null;
          current_rsvp_status: string | null;
        }>(),
    ]);

    const talliesByOption = new Map<string, { yes: number; no: number; maybe: number }>();
    for (const row of tallyRows) {
      let tally = talliesByOption.get(row.option_id);
      if (!tally) {
        tally = { yes: 0, no: 0, maybe: 0 };
        talliesByOption.set(row.option_id, tally);
      }
      tally[row.vote as 'yes' | 'no' | 'maybe'] = row.n;
    }

    const myVoteByOption = new Map<string, string>();
    for (const row of myVoteRows) myVoteByOption.set(row.option_id, row.vote);

    const confirmedByOption = new Map<string, { userId: string; username: string; globalName: string | null }[]>();
    for (const row of confirmedRows) {
      if (!confirmedByOption.has(row.option_id)) confirmedByOption.set(row.option_id, []);
      confirmedByOption.get(row.option_id)!.push({
        userId: row.user_id,
        username: row.username,
        globalName: row.global_name,
      });
    }

    const votersByOption = new Map<
      string,
      { userId: string; username: string; globalName: string | null; vote: string; currentRsvpStatus: string | null }[]
    >();
    for (const row of voterRows) {
      if (!votersByOption.has(row.option_id)) votersByOption.set(row.option_id, []);
      votersByOption.get(row.option_id)!.push({
        userId: row.user_id,
        username: row.username,
        globalName: row.global_name,
        vote: row.vote,
        currentRsvpStatus: row.current_rsvp_status,
      });
    }

    pollOptions = options.map((opt) => ({
      id: opt.id,
      startAt: opt.start_at,
      endAt: opt.end_at,
      displayOrder: opt.display_order,
      confirmedAt: opt.confirmed_at,
      confirmedUsers: confirmedByOption.get(opt.id) ?? [],
      // IDEAS item 49: everyone's answer, not just the confirmed set --
      // `vote` is what they said before the poll settled; `currentRsvpStatus`
      // is what they said since (null if they never answered the RSVP,
      // which is the normal case before resolution).
      voters: votersByOption.get(opt.id) ?? [],
      tally: talliesByOption.get(opt.id) ?? { yes: 0, no: 0, maybe: 0 },
      myVote: myVoteByOption.get(opt.id) ?? null,
    }));
  }

  return c.json({
    occurrenceId: event.id,
    eventId: event.id,
    id: event.id,
    guildId: event.guild_id,
    guildName: guild?.name ?? null,
    title: event.title,
    description: event.description,
    game: event.game,
    eventType: event.event_type,
    status: event.status,
    timezone: event.timezone,
    // For a recurring event this is the resolved occurrence's time, not the
    // event row's own start_at/end_at -- which are always NULL for a
    // recurring event (the real schedule lives in event_recurrence_rules).
    startAt: resolved.startAt,
    endAt: resolved.endAt,
    isRecurring: !!event.is_recurring,
    organizerId: event.organizer_id,
    organizerUsername: organizer?.username ?? null,
    organizerGlobalName: organizer?.global_name ?? null,
    // The optimistic-concurrency token the client must send back on PATCH
    // (F-08-B). Without it, PATCH had no way to tell "the row I'm about to
    // edit is still the one I loaded" from "someone else changed it after I
    // loaded it, and my edit is about to silently overwrite theirs" -- the
    // route re-read the row immediately before calling updateEvent, so the
    // server-observed revision was always current by construction, and the
    // guard it built compared that fresh read to itself.
    revision: event.revision ?? 0,
    occurrenceDate,
    // Decision 1, carried over per-occurrence: an organizer with no explicit
    // answer for this occurrence is implicitly attending, same as
    // getConfirmedAttendeeIds' ORGANIZER_UNLESS_DECLINED -- so the website
    // and the notification path tell the same story about them.
    myRsvpStatus:
      inviteRows.find((i) => i.user_id === userId)?.rsvp_status ??
      (userId === event.organizer_id ? 'accepted' : null),
    pollStrategy: event.poll_strategy,
    pollThresholdCount: event.poll_threshold_count,
    pollDeadlineAt: event.poll_deadline_at,
    pollMode: event.poll_mode,
    pollResolutionMode: event.poll_resolution_mode,
    windowStartAt: event.window_start_at,
    windowEndAt: event.window_end_at,
    windowBlockMinutes: event.window_block_minutes,
    voiceChannelId: event.voice_channel_id,
    voiceChannelName: event.voice_channel_name,
    // specs/0014 stage 3, decision 4.
    minimumAttendees: event.minimum_attendees ?? null,
    autoCancelBelowMinimum: !!event.auto_cancel_below_minimum,
    // IDEAS item 54.
    minimumAttendeesDeadlineAt: event.minimum_attendees_deadline_at ?? null,
    minimumAttendeesDeadlineHoursBefore: event.minimum_attendees_deadline_hours_before ?? null,
    recurrence: recurrence
      ? {
          freq: recurrence.freq,
          interval: recurrence.interval,
          byWeekday: recurrence.by_weekday ? recurrence.by_weekday.split(',').map(Number) : null,
          byMonthDay: recurrence.by_month_day,
          startDate: recurrence.start_date,
          startTime: recurrence.start_time,
          durationMinutes: recurrence.duration_minutes,
          endType: recurrence.end_type,
          endDate: recurrence.end_date,
          endCount: recurrence.end_count,
        }
      : null,
    invites: inviteRows.map((i) => ({
      userId: i.user_id,
      username: i.username,
      globalName: i.global_name,
      invitedVia: i.invited_via,
      sourceGroupId: i.source_group_id,
      // Same decision-1 fallback as myRsvpStatus above, applied per row so
      // the organizer doesn't show as "no answer" here while every other
      // read of this occurrence (the reminder path, myRsvpStatus) treats
      // them as attending by default.
      rsvpStatus: i.rsvp_status ?? (i.user_id === event.organizer_id ? 'accepted' : null),
    })),
    pollOptions,
  });
});

eventRoutes.patch('/:eventId', async (c) => {
  const userId = c.get('userId');
  const eventId = c.req.param('eventId');
  const event = await loadOwnedActiveEvent(c.env, eventId, userId);
  if (!event) return c.text('Not found', 404);

  const body = await readJsonBody<Partial<EventWriteInput>>(c);
  await updateEvent(c.env, eventId, event.guild_id, body, event);
  return c.json({ ok: true });
});

eventRoutes.delete('/:eventId', async (c) => {
  const userId = c.get('userId');
  const eventId = c.req.param('eventId');
  const event = await loadOwnedActiveEvent(c.env, eventId, userId);
  if (!event) return c.text('Not found', 404);

  await c.env.DB.prepare(`UPDATE events SET status = 'cancelled', updated_at = ? WHERE id = ?`)
    .bind(Date.now(), eventId)
    .run();
  return c.json({ ok: true });
});

// Overrides are loaded and applied for every recurring event on every
// calendar request, so an unbounded pile of them on one series is a cost
// every viewer pays. Nothing about the feature needs hundreds.
async function assertOverrideQuota(env: Env, eventId: string): Promise<void> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM event_occurrence_overrides WHERE event_id = ?`)
    .bind(eventId)
    .first<{ n: number }>();
  if ((row?.n ?? 0) >= LIMITS.MAX_OVERRIDES_PER_EVENT) {
    throw new ValidationError(`This event has reached its limit of ${LIMITS.MAX_OVERRIDES_PER_EVENT} changed occurrences`);
  }
}

eventRoutes.post('/:eventId/occurrences/:date/cancel', async (c) => {
  const userId = c.get('userId');
  const eventId = c.req.param('eventId');
  // Path parameters are as attacker-controlled as bodies are, and this one is
  // stored verbatim and later compared against dates the recurrence expander
  // generates. An unvalidated value writes a row that can never match any
  // occurrence -- an override that does nothing but take up space and count
  // against the per-event cap.
  const date = assertIsoDate(c.req.param('date'), 'date');
  const event = await loadOwnedActiveEvent(c.env, eventId, userId);
  if (!event) return c.text('Not found', 404);

  await assertOverrideQuota(c.env, eventId);

  await c.env.DB.prepare(
    `INSERT INTO event_occurrence_overrides (id, event_id, occurrence_date, is_cancelled)
     VALUES (?, ?, ?, 1)
     ON CONFLICT(event_id, occurrence_date) DO UPDATE SET is_cancelled = 1`,
  )
    .bind(newId(), eventId, date)
    .run();
  return c.json({ ok: true });
});

eventRoutes.post('/:eventId/invites', async (c) => {
  const userId = c.get('userId');
  const eventId = c.req.param('eventId');
  const event = await loadOwnedActiveEvent(c.env, eventId, userId);
  if (!event) return c.text('Not found', 404);

  const body = await readJsonBody<{ userIds?: string[]; groupIds?: string[] }>(c);
  const userIds = assertStringArray(body.userIds ?? [], 'userIds', LIMITS.MAX_INVITEES, 64);
  const groupIds = assertStringArray(body.groupIds ?? [], 'groupIds', LIMITS.MAX_GROUP_IDS, 64);
  // Additive only -- unlike PATCH /:eventId (the full edit form, which
  // replaces the invite list to match whatever it submits), this endpoint's
  // whole purpose is inviting more people without touching anyone already invited.
  await addInvitesToEvent(c.env, eventId, event.guild_id, userIds, groupIds);
  return c.json({ ok: true });
});

eventRoutes.delete('/:eventId/invites/:userId', async (c) => {
  const requesterId = c.get('userId');
  const eventId = c.req.param('eventId');
  const targetUserId = c.req.param('userId');
  const event = await loadOwnedActiveEvent(c.env, eventId, requesterId);
  if (!event) return c.text('Not found', 404);

  // event_attendance (specs/0014) has no FK back to event_invites -- it only
  // cascades from events -- so revoking access has to clear it explicitly,
  // the same reasoning as replaceInviteStatements' matching delete.
  await c.env.DB.batch([
    c.env.DB.prepare(`DELETE FROM event_invites WHERE event_id = ? AND user_id = ?`).bind(eventId, targetUserId),
    c.env.DB.prepare(`DELETE FROM event_attendance WHERE event_id = ? AND user_id = ?`).bind(eventId, targetUserId),
  ]);
  return c.json({ ok: true });
});

// The body of this route now lives in lib/attendance.ts, permission checks
// included, so that a Discord button press records an RSVP through exactly
// the same code (specs/0010). What stays here is the HTTP shape: parse,
// call, translate the outcome into a status code.
eventRoutes.post('/:eventId/rsvp', async (c) => {
  const userId = c.get('userId');
  const eventId = c.req.param('eventId');
  const body = await readJsonBody<{ status: RsvpStatus; occurrenceDate?: string }>(c);
  const status = assertOneOf(body.status, 'status', ['accepted', 'declined', 'tentative'] as const);
  const occurrenceDate = body.occurrenceDate ? assertIsoDate(body.occurrenceDate, 'occurrenceDate') : '';

  const outcome = await recordRsvp(c.env, userId, eventId, occurrenceDate, status);
  // invalid_occurrence is a client-bug shape (an occurrence date that
  // doesn't match whether the event is recurring), distinct enough from the
  // existing collapsed 403 to deserve its own status -- unlike no_such_event
  // vs. not_invited, there's no probing concern here worth hiding it for.
  if (outcome === 'invalid_occurrence') return c.text('Occurrence does not match this event', 400);
  // Also its own message, same reasoning as invalid_occurrence: not a
  // probing concern (the caller already knows this event exists and they
  // were invited to it), just a stale client trying to answer something
  // that is no longer answerable.
  if (outcome === 'event_not_active') return c.text('This event is no longer active', 409);
  // A missing event and an uninvited caller stay one answer, as they were
  // before the extraction: telling someone which of the two it is would let
  // an event id be probed for existence.
  if (outcome !== 'recorded') return c.text('Not invited to this event', 403);
  return c.json({ ok: true });
});
