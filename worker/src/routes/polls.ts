import { Hono } from 'hono';
import type { AppEnv } from '../lib/authMiddleware';
import type { EventRow } from '../lib/events';
import { checkThresholdAndResolve, getOptionTallies } from '../lib/polls';

export const pollRoutes = new Hono<AppEnv>();

pollRoutes.get('/:eventId/poll', async (c) => {
  const userId = c.get('userId');
  const eventId = c.req.param('eventId');

  const invite = await c.env.DB.prepare(
    `SELECT 1 FROM event_invites WHERE event_id = ? AND user_id = ?
     UNION SELECT 1 FROM events WHERE id = ? AND organizer_id = ?`,
  )
    .bind(eventId, userId, eventId, userId)
    .first();
  if (!invite) return c.text('Forbidden', 403);

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
      tally: { yes: t.yes, no: t.no, maybe: t.maybe },
      myVote: myVoteByOption.get(t.id) ?? null,
    })),
  );
});

pollRoutes.post('/:eventId/poll/vote', async (c) => {
  const userId = c.get('userId');
  const eventId = c.req.param('eventId');
  const body = await c.req.json<{ optionId: string; vote: 'yes' | 'no' | 'maybe' }>();

  const event = await c.env.DB.prepare(`SELECT * FROM events WHERE id = ?`).bind(eventId).first<EventRow>();
  if (!event || event.event_type !== 'poll') return c.text('Not found', 404);
  if (event.status !== 'active') return c.text('Voting is closed for this event', 400);

  const invite = await c.env.DB.prepare(
    `SELECT 1 FROM event_invites WHERE event_id = ? AND user_id = ?`,
  )
    .bind(eventId, userId)
    .first();
  if (!invite && event.organizer_id !== userId) return c.text('Forbidden', 403);

  const option = await c.env.DB.prepare(
    `SELECT id FROM event_poll_options WHERE id = ? AND event_id = ?`,
  )
    .bind(body.optionId, eventId)
    .first();
  if (!option) return c.text('Invalid option', 400);

  await c.env.DB.prepare(
    `INSERT INTO event_poll_votes (option_id, user_id, vote, voted_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(option_id, user_id) DO UPDATE SET vote = excluded.vote, voted_at = excluded.voted_at`,
  )
    .bind(body.optionId, userId, body.vote, Date.now())
    .run();

  await checkThresholdAndResolve(c.env, event);

  return c.json({ ok: true });
});
