import type { Env } from '../env';
import type { EventRow } from './events';
import { LIMITS } from './validate';

interface OptionTally {
  id: string;
  displayOrder: number;
  startAt: number;
  endAt: number;
  yes: number;
  no: number;
  maybe: number;
  confirmedAt: number | null;
}

export async function getOptionTallies(env: Env, eventId: string): Promise<OptionTally[]> {
  const { results: options } = await env.DB.prepare(
    `SELECT id, display_order, start_at, end_at, confirmed_at FROM event_poll_options
     WHERE event_id = ? ORDER BY display_order`,
  )
    .bind(eventId)
    .all<{ id: string; display_order: number; start_at: number; end_at: number; confirmed_at: number | null }>();

  const tallies: OptionTally[] = [];
  for (const opt of options) {
    const { results: counts } = await env.DB.prepare(
      `SELECT vote, COUNT(*) as n FROM event_poll_votes WHERE option_id = ? GROUP BY vote`,
    )
      .bind(opt.id)
      .all<{ vote: string; n: number }>();

    const t: OptionTally = {
      id: opt.id,
      displayOrder: opt.display_order,
      startAt: opt.start_at,
      endAt: opt.end_at,
      confirmedAt: opt.confirmed_at,
      yes: 0,
      no: 0,
      maybe: 0,
    };
    for (const c of counts) t[c.vote as 'yes' | 'no' | 'maybe'] = c.n;
    tallies.push(t);
  }
  return tallies;
}

// Compare-and-set: only transitions an event that's still 'active'. Two
// concurrent requests (a synchronous threshold-crossing vote racing the cron
// deadline sweep, or two votes crossing threshold in the same instant) must
// produce exactly one resolution and one notification claim, not two -- the
// WHERE clause makes the database the arbiter instead of a check-then-act
// race in application code. Returns whether *this* call won the transition.
async function markResolved(env: Env, eventId: string, option: { id: string; startAt: number; endAt: number }): Promise<boolean> {
  const result = await env.DB.prepare(
    `UPDATE events SET status = 'resolved', resolved_option_id = ?, start_at = ?, end_at = ?, updated_at = ?
     WHERE id = ? AND status = 'active'`,
  )
    .bind(option.id, option.startAt, option.endAt, Date.now(), eventId)
    .run();
  return result.meta.changes > 0;
}

