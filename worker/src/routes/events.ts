import { Hono } from 'hono';
import type { AppEnv } from '../lib/authMiddleware';
import type { EventRow } from '../lib/events';
import { newId } from '../lib/ids';
import { updateEvent } from '../lib/eventWrites';

export const eventRoutes = new Hono<AppEnv>();

async function loadEventIfVisible(
  db: D1Database,
  eventId: string,
  userId: string,
): Promise<EventRow | null> {
  const event = await db.prepare(`SELECT * FROM events WHERE id = ?`).bind(eventId).first<EventRow>();
  if (!event) return null;
  if (event.organizer_id === userId) return event;
  const invite = await db
    .prepare(`SELECT 1 FROM event_invites WHERE event_id = ? AND user_id = ?`)
    .bind(eventId, userId)
    .first();
  return invite ? event : null;
}

eventRoutes.get('/:eventId', async (c) => {
  const userId = c.get('userId');
  const eventId = c.req.param('eventId');
  const event = await loadEventIfVisible(c.env.DB, eventId, userId);
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
  if (event.event_type === 'poll') {
    const { results: options } = await c.env.DB.prepare(
      `SELECT id, start_at, end_at, display_order FROM event_poll_options
       WHERE event_id = ? ORDER BY display_order`,
    )
      .bind(eventId)
      .all<{ id: string; start_at: number; end_at: number; display_order: number }>();

    pollOptions = [];
    for (const opt of options) {
      const { results: votes } = await c.env.DB.prepare(
        `SELECT user_id, vote FROM event_poll_votes WHERE option_id = ?`,
      )
        .bind(opt.id)
        .all<{ user_id: string; vote: string }>();

      const tally = { yes: 0, no: 0, maybe: 0 };
      let myVote: string | null = null;
      for (const v of votes) {
        tally[v.vote as 'yes' | 'no' | 'maybe']++;
        if (v.user_id === userId) myVote = v.vote;
      }
      pollOptions.push({
        id: opt.id,
        startAt: opt.start_at,
        endAt: opt.end_at,
        displayOrder: opt.display_order,
        tally,
        myVote,
      });
    }
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
    myRsvpStatus:
      inviteRows.find((i) => i.user_id === userId)?.rsvp_status ?? null,
    pollStrategy: event.poll_strategy,
    pollThresholdCount: event.poll_threshold_count,
    pollDeadlineAt: event.poll_deadline_at,
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
  const event = await c.env.DB.prepare(`SELECT * FROM events WHERE id = ?`).bind(eventId).first<EventRow>();
  if (!event) return c.text('Not found', 404);
  if (event.organizer_id !== userId) return c.text('Forbidden', 403);

  const body = await c.req.json();
  await updateEvent(c.env, eventId, event.guild_id, body);
  return c.json({ ok: true });
});

eventRoutes.delete('/:eventId', async (c) => {
  const userId = c.get('userId');
  const eventId = c.req.param('eventId');
  const event = await c.env.DB.prepare(`SELECT * FROM events WHERE id = ?`).bind(eventId).first<EventRow>();
  if (!event) return c.text('Not found', 404);
  if (event.organizer_id !== userId) return c.text('Forbidden', 403);

  await c.env.DB.prepare(`UPDATE events SET status = 'cancelled', updated_at = ? WHERE id = ?`)
    .bind(Date.now(), eventId)
    .run();
  return c.json({ ok: true });
});

eventRoutes.post('/:eventId/occurrences/:date/cancel', async (c) => {
  const userId = c.get('userId');
  const eventId = c.req.param('eventId');
  const date = c.req.param('date');
  const event = await c.env.DB.prepare(`SELECT * FROM events WHERE id = ?`).bind(eventId).first<EventRow>();
  if (!event) return c.text('Not found', 404);
  if (event.organizer_id !== userId) return c.text('Forbidden', 403);

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
  const event = await c.env.DB.prepare(`SELECT * FROM events WHERE id = ?`).bind(eventId).first<EventRow>();
  if (!event) return c.text('Not found', 404);
  if (event.organizer_id !== userId) return c.text('Forbidden', 403);

  const body = await c.req.json<{ userIds?: string[]; groupIds?: string[] }>();
  await updateEvent(c.env, eventId, event.guild_id, {
    invites: { userIds: body.userIds ?? [], groupIds: body.groupIds ?? [] },
  });
  return c.json({ ok: true });
});

eventRoutes.delete('/:eventId/invites/:userId', async (c) => {
  const requesterId = c.get('userId');
  const eventId = c.req.param('eventId');
  const targetUserId = c.req.param('userId');
  const event = await c.env.DB.prepare(`SELECT * FROM events WHERE id = ?`).bind(eventId).first<EventRow>();
  if (!event) return c.text('Not found', 404);
  if (event.organizer_id !== requesterId) return c.text('Forbidden', 403);

  await c.env.DB.prepare(`DELETE FROM event_invites WHERE event_id = ? AND user_id = ?`)
    .bind(eventId, targetUserId)
    .run();
  return c.json({ ok: true });
});

eventRoutes.post('/:eventId/rsvp', async (c) => {
  const userId = c.get('userId');
  const eventId = c.req.param('eventId');
  const body = await c.req.json<{ status: 'accepted' | 'declined' | 'tentative' }>();

  const result = await c.env.DB.prepare(
    `UPDATE event_invites SET rsvp_status = ?, responded_at = ? WHERE event_id = ? AND user_id = ?`,
  )
    .bind(body.status, Date.now(), eventId, userId)
    .run();

  if (result.meta.changes === 0) return c.text('Not invited to this event', 403);
  return c.json({ ok: true });
});
