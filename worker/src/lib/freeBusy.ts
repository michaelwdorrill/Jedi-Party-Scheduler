import type { Env } from '../env';
import { chunkIds, placeholders } from './d1';
import type { EventRow } from './events';
import { loadOverridesForEvents } from './events';
import { expandOccurrencesForEvent, loadRecurrenceRulesForEvents } from './recurrence';
import { expandPersonalOccurrencesForUsers } from './personalEvents';

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

// Computes busy blocks for every user in `userIds` at once. The route this
// serves allows up to 100 requested users, and the previous version computed
// each one independently -- roughly six D1 queries per user, so a
// full-sized, entirely valid request reached several hundred to several
// thousand queries in one Worker invocation, far past Cloudflare's
// per-invocation query budget on any plan. This does the same work with a
// handful of chunked, set-based queries regardless of how many users are
// requested.
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

  const eventIds = [...new Set(rows.map((r) => r.id))];
  const overridesByEvent = await loadOverridesForEvents(env, eventIds);
  const recurrenceRulesByEvent = await loadRecurrenceRulesForEvents(
    env,
    rows.filter((r) => r.is_recurring).map((r) => r.id),
  );
  const confirmedVotesByEvent = await loadConfirmedYesVotesForEvents(
    env,
    rows.filter((r) => r.event_type === 'poll').map((r) => r.id),
  );

  for (const row of rows) {
    const blocks = out.get(row.for_user);
    if (!blocks) continue; // defensive; for_user is always one of userIds

    if (row.event_type === 'poll') {
      // Only slots that actually got confirmed AND that this user said yes to
      // represent a real commitment. Open polls are not commitments.
      for (const vote of confirmedVotesByEvent.get(row.id) ?? []) {
        if (vote.user_id !== row.for_user) continue;
        if (vote.start_at <= toMs && vote.end_at >= fromMs) {
          blocks.push({ startAt: vote.start_at, endAt: vote.end_at });
        }
      }
      // A single_winner poll that resolved sets start_at/end_at on the event
      // itself, so fall through to pick that up too.
      if (row.status !== 'resolved') continue;
    }

    if (!row.is_recurring) {
      if (row.start_at != null && row.start_at <= toMs && (row.end_at ?? row.start_at) >= fromMs) {
        blocks.push({ startAt: row.start_at, endAt: row.end_at ?? row.start_at });
      }
      continue;
    }

    const expanded = await expandOccurrencesForEvent(
      env,
      row,
      fromMs,
      toMs,
      overridesByEvent.get(row.id) ?? [],
      recurrenceRulesByEvent.get(row.id),
    );
    for (const occ of expanded) blocks.push({ startAt: occ.startAt, endAt: occ.endAt });
  }

  // Only 'busy' personal events count as unavailable -- 'considering' is
  // explicitly a non-commitment (still open to being scheduled over) and
  // 'free' is just a personal note.
  const personalByUser = await expandPersonalOccurrencesForUsers(env, userIds, fromMs, toMs);
  for (const [userId, occurrences] of personalByUser) {
    const blocks = out.get(userId);
    if (!blocks) continue;
    for (const occ of occurrences) {
      if (occ.event.availability === 'busy') blocks.push({ startAt: occ.startAt, endAt: occ.endAt });
    }
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
// event id. Filtering by event id alone (rather than also by user id) keeps
// this to one query per <=80-event chunk regardless of how many users were
// requested -- a poll's own voter count is small, so reading every voter for
// these events and filtering to the requested users in memory is cheap.
async function loadConfirmedYesVotesForEvents(
  env: Env,
  eventIds: string[],
): Promise<Map<string, ConfirmedVoteRow[]>> {
  const map = new Map<string, ConfirmedVoteRow[]>();
  for (const chunk of chunkIds(eventIds)) {
    const { results } = await env.DB.prepare(
      `SELECT o.event_id, v.user_id, o.start_at, o.end_at
       FROM event_poll_options o
       JOIN event_poll_votes v ON v.option_id = o.id
       WHERE o.event_id IN (${placeholders(chunk.length)}) AND o.confirmed_at IS NOT NULL AND v.vote = 'yes'`,
    )
      .bind(...chunk)
      .all<ConfirmedVoteRow>();
    for (const row of results) {
      if (!map.has(row.event_id)) map.set(row.event_id, []);
      map.get(row.event_id)!.push(row);
    }
  }
  return map;
}