async function markCancelled(env: Env, eventId: string): Promise<boolean> {
  const result = await env.DB.prepare(`UPDATE events SET status = 'cancelled', updated_at = ? WHERE id = ? AND status = 'active'`)
    .bind(Date.now(), eventId)
    .run();
  return result.meta.changes > 0;
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

// Same compare-and-set principle as markResolved, scoped to one option.
async function confirmOption(env: Env, optionId: string): Promise<boolean> {
  const result = await env.DB.prepare(`UPDATE event_poll_options SET confirmed_at = ? WHERE id = ? AND confirmed_at IS NULL`)
    .bind(Date.now(), optionId)
    .run();
  return result.meta.changes > 0;
}

// Called synchronously after a vote is cast. For 'single_winner' events,
// mirrors the original behavior: the first option to cross the threshold
// resolves the whole event. For 'multi_winner' events, every option is
// checked independently -- each one that crosses the threshold gets its own
// confirmed_at, and the parent event is never marked resolved here (it can
// keep collecting votes on other candidate days). Returns the ids of any
// options newly confirmed in this call, so the caller/cron can notify them.
export async function checkThresholdAndResolve(env: Env, event: EventRow): Promise<string[]> {
  if (event.event_type !== 'poll' || event.poll_mode !== 'options') return [];
  if (event.poll_strategy !== 'threshold' || !event.poll_threshold_count) return [];

  const tallies = await getOptionTallies(env, event.id);

  if (event.poll_resolution_mode === 'multi_winner') {
    if (event.status !== 'active') return [];
    const newlyConfirmed: string[] = [];
    for (const t of tallies) {
      if (!t.confirmedAt && t.yes >= event.poll_threshold_count) {
        if (await confirmOption(env, t.id)) newlyConfirmed.push(t.id);
      }
    }
    return newlyConfirmed;
  }

  if (event.status !== 'active') return [];
  const winner = tallies
    .filter((t) => t.yes >= event.poll_threshold_count!)
    .sort((a, b) => a.displayOrder - b.displayOrder || a.id.localeCompare(b.id))[0];

  if (winner && (await markResolved(env, event.id, winner))) {
    return [winner.id];
  }
  return [];
}

// Finds the block of `blockMinutes` within [windowStart, windowEnd] (stepped
// at 30-minute granularity) covered by the most submitted availability
// ranges. Ties keep the earliest (soonest) candidate, since candidates are
// walked chronologically and only replaced on a strictly higher count.
const WINDOW_STEP_MS = 30 * 60 * 1000;

export interface WindowCandidate {
  startAt: number;
  endAt: number;
  count: number;
}

export function bestWindowBlock(
  windowStart: number,
  windowEnd: number,
  blockMinutes: number,
  submissions: { startAt: number; endAt: number }[],
): WindowCandidate | null {
  const blockMs = blockMinutes * 60 * 1000;
  if (blockMs <= 0 || windowEnd <= windowStart) return null;

  // Write-time validation (see routes/guilds.ts, lib/eventWrites.ts) is
  // supposed to keep every stored window well within this ceiling. This is
  // the last line of defense against a row that predates that validation, or
  // any other path that could otherwise hand this function an attacker-sized
  // span -- without it, work scales with span x submission count, unbounded.
  const candidateCount = Math.floor((windowEnd - blockMs - windowStart) / WINDOW_STEP_MS) + 1;
  if (candidateCount > LIMITS.MAX_WINDOW_CANDIDATES) return null;

  let best: WindowCandidate | null = null;
  for (let s = windowStart; s + blockMs <= windowEnd; s += WINDOW_STEP_MS) {
    const e = s + blockMs;
    const count = submissions.filter((sub) => sub.startAt <= s && sub.endAt >= e).length;
    if (!best || count > best.count) best = { startAt: s, endAt: e, count };
  }
  return best;
}

async function getWindowSubmissions(env: Env, eventId: string) {
  const { results } = await env.DB.prepare(
    `SELECT avail_start_at as "startAt", avail_end_at as "endAt" FROM event_window_availability WHERE event_id = ?`,
  )
    .bind(eventId)
    .all<{ startAt: number; endAt: number }>();
  return results;
}

// Called synchronously after an attendee submits/updates their window
// availability. Window-mode events are always single_winner (enforced at
// creation), so this resolves the whole event, same as the options path.
export async function checkWindowThresholdAndResolve(env: Env, event: EventRow): Promise<boolean> {
  if (event.event_type !== 'poll' || event.poll_mode !== 'window' || event.status !== 'active') return false;
  if (event.poll_strategy !== 'threshold' || !event.poll_threshold_count) return false;
  if (event.window_start_at == null || event.window_end_at == null || event.window_block_minutes == null) return false;

  const submissions = await getWindowSubmissions(env, event.id);
  const best = bestWindowBlock(event.window_start_at, event.window_end_at, event.window_block_minutes, submissions);
  if (best && best.count >= event.poll_threshold_count) {
    return markResolved(env, event.id, { id: 'window', startAt: best.startAt, endAt: best.endAt });
  }
  return false;
}

// Called from the cron sweep for polls whose deadline has passed.
export async function resolvePastDeadlinePolls(env: Env): Promise<string[]> {
  const now = Date.now();
  const { results: events } = await env.DB.prepare(
    `SELECT * FROM events WHERE event_type = 'poll' AND status = 'active' AND poll_deadline_at <= ?`,
  )
    .bind(now)
    .all<EventRow>();

  const resolvedEventIds: string[] = [];
  for (const event of events) {
    if (event.poll_resolution_mode === 'multi_winner') {
      // Unconfirmed options are simply dropped (never voted on again); any
      // already-confirmed options stay confirmed and remain joinable.
      const tallies = await getOptionTallies(env, event.id);
      const anyConfirmed = tallies.some((t) => t.confirmedAt);
      if (anyConfirmed) {
        await env.DB.prepare(`UPDATE events SET status = 'resolved', updated_at = ? WHERE id = ? AND status = 'active'`)
          .bind(now, event.id)
          .run();
      } else {
        await markCancelled(env, event.id);
      }
      resolvedEventIds.push(event.id);
      continue;
    }

    if (event.poll_mode === 'window') {
      if (event.window_start_at != null && event.window_end_at != null && event.window_block_minutes != null) {
        const submissions = await getWindowSubmissions(env, event.id);
        const best = bestWindowBlock(event.window_start_at, event.window_end_at, event.window_block_minutes, submissions);
        if (best && best.count > 0) {
          await markResolved(env, event.id, { id: 'window', startAt: best.startAt, endAt: best.endAt });
        } else {
          await markCancelled(env, event.id);
        }
      } else {
        await markCancelled(env, event.id);
      }
      resolvedEventIds.push(event.id);
      continue;
    }

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
