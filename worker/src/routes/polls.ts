import { Hono } from 'hono';
import type { AppEnv } from '../lib/authMiddleware';
import type { Env } from '../env';
import type { EventRow } from '../lib/events';
import { requireActiveGuildMember } from '../lib/db';
import {
  bestWindowBlock,
  checkThresholdAndResolve,
  checkWindowThresholdAndResolve,
  getOptionTallies,
} from '../lib/polls';
import { assertOneOf, assertSafeInt, assertString, assertTimeRange } from '../lib/validate';

export const pollRoutes = new Hono<AppEnv>();

// A former member holding a stale invite/organizer row must not keep poll
// access -- current active membership in the event's guild is required too.
async function requireInvitedOrOrganizer(env: Env, eventId: string, userId: string): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT e.guild_id FROM events e
     LEFT JOIN event_invites i ON i.event_id = e.id AND i.user_id = ?
     WHERE e.id = ? AND (e.organizer_id = ? OR i.user_id IS NOT NULL)`,
  )
    .bind(userId, eventId, userId)
    .first<{ guild_id: string }>();
  if (!row) return false;
  return requireActiveGuildMember(env, userId, row.guild_id);
}

pollRoutes.get('/:eventId/poll', async (c) => {
  const userId = c.get('userId');
  const eventId = c.req.param('eventId');
  if (!(await requireInvitedOrOrganizer(c.env, eventId, userId))) return c.text('Forbidden', 403);

  const tallies = await getOptionTallies(c.env, eventId);
  const { results: myVotes } = await c.env.DB.prepare(
    `SELECT option_id, vote FROM event_poll_votes WHERE user_id = ? AND option_id IN
       (SELECT id FROM event_poll_options WHERE event_id = ?)`,
  )
    .bind(userId, eventId)
    .all<{ option_id: string; vote: string }>();
  const myVoteByOption = new Map(myVotes.map((v) => [v.option_id, v.vote]));

  return c.json(
    tallies.map((t) => ({
      id: t.id,
      startAt: t.startAt,
      endAt: t.endAt,
      displayOrder: t.displayOrder,
      confirmedAt: t.confirmedAt,
      tally: { yes: t.yes, no: t.no, maybe: t.maybe },
      myVote: myVoteByOption.get(t.id) ?? null,
    })),
  );
});

pollRoutes.post('/:eventId/poll/vote', async (c) => {
  const userId = c.get('userId');
  const eventId = c.req.param('eventId');
  const body = await c.req.json<{ optionId: string; vote: 'yes' | 'no' | 'maybe' }>();
  const optionId = assertString(body.optionId, 'optionId', 64);
  const vote = assertOneOf(body.vote, 'vote', ['yes', 'no', 'maybe'] as const);

  const event = await c.env.DB.prepare(`SELECT * FROM events WHERE id = ?`).bind(eventId).first<EventRow>();
  if (!event || event.event_type !== 'poll' || event.poll_mode !== 'options') return c.text('Not found', 404);

  const option = await c.env.DB.prepare(
    `SELECT id, confirmed_at FROM event_poll_options WHERE id = ? AND event_id = ?`,
  )
    .bind(optionId, eventId)
    .first<{ id: string; confirmed_at: number | null }>();
  if (!option) return c.text('Invalid option', 400);

  if (event.poll_resolution_mode === 'multi_winner') {
    // Confirmed days stay open forever for late joiners; unconfirmed days
    // close once the deadline passes.
    const deadlinePassed = !!event.poll_deadline_at && Date.now() > event.poll_deadline_at;
    if (!option.confirmed_at && deadlinePassed) {
      return c.text('Voting for this day has closed', 400);
    }
  } else if (event.status !== 'active') {
    return c.text('Voting is closed for this event', 400);
  }

  if (!(await requireInvitedOrOrganizer(c.env, eventId, userId))) return c.text('Forbidden', 403);

  await c.env.DB.prepare(
    `INSERT INTO event_poll_votes (option_id, user_id, vote, voted_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(option_id, user_id) DO UPDATE SET vote = excluded.vote, voted_at = excluded.voted_at`,
  )
    .bind(optionId, userId, vote, Date.now())
    .run();

  await checkThresholdAndResolve(c.env, event);

  return c.json({ ok: true });
});

pollRoutes.get('/:eventId/window', async (c) => {
  const userId = c.get('userId');
  const eventId = c.req.param('eventId');
  if (!(await requireInvitedOrOrganizer(c.env, eventId, userId))) return c.text('Forbidden', 403);

  const event = await c.env.DB.prepare(`SELECT * FROM events WHERE id = ?`).bind(eventId).first<EventRow>();
  if (!event || event.event_type !== 'poll' || event.poll_mode !== 'window') return c.text('Not found', 404);

  const { results: submissions } = await c.env.DB.prepare(
    `SELECT ewa.user_id, u.username, u.global_name, ewa.avail_start_at, ewa.avail_end_at
     FROM event_window_availability ewa JOIN users u ON u.id = ewa.user_id
     WHERE ewa.event_id = ?`,
  )
    .bind(eventId)
    .all<{ user_id: string; username: string; global_name: string | null; avail_start_at: number; avail_end_at: number }>();

  const best =
    event.window_start_at != null && event.window_end_at != null && event.window_block_minutes != null
      ? bestWindowBlock(
          event.window_start_at,
          event.window_end_at,
          event.window_block_minutes,
          submissions.map((s) => ({ startAt: s.avail_start_at, endAt: s.avail_end_at })),
        )
      : null;

  const mine = submissions.find((s) => s.user_id === userId);

  return c.json({
    windowStartAt: event.window_start_at,
    windowEndAt: event.window_end_at,
    windowBlockMinutes: event.window_block_minutes,
    mySubmission: mine ? { startAt: mine.avail_start_at, endAt: mine.avail_end_at } : null,
    submissions: submissions.map((s) => ({
      userId: s.user_id,
      username: s.username,
      globalName: s.global_name,
      startAt: s.avail_start_at,
      endAt: s.avail_end_at,
    })),
    bestCandidate: best,
  });
});

pollRoutes.post('/:eventId/window', async (c) => {
  const userId = c.get('userId');
  const eventId = c.req.param('eventId');

  const event = await c.env.DB.prepare(`SELECT * FROM events WHERE id = ?`).bind(eventId).first<EventRow>();
  if (!event || event.event_type !== 'poll' || event.poll_mode !== 'window') return c.text('Not found', 404);
  if (event.status !== 'active') return c.text('Voting is closed for this event', 400);
  if (!(await requireInvitedOrOrganizer(c.env, eventId, userId))) return c.text('Forbidden', 403);

  const rawBody = await c.req.json<{ startAt: number; endAt: number }>();
  const startAt = assertSafeInt(rawBody.startAt, 'startAt');
  const endAt = assertSafeInt(rawBody.endAt, 'endAt');
  assertTimeRange(startAt, endAt, 'availability');

  if (
    event.window_start_at == null ||
    event.window_end_at == null ||
    event.window_block_minutes == null ||
    startAt < event.window_start_at ||
    endAt > event.window_end_at ||
    endAt - startAt < event.window_block_minutes * 60 * 1000
  ) {
    return c.text('Submitted range must fall within the window and cover at least one full block', 400);
  }

  await c.env.DB.prepare(
    `INSERT INTO event_window_availability (event_id, user_id, avail_start_at, avail_end_at, submitted_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(event_id, user_id) DO UPDATE SET avail_start_at = excluded.avail_start_at,
       avail_end_at = excluded.avail_end_at, submitted_at = excluded.submitted_at`,
  )
    .bind(eventId, userId, startAt, endAt, Date.now())
    .run();

  await checkWindowThresholdAndResolve(c.env, event);

  return c.json({ ok: true });
});
