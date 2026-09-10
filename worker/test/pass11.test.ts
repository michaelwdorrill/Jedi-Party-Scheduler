import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/router';
import { base64UrlEncode } from '../src/lib/base64url';
import { deleteUserCompletely } from '../src/lib/db';
import { updateEvent } from '../src/lib/eventWrites';
import { buildNoticeboard } from '../src/lib/noticeboard';
import { signJwt } from '../src/lib/jwt';
import { createSession } from '../src/lib/sessions';
import { signToken } from '../src/lib/signedToken';
import { runReminderSweep } from '../src/cron/reminders';
import type { Env } from '../src/env';
import type { EventWriteInput } from '../src/lib/eventWrites';
import { D1_FREE_PLAN_QUERY_BUDGET, type ShimDatabase } from './d1shim';
import {
  countRows,
  DAY_MS,
  DM_CHANNEL_RULE,
  dmSendRule,
  HOUR_MS,
  loadEventRow,
  membershipRule,
  seedAttendance,
  seedEvent,
  seedGuild,
  seedInvite,
  seedMembership,
  seedUser,
  setup,
  stubFetch,
  type FetchStub,
} from './helpers';

// Pass 11 review (September 2026) -- the first structured pass over Phase 4
// (specs/0015, 0016) and Phase 5 (specs/0007, 0017), reviewed at e5180a0 by
// two independent reviewers whose findings are merged here. One describe()
// per finding, finding id in the title, same shape as pass9/pass10.
//
// Findings carry both reviewers' ids where both found it (F-15 / R04); a
// single id means only one of them did. Blocks land as their fixes do.

let fetchStub: FetchStub | null = null;
afterEach(() => {
  fetchStub?.restore();
  fetchStub = null;
  vi.useRealTimers();
});

// Two users in one guild, B invited to A's event. The shape every F-15
// scenario starts from.
async function seedOrganizerAndInvitee(db: ShimDatabase): Promise<{ eventId: string }> {
  await seedGuild(db);
  await seedUser(db, 'alice');
  await seedUser(db, 'bob');
  await seedMembership(db, 'alice', 'guild-1');
  await seedMembership(db, 'bob', 'guild-1');
  const eventId = await seedEvent(db, { id: 'ev-1', organizerId: 'alice' });
  await seedInvite(db, eventId, 'bob');
  return { eventId };
}

