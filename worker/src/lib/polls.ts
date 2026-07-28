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

// One query, not one per option.
//
// This used to load the options and then run an aggregate vote query for each
// one. At the configured MAX_POLL_OPTIONS of 50 that is 51 D1 statements, and
// the Free plan allows 50 per invocation -- so a poll built entirely within
// its own configured limits could not be read at all, before authentication
// and session queries were even counted. Every caller was affected: the poll
// GET route, the threshold check on each vote, and the cron deadline sweep.
//
// The LEFT JOIN keeps options with no votes yet (an INNER JOIN would silently
// drop them), and grouping by vote gives one row per (option, vote) pair to
// fold into the tallies below.
export async function getOptionTallies(env: Env, eventId: string): Promise<OptionTally[]> {
  const { results } = await env.DB.prepare(
    `SELECT o.id, o.display_order, o.start_at, o.end_at, o.confirmed_at,
            v.vote, COUNT(v.user_id) AS n
     FROM event_poll_options o
     LEFT JOIN event_poll_votes v ON v.option_id = o.id
     WHERE o.event_id = ?
     GROUP BY o.id, v.vote
     ORDER BY o.display_order`,
  )
    .bind(eventId)
    .all<{
      id: string;
      display_order: number;
      start_at: number;
      end_at: number;
      confirmed_at: number | null;
      vote: string | null;
      n: number;
    }>();

  const byId = new Map<string, OptionTally>();
  for (const row of results) {
    let t = byId.get(row.id);
    if (!t) {
      t = {
        id: row.id,
        displayOrder: row.display_order,
        startAt: row.start_at,
        endAt: row.end_at,
        confirmedAt: row.confirmed_at,
        yes: 0,
        no: 0,
        maybe: 0,
      };
      byId.set(row.id, t);
    }
    // vote is NULL for the LEFT JOIN's no-votes-yet row; COUNT(v.user_id)
    // is 0 there, so there is nothing to add.
    if (row.vote === 'yes' || row.vote === 'no' || row.vote === 'maybe') t[row.vote] = row.n;
  }
  // Map preserves insertion order, which the ORDER BY above made display order.
  return [...byId.values()];
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
// Structural so this module doesn't depend on the cron's budget type.
export interface WorkBudget {
  trySpend(queries: number): boolean;
}

// What resolving one poll costs: reading its tallies or window submissions,
// plus the state transition. Charged up front so the sweep stops walking
// polls once the tick can no longer afford one.
const RESOLUTION_COST_PER_POLL = 3;

// How many expired polls one invocation will look at. Previously unbounded:
// every expired active poll in the database was loaded and resolved in a
// single pass, ahead of the budgeted notification work, so a backlog of them
// could consume the tick's entire D1 allowance before a single reminder was
// attempted. Anything not reached stays expired and is picked up next tick.
const MAX_POLLS_RESOLVED_PER_INVOCATION = 25;

// After this many consecutive failures a poll is considered stuck: still
// retried on every pass, but ordered behind every healthy poll so it cannot
// hold a place in the page. Three is enough to ride out transient D1 or
// Discord trouble without letting a genuinely broken row settle in.
const POLL_RESOLUTION_DEAD_LETTER_AFTER = 3;

export async function resolvePastDeadlinePolls(env: Env, budget?: WorkBudget): Promise<string[]> {
  const now = Date.now();
  // Ordered by failure count first, then by deadline.
  //
  // A poll that fails to resolve stays 'active' and stays past its deadline,
  // so it matches this predicate again on the very next tick -- in the same
  // position, because the ordering was purely by deadline. Twenty-five
  // deterministically failing rows therefore filled the page forever and no
  // poll behind them was ever selected again. The per-row try/catch below
  // isolates failures *within* the page; nothing was getting anything *past*
  // it.
  //
  // Sorting by failure count fixes that without abandoning the broken rows:
  // a poll that has failed repeatedly sinks behind everything healthy, so
  // later due polls enter the page, while the stuck row is still picked up
  // on every pass that has room for it. Deliberately not "cancel the poll
  // after N failures" -- an internal error is not a product decision, and
  // silently cancelling someone's event because a query misbehaved is worse
  // than resolving it late.
  const { results: events } = await env.DB.prepare(
    `SELECT * FROM events WHERE event_type = 'poll' AND status = 'active' AND poll_deadline_at <= ?
     ORDER BY poll_resolution_failures, poll_deadline_at, id
     LIMIT ?`,
  )
    .bind(now, MAX_POLLS_RESOLVED_PER_INVOCATION)
    .all<EventRow>();

  const resolvedEventIds: string[] = [];
  for (const event of events) {
    if (budget && !budget.trySpend(RESOLUTION_COST_PER_POLL)) break;
    try {
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
    } catch (err) {
      // One malformed/expensive poll record must not stop the deadline sweep
      // from resolving the rest -- it'll be retried (still 'active' and past
      // its deadline) on the next tick rather than silently blocking others.
      console.error(`resolvePastDeadlinePolls failed for event ${event.id}:`, err);
      // Counted so the ordering above can deprioritise it. Best-effort: if
      // this write itself fails there is nothing useful left to do, and
      // swallowing it keeps one broken row from turning into a thrown sweep.
      try {
        const failures = (event.poll_resolution_failures ?? 0) + 1;
        await env.DB.prepare(
          `UPDATE events SET poll_resolution_failures = poll_resolution_failures + 1 WHERE id = ?`,
        )
          .bind(event.id)
          .run();
        if (failures === POLL_RESOLUTION_DEAD_LETTER_AFTER) {
          console.error(
            `Poll ${event.id} has failed to resolve ${failures} times and is now deprioritised behind healthy polls. ` +
              `Investigate: SELECT * FROM events WHERE poll_resolution_failures >= ${POLL_RESOLUTION_DEAD_LETTER_AFTER};`,
          );
        }
      } catch (countErr) {
        console.error(`Could not record resolution failure for event ${event.id}:`, countErr);
      }
    }
  }
  return resolvedEventIds;
}
