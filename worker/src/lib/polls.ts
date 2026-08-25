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
  // Windowed polls are counted from submitted ranges, not from yes/no votes,
  // so they go the other way -- see checkWindowThresholdAndResolve. This is
  // the fixed-slot half of the merged model (specs/0013), and it is decided
  // by `window_block_minutes` rather than by `poll_mode`, which nothing reads
  // any more.
  if (event.event_type !== 'poll' || event.window_block_minutes != null) return [];
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

// The same search, but returning the *longest* span that still reaches the
// best achievable coverage rather than a block of exactly `minBlockMinutes`
// (IDEAS 40, specs/0013). The minimum stops being the session length and
// becomes a floor: "two and a half hours at least, and if everyone is free
// all afternoon on the 30th then we play all afternoon."
//
// Two objectives need an order and the order is not arbitrary: **most people
// first, then longest.** Trading a player for an extra half hour would be
// choosing a longer session with fewer people in it, which is the wrong way
// round for this app. So coverage is fixed to the maximum a minimum-length
// block can achieve, and only then is the span stretched.
//
// It stays cheap by not searching over pairs. For a given start `s`, the
// latest end that `target` people can all reach is simply the `target`-th
// largest `endAt` among submissions that begin at or before `s` -- so the
// answer for every start comes from one pass, not from trying every end.
//
// Ties go to the earliest start (`>` rather than `>=` below), matching what
// the existing window resolution already does for equal counts: soonest wins.
export function bestWindowSpan(
  windowStart: number,
  windowEnd: number,
  minBlockMinutes: number,
  submissions: { startAt: number; endAt: number }[],
): WindowCandidate | null {
  const blockMs = minBlockMinutes * 60 * 1000;
  if (blockMs <= 0 || windowEnd <= windowStart) return null;

  // `bestWindowBlock` already refuses an over-sized window, and this is the
  // same refusal -- but it now matters *per candidate* rather than per poll.
  // Work used to be bounded once for a poll's single window; a poll can now
  // carry MAX_POLL_OPTIONS of them, so the ceiling is checked on each one and
  // twenty candidates cannot buy twenty times the work.
  const base = bestWindowBlock(windowStart, windowEnd, minBlockMinutes, submissions);
  if (!base || base.count === 0) return base;
  const target = base.count;

  // `top` holds the `target` largest `endAt` values among the submissions
  // eligible at the current start, ascending -- so `top[0]` is the
  // `target`-th largest, which is exactly the latest end all of them reach.
  // The eligible set only grows as `s` advances, so this is filled once
  // across the whole sweep rather than rebuilt at every step.
  const byStart = [...submissions].sort((a, b) => a.startAt - b.startAt);
  const top: number[] = [];
  let next = 0;
  let best: WindowCandidate | null = null;

  for (let s = windowStart; s + blockMs <= windowEnd; s += WINDOW_STEP_MS) {
    while (next < byStart.length && byStart[next].startAt <= s) {
      let i = top.length;
      top.push(byStart[next++].endAt);
      while (i > 0 && top[i - 1] > top[i]) {
        const swap = top[i - 1];
        top[i - 1] = top[i];
        top[i] = swap;
        i--;
      }
      // Ascending, so dropping the front drops the smallest -- what is kept
      // is the `target` largest.
      if (top.length > target) top.shift();
    }
    if (top.length < target) continue;

    const e = Math.min(top[0], windowEnd);
    if (e - s < blockMs) continue;
    if (!best || e - s > best.endAt - best.startAt) best = { startAt: s, endAt: e, count: target };
  }

  // `base`'s own start always satisfies the loop above, so this is a
  // belt-and-braces fallback rather than a reachable branch.
  return best ?? base;
}

// Every submission on a poll, grouped by the candidate it was made on.
//
// One query for the whole poll rather than one per candidate: a poll can
// carry MAX_POLL_OPTIONS windows, and twenty statements to resolve one poll
// would not survive the Free plan's fifty-per-invocation allowance -- the
// same reasoning that made getOptionTallies a single query.
export interface WindowedCandidate {
  id: string;
  displayOrder: number;
  startAt: number;
  endAt: number;
  confirmedAt: number | null;
  submissions: { startAt: number; endAt: number }[];
}