async function seedChangeRequest(
  db: ShimDatabase,
  id: string,
  eventId: string,
  requesterId: string,
  extra: { kind?: 'time_change' | 'add_invitee'; targetUserId?: string | null } = {},
): Promise<void> {
  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO event_change_requests
         (id, event_id, requester_id, kind, proposed_start_at, proposed_end_at, target_user_id, event_revision, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`,
    )
    .bind(
      id,
      eventId,
      requesterId,
      extra.kind ?? 'time_change',
      extra.kind === 'add_invitee' ? null : now + 2 * DAY_MS,
      extra.kind === 'add_invitee' ? null : now + 2 * DAY_MS + HOUR_MS,
      extra.targetUserId ?? null,
      now,
    )
    .run();
}

// ---------------------------------------------------------------------------
// F-15 / R04
// ---------------------------------------------------------------------------

// deleteUserCompletely never cleared organizer_rsvp_notice_log (as responder),
// event_change_requests (as requester or target), event_change_request_votes
// or change_request_log. All four reference users(id) with no ON DELETE
// action, so the final `DELETE FROM users` failed and D1 rolled the whole
// batch back -- DELETE /me answered 500, and the stale-account purge re-threw
// every tick for that account. The organizer_rsvp_notice_log case is the
// common one: the cron writes one row per RSVP to another person's active
// event (migration 0035) and never removes it, so anyone who had ever pressed
// a button on a DM about someone else's event was undeletable.
describe('account deletion clears every table that references the user (F-15 / R04)', () => {
  it("deletes a user who responded to someone else's event once the RSVP-notice log has recorded it", async () => {
    const { db, env } = setup();
    const { eventId } = await seedOrganizerAndInvitee(db);
    const now = Date.now();
    await seedAttendance(db, eventId, 'bob', 'accepted');
    await db
      .prepare(
        `INSERT INTO organizer_rsvp_notice_log
           (id, organizer_id, event_id, occurrence_date, responder_id, responded_at, sent_at, delivered_at)
         VALUES ('n1', 'alice', ?, '', 'bob', ?, ?, ?)`,
      )
      .bind(eventId, now, now, now)
      .run();

    await expect(deleteUserCompletely(env, 'bob')).resolves.toBeUndefined();

    expect(await countRows(db, 'users', 'id = ?', 'bob')).toBe(0);
    expect(await countRows(db, 'organizer_rsvp_notice_log', 'responder_id = ?', 'bob')).toBe(0);
    // Alice's event is untouched -- only Bob's rows went.
    expect(await countRows(db, 'events', 'id = ?', eventId)).toBe(1);
  });

  it("deletes a user who filed a change request on someone else's event", async () => {
    const { db, env } = setup();
    const { eventId } = await seedOrganizerAndInvitee(db);
    await seedChangeRequest(db, 'cr1', eventId, 'bob');

    await expect(deleteUserCompletely(env, 'bob')).resolves.toBeUndefined();

    expect(await countRows(db, 'users', 'id = ?', 'bob')).toBe(0);
    expect(await countRows(db, 'event_change_requests', 'requester_id = ?', 'bob')).toBe(0);
  });

  it('deletes a user who voted on a change request they did not file', async () => {
    const { db, env } = setup();
    const { eventId } = await seedOrganizerAndInvitee(db);
    await seedUser(db, 'carol');
    await seedMembership(db, 'carol', 'guild-1');
    await seedInvite(db, eventId, 'carol');
    await seedChangeRequest(db, 'cr1', eventId, 'carol');
    await db
      .prepare(
        `INSERT INTO event_change_request_votes (request_id, user_id, vote, voted_at) VALUES ('cr1', 'bob', 'yes', ?)`,
      )
      .bind(Date.now())
      .run();

    await expect(deleteUserCompletely(env, 'bob')).resolves.toBeUndefined();

    expect(await countRows(db, 'users', 'id = ?', 'bob')).toBe(0);
    expect(await countRows(db, 'event_change_request_votes', 'user_id = ?', 'bob')).toBe(0);
    // Carol's request survives; it was hers.
    expect(await countRows(db, 'event_change_requests', 'id = ?', 'cr1')).toBe(1);
  });

  it('deletes a user who was DMed about a change request through change_request_log', async () => {
    const { db, env } = setup();
    const { eventId } = await seedOrganizerAndInvitee(db);
    await seedUser(db, 'carol');
    await seedMembership(db, 'carol', 'guild-1');
    await seedChangeRequest(db, 'cr1', eventId, 'carol');
    const now = Date.now();
    await db
      .prepare(
        `INSERT INTO change_request_log (id, request_id, user_id, notification_type, sent_at, delivered_at)
         VALUES ('l1', 'cr1', 'bob', 'change_request_opened', ?, ?)`,
      )
      .bind(now, now)
      .run();

    await expect(deleteUserCompletely(env, 'bob')).resolves.toBeUndefined();

    expect(await countRows(db, 'users', 'id = ?', 'bob')).toBe(0);
    expect(await countRows(db, 'change_request_log', 'user_id = ?', 'bob')).toBe(0);
  });

  it("deletes a user who is the target of someone else's add_invitee request", async () => {
    const { db, env } = setup();
    const { eventId } = await seedOrganizerAndInvitee(db);
    await seedUser(db, 'carol');
    await seedMembership(db, 'carol', 'guild-1');
    await seedChangeRequest(db, 'cr1', eventId, 'carol', { kind: 'add_invitee', targetUserId: 'bob' });

    await expect(deleteUserCompletely(env, 'bob')).resolves.toBeUndefined();

    expect(await countRows(db, 'users', 'id = ?', 'bob')).toBe(0);
    expect(await countRows(db, 'event_change_requests', 'target_user_id = ?', 'bob')).toBe(0);
  });

  // decided_by is nulled rather than deleted: the request belongs to whoever
  // filed it, on an event this user does not own, so it has to survive them.
  it("keeps someone else's request but drops the decider when the decider is erased", async () => {
    const { db, env } = setup();
    const { eventId } = await seedOrganizerAndInvitee(db);
    await seedUser(db, 'carol');
    await seedMembership(db, 'carol', 'guild-1');
    await seedChangeRequest(db, 'cr1', eventId, 'carol');
    const now = Date.now();
    await db
      .prepare(`UPDATE event_change_requests SET status = 'declined', decided_at = ?, decided_by = 'bob' WHERE id = 'cr1'`)
      .bind(now)
      .run();

    await expect(deleteUserCompletely(env, 'bob')).resolves.toBeUndefined();

    expect(await countRows(db, 'users', 'id = ?', 'bob')).toBe(0);
    expect(await countRows(db, 'event_change_requests', 'id = ?', 'cr1')).toBe(1);
    expect(await countRows(db, 'event_change_requests', 'decided_by IS NULL AND id = ?', 'cr1')).toBe(1);
    // Still readable as decided -- only the attribution went.
    expect(await countRows(db, 'event_change_requests', 'decided_at IS NOT NULL AND id = ?', 'cr1')).toBe(1);
  });

  // The control the others are measured against: this already passed before
  // the fix, and must keep passing -- the fix is additive.
  it('still deletes an organizer along with their own event and its notice-log rows', async () => {
    const { db, env } = setup();
    const { eventId } = await seedOrganizerAndInvitee(db);
    const now = Date.now();
    await db
      .prepare(
        `INSERT INTO organizer_rsvp_notice_log
           (id, organizer_id, event_id, occurrence_date, responder_id, responded_at, sent_at, delivered_at)
         VALUES ('n1', 'alice', ?, '', 'bob', ?, ?, ?)`,
      )
      .bind(eventId, now, now, now)
      .run();

    await expect(deleteUserCompletely(env, 'alice')).resolves.toBeUndefined();

    expect(await countRows(db, 'users', 'id = ?', 'alice')).toBe(0);
    expect(await countRows(db, 'events')).toBe(0);
    expect(await countRows(db, 'organizer_rsvp_notice_log')).toBe(0);
    expect(await countRows(db, 'users', 'id = ?', 'bob')).toBe(1);
  });

  // The purge path is the same function, so the same rows blocked it -- and
  // the second consequence is that the throw exited sweepStaleAccounts, so one
  // stuck account also stopped every account sorting after it from being
  // warned or purged. Two stale accounts, the first holding an RSVP-notice
  // row: both have to be gone after two ticks (STALE_PURGE_MAX_PER_TICK is 1).
  it('purges both stale accounts across two ticks when the first holds an RSVP-notice row', async () => {
    vi.useFakeTimers();
    const base = Date.UTC(2026, 8, 10, 12, 0, 0);
    vi.setSystemTime(base);

    const { db, env } = setup();
    await seedGuild(db);
    // Two accounts, both a year stale. 'aaa' sorts first; give it an RSVP row
    // on a live event so its erasure would fail under the old statement list.
    for (const id of ['aaa', 'zzz']) {
      await seedUser(db, id);
      await seedMembership(db, id, 'guild-1');
      await db
        .prepare(`UPDATE users SET last_login_at = ?, created_at = ? WHERE id = ?`)
        .bind(base - 366 * DAY_MS, base - 366 * DAY_MS, id)
        .run();
    }
    await seedUser(db, 'organizer');
    await seedMembership(db, 'organizer', 'guild-1');
    // A *past* event, so hasUpcomingStake does not pause the purge.
    const eventId = await seedEvent(db, {
      id: 'ev-past',
      organizerId: 'organizer',
      startAt: base - 2 * DAY_MS,
      endAt: base - 2 * DAY_MS + HOUR_MS,
    });
    await seedInvite(db, eventId, 'aaa');
    await db
      .prepare(
        `INSERT INTO organizer_rsvp_notice_log
           (id, organizer_id, event_id, occurrence_date, responder_id, responded_at, sent_at, delivered_at)
         VALUES ('n1', 'organizer', ?, '', 'aaa', ?, ?, ?)`,
      )
      .bind(eventId, base, base, base)
      .run();

    fetchStub = stubFetch([DM_CHANNEL_RULE, dmSendRule(200)]);

    // STALE_PURGE_MAX_PER_TICK is 1, so two ticks for two accounts.
    await runReminderSweep(env);
    vi.setSystemTime(base + 15 * 60 * 1000);
    await runReminderSweep(env);

    expect(await countRows(db, 'users', 'id = ?', 'aaa')).toBe(0);
    expect(await countRows(db, 'users', 'id = ?', 'zzz')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// F-18 / R03
// ---------------------------------------------------------------------------

// createFannedOutEvent's INSERT omitted is_private and the sweep's SELECT
// never read it, so migration 0038's default (0 = visible) applied to every
// event a confirmed multi-winner option spawned. The organiser ticked "keep
// this one off the noticeboard" on the poll; each confirmed day then appeared
// on it anyway -- title, time, organiser, invitee list and RSVP answers, to
// every member of the server, none of whom were invited.
describe('a private multi-winner poll fans out private events (F-18 / R03)', () => {
  async function seedMultiWinnerPoll(db: ShimDatabase, isPrivate: number): Promise<number> {
    await seedGuild(db);
    await seedUser(db, 'organizer');
    await seedUser(db, 'invitee');
    await seedMembership(db, 'organizer', 'guild-1');
    await seedMembership(db, 'invitee', 'guild-1');

    const now = Date.now();
    await db
      .prepare(
        `INSERT INTO events (id, guild_id, organizer_id, title, event_type, timezone, start_at, end_at, status,
           poll_mode, poll_resolution_mode, is_recurring, is_private, created_at, updated_at)
         VALUES ('poll-1', 'guild-1', 'organizer', 'Private therapy discussion', 'poll', 'America/New_York', NULL, NULL,
           'active', 'options', 'multi_winner', 0, ?, ?, ?)`,
      )
      .bind(isPrivate, now, now)
      .run();
    await seedInvite(db, 'poll-1', 'organizer');
    await seedInvite(db, 'poll-1', 'invitee');
    await db
      .prepare(
        `INSERT INTO event_poll_options (id, event_id, start_at, end_at, display_order, confirmed_at)
         VALUES ('opt-1', 'poll-1', ?, ?, 0, ?)`,
      )
      .bind(now + 3 * DAY_MS, now + 3 * DAY_MS + 2 * HOUR_MS, now)
      .run();
    return now;
  }

  it('copies is_private from the parent poll onto the spawned event and keeps it off the noticeboard', async () => {
    const { db, env } = setup();
    const now = await seedMultiWinnerPoll(db, 1);

    fetchStub = stubFetch([DM_CHANNEL_RULE, dmSendRule(200)]);
    await runReminderSweep(env);

    const spawned = await db
      .prepare(`SELECT id, is_private FROM events WHERE created_from_option_id = 'opt-1'`)
      .first<{ id: string; is_private: number }>();
    expect(spawned).not.toBeNull();
    expect(spawned!.is_private).toBe(1);

    const board = await buildNoticeboard(env, 'guild-1', now, now + 30 * DAY_MS);
    expect(board.map((o) => o.eventId)).not.toContain(spawned!.id);
  });

  // The other direction, so the fix cannot be "always private" -- a poll the
  // organiser left on the noticeboard still spawns days that appear on it.
  it("leaves a public poll's confirmed days on the noticeboard", async () => {
    const { db, env } = setup();
    const now = await seedMultiWinnerPoll(db, 0);

    fetchStub = stubFetch([DM_CHANNEL_RULE, dmSendRule(200)]);
    await runReminderSweep(env);

    const spawned = await db
      .prepare(`SELECT id, is_private FROM events WHERE created_from_option_id = 'opt-1'`)
      .first<{ id: string; is_private: number }>();
    expect(spawned).not.toBeNull();
    expect(spawned!.is_private).toBe(0);

    const board = await buildNoticeboard(env, 'guild-1', now, now + 30 * DAY_MS);
    expect(board.map((o) => o.eventId)).toContain(spawned!.id);
  });
});

// ---------------------------------------------------------------------------
// R05
// ---------------------------------------------------------------------------

// updateEvent treated the presence of `pollOptions` as "replace the candidate
// set", deleting every vote on the event and rebuilding the rows from the
// request. EventFormPage sends that array on every poll save -- it has no
// notion of "the candidates didn't change" -- so correcting a typo in the
// title, or just pressing Save changes, silently destroyed every vote already
// cast. Candidates are reconciled by their (start_at, end_at) slot now, so a
// row that survives keeps its id, its votes, its window submissions and its
// confirmed_at.
describe('editing a poll keeps the votes on candidates that did not change (R05)', () => {
  const SLOTS = [7, 8, 9];

  async function seedPollWithVotes(db: ShimDatabase): Promise<{ now: number; optionIds: string[] }> {
    await seedGuild(db);
    await seedUser(db, 'organizer');
    await seedUser(db, 'voter');
    await seedMembership(db, 'organizer', 'guild-1');
    await seedMembership(db, 'voter', 'guild-1');

    const now = Date.now();
    await seedEvent(db, {
      id: 'poll-1',
      organizerId: 'organizer',
      title: 'Which night?',
      eventType: 'poll',
      startAt: null,
      endAt: null,
    });
    await seedInvite(db, 'poll-1', 'organizer');
    await seedInvite(db, 'poll-1', 'voter');

    const optionIds: string[] = [];
    for (const [index, day] of SLOTS.entries()) {
      const id = `opt-${day}`;
      optionIds.push(id);
      await db
        .prepare(
          `INSERT INTO event_poll_options (id, event_id, start_at, end_at, display_order)
           VALUES (?, 'poll-1', ?, ?, ?)`,
        )
        .bind(id, now + day * DAY_MS, now + day * DAY_MS + HOUR_MS, index)
        .run();
      await db
        .prepare(`INSERT INTO event_poll_votes (option_id, user_id, vote, voted_at) VALUES (?, 'voter', 'yes', ?)`)
        .bind(id, now)
        .run();
    }
    return { now, optionIds };
  }

  const slotsFor = (now: number, days: number[]) =>
    days.map((day) => ({ startAt: now + day * DAY_MS, endAt: now + day * DAY_MS + HOUR_MS }));

  // The reported case: nothing about the candidates changed at all.
  it('keeps every vote when only the title changed', async () => {
    const { db, env } = setup();
    const { now, optionIds } = await seedPollWithVotes(db);

    await updateEvent(
      env,
      'poll-1',
      'guild-1',
      { title: 'Which night? (fixed typo)', pollOptions: slotsFor(now, SLOTS) } as Partial<EventWriteInput>,
      await loadEventRow(db, 'poll-1'),
    );

    expect(await countRows(db, 'event_poll_votes')).toBe(SLOTS.length);
    // The rows themselves survived, so the option ids existing Discord vote
    // messages point at are still the right ones.
    for (const id of optionIds) {
      expect(await countRows(db, 'event_poll_options', 'id = ?', id)).toBe(1);
    }
    const title = await db.prepare(`SELECT title FROM events WHERE id = 'poll-1'`).first<{ title: string }>();
    expect(title?.title).toBe('Which night? (fixed typo)');
  });

  it('keeps the votes on the candidates that survive when one slot is replaced', async () => {
    const { db, env } = setup();
    const { now } = await seedPollWithVotes(db);

    // Day 8 goes, day 12 arrives; days 7 and 9 are untouched.
    await updateEvent(
      env,
      'poll-1',
      'guild-1',
      { pollOptions: slotsFor(now, [7, 12, 9]) } as Partial<EventWriteInput>,
      await loadEventRow(db, 'poll-1'),
    );

    expect(await countRows(db, 'event_poll_votes', 'option_id = ?', 'opt-7')).toBe(1);
    expect(await countRows(db, 'event_poll_votes', 'option_id = ?', 'opt-9')).toBe(1);
    // The candidate the organizer actually removed took its vote with it.
    expect(await countRows(db, 'event_poll_options', 'id = ?', 'opt-8')).toBe(0);
    expect(await countRows(db, 'event_poll_votes', 'option_id = ?', 'opt-8')).toBe(0);
    expect(await countRows(db, 'event_poll_options', 'event_id = ?', 'poll-1')).toBe(3);
  });

  it('reorders surviving candidates without dropping their votes', async () => {
    const { db, env } = setup();
    const { now } = await seedPollWithVotes(db);

    await updateEvent(
      env,
      'poll-1',
      'guild-1',
      { pollOptions: slotsFor(now, [9, 7, 8]) } as Partial<EventWriteInput>,
      await loadEventRow(db, 'poll-1'),
    );

    expect(await countRows(db, 'event_poll_votes')).toBe(SLOTS.length);
    const order = await db
      .prepare(`SELECT id, display_order FROM event_poll_options WHERE event_id = 'poll-1' ORDER BY display_order`)
      .all<{ id: string; display_order: number }>();
    expect(order.results.map((r) => r.id)).toEqual(['opt-9', 'opt-7', 'opt-8']);
  });

  // Window submissions cascade from the candidate row, so they are only safe
  // for as long as the row is.
  it('keeps window-availability submissions across an unrelated edit', async () => {
    const { db, env } = setup();
    const { now } = await seedPollWithVotes(db);
    await db
      .prepare(
        `INSERT INTO event_window_availability (option_id, event_id, user_id, avail_start_at, avail_end_at, submitted_at)
         VALUES ('opt-7', 'poll-1', 'voter', ?, ?, ?)`,
      )
      .bind(now + 7 * DAY_MS, now + 7 * DAY_MS + HOUR_MS, now)
      .run();

    await updateEvent(
      env,
      'poll-1',
      'guild-1',
      { title: 'Renamed', pollOptions: slotsFor(now, SLOTS) } as Partial<EventWriteInput>,
      await loadEventRow(db, 'poll-1'),
    );

    expect(await countRows(db, 'event_window_availability', 'option_id = ?', 'opt-7')).toBe(1);
  });

  // A confirmed multi-winner day is referenced by the event it spawned
  // (events.created_from_option_id, a foreign key with no ON DELETE action),
  // so the blanket delete could not run at all once fan-out had happened.
  it('lets an unrelated edit through on a poll whose day has already fanned out', async () => {
    const { db, env } = setup();
    const { now } = await seedPollWithVotes(db);
    await db.prepare(`UPDATE event_poll_options SET confirmed_at = ? WHERE id = 'opt-7'`).bind(now).run();
    await db
      .prepare(
        `INSERT INTO events (id, guild_id, organizer_id, title, event_type, timezone, start_at, end_at, status,
           poll_mode, poll_resolution_mode, is_recurring, created_from_poll_id, created_from_option_id,
           created_at, updated_at)
         VALUES ('spawned', 'guild-1', 'organizer', 'Which night?', 'single', 'America/New_York', ?, ?, 'active',
           'options', 'single_winner', 0, 'poll-1', 'opt-7', ?, ?)`,
      )
      .bind(now + 7 * DAY_MS, now + 7 * DAY_MS + HOUR_MS, now, now)
      .run();

    await expect(
      updateEvent(
        env,
        'poll-1',
        'guild-1',
        { title: 'Renamed', pollOptions: slotsFor(now, SLOTS) } as Partial<EventWriteInput>,
        await loadEventRow(db, 'poll-1'),
      ),
    ).resolves.toBeUndefined();

    expect(await countRows(db, 'event_poll_options', 'id = ?', 'opt-7')).toBe(1);
    // The confirmation survived too -- it lives on the candidate row.
    expect(await countRows(db, 'event_poll_options', 'confirmed_at IS NOT NULL AND id = ?', 'opt-7')).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// R06
// ---------------------------------------------------------------------------

// sweepMinimumAttendeesDeadlines' recurring arm ran two scalable reads per
// candidate event -- the occurrence overrides, and the recurrence rule
// expandOccurrencesForEvent falls back to loading itself -- and charged the
// budget for neither. resolveMinimumAttendeesDeadline then spent its
// cancellation write and its recipient lookups uncharged too. So an entirely
// valid, in-quota install could sail past Cloudflare's documented 50 D1
// queries per Worker invocation on the Free plan while TickBudget still
// believed it was well inside its allowance: the review measured 89. In
// production that is the invocation failing partway through, every tick,
// against the same workload each time.
//
// Measured against the database rather than the ledger, which is the whole
// point -- the ledger was what was wrong.
describe('a recurring-deadline tick stays inside the Free-plan D1 ceiling (R06)', () => {
  const EVENT_COUNT = 30;

  // Thirty daily recurring events, well under the configured per-guild cap,
  // each with a deadline 24h before an occurrence that is already due.
  async function seedRecurringDeadlineEvents(
    db: ShimDatabase,
    base: number,
    minimumAttendees: number,
  ): Promise<void> {
    await seedGuild(db);
    await seedUser(db, 'organizer');
    await seedMembership(db, 'organizer', 'guild-1');

    const seriesStart = new Date(base + 12 * HOUR_MS);
    const startDate = seriesStart.toISOString().slice(0, 10);
    const startTime = `${String(seriesStart.getUTCHours()).padStart(2, '0')}:${String(seriesStart.getUTCMinutes()).padStart(2, '0')}`;

    for (let i = 0; i < EVENT_COUNT; i++) {
      const id = `rec-${String(i).padStart(2, '0')}`;
      await seedEvent(db, { id, organizerId: 'organizer', isRecurring: 1, startAt: null, endAt: null });
      await db
        .prepare(
          `UPDATE events SET timezone = 'UTC', minimum_attendees = ?, auto_cancel_below_minimum = 0,
             minimum_attendees_deadline_hours_before = 24 WHERE id = ?`,
        )
        .bind(minimumAttendees, id)
        .run();
      await db
        .prepare(
          `INSERT INTO event_recurrence_rules (event_id, freq, interval, start_date, start_time, duration_minutes, end_type)
           VALUES (?, 'DAILY', 1, ?, ?, 60, 'never')`,
        )
        .bind(id, startDate, startTime)
        .run();
      await seedInvite(db, id, 'organizer');
    }
  }

  it('measures actual statements for thirty in-quota recurring events', async () => {
    vi.useFakeTimers();
    const base = Date.UTC(2026, 8, 10, 12, 0, 0);
    vi.setSystemTime(base);

    const { db, env } = setup();
    await seedRecurringDeadlineEvents(db, base, 1);
    // Notifications off, so nothing here is bounded by delivery cost -- what
    // is being measured is the discovery work alone.
    await db.prepare(`UPDATE users SET notifications_enabled = 0 WHERE id = 'organizer'`).run();

    fetchStub = stubFetch([DM_CHANNEL_RULE, dmSendRule(200), membershipRule(200)]);

    db.resetQueryCount();
    await runReminderSweep(env);
    expect(db.queryCount).toBeLessThanOrEqual(D1_FREE_PLAN_QUERY_BUDGET);
  });

  // The other half of R06, and the reason charging the queries is not enough
  // on its own: once the ledger is honest, a tick can only afford a dozen or
  // so events, and both arms of this sweep selected their page with a LIMIT
  // and no cursor. So the same prefix came back every tick and everything
  // behind it was never resolved at all -- ten ticks reached nine of thirty
  // before the keyset cursor was added. Deadlines that silently never resolve
  // are worse than a tick that stops early, which is why this is measured
  // over several ticks rather than one.
  it('reaches every event across successive ticks rather than the same prefix', async () => {
    vi.useFakeTimers();
    let base = Date.UTC(2026, 8, 10, 12, 0, 0);
    vi.setSystemTime(base);

    const { db, env } = setup();
    // Minimum of five against a single attendee, so every occurrence really
    // is below its minimum and owes its organizer a prompt.
    await seedRecurringDeadlineEvents(db, base, 5);

    fetchStub = stubFetch([DM_CHANNEL_RULE, dmSendRule(200), membershipRule(200)]);

    for (let tick = 0; tick < 10; tick++) {
      await runReminderSweep(env);
      base += 15 * 60 * 1000;
      vi.setSystemTime(base);
    }

    const prompted = await db
      .prepare(`SELECT DISTINCT event_id FROM notification_log WHERE notification_type = 'organizer_cancel_prompt'`)
      .all<{ event_id: string }>();
    expect(prompted.results).toHaveLength(EVENT_COUNT);
  });
});

// ---------------------------------------------------------------------------
// R02
// ---------------------------------------------------------------------------

// The Worker used to finish a login by redirecting to
// `${FRONTEND_URL}/#/auth/callback?token=<jwt>`, and the frontend installed
// whatever token was in that fragment as the browser's session. The Discord
// leg was properly CSRF-bound by the oauth_state cookie, but this last hop was
// bound to nothing: anyone holding a valid session could send someone else
// that URL carrying their *own* token, and the visitor silently became logged
// in as them -- then saved personal time, private notes or a Google connection
// into an account the sender controls. Login CSRF, not a stolen token.
//
// The redirect now carries a one-time code that is useless without the
// verifier the initiating browser parked before it ever navigated (PKCE, on
// this app's own final hop). These are the Worker's half; the browser's half
// lives in frontend/src/auth/loginTransaction.ts.
describe('a login can only be completed by the browser that started it (R02)', () => {
  const app = buildApp();
  const call = (env: Env, path: string, init: RequestInit = {}) =>
    app.request(`https://worker.test${path}`, init, env);

  const VERIFIER = 'a-browser-transaction-secret-nobody-else-has';

  async function challengeFor(verifier: string): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    return base64UrlEncode(new Uint8Array(digest));
  }

  async function codeFor(env: Env, userId: string, challenge: string): Promise<string> {
    const { id: sessionId } = await createSession(env, userId);
    return signToken('login_code', { userId, sessionId, challenge }, env.JWT_SIGNING_KEY, 120);
  }

  it('refuses to start a login with no challenge, rather than falling back to the old flow', async () => {
    const { env } = setup();
    const res = await call(env, '/auth/login');
    expect(res.status).toBe(400);
    // Specifically not a redirect to Discord: a login that cannot be bound to
    // this browser must not begin at all.
    expect(res.headers.get('location')).toBeNull();
  });

  it('redeems a code for the browser holding the matching verifier', async () => {
    const { db, env } = setup();
    await seedGuild(db);
    await seedUser(db, 'alice');
    await seedMembership(db, 'alice', 'guild-1');

    const code = await codeFor(env, 'alice', await challengeFor(VERIFIER));
    const res = await call(env, '/auth/redeem', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, verifier: VERIFIER }),
    });

    expect(res.status).toBe(200);
    const { token } = (await res.json()) as { token: string };
    // A real session token: it authenticates against /me like any other.
    const me = await call(env, '/me', { headers: { Authorization: `Bearer ${token}` } });
    expect(me.status).toBe(200);
  });

  // The finding itself. The attacker mints a code through a genuine login of
  // their own, then sends the victim the callback URL carrying it.
  it("refuses a code sent to a browser that never started a login", async () => {
    const { db, env } = setup();
    await seedGuild(db);
    await seedUser(db, 'attacker');
    await seedMembership(db, 'attacker', 'guild-1');

    const attackerCode = await codeFor(env, 'attacker', await challengeFor(VERIFIER));

    // The victim's browser has no verifier for this transaction, so the best
    // it could send is a guess.
    const res = await call(env, '/auth/redeem', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: attackerCode, verifier: 'a-guess' }),
    });

    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain('eyJ');
  });

  it('refuses a forged code, and one signed for a different purpose', async () => {
    const { env } = setup();

    for (const code of [
      'not-a-token',
      // Correctly signed with the real key, but minted for the Google connect
      // flow -- the purpose check is what stops one being spent as the other.
      await signToken('google_connect', { userId: 'alice', challenge: await challengeFor(VERIFIER) }, env.JWT_SIGNING_KEY, 120),
    ]) {
      const res = await call(env, '/auth/redeem', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, verifier: VERIFIER }),
      });
      expect(res.status).toBe(400);
    }
  });

  it('refuses a code whose two-minute window has passed', async () => {
    const { db, env } = setup();
    await seedGuild(db);
    await seedUser(db, 'alice');
    await seedMembership(db, 'alice', 'guild-1');

    const code = await codeFor(env, 'alice', await challengeFor(VERIFIER));
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 3 * 60 * 1000);

    const res = await call(env, '/auth/redeem', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, verifier: VERIFIER }),
    });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// F-16 / R01
