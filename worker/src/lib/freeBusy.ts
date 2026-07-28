import type { Env } from '../env';
import { chunkIds, placeholders } from './d1';
import type { EventRow } from './events';
import { loadOverridesForEvents } from './events';
import { expandOccurrencesForEvent, loadRecurrenceRulesForEvents } from './recurrence';
import { expandPersonalOccurrencesForUsers } from './personalEvents';
import { FreeBusyTooLargeError, LIMITS } from './validate';

// Deliberately opaque: a busy block carries *only* a time range. No title, no
// game, no guild, no attendees, no event id -- nothing that would let a viewer
// work out what someone is doing or who with. This shape is the privacy
// contract of the whole scheduling-assistant feature; do not widen it.
export interface BusyBlock {
  startAt: number;
  endAt: number;
}

function merge(blocks: BusyBlock[]): BusyBlock[] {
  if (blocks.length === 0) return [];
  const sorted = [...blocks].sort((a, b) => a.startAt - b.startAt);
  const out: BusyBlock[] = [sorted[0]];
  for (const b of sorted.slice(1)) {
    const last = out[out.length - 1];
    if (b.startAt <= last.endAt) {
      last.endAt = Math.max(last.endAt, b.endAt);
    } else {
      out.push({ ...b });
    }
  }
  return out;
}

interface ForUserRow {
  for_user: string;
}

// Computes busy blocks for every user in `userIds` at once, in a handful of
// chunked, set-based queries regardless of how many are requested.
//
// The original version computed each user independently -- roughly six D1
// queries each -- so a full-sized, entirely valid request reached several
// hundred queries in one Worker invocation, far past Cloudflare's
// per-invocation budget on any plan. See LIMITS.MAX_FREE_BUSY_USERS for the
// current cap; it was lowered from 100 to 25 once the *expansion* cost, not
// just the query count, was accounted for.
export async function computeBusyBlocksForUsers(
  env: Env,
  userIds: string[],
  fromMs: number,
  toMs: number,
): Promise<Map<string, BusyBlock[]>> {
  const out = new Map<string, BusyBlock[]>();
  if (userIds.length === 0) return out;
  for (const id of userIds) out.set(id, []);

  // Every guild event any requested user organizes or holds a non-declined
  // invite to. Two queries per chunk (organizer side, invitee side) instead
  // of one per user; `for_user` records which requested user this row is
  // relevant to -- an event can appear once per relevant user (e.g. once for
  // the organizer and once per invitee among the requested set).
  const rows: (EventRow & ForUserRow)[] = [];
  for (const chunk of chunkIds(userIds)) {
    const ph = placeholders(chunk.length);
    const [{ results: organized }, { results: invited }] = await Promise.all([
      env.DB.prepare(
        `SELECT e.*, e.organizer_id AS for_user FROM events e
         WHERE e.status IN ('active','resolved') AND e.organizer_id IN (${ph})`,
      )
        .bind(...chunk)
        .all<EventRow & ForUserRow>(),
      env.DB.prepare(
        `SELECT e.*, ei.user_id AS for_user FROM event_invites ei
         JOIN events e ON e.id = ei.event_id
         WHERE e.status IN ('active','resolved') AND ei.rsvp_status != 'declined' AND ei.user_id IN (${ph})`,
      )
        .bind(...chunk)
        .all<EventRow & ForUserRow>(),
    ]);
    rows.push(...organized, ...invited);
  }

  // Collapse the per-(event, user) rows into one entry per *event*, carrying
  // the set of requested users it's relevant to. This is the difference
  // between work that scales with users x events and work that scales with
  // events: an event shared by all 25 requested users appeared 25 times in
  // `rows`, and the previous version expanded its recurrence 25 separate
  // times to produce 25 identical occurrence lists.
  const eventsById = new Map<string, EventRow>();
  const usersByEvent = new Map<string, string[]>();
  for (const row of rows) {
    if (!eventsById.has(row.id)) {
      eventsById.set(row.id, row);
      usersByEvent.set(row.id, []);
    }
    const users = usersByEvent.get(row.id)!;
    if (!users.includes(row.for_user)) users.push(row.for_user);
  }

  const eventIds = [...eventsById.keys()];
  const overridesByEvent = await loadOverridesForEvents(env, eventIds);
  const recurrenceRulesByEvent = await loadRecurrenceRulesForEvents(
    env,
    eventIds.filter((id) => eventsById.get(id)!.is_recurring),
  );
  const confirmedVotesByEvent = await loadConfirmedYesVotesForEvents(
    env,
    eventIds.filter((id) => eventsById.get(id)!.event_type === 'poll'),
    userIds,
    fromMs,
    toMs,
  );

  // Every expanded occurrence, for every event and user, counts against one
  // shared ceiling. The per-factor limits should keep a real request far
  // below it -- this is the guarantee that no combination of them multiplies
  // into unbounded work.
  //
  // Exceeding it *refuses the request*. It used to log a warning, break, and
  // return what it had as an ordinary 200 -- but the response shape is a list
  // of busy blocks, so an omitted commitment is indistinguishable from
  // genuine free time. That turned a work limit into a wrong answer: the
  // caller would be told someone is available at a time the database says
  // they are busy, and would schedule over it. Which commitments went missing
  // depended on map iteration order, so it was not even reproducible.
  //
  // A refusal is recoverable -- ask for fewer users or a shorter range -- and
  // it is the one outcome that never asserts something false.
  let budget = LIMITS.MAX_FREE_BUSY_OCCURRENCES;
  const spend = (n: number): void => {
    // `n > budget`, not `>=`: a request that lands exactly on the ceiling has
    // not exceeded it. The old `budget > 0` test rejected the exact-budget
    // case as if it had.
    if (n > budget) throw new FreeBusyTooLargeError();
    budget -= n;
  };

  for (const [eventId, event] of eventsById) {
    const users = usersByEvent.get(eventId)!;

    if (event.event_type === 'poll') {
      // Only slots that actually got confirmed AND that a given user said yes
      // to represent a real commitment. Open polls are not commitments. The
      // loader already filtered these to the requested users and the
      // requested range, so what's here is exactly the work this request is
      // charged for -- not every guild member's vote on every confirmed
      // option, which is what made this path bypass the shared ceiling.
      const votes = confirmedVotesByEvent.get(eventId) ?? [];
      spend(votes.length);
      for (const vote of votes) {
        const blocks = out.get(vote.user_id);
        if (blocks) blocks.push({ startAt: vote.start_at, endAt: vote.end_at });
      }
      // A single_winner poll that resolved sets start_at/end_at on the event
      // itself, so fall through to pick that up too.
      if (event.status !== 'resolved') continue;
    }

    if (!event.is_recurring) {
      if (event.start_at != null && event.start_at <= toMs && (event.end_at ?? event.start_at) >= fromMs) {
        // A non-recurring event contributes one block per relevant requested
        // user -- the same "occurrence x user" cost a recurring event's
        // expansion is charged below, so it has to spend from the same
        // ceiling rather than being free just because there's nothing to
        // expand.
        spend(users.length);
        for (const userId of users) {
          out.get(userId)?.push({ startAt: event.start_at, endAt: event.end_at ?? event.start_at });
        }
      }
      continue;
    }

    // Expanded once, then attributed to every user it applies to.
    const expanded = await expandOccurrencesForEvent(
      env,
      event,
      fromMs,
      toMs,
      overridesByEvent.get(eventId) ?? [],
      recurrenceRulesByEvent.get(eventId),
    );
    spend(expanded.length * users.length);
    for (const userId of users) {
      const blocks = out.get(userId);
      if (!blocks) continue;
      for (const occ of expanded) blocks.push({ startAt: occ.startAt, endAt: occ.endAt });
    }
  }

  // Only 'busy' personal events count as unavailable -- 'considering' is
  // explicitly a non-commitment (still open to being scheduled over) and
  // 'free' is just a personal note. That filter is pushed down into the SQL
  // rather than applied after expansion: previously every active personal
  // event for every requested user was loaded and expanded, then most of the
  // result was discarded here.
  const personalByUser = await expandPersonalOccurrencesForUsers(env, userIds, fromMs, toMs, {
    availability: 'busy',
    maxOccurrences: Math.max(0, budget),
  });
  for (const [userId, occurrences] of personalByUser) {
    const blocks = out.get(userId);
    if (!blocks) continue;
    for (const occ of occurrences) blocks.push({ startAt: occ.startAt, endAt: occ.endAt });
  }

  for (const [userId, blocks] of out) out.set(userId, merge(blocks));
  return out;
}

