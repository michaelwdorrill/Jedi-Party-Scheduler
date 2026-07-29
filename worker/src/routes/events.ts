import { Hono } from 'hono';
import type { AppEnv } from '../lib/authMiddleware';
import type { Env } from '../env';
import type { EventRow } from '../lib/events';
import { requireActiveGuildMember } from '../lib/db';
import { newId } from '../lib/ids';
import { addInvitesToEvent, updateEvent, type EventWriteInput } from '../lib/eventWrites';
import { assertIsoDate, assertOneOf, assertStringArray, LIMITS, readJsonBody, ValidationError } from '../lib/validate';

export const eventRoutes = new Hono<AppEnv>();

async function loadEventIfVisible(env: Env, eventId: string, userId: string): Promise<EventRow | null> {
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
async function loadOwnedActiveEvent(env: Env, eventId: string, userId: string): Promise<EventRow | null> {
  const event = await env.DB.prepare(`SELECT * FROM events WHERE id = ?`).bind(eventId).first<EventRow>();
  if (!event) return null;
  if (event.organizer_id !== userId) return null;
  if (!(await requireActiveGuildMember(env, userId, event.guild_id))) return null;
  return event;
}

eventRoutes.get('/:eventId', async (c) => {
  const userId = c.get('userId');
  const eventId = c.req.param('eventId');
  const event = await loadEventIfVisible(c.env, eventId, userId);
  if (!event) return c.text('Not found', 404);

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
    `SELECT i.user_id, u.username, u.global_name, i.invited_via, i.source_group_id, i.rsvp_status
     FROM event_invites i JOIN users u ON u.id = i.user_id
     WHERE i.event_id = ? ORDER BY u.username`,
  )
    .bind(eventId)
    .all<{
      user_id: string;
      username: string;
      global_name: string | null;
      invited_via: string;
      source_group_id: string | null;
      rsvp_status: string;
    }>();

  let pollOptions = null;
  if (event.event_type === 'poll' && event.poll_mode === 'options') {
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
    const [{ results: tallyRows }, { results: myVoteRows }, { results: confirmedRows }] = await Promise.all([
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

    pollOptions = options.map((opt) => ({
      id: opt.id,
      startAt: opt.start_at,
      endAt: opt.end_at,
      displayOrder: opt.display_order,
      confirmedAt: opt.confirmed_at,
      confirmedUsers: confirmedByOption.get(opt.id) ?? [],
      tally: talliesByOption.get(opt.id) ?? { yes: 0, no: 0, maybe: 0 },
      myVote: myVoteByOption.get(opt.id) ?? null,
    }));
  }

  return c.json({
    occurrenceId: event.id,
    eventId: event.id,
    id: event.id,
    guildId: event.guild_id,
    title: event.title,
    description: event.description,
    game: event.game,
    eventType: event.event_type,
    status: event.status,
    timezone: event.timezone,
    startAt: event.start_at,
    endAt: event.end_at,
    isRecurring: !!event.is_recurring,
    organizerId: event.organizer_id,
    // The optimistic-concurrency token the client must send back on PATCH
    // (F-08-B). Without it, PATCH had no way to tell "the row I'm about to
    // edit is still the one I loaded" from "someone else changed it after I
    // loaded it, and my edit is about to silently overwrite theirs" -- the
    // route re-read the row immediately before calling updateEvent, so the
    // server-observed revision was always current by construction, and the
    // guard it built compared that fresh read to itself.
    revision: event.revision ?? 0,
    myRsvpStatus:
      inviteRows.find((i) => i.user_id === userId)?.rsvp_status ?? null,
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
      rsvpStatus: i.rsvp_status,
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

  await c.env.DB.prepare(`DELETE FROM event_invites WHERE event_id = ? AND user_id = ?`)
    .bind(eventId, targetUserId)
    .run();
  return c.json({ ok: true });
});

eventRoutes.post('/:eventId/rsvp', async (c) => {
  const userId = c.get('userId');
  const eventId = c.req.param('eventId');
  const body = await readJsonBody<{ status: 'accepted' | 'declined' | 'tentative' }>(c);
  const status = assertOneOf(body.status, 'status', ['accepted', 'declined', 'tentative'] as const);

  const event = await c.env.DB.prepare(`SELECT guild_id FROM events WHERE id = ?`).bind(eventId).first<{ guild_id: string }>();
  if (!event || !(await requireActiveGuildMember(c.env, userId, event.guild_id))) {
    return c.text('Not invited to this event', 403);
  }

  const result = await c.env.DB.prepare(
    `UPDATE event_invites SET rsvp_status = ?, responded_at = ? WHERE event_id = ? AND user_id = ?`,
  )
    .bind(status, Date.now(), eventId, userId)
    .run();

  if (result.meta.changes === 0) return c.text('Not invited to this event', 403);
  return c.json({ ok: true });
});