// ---------------------------------------------------------------------------

// The most serious finding of the pass, and both reviewers found it. /google/
// start is unauthenticated by construction -- it is the top-level navigation
// that sets the nonce cookie -- so it took the app identity from the signed
// `t` token in its own URL, and that URL is transferable to anyone. An
// attacker could mint one naming their own account, send it to someone else,
// and every downstream check still passed: the state signature was valid, and
// the nonce matched because the *victim's* browser is the one that created it
// at /start. The victim's refresh token was then stored against the attacker's
// user_id, handing them the victim's calendar -- readable through the hourly
// import, writable through the push half -- while the victim's own Settings
// page showed nothing connected.
//
// The missing proof was never a second demonstration that the browser began
// the flow; it was any demonstration that the browser belongs to the account
// being connected. Grants are parked now and claimed through an ordinary
// authenticated request, which is the one hop that can answer that.
describe('a Google grant attaches only to the account that claims it (F-16 / R01)', () => {
  const app = buildApp();
  const ENCRYPTION_KEY = 'test-google-encryption-key-at-least-32-chars';

  const call = (env: Env, path: string, init: RequestInit = {}) =>
    app.request(`https://worker.test${path}`, init, env);

  const googleEnv = (base: Env): Env => ({
    ...base,
    GOOGLE_SYNC_MODE: 'live',
    GOOGLE_CLIENT_ID: 'google-client-id',
    GOOGLE_CLIENT_SECRET: 'google-client-secret',
    GOOGLE_TOKEN_ENCRYPTION_KEY: ENCRYPTION_KEY,
  });

  async function authHeader(env: Env, userId: string): Promise<Record<string, string>> {
    const { id: sessionId } = await createSession(env, userId);
    return {
      Authorization: `Bearer ${await signJwt(userId, sessionId, env.JWT_SIGNING_KEY)}`,
      'Content-Type': 'application/json',
    };
  }

  // Plays the attack out through the real routes: the attacker gets a start
  // URL naming themselves, and the victim's browser is what follows it and
  // consents at Google.
  async function victimConsentsToAttackersLink(
    env: Env,
    attacker: string,
  ): Promise<{ pendingId: string }> {
    const urlRes = await call(env, '/google/connect-url', {
      method: 'POST',
      headers: await authHeader(env, attacker),
    });
    const { startUrl } = await urlRes.json<{ startUrl: string }>();

    // From here on, this is the victim's browser -- it carries no session of
    // the attacker's, only the nonce cookie /start hands it.
    const startRes = await call(env, `/google/start${new URL(startUrl).search}`, { redirect: 'manual' });
    const cookie = startRes.headers.get('set-cookie')!.split(';')[0];
    const state = new URL(startRes.headers.get('location')!).searchParams.get('state')!;

    const cbRes = await call(env, `/google/callback?code=abc&state=${encodeURIComponent(state)}`, {
      headers: { Cookie: cookie },
      redirect: 'manual',
    });
    const location = cbRes.headers.get('location')!;
    return { pendingId: new URL(location.replace('#/', '')).searchParams.get('pending')! };
  }

  it("does not attach the victim's grant to the attacker's account, and revokes it", async () => {
    const { db, env: base } = setup();
    const env = googleEnv(base);
    await seedGuild(db);
    for (const id of ['attacker', 'victim']) {
      await seedUser(db, id);
      await seedMembership(db, id, 'guild-1');
    }

    fetchStub = stubFetch([
      { match: 'oauth2.googleapis.com/token', status: 200, body: { access_token: 'a', refresh_token: 'r', expires_in: 3600 } },
      { match: 'users/me/calendarList', status: 200, body: { items: [{ id: 'victim@gmail.com', summary: 'Personal', accessRole: 'owner', primary: true }] } },
      { match: 'oauth2.googleapis.com/revoke', status: 200, body: {} },
    ]);

    const { pendingId } = await victimConsentsToAttackersLink(env, 'attacker');

    // Nothing is attached to anyone yet -- which is already the difference.
    expect(await countRows(db, 'google_calendar_connections')).toBe(0);

    // The victim's browser lands on Settings and claims the grant, as their
    // own signed-in account. The claim does not match the account the
    // transferable start URL named, so it is refused outright.
    const res = await call(env, '/google/finalize', {
      method: 'POST',
      headers: await authHeader(env, 'victim'),
      body: JSON.stringify({ pendingId }),
    });

    expect(res.status).toBe(403);
    // Neither account ends up holding it.
    expect(await countRows(db, 'google_calendar_connections')).toBe(0);
    // And the grant is torn down at Google rather than left live with nothing
    // here to show for it.
    expect(fetchStub!.calls.some((u) => u.includes('oauth2.googleapis.com/revoke'))).toBe(true);
    // The pending row is spent either way, so a second attempt has nothing.
    expect(await countRows(db, 'google_pending_connections')).toBe(0);
  });

  it('cannot be finalized by the attacker either, since the id only ever reached the other browser', async () => {
    const { db, env: base } = setup();
    const env = googleEnv(base);
    await seedGuild(db);
    for (const id of ['attacker', 'victim']) {
      await seedUser(db, id);
      await seedMembership(db, id, 'guild-1');
    }
    fetchStub = stubFetch([
      { match: 'oauth2.googleapis.com/token', status: 200, body: { access_token: 'a', refresh_token: 'r', expires_in: 3600 } },
      { match: 'users/me/calendarList', status: 200, body: { items: [] } },
      { match: 'oauth2.googleapis.com/revoke', status: 200, body: {} },
    ]);

    await victimConsentsToAttackersLink(env, 'attacker');

    // The attacker never saw the pending id -- it went to the browser that
    // consented -- so the best they can do is guess one.
    const res = await call(env, '/google/finalize', {
      method: 'POST',
      headers: await authHeader(env, 'attacker'),
      body: JSON.stringify({ pendingId: 'a-guessed-id' }),
    });
    expect(res.status).toBe(410);
    expect(await countRows(db, 'google_calendar_connections')).toBe(0);
  });

  it('requires a session at all -- an unauthenticated claim gets nowhere', async () => {
    const { db, env: base } = setup();
    const env = googleEnv(base);
    await seedGuild(db);
    await seedUser(db, 'alice');
    await seedMembership(db, 'alice', 'guild-1');
    fetchStub = stubFetch([
      { match: 'oauth2.googleapis.com/token', status: 200, body: { access_token: 'a', refresh_token: 'r', expires_in: 3600 } },
      { match: 'users/me/calendarList', status: 200, body: { items: [] } },
    ]);

    const { pendingId } = await victimConsentsToAttackersLink(env, 'alice');
    const res = await call(env, '/google/finalize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pendingId }),
    });
    expect(res.status).toBe(401);
    // Still parked, not consumed -- an unauthenticated attempt must not be
    // able to burn somebody else's pending grant either.
    expect(await countRows(db, 'google_pending_connections')).toBe(1);
  });

  it('expires an unclaimed grant rather than leaving it available', async () => {
    const { db, env: base } = setup();
    const env = googleEnv(base);
    await seedGuild(db);
    await seedUser(db, 'alice');
    await seedMembership(db, 'alice', 'guild-1');
    fetchStub = stubFetch([
      { match: 'oauth2.googleapis.com/token', status: 200, body: { access_token: 'a', refresh_token: 'r', expires_in: 3600 } },
      { match: 'users/me/calendarList', status: 200, body: { items: [] } },
    ]);

    const { pendingId } = await victimConsentsToAttackersLink(env, 'alice');

    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 6 * 60 * 1000);

    const res = await call(env, '/google/finalize', {
      method: 'POST',
      headers: await authHeader(env, 'alice'),
      body: JSON.stringify({ pendingId }),
    });
    expect(res.status).toBe(410);
  });

  // Cleared on the path that creates them rather than from the cron, so
  // abandoned grants cannot accumulate without costing a fixed per-tick query
  // -- see storePendingConnection for why that trade matters here.
  it('clears expired grants the next time one is parked', async () => {
    const { db, env: base } = setup();
    const env = googleEnv(base);
    await seedGuild(db);
    await seedUser(db, 'alice');
    await seedMembership(db, 'alice', 'guild-1');
    fetchStub = stubFetch([
      { match: 'oauth2.googleapis.com/token', status: 200, body: { access_token: 'a', refresh_token: 'r', expires_in: 3600 } },
      { match: 'users/me/calendarList', status: 200, body: { items: [] } },
    ]);

    await victimConsentsToAttackersLink(env, 'alice');
    expect(await countRows(db, 'google_pending_connections')).toBe(1);

    // Long enough that the first one is dead, then a second connect attempt.
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 6 * 60 * 1000);
    await victimConsentsToAttackersLink(env, 'alice');

    // Only the live one is left.
    expect(await countRows(db, 'google_pending_connections')).toBe(1);
    expect(await countRows(db, 'google_pending_connections', 'expires_at > ?', Date.now())).toBe(1);
  });

  // Migration 0040 adds another REFERENCES users(id) with no ON DELETE action,
  // which is exactly the shape of F-15 in this same review. Covered here in
  // the same commit as the table, which is the rule that finding established.
  it('does not block account deletion for someone with a grant still pending', async () => {
    const { db, env: base } = setup();
    const env = googleEnv(base);
    await seedGuild(db);
    await seedUser(db, 'alice');
    await seedMembership(db, 'alice', 'guild-1');
    fetchStub = stubFetch([
      { match: 'oauth2.googleapis.com/token', status: 200, body: { access_token: 'a', refresh_token: 'r', expires_in: 3600 } },
      { match: 'users/me/calendarList', status: 200, body: { items: [] } },
      { match: 'oauth2.googleapis.com/revoke', status: 200, body: {} },
    ]);

    await victimConsentsToAttackersLink(env, 'alice');
    expect(await countRows(db, 'google_pending_connections')).toBe(1);

    await expect(deleteUserCompletely(env, 'alice')).resolves.toBeUndefined();
    expect(await countRows(db, 'users', 'id = ?', 'alice')).toBe(0);
    expect(await countRows(db, 'google_pending_connections')).toBe(0);
  });
});
