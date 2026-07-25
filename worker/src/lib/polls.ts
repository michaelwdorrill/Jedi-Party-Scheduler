import type { Env } from '../env';
import type { EventRow } from './events';

interface OptionTally {
  id: string;
  displayOrder: number;
  startAt: number;
  endAt: number;
  yes: number;
  no: number;
  maybe: number;
}

export async function getOptionTallies(env: Env, eventId: string): Promise<OptionTally[]> {
  const { results: options } = await env.DB.prepare(
    `SELECT id, display_order, start_at, end_at FROM event_poll_options
     WHERE event_id = ? ORDER BY display_order`,
  )
    .bind(eventId)
    .all<{ id: string; display_order: number; start_at: number; end_at: number }>();

  const tallies: OptionTally[] = [];
  for (const opt of options) {
    const { results: counts } = await env.DB.prepare(
      `SELECT vote, COUNT(*) as n FROM event_poll_votes WHERE option_id = ? GROUP BY vote`,
    )
      .bind(opt.id)
      .all<{ vote: string; n: number }>();

    const t: OptionTally = { id: opt.id, displayOrder: opt.display_order, startAt: opt.start_at, endAt: opt.end_at, yes: 0, no: 0, maybe: 0 };
    for (const c of counts) t[c.vote as 'yes' | 'no' | 'maybe'] = c.n;
    tallies.push(t);
  }
  return tallies;
}

async function markResolved(env: Env, eventId: string, option: OptionTally): Promise<void> {
  await env.DB.prepare(
    `UPDATE events SET status = 'resolved', resolved_option_id = ?, start_at = ?, end_at = ?, updated_at = ?
     WHERE id = ?`,
  )
    .bind(option.id, option.startAt, option.endAt, Date.now(), eventId)
    .run();
}

async function markCancelled(env: Env, eventId: string): Promise<void> {
  await env.DB.prepare(`UPDATE events SET status = 'cancelled', updated_at = ? WHERE id = ?`)
    .bind(Date.now(), eventId)
    .run();
}

function pickMostVotes(tallies: OptionTally[]): OptionTally | null {
  const withVotes = tallies.filter((t) => t.yes + t.no + t.maybe > 0);
  if (withVotes.length === 0) return null;
  return [...withVotes].sort((a, b) => {
    if (b.yes !== a.yes) return b.yes - a.yes;
    if (a.no !== b.no) return a.no - b.no;
    if (a.displayOrder !== b.displayOrder) return a.displayOrder - b.displayOrder;
    return a.id.localeCompare(b.id);
  })[0];
}

// Called synchronously after a vote is cast, but only meaningful for the
// 'threshold' strategy -- checks whether any option just crossed the
// configured yes-count and resolves the event immediately if so.
export async function checkThresholdAndResolve(env: Env, event: EventRow): Promise<boolean> {
  if (event.event_type !== 'poll' || event.status !== 'active') return false;
  if (event.poll_strategy !== 'threshold' || !event.poll_threshold_count) return false;

  const tallies = await getOptionTallies(env, event.id);
  const winner = tallies
    .filter((t) => t.yes >= event.poll_threshold_count!)
    .sort((a, b) => a.displayOrder - b.displayOrder || a.id.localeCompare(b.id))[0];

  if (winner) {
    await markResolved(env, event.id, winner);
    return true;
  }
  return false;
}

// Called from the cron sweep for polls whose deadline has passed: resolves
// via most-votes logic regardless of strategy (this is both the primary
// resolution path for 'most_votes' and the fallback for 'threshold' polls
// that never crossed their threshold).
export async function resolvePastDeadlinePolls(env: Env): Promise<string[]> {
  const now = Date.now();
  const { results: events } = await env.DB.prepare(
    `SELECT * FROM events WHERE event_type = 'poll' AND status = 'active' AND poll_deadline_at <= ?`,
  )
    .bind(now)
    .all<EventRow>();

  const resolvedEventIds: string[] = [];
  for (const event of events) {
    const tallies = await getOptionTallies(env, event.id);
    const winner = pickMostVotes(tallies);
    if (winner) {
      await markResolved(env, event.id, winner);
    } else {
      await markCancelled(env, event.id);
    }
    resolvedEventIds.push(event.id);
  }
  return resolvedEventIds;
}