export async function getWindowedCandidates(env: Env, eventId: string): Promise<WindowedCandidate[]> {
  const { results } = await env.DB.prepare(
    `SELECT o.id, o.display_order, o.start_at, o.end_at, o.confirmed_at,
            a.avail_start_at, a.avail_end_at
     FROM event_poll_options o
     LEFT JOIN event_window_availability a ON a.option_id = o.id
     WHERE o.event_id = ?
     ORDER BY o.display_order, o.id`,
  )
    .bind(eventId)
    .all<{
      id: string;
      display_order: number;
      start_at: number;
      end_at: number;
      confirmed_at: number | null;
      avail_start_at: number | null;
      avail_end_at: number | null;
    }>();

  const byId = new Map<string, WindowedCandidate>();
  for (const row of results) {
    let c = byId.get(row.id);
    if (!c) {
      c = {
        id: row.id,
        displayOrder: row.display_order,
        startAt: row.start_at,
        endAt: row.end_at,
        confirmedAt: row.confirmed_at,
        submissions: [],
      };
      byId.set(row.id, c);
    }
    // NULL for the LEFT JOIN's nobody-has-submitted-yet row.
    if (row.avail_start_at != null && row.avail_end_at != null) {
      c.submissions.push({ startAt: row.avail_start_at, endAt: row.avail_end_at });
    }
  }
  return [...byId.values()];
}

// The best span each candidate can offer, in candidate order. Everything
// that has to choose between candidates -- resolution, the poll route, the
// DM copy -- reads this rather than re-deriving it.
export function resolveWindowedCandidates(
  event: EventRow,
  candidates: WindowedCandidate[],
): { candidate: WindowedCandidate; best: WindowCandidate | null }[] {
  const blockMinutes = event.window_block_minutes;
  if (blockMinutes == null) return [];
  return candidates.map((candidate) => ({
    candidate,
    // The MAX_WINDOW_CANDIDATES ceiling inside this call is now checked per
    // candidate, which is the tightening specs/0013 asked for: work used to
    // be bounded once per poll, and a poll can now hold twenty windows.
    best: bestWindowSpan(candidate.startAt, candidate.endAt, blockMinutes, candidate.submissions),
  }));
}

// Confirming one windowed candidate in multi-winner mode.
//
// Unlike a fixed candidate, a window does not know its own session time
// until it resolves -- so confirmation narrows the row from the window to
// the span that actually won. Both writes are in the one compare-and-set, so
// a candidate cannot be confirmed twice or be left confirmed with its window
// still in place.
async function confirmWindowedOption(env: Env, optionId: string, span: WindowCandidate): Promise<boolean> {
  const result = await env.DB.prepare(
    `UPDATE event_poll_options SET confirmed_at = ?, start_at = ?, end_at = ? WHERE id = ? AND confirmed_at IS NULL`,
  )
    .bind(Date.now(), span.startAt, span.endAt, optionId)
    .run();
  return result.meta.changes > 0;
}

// Called synchronously after an attendee submits or updates their
// availability on one candidate.
//
// Single-winner: the first candidate (in display order) whose best span
// clears the threshold resolves the whole poll, and the event takes that
// span as its time. Multi-winner: every candidate that clears it is
// confirmed independently, which is what multi-winner already means for
// fixed slots -- windows compose with it rather than being excluded from it.
//
// Returns the option ids newly settled by *this* call, so the caller can
// notify exactly those.
export async function checkWindowThresholdAndResolve(env: Env, event: EventRow): Promise<string[]> {
  if (event.event_type !== 'poll' || event.window_block_minutes == null || event.status !== 'active') return [];
  if (event.poll_strategy !== 'threshold' || !event.poll_threshold_count) return [];

  const resolved = resolveWindowedCandidates(event, await getWindowedCandidates(env, event.id));
  const threshold = event.poll_threshold_count;

  if (event.poll_resolution_mode === 'multi_winner') {
    const newlyConfirmed: string[] = [];
    for (const { candidate, best } of resolved) {
      if (candidate.confirmedAt || !best || best.count < threshold) continue;
      if (await confirmWindowedOption(env, candidate.id, best)) newlyConfirmed.push(candidate.id);
    }
    return newlyConfirmed;
  }

  const winner = resolved.find(({ best }) => best && best.count >= threshold);
  if (winner && (await markResolved(env, event.id, { id: winner.candidate.id, ...winner.best! }))) {
    return [winner.candidate.id];
  }
  return [];
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

      if (event.window_block_minutes != null) {
        // No threshold to clear at the deadline -- whatever people managed
        // to agree on wins, the same way pickMostVotes settles a fixed-slot
        // poll below. The candidate with the most coverage takes it; ties go
        // to the longer session, then to the earlier candidate.
        const resolved = resolveWindowedCandidates(event, await getWindowedCandidates(env, event.id));
        const winner = resolved
          .filter((r) => r.best && r.best.count > 0)
          .sort((a, b) => {
            if (b.best!.count !== a.best!.count) return b.best!.count - a.best!.count;
            const lenA = a.best!.endAt - a.best!.startAt;
            const lenB = b.best!.endAt - b.best!.startAt;
            if (lenB !== lenA) return lenB - lenA;
            return a.candidate.displayOrder - b.candidate.displayOrder || a.candidate.id.localeCompare(b.candidate.id);
          })[0];
        if (winner) {
          await markResolved(env, event.id, { id: winner.candidate.id, ...winner.best! });
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
