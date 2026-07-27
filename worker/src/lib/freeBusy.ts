import type { Env } from '../env';
import type { EventRow } from './events';
import { loadOverridesForEvents } from './events';
import { expandOccurrencesForEvent } from './recurrence';
import { expandPersonalOccurrences } from './personalEvents';

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

// Every commitment that should make `userId` look unavailable in the window:
// guild events they organize or accepted, confirmed poll slots they said yes
// to, and personal events flagged busy. Merged into non-overlapping ranges so
// the caller can't infer how many separate things someone has on.
export async function computeBusyBlocks(
  env: Env,
  userId: string,
  fromMs: number,
  toMs: number,
): Promise<BusyBlock[]> {
  const blocks: BusyBlock[] = [];

  // Guild events: organizer always counts; invitees count unless they declined.
  const { results: events } = await env.DB.prepare(
    `SELECT DISTINCT e.* FROM events e
     LEFT JOIN event_invites i ON i.event_id = e.id AND i.user_id = ?
     WHERE e.status IN ('active','resolved')
       AND (e.organizer_id = ? OR (i.user_id IS NOT NULL AND i.rsvp_status != 'declined'))`,
  )
    .bind(userId, userId)
    .all<EventRow>();

  const overridesByEvent = await loadOverridesForEvents(env, events.map((e) => e.id));

  for (const event of events) {
    if (event.event_type === 'poll') {
      // Only slots that actually got confirmed AND that this user said yes to
      // represent a real commitment. Open polls are not commitments.
      const { results: confirmed } = await env.DB.prepare(
        `SELECT o.start_at, o.end_at FROM event_poll_options o
         JOIN event_poll_votes v ON v.option_id = o.id
         WHERE o.event_id = ? AND o.confirmed_at IS NOT NULL AND v.user_id = ? AND v.vote = 'yes'`,
      )
        .bind(event.id, userId)
        .all<{ start_at: number; end_at: number }>();
      for (const opt of confirmed) {
        if (opt.start_at <= toMs && opt.end_at >= fromMs) {
          blocks.push({ startAt: opt.start_at, endAt: opt.end_at });
        }
      }
      // A single_winner poll that resolved sets start_at/end_at on the event
      // itself, so fall through to pick that up too.
      if (event.status !== 'resolved') continue;
    }

    if (!event.is_recurring) {
      if (event.start_at != null && event.start_at <= toMs && (event.end_at ?? event.start_at) >= fromMs) {
        blocks.push({ startAt: event.start_at, endAt: event.end_at ?? event.start_at });
      }
      continue;
    }

    const expanded = await expandOccurrencesForEvent(
      env,
      event,
      fromMs,
      toMs,
      overridesByEvent.get(event.id) ?? [],
    );
    for (const occ of expanded) blocks.push({ startAt: occ.startAt, endAt: occ.endAt });
  }

  // Personal events, unless explicitly marked as not-busy.
  const personal = await expandPersonalOccurrences(env, userId, fromMs, toMs);
  for (const occ of personal) {
    if (occ.event.busy) blocks.push({ startAt: occ.startAt, endAt: occ.endAt });
  }

  return merge(blocks);
}
