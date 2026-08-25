import { Hono } from 'hono';
import type { AppEnv } from '../lib/authMiddleware';
import type { Env } from '../env';
import type { EventRow } from '../lib/events';
import { requireActiveGuildMember } from '../lib/db';
import {
  checkThresholdAndResolve,
  checkWindowThresholdAndResolve,
  getOptionTallies,
  getWindowedCandidates,
  resolveWindowedCandidates,
} from '../lib/polls';
import { assertOneOf, assertSafeInt, assertString, assertTimeRange, LIMITS, readJsonBody } from '../lib/validate';

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
  const body = await readJsonBody<{ optionId: string; vote: 'yes' | 'no' | 'maybe' }>(c);
  const optionId = assertString(body.optionId, 'optionId', 64);
  const vote = assertOneOf(body.vote, 'vote', ['yes', 'no', 'maybe'] as const);

  const event = await c.env.DB.prepare(`SELECT * FROM events WHERE id = ?`).bind(eventId).first<EventRow>();
  // A windowed poll is answered with a range, not a yes/no -- see the
  // /window routes below. Decided by window_block_minutes rather than
  // poll_mode, which nothing reads any more (specs/0013).
  if (!event || event.event_type !== 'poll' || event.window_block_minutes != null) return c.text('Not found', 404);

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
  if (!event || event.event_type !== 'poll' || event.window_block_minutes == null) return c.text('Not found', 404);

  const candidates = await getWindowedCandidates(c.env, eventId);
  const best = new Map(resolveWindowedCandidates(event, candidates).map((r) => [r.candidate.id, r.best]));

  // Names are attached in a second query rather than joined into the first:
  // getWindowedCandidates is shared with the resolution path, which needs
  // ranges and nothing else, and a poll's submitters are bounded by
  // MAX_RESOLVED_INVITEES so this is one small statement either way.
  const { results: rows } = await c.env.DB.prepare(
    `SELECT a.option_id, a.user_id, u.username, u.global_name, a.avail_start_at, a.avail_end_at
     FROM event_window_availability a JOIN users u ON u.id = a.user_id
     WHERE a.event_id = ?`,
  )
    .bind(eventId)
    .all<{
      option_id: string;
      user_id: string;
      username: string;
      global_name: string | null;
      avail_start_at: number;
      avail_end_at: number;
    }>();

  const byOption = new Map<string, typeof rows>();
  for (const row of rows) {
    if (!byOption.has(row.option_id)) byOption.set(row.option_id, []);
    byOption.get(row.option_id)!.push(row);
  }

  return c.json({
    blockMinutes: event.window_block_minutes,
    candidates: candidates.map((candidate) => {
      const submissions = byOption.get(candidate.id) ?? [];
      const mine = submissions.find((s) => s.user_id === userId);
      return {
        optionId: candidate.id,
        windowStartAt: candidate.startAt,
        windowEndAt: candidate.endAt,
        displayOrder: candidate.displayOrder,
        confirmedAt: candidate.confirmedAt,
        mySubmission: mine ? { startAt: mine.avail_start_at, endAt: mine.avail_end_at } : null,
        submissions: submissions.map((s) => ({
          userId: s.user_id,
          username: s.username,
          globalName: s.global_name,
          startAt: s.avail_start_at,
          endAt: s.avail_end_at,
        })),
        bestCandidate: best.get(candidate.id) ?? null,
      };
    }),
  });
});

pollRoutes.post('/:eventId/window', async (c) => {
  const userId = c.get('userId');
  const eventId = c.req.param('eventId');

  const event = await c.env.DB.prepare(`SELECT * FROM events WHERE id = ?`).bind(eventId).first<EventRow>();
  if (!event || event.event_type !== 'poll' || event.window_block_minutes == null) return c.text('Not found', 404);
  if (event.status !== 'active') return c.text('Voting is closed for this event', 400);
  if (!(await requireInvitedOrOrganizer(c.env, eventId, userId))) return c.text('Forbidden', 403);

  const rawBody = await readJsonBody<{ optionId?: string; startAt: number; endAt: number }>(c);
  const startAt = assertSafeInt(rawBody.startAt, 'startAt');
  const endAt = assertSafeInt(rawBody.endAt, 'endAt');
  assertTimeRange(startAt, endAt, 'availability');

  // `optionId` is optional for one specific reason, and it is not
  // convenience: the previous frontend submits a range with no candidate
  // named, because a window poll used to have exactly one window. The Worker
  // deploys before Pages does, so for a few minutes that is a live client.
  // Defaulting is safe precisely where it is unambiguous -- a poll with one
  // candidate -- and refuses otherwise rather than guessing.
  const candidates = await getWindowedCandidates(c.env, eventId);
  const optionId = rawBody.optionId === undefined ? candidates[0]?.id : assertString(rawBody.optionId, 'optionId', 64);
  if (rawBody.optionId === undefined && candidates.length !== 1) {
    return c.text('optionId is required for a poll with more than one window', 400);
  }
  const option = candidates.find((o) => o.id === optionId);
  if (!option) return c.text('Invalid option', 400);

  if (
    startAt < option.startAt ||
    endAt > option.endAt ||
    endAt - startAt < event.window_block_minutes * 60 * 1000
  ) {
    return c.text('Submitted range must fall within the window and cover at least one full block', 400);
  }

  // Invite lists are already capped (see MAX_RESOLVED_INVITEES), which
  // indirectly bounds distinct submitters since submission requires an
  // invite -- this is just a direct backstop against a pre-cap event row.
  // Counted per candidate now, since that is what the table is keyed on.
  const { results: existingCount } = await c.env.DB.prepare(
    `SELECT COUNT(*) as n FROM event_window_availability WHERE option_id = ? AND user_id != ?`,
  )
    .bind(optionId, userId)
    .all<{ n: number }>();
  if ((existingCount[0]?.n ?? 0) >= LIMITS.MAX_WINDOW_SUBMISSIONS) {
    return c.text('This poll has reached its maximum number of submissions', 400);
  }

  await c.env.DB.prepare(
    `INSERT INTO event_window_availability (option_id, event_id, user_id, avail_start_at, avail_end_at, submitted_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(option_id, user_id) DO UPDATE SET avail_start_at = excluded.avail_start_at,
       avail_end_at = excluded.avail_end_at, submitted_at = excluded.submitted_at`,
  )
    .bind(optionId, eventId, userId, startAt, endAt, Date.now())
    .run();

  await checkWindowThresholdAndResolve(c.env, event);

  return c.json({ ok: true });
});