interface ConfirmedVoteRow {
  event_id: string;
  user_id: string;
  start_at: number;
  end_at: number;
}

// Bulk "who confirmed yes on a locked-in poll option" lookup, chunked by
// event id.
//
// Filtered in SQL by the requested user IDs and the requested time range, not
// just by event ID. A confirmed multi-winner option can carry every guild
// member's vote -- up to the configured 300 invitees -- and the caller only
// ever wants the up-to-25 users it asked about. Reading every voter and
// discarding the rest in memory meant a maximal poll topology (17 polls x 50
// confirmed options x 300 voters) loaded 255,000 rows before any filtering,
// and the discarded rows never touched the occurrence budget at all -- so the
// bypass was both a memory/row-volume problem and a budget-accounting one.
async function loadConfirmedYesVotesForEvents(
  env: Env,
  eventIds: string[],
  userIds: string[],
  fromMs: number,
  toMs: number,
): Promise<Map<string, ConfirmedVoteRow[]>> {
  const map = new Map<string, ConfirmedVoteRow[]>();
  if (eventIds.length === 0 || userIds.length === 0) return map;
  // Reserve room for the requested-user list and the two range bounds
  // alongside the chunked event IDs, so this never risks D1's per-statement
  // bound-parameter ceiling even at the maximum 25 requested users.
  for (const chunk of chunkIds(eventIds, userIds.length + 2)) {
    const { results } = await env.DB.prepare(
      `SELECT o.event_id, v.user_id, o.start_at, o.end_at
       FROM event_poll_options o
       JOIN event_poll_votes v ON v.option_id = o.id
       WHERE o.event_id IN (${placeholders(chunk.length)}) AND o.confirmed_at IS NOT NULL AND v.vote = 'yes'
         AND v.user_id IN (${placeholders(userIds.length)})
         AND o.start_at <= ? AND o.end_at >= ?`,
    )
      .bind(...chunk, ...userIds, toMs, fromMs)
      .all<ConfirmedVoteRow>();
    for (const row of results) {
      if (!map.has(row.event_id)) map.set(row.event_id, []);
      map.get(row.event_id)!.push(row);
    }
  }
  return map;
}
