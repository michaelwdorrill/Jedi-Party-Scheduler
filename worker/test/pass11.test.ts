import { afterEach, describe, expect, it, vi } from 'vitest';
import { DateTime } from 'luxon';
import { expandOccurrences } from '../src/lib/recurrence';
import { buildApp } from '../src/router';
import { base64UrlEncode } from '../src/lib/base64url';
import { deleteUserCompletely } from '../src/lib/db';
import { createEventWithInvites, inviteStatements, updateEvent } from '../src/lib/eventWrites';
import { recordRsvp } from '../src/lib/attendance';
import { LIMITS } from '../src/lib/validate';
import { buildNoticeboard } from '../src/lib/noticeboard';
import { signJwt } from '../src/lib/jwt';
import { createSession } from '../src/lib/sessions';
import { signToken } from '../src/lib/signedToken';
import { seal } from '../src/lib/crypto';
import { revokeToken, storeConnection } from '../src/lib/googleCalendar';
import { runReminderSweep } from '../src/cron/reminders';
import { googleSyncDue, sweepGoogleCalendar } from '../src/cron/googleSync';
import { CURRENT_POLICY_VERSION } from '../src/lib/policy';
import { TickBudget } from '../src/cron/budget';
import type { Env } from '../src/env';
import type { EventWriteInput } from '../src/lib/eventWrites';
import { D1_FREE_PLAN_QUERY_BUDGET, type ShimDatabase } from './d1shim';
import {
  ageSession,
  countRows,
  DAY_MS,
  DM_CHANNEL_RULE,
  dmSendRule,
  HOUR_MS,
  ids,
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

    const board = (await buildNoticeboard(env, 'guild-1', now, now + 30 * DAY_MS)).occurrences;
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

    const board = (await buildNoticeboard(env, 'guild-1', now, now + 30 * DAY_MS)).occurrences;
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
// An identifiable Google account, which `items: []` used to stand in for.
//
// It no longer can (Pass-15 review, P15-05): a calendar list with no primary
// entry on it now means "this account could not be identified", and the
// callback refuses to park a grant it cannot attribute. These five fixtures
// were using an empty list as shorthand for "the list call succeeded" -- none
// of them is about calendar identity, they are all about who may CLAIM a
// parked grant -- so they say what they meant now.
const PRIMARY_CALENDAR = { id: 'someone@gmail.com', summary: 'Personal', accessRole: 'owner', primary: true };

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
      { match: 'users/me/calendarList', status: 200, body: { items: [PRIMARY_CALENDAR] } },
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
      { match: 'users/me/calendarList', status: 200, body: { items: [PRIMARY_CALENDAR] } },
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
      { match: 'users/me/calendarList', status: 200, body: { items: [PRIMARY_CALENDAR] } },
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
      { match: 'users/me/calendarList', status: 200, body: { items: [PRIMARY_CALENDAR] } },
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
      { match: 'users/me/calendarList', status: 200, body: { items: [PRIMARY_CALENDAR] } },
      { match: 'oauth2.googleapis.com/revoke', status: 200, body: {} },
    ]);

    await victimConsentsToAttackersLink(env, 'alice');
    expect(await countRows(db, 'google_pending_connections')).toBe(1);

    await expect(deleteUserCompletely(env, 'alice')).resolves.toBeUndefined();
    expect(await countRows(db, 'users', 'id = ?', 'alice')).toBe(0);
    expect(await countRows(db, 'google_pending_connections')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// F-26 / R07, F-25 / R08, F-23
// ---------------------------------------------------------------------------

// Three leaks of the same shape: an id the caller happens to know was treated
// as permission to use it. Grouped because the fix is the same idea three
// times -- resolve every id against what the caller is actually entitled to.
describe('an id the caller knows is not permission to use it (F-26 / R07, F-25 / R08, F-23)', () => {
  const app = buildApp();
  const call = (env: Env, path: string, init: RequestInit = {}) =>
    app.request(`https://worker.test${path}`, init, env);

  async function authHeader(env: Env, userId: string): Promise<Record<string, string>> {
    const { id: sessionId } = await createSession(env, userId);
    return {
      Authorization: `Bearer ${await signJwt(userId, sessionId, env.JWT_SIGNING_KEY)}`,
      'Content-Type': 'application/json',
    };
  }

  // POST /groups/common-servers passed only the submitted ids to
  // commonServerSet, so any authenticated user could post any Discord ids and
  // be told the id and name of every active server those people share --
  // including servers the caller has no part in. lib/db.ts's FriendWithGuilds
  // comment says a server the caller cannot already see must never leak.
  it('does not name a server the caller is not in', async () => {
    const { db, env } = setup();
    await seedGuild(db, 'guild-1');
    await seedGuild(db, 'guild-secret');
    await seedUser(db, 'caller');
    await seedUser(db, 'subject-a');
    await seedUser(db, 'subject-b');
    // The caller shares guild-1 with both subjects; the subjects also share a
    // second server the caller knows nothing about.
    await seedMembership(db, 'caller', 'guild-1');
    for (const id of ['subject-a', 'subject-b']) {
      await seedMembership(db, id, 'guild-1');
      await seedMembership(db, id, 'guild-secret');
    }

    const res = await call(env, '/groups/common-servers', {
      method: 'POST',
      headers: await authHeader(env, 'caller'),
      body: JSON.stringify({ member_user_ids: ['subject-a', 'subject-b'] }),
    });

    expect(res.status).toBe(200);
    const { servers } = (await res.json()) as { servers: { id: string; name: string }[] };
    expect(servers.map((s) => s.id)).toEqual(['guild-1']);
  });

  // The other half: the answer still has to be right for the picker it exists
  // to serve, which is the one that decides whether a roster is usable.
  it('still answers for a roster the caller really shares a server with', async () => {
    const { db, env } = setup();
    await seedGuild(db, 'guild-1');
    for (const id of ['caller', 'friend']) {
      await seedUser(db, id);
      await seedMembership(db, id, 'guild-1');
    }

    const res = await call(env, '/groups/common-servers', {
      method: 'POST',
      headers: await authHeader(env, 'caller'),
      body: JSON.stringify({ member_user_ids: ['friend'] }),
    });
    const { servers } = (await res.json()) as { servers: { id: string }[] };
    expect(servers.map((s) => s.id)).toEqual(['guild-1']);
  });

  // resolveInviteeUserIds expanded any group id it was handed. Rosters are
  // private everywhere else, but the id leaks through sourceGroupId on
  // GET /events/:id -- so someone removed from a group could keep reading its
  // roster by building an event from it, and every member got an invite DM
  // from a stranger.
  it('refuses a group the organizer does not belong to, and accepts one they do', async () => {
    const { db, env } = setup();
    await seedGuild(db, 'guild-1');
    for (const id of ['outsider', 'insider', 'member-1']) {
      await seedUser(db, id);
      await seedMembership(db, id, 'guild-1');
    }
    const now = Date.now();
    await db
      .prepare(`INSERT INTO groups (id, name, idle_reminder_days, created_by, created_at) VALUES ('grp', 'Private', 2, 'insider', ?)`)
      .bind(now)
      .run();
    for (const id of ['insider', 'member-1']) {
      await db
        .prepare(`INSERT INTO group_members (group_id, user_id, added_at) VALUES ('grp', ?, ?)`)
        .bind(id, now)
        .run();
    }

    fetchStub = stubFetch([membershipRule(200)]);

    const base = {
      title: 'Session',
      description: null,
      game: null,
      timezone: 'UTC',
      eventType: 'single' as const,
      startAt: now + 24 * HOUR_MS,
      endAt: now + 25 * HOUR_MS,
    };

    // The outsider knows the id but is not in the group.
    await expect(
      createEventWithInvites(env, 'guild-1', 'outsider', {
        ...base,
        invites: { userIds: [], groupIds: ['grp'] },
      } as EventWriteInput),
    ).rejects.toThrow(/groups you belong to/i);

    // A member of the same group is unaffected.
    await expect(
      createEventWithInvites(env, 'guild-1', 'insider', {
        ...base,
        invites: { userIds: [], groupIds: ['grp'] },
      } as EventWriteInput),
    ).resolves.toBeTruthy();
  });

  // The additive path had no actor at all before this, so it was the way
  // around the check above even once creation was scoped.
  it('refuses the same group id on the additive invite route', async () => {
    const { db, env } = setup();
    await seedGuild(db, 'guild-1');
    for (const id of ['outsider', 'insider', 'member-1']) {
      await seedUser(db, id);
      await seedMembership(db, id, 'guild-1');
    }
    const now = Date.now();
    await db
      .prepare(`INSERT INTO groups (id, name, idle_reminder_days, created_by, created_at) VALUES ('grp', 'Private', 2, 'insider', ?)`)
      .bind(now)
      .run();
    for (const id of ['insider', 'member-1']) {
      await db
        .prepare(`INSERT INTO group_members (group_id, user_id, added_at) VALUES ('grp', ?, ?)`)
        .bind(id, now)
        .run();
    }
    await seedEvent(db, { id: 'ev-1', organizerId: 'outsider' });

    fetchStub = stubFetch([membershipRule(200)]);

    const res = await call(env, '/events/ev-1/invites', {
      method: 'POST',
      headers: await authHeader(env, 'outsider'),
      body: JSON.stringify({ userIds: [], groupIds: ['grp'] }),
    });
    expect(res.status).toBe(400);
    // member-1 was never invited to anything.
    expect(await countRows(db, 'event_invites', 'user_id = ?', 'member-1')).toBe(0);
  });

  // Diffing free/busy with and without an arbitrary exclude_event_id reveals
  // whether a given person holds a non-declined invite to that event. The
  // parameter is only meaningful for an event the caller can already see.
  it('ignores an exclude_event_id the caller cannot see', async () => {
    const { db, env } = setup();
    await seedGuild(db, 'guild-1');
    for (const id of ['snooper', 'subject', 'organizer']) {
      await seedUser(db, id);
      await seedMembership(db, id, 'guild-1');
    }
    const now = Date.now();
    const from = now;
    const to = now + 7 * DAY_MS;
    // An event the snooper is not invited to, which the subject is.
    await seedEvent(db, {
      id: 'secret',
      organizerId: 'organizer',
      startAt: now + 2 * HOUR_MS,
      endAt: now + 3 * HOUR_MS,
    });
    await seedInvite(db, 'secret', 'subject');

    const headers = await authHeader(env, 'snooper');
    const read = async (query: string) => {
      const res = await call(
        env,
        `/guilds/guild-1/free-busy?from=${from}&to=${to}&user_ids=subject${query}`,
        { headers },
      );
      const body = (await res.json()) as { userId: string; busy: unknown[] }[];
      return body.find((m) => m.userId === 'subject')!.busy.length;
    };

    // Without the fix the excluded read drops a block and the difference is
    // the answer to "is subject invited to `secret`?".
    expect(await read('&exclude_event_id=secret')).toBe(await read(''));
  });
});

// ---------------------------------------------------------------------------
// R09
// ---------------------------------------------------------------------------

// The source-independent retry consumer (migration 0014) checked that the
// recipient was still in the event's server and still had notifications on,
// but never that they were still invited to the event itself. Removing an
// invitee deletes their event_invites and event_attendance rows and nothing
// else -- it has no say over a DM already queued -- so a pending notification
// outlived the access that justified it. This is not a copy of something
// already delivered: delivered_at stays NULL until the unauthorized retry
// sends it, so the removed person learns the private event's title and time,
// or gets a live voice-channel link, for the first time after losing access.
describe('a queued DM does not outlive the access that justified it (R09)', () => {
  async function seedPendingVoiceInvite(db: ShimDatabase): Promise<void> {
    await seedGuild(db);
    await seedUser(db, 'organizer');
    await seedUser(db, 'removed');
    await seedMembership(db, 'organizer', 'guild-1');
    // Still a fully current member of the server -- only their invite goes.
    await seedMembership(db, 'removed', 'guild-1');

    const now = Date.now();
    // Deliberately well past the voice-invite lead window, so the primary
    // voice sweep does not also select this event -- what is under test is the
    // source-independent retry consumer alone, and that consumer scans by
    // next_attempt_at rather than by the event's timing. An event starting
    // within the lead window would have the primary sweep sending the
    // organizer their own (legitimate) copy, which is not the question here.
    await seedEvent(db, {
      id: 'ev-private',
      organizerId: 'organizer',
      title: 'Private therapy discussion',
      startAt: now + 3 * DAY_MS,
      endAt: now + 3 * DAY_MS + HOUR_MS,
    });
    await db
      .prepare(`UPDATE events SET is_private = 1, voice_channel_id = 'vc-1', voice_channel_name = 'Table 1' WHERE id = 'ev-private'`)
      .run();
    await seedInvite(db, 'ev-private', 'removed');
    await seedAttendance(db, 'ev-private', 'removed', 'accepted');

    // An undelivered notification, due for retry, carrying the private
    // content -- exactly what migration 0014's durable content column holds.
    await db
      .prepare(
        `INSERT INTO notification_log
           (id, user_id, event_id, notification_type, occurrence_date, sent_at, next_attempt_at, attempt_count, content)
         VALUES ('nl-1', 'removed', 'ev-private', 'voice_channel_invite', '', ?, ?, 1,
                 '"Private therapy discussion" is starting soon -- join the "Table 1" voice channel')`,
      )
      .bind(now - 60_000, now - 30_000)
      .run();
  }

  it('does not deliver a pending private DM to someone whose invite was removed', async () => {
    const { db, env } = setup();
    await seedPendingVoiceInvite(db);

    // The invite-removal route's actual effect, and all of it.
    await db.prepare(`DELETE FROM event_invites WHERE event_id = 'ev-private' AND user_id = 'removed'`).run();
    await db.prepare(`DELETE FROM event_attendance WHERE event_id = 'ev-private' AND user_id = 'removed'`).run();

    fetchStub = stubFetch([DM_CHANNEL_RULE, dmSendRule(200), membershipRule(200)]);
    await runReminderSweep(env);

    // Nothing carrying the private content went out.
    expect(fetchStub!.bodies.some((b) => (b ?? '').includes('Private therapy discussion'))).toBe(false);
    const row = await db
      .prepare(`SELECT delivered_at FROM notification_log WHERE id = 'nl-1'`)
      .first<{ delivered_at: number | null }>();
    expect(row?.delivered_at).toBeNull();
  });

  // The control: an invitee who still holds their invite is owed the retry,
  // which is the whole reason this consumer exists.
  it('still delivers to someone who is still invited', async () => {
    const { db, env } = setup();
    await seedPendingVoiceInvite(db);

    fetchStub = stubFetch([DM_CHANNEL_RULE, dmSendRule(200), membershipRule(200)]);
    await runReminderSweep(env);

    const row = await db
      .prepare(`SELECT delivered_at FROM notification_log WHERE id = 'nl-1'`)
      .first<{ delivered_at: number | null }>();
    expect(row?.delivered_at).not.toBeNull();
  });

  // The organizer has no event_invites row of their own on every path, so the
  // check has to admit them explicitly or it would silently stop their own
  // retries.
  it('still delivers to the organizer, who holds no invite row', async () => {
    const { db, env } = setup();
    await seedPendingVoiceInvite(db);
    const now = Date.now();
    await db
      .prepare(
        `INSERT INTO notification_log
           (id, user_id, event_id, notification_type, occurrence_date, sent_at, next_attempt_at, attempt_count, content)
         VALUES ('nl-org', 'organizer', 'ev-private', 'voice_channel_invite', '', ?, ?, 1, 'organizer copy')`,
      )
      .bind(now - 60_000, now - 30_000)
      .run();

    fetchStub = stubFetch([DM_CHANNEL_RULE, dmSendRule(200), membershipRule(200)]);
    await runReminderSweep(env);

    const row = await db
      .prepare(`SELECT delivered_at FROM notification_log WHERE id = 'nl-org'`)
      .first<{ delivered_at: number | null }>();
    expect(row?.delivered_at).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// F-17 / R11, R10, R12, F-22
// ---------------------------------------------------------------------------

// Four ways "stop using my calendar" did not stop. Grouped because they are
// one promise -- the Privacy Policy's account of withdrawal -- failing at four
// different points in the same lifecycle.
describe('withdrawing Google access actually withdraws it (F-17 / R11, R10, R12, F-22)', () => {
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

  async function seedConnection(
    db: ShimDatabase,
    userId: string,
    overrides: { readCalendarId?: string | null; email?: string } = {},
  ): Promise<void> {
    const sealed = await seal('stored-refresh-token', ENCRYPTION_KEY);
    const now = Date.now();
    await db
      .prepare(
        `INSERT INTO google_calendar_connections
           (user_id, refresh_token_ciphertext, refresh_token_iv, access_token_ciphertext, access_token_iv,
            access_token_expires_at, google_account_email, calendar_id, read_calendar_id, sync_enabled, status,
            last_synced_at, disconnect_attempts, connected_at, updated_at)
         VALUES (?, ?, ?, NULL, NULL, NULL, ?, 'primary', ?, 1, 'active', NULL, 0, ?, ?)`,
      )
      .bind(
        userId,
        sealed.ciphertext,
        sealed.iv,
        overrides.email ?? 'someone@gmail.com',
        overrides.readCalendarId === undefined ? 'primary' : overrides.readCalendarId,
        now,
        now,
      )
      .run();
  }

  async function seedImported(db: ShimDatabase, userId: string, googleEventId: string): Promise<void> {
    const now = Date.now();
    await db
      .prepare(
        `INSERT INTO personal_events
           (id, user_id, title, description, timezone, start_at, end_at, status, availability, is_recurring,
            google_event_id, created_at, updated_at)
         VALUES (?, ?, 'Dentist', 'root canal, do not reschedule', 'UTC', ?, ?, 'active', 'busy', 0, ?, ?, ?)`,
      )
      .bind(`pe-${googleEventId}`, userId, now + DAY_MS, now + DAY_MS + HOUR_MS, googleEventId, now, now)
      .run();
  }

  // F-17 / R11, found by both reviewers. PATCH readCalendarId:null dropped the
  // imports; DELETE /google did not -- and once the connection row is gone no
  // sync ever reconciles them, while routes/personal.ts answers 409 to any
  // attempt to delete one by hand. The person keeps titles and descriptions
  // from a calendar they disconnected, still counted as busy against them.
  it('drops imported personal time the moment disconnect is requested', async () => {
    const { db, env: base } = setup();
    const env = googleEnv(base);
    await seedGuild(db);
    await seedUser(db, 'u1');
    await seedMembership(db, 'u1', 'guild-1');
    await seedConnection(db, 'u1');
    await seedImported(db, 'u1', 'g-1');
    // A hand-made entry, which must survive: this is about what *reading*
    // created, not about the person's own personal time.
    await db
      .prepare(
        `INSERT INTO personal_events (id, user_id, title, timezone, start_at, end_at, status, availability, is_recurring, created_at, updated_at)
         VALUES ('mine', 'u1', 'Gym', 'UTC', ?, ?, 'active', 'busy', 0, ?, ?)`,
      )
      .bind(Date.now() + DAY_MS, Date.now() + DAY_MS + HOUR_MS, Date.now(), Date.now())
      .run();

    const res = await call(env, '/google', { method: 'DELETE', headers: await authHeader(env, 'u1') });
    expect(res.status).toBe(200);

    expect(await countRows(db, 'personal_events', 'google_event_id IS NOT NULL')).toBe(0);
    expect(await countRows(db, 'personal_events', 'id = ?', 'mine')).toBe(1);
    // Reading is off in the same breath, so nothing re-imports in the window
    // before the sweep finishes the disconnect.
    expect(await countRows(db, 'google_calendar_connections', 'read_calendar_id IS NULL')).toBe(1);
  });

  // R10. The sweep snapshots the connection, awaits Google over the network,
  // then writes. If the person switches reading off during that await, PATCH
  // deletes the imports and clears the preference -- and the older sweep used
  // to write them straight back, permanently, since the next sweep returns
  // early for a null read calendar.
  it('does not write imports back when reading was switched off mid-flight', async () => {
    const { db, env: base } = setup();
    const env = googleEnv(base);
    await seedGuild(db);
    await seedUser(db, 'u1');
    await seedMembership(db, 'u1', 'guild-1');
    await seedConnection(db, 'u1');

    const headers = await authHeader(env, 'u1');
    fetchStub = stubFetch([
      { match: 'oauth2.googleapis.com/token', status: 200, body: { access_token: 'a', expires_in: 3600 } },
      {
        match: '/events',
        status: 200,
        // The opt-out lands while this request is in flight, which is the
        // whole scenario -- a real interleaving, not a doctored database.
        before: async () => {
          await call(env, '/google', {
            method: 'PATCH',
            headers,
            body: JSON.stringify({ readCalendarId: null }),
          });
        },
        body: {
          items: [
            {
              id: 'g-1',
              summary: 'Therapy',
              description: 'private',
              start: { dateTime: new Date(Date.now() + DAY_MS).toISOString() },
              end: { dateTime: new Date(Date.now() + DAY_MS + HOUR_MS).toISOString() },
            },
          ],
        },
      },
    ]);

    await sweepGoogleCalendar(env, new TickBudget('paid'));

    expect(await countRows(db, 'google_calendar_connections', 'read_calendar_id IS NULL')).toBe(1);
    // The finding: nothing the person opted out of got written back.
    expect(await countRows(db, 'personal_events', 'google_event_id IS NOT NULL')).toBe(0);
  });

  // R12. revokeToken never looked at the response and swallowed network
  // errors, so a Google 500 was reported as a successful revocation while the
  // cron deleted the one credential a retry would have needed.
  it('reports a failed revocation as failed rather than as success', async () => {
    fetchStub = stubFetch([{ match: 'oauth2.googleapis.com/revoke', status: 500, body: {} }]);
    expect(await revokeToken('a-token')).toBe(false);

    fetchStub.restore();
    fetchStub = stubFetch([{ match: 'oauth2.googleapis.com/revoke', status: 200, body: {} }]);
    expect(await revokeToken('a-token')).toBe(true);

    // Already-revoked is the outcome being asked for, not a failure to retry.
    fetchStub.restore();
    fetchStub = stubFetch([{ match: 'oauth2.googleapis.com/revoke', status: 400, body: { error: 'invalid_token' } }]);
    expect(await revokeToken('a-token')).toBe(true);
  });

  // F-22. prompt=consent mints a new refresh token every reconnect and the old
  // one stays live at Google until the user hunts it down in their account
  // settings.
  //
  // Narrowed by the Pass-12 review (P12-02), which is why this now seeds a
  // *different* account than the one it stores. This test used to reconnect
  // the same account and assert a revocation, and that expectation was wrong:
  // Google's revocation is grant-level, so revoking the superseded token of a
  // same-account reconnect revokes the grant the replacement was just issued
  // under, destroying the credential F-22's own fix had just stored. The
  // property F-22 was actually after -- a credential we abandon does not stay
  // live at Google unnoticed -- only arises on an account switch, because that
  // is the only case where the old token belongs to a grant nothing else here
  // will ever revoke. The same-account half is pinned in pass12.test.ts.
  it('revokes the superseded grant when the account changes', async () => {
    const { db, env: base } = setup();
    const env = googleEnv(base);
    await seedGuild(db);
    await seedUser(db, 'u1');
    await seedMembership(db, 'u1', 'guild-1');
    await seedConnection(db, 'u1', { email: 'old@gmail.com' });

    fetchStub = stubFetch([{ match: 'oauth2.googleapis.com/revoke', status: 200, body: {} }]);
    await storeConnection(env, 'u1', 'a-new-refresh-token', 'a', 3600, 'someone@gmail.com', 'primary');

    expect(fetchStub.calls.some((u) => u.includes('oauth2.googleapis.com/revoke'))).toBe(true);
    expect(fetchStub.bodies.some((b) => (b ?? '').includes('stored-refresh-token'))).toBe(true);
  });

  // The other half of F-22: reconnecting as a *different* Google account must
  // not inherit the previous account's read selection or keep the rows it
  // produced -- nothing would ever reconcile those again.
  it('clears the old account\'s read selection and imports when the account changes', async () => {
    const { db, env: base } = setup();
    const env = googleEnv(base);
    await seedGuild(db);
    await seedUser(db, 'u1');
    await seedMembership(db, 'u1', 'guild-1');
    await seedConnection(db, 'u1', { email: 'old@gmail.com' });
    await seedImported(db, 'u1', 'g-old');

    fetchStub = stubFetch([{ match: 'oauth2.googleapis.com/revoke', status: 200, body: {} }]);
    await storeConnection(env, 'u1', 'new-refresh', 'a', 3600, 'new@gmail.com', 'primary');

    expect(await countRows(db, 'google_calendar_connections', 'read_calendar_id IS NULL')).toBe(1);
    expect(await countRows(db, 'personal_events', 'google_event_id IS NOT NULL')).toBe(0);
  });

  // Reconnecting the *same* account is a repair, not a switch: switching
  // reading off underneath someone who just fixed a broken grant would be its
  // own bug.
  it('leaves the read selection alone when reconnecting the same account', async () => {
    const { db, env: base } = setup();
    const env = googleEnv(base);
    await seedGuild(db);
    await seedUser(db, 'u1');
    await seedMembership(db, 'u1', 'guild-1');
    await seedConnection(db, 'u1', { email: 'same@gmail.com', readCalendarId: 'games@group.calendar.google.com' });
    await seedImported(db, 'u1', 'g-keep');

    fetchStub = stubFetch([{ match: 'oauth2.googleapis.com/revoke', status: 200, body: {} }]);
    await storeConnection(env, 'u1', 'new-refresh', 'a', 3600, 'same@gmail.com', 'primary');

    expect(
      await countRows(db, 'google_calendar_connections', 'read_calendar_id = ?', 'games@group.calendar.google.com'),
    ).toBe(1);
    expect(await countRows(db, 'personal_events', 'google_event_id IS NOT NULL')).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// R16, R19, R17, R18
// ---------------------------------------------------------------------------

// Four ways the Google sync reported something other than what it did.
describe('the Google sync tells the truth about what it did (R16, R19, R17, R18)', () => {
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

  async function seedReadConnection(db: ShimDatabase, userId: string): Promise<void> {
    const sealed = await seal('stored-refresh-token', ENCRYPTION_KEY);
    const now = Date.now();
    await seedGuild(db);
    await seedUser(db, userId);
    await seedMembership(db, userId, 'guild-1');
    await db
      .prepare(
        `INSERT INTO google_calendar_connections
           (user_id, refresh_token_ciphertext, refresh_token_iv, access_token_ciphertext, access_token_iv,
            access_token_expires_at, google_account_email, calendar_id, read_calendar_id, sync_enabled, status,
            last_synced_at, disconnect_attempts, connected_at, updated_at)
         VALUES (?, ?, ?, NULL, NULL, NULL, 'someone@gmail.com', 'primary', 'primary', 1, 'active', NULL, 0, ?, ?)`,
      )
      .bind(userId, sealed.ciphertext, sealed.iv, now, now)
      .run();
  }

  const TOKEN_RULE = {
    match: 'oauth2.googleapis.com/token',
    status: 200,
    body: { access_token: 'a', expires_in: 3600 },
  };

  function calendarEvent(id: string, startAt: number, endAt: number) {
    return {
      id,
      summary: `Meeting ${id}`,
      start: { dateTime: new Date(startAt).toISOString() },
      end: { dateTime: new Date(endAt).toISOString() },
    };
  }

  // R16. Forty-one events over two months is ordinary usage. Everything past
  // the cap was dropped with nothing recorded anywhere, so the omitted times
  // were reported as free by the scheduling assistant -- incomplete data
  // presented as complete.
  it('says so when the import is truncated, instead of reporting a clean sync', async () => {
    const { db, env: base } = setup();
    const env = googleEnv(base);
    await seedReadConnection(db, 'u1');

    const now = Date.now();
    const items = Array.from({ length: 41 }, (_, i) =>
      calendarEvent(`g-${i}`, now + (i + 1) * DAY_MS, now + (i + 1) * DAY_MS + HOUR_MS),
    );
    fetchStub = stubFetch([TOKEN_RULE, { match: '/events', status: 200, body: { timeZone: 'UTC', items } }]);

    await sweepGoogleCalendar(env, new TickBudget('paid'));

    expect(await countRows(db, 'personal_events', 'google_event_id IS NOT NULL')).toBe(40);
    const conn = await db
      .prepare(`SELECT last_error FROM google_calendar_connections WHERE user_id = 'u1'`)
      .first<{ last_error: string | null }>();
    expect(conn?.last_error).toMatch(/only the first 40/i);
  });

  // The other half of R16: a truncated answer is not evidence that anything
  // was removed, so reconciliation must not delete on the strength of it.
  it('does not delete previously imported rows from a truncated response', async () => {
    const { db, env: base } = setup();
    const env = googleEnv(base);
    await seedReadConnection(db, 'u1');

    const now = Date.now();
    // An existing import that will not appear in the (capped) response.
    await db
      .prepare(
        `INSERT INTO personal_events
           (id, user_id, title, timezone, start_at, end_at, status, availability, is_recurring, google_event_id, created_at, updated_at)
         VALUES ('pe-far', 'u1', 'Far meeting', 'UTC', ?, ?, 'active', 'busy', 0, 'g-far', ?, ?)`,
      )
      .bind(now + 50 * DAY_MS, now + 50 * DAY_MS + HOUR_MS, now, now)
      .run();

    const items = Array.from({ length: 41 }, (_, i) =>
      calendarEvent(`g-${i}`, now + (i + 1) * DAY_MS, now + (i + 1) * DAY_MS + HOUR_MS),
    );
    fetchStub = stubFetch([TOKEN_RULE, { match: '/events', status: 200, body: { timeZone: 'UTC', items } }]);

    await sweepGoogleCalendar(env, new TickBudget('paid'));

    expect(await countRows(db, 'personal_events', 'google_event_id = ?', 'g-far')).toBe(1);
  });

  // Google documents nextPageToken arriving with a short page, so "fewer than
  // maxResults" is not the same as "that was all of it". The fields mask used
  // to strip the token, making the two indistinguishable.
  it('treats a nextPageToken as truncation even on a short page', async () => {
    const { db, env: base } = setup();
    const env = googleEnv(base);
    await seedReadConnection(db, 'u1');

    const now = Date.now();
    fetchStub = stubFetch([
      TOKEN_RULE,
      {
        match: '/events',
        status: 200,
        body: {
          timeZone: 'UTC',
          nextPageToken: 'more-please',
          items: [calendarEvent('g-1', now + DAY_MS, now + DAY_MS + HOUR_MS)],
        },
      },
    ]);

    await sweepGoogleCalendar(env, new TickBudget('paid'));

    const conn = await db
      .prepare(`SELECT last_error FROM google_calendar_connections WHERE user_id = 'u1'`)
      .first<{ last_error: string | null }>();
    expect(conn?.last_error).toMatch(/only the first 40/i);
  });

  // R19. Google's timeMin bounds an event's END, so an in-progress event is
  // inside the requested range -- but the stale-row DELETE required
  // start_at >= now, which such a row can never satisfy. Deleting it in Google
  // therefore never removed the app's copy, and the local delete route refuses
  // to touch an imported row.
  it('removes an in-progress imported event once it is deleted in Google', async () => {
    const { db, env: base } = setup();
    const env = googleEnv(base);
    await seedReadConnection(db, 'u1');

    const now = Date.now();
    await db
      .prepare(
        `INSERT INTO personal_events
           (id, user_id, title, timezone, start_at, end_at, status, availability, is_recurring, google_event_id, created_at, updated_at)
         VALUES ('pe-ongoing', 'u1', 'Ongoing', 'UTC', ?, ?, 'active', 'busy', 0, 'g-ongoing', ?, ?)`,
      )
      .bind(now - DAY_MS, now + DAY_MS, now, now)
      .run();

    // Deleted at the source: the current listing comes back empty.
    fetchStub = stubFetch([TOKEN_RULE, { match: '/events', status: 200, body: { timeZone: 'UTC', items: [] } }]);

    await sweepGoogleCalendar(env, new TickBudget('paid'));

    expect(await countRows(db, 'personal_events', 'google_event_id = ?', 'g-ongoing')).toBe(0);
  });

  // The control for R19: an event that has already finished is outside the
  // window this sync asked about, so its absence proves nothing and it stays.
  it('leaves a finished imported event alone', async () => {
    const { db, env: base } = setup();
    const env = googleEnv(base);
    await seedReadConnection(db, 'u1');

    const now = Date.now();
    await db
      .prepare(
        `INSERT INTO personal_events
           (id, user_id, title, timezone, start_at, end_at, status, availability, is_recurring, google_event_id, created_at, updated_at)
         VALUES ('pe-past', 'u1', 'Last week', 'UTC', ?, ?, 'active', 'busy', 0, 'g-past', ?, ?)`,
      )
      .bind(now - 8 * DAY_MS, now - 7 * DAY_MS, now, now)
      .run();

    fetchStub = stubFetch([TOKEN_RULE, { match: '/events', status: 200, body: { timeZone: 'UTC', items: [] } }]);
    await sweepGoogleCalendar(env, new TickBudget('paid'));

    expect(await countRows(db, 'personal_events', 'google_event_id = ?', 'g-past')).toBe(1);
  });

  // R17. google_event_links stores a Google event id with no record of which
  // calendar it is in, so changing the destination left every mapping pointing
  // at the old one -- and the sweep, seeing unchanged synced values, skipped
  // writing those events to the newly chosen calendar entirely.
  it('retires upcoming mappings when the write calendar changes', async () => {
    const { db, env: base } = setup();
    const env = googleEnv(base);
    await seedReadConnection(db, 'u1');

    const now = Date.now();
    for (const [id, endAt] of [
      ['link-future', now + DAY_MS],
      ['link-past', now - DAY_MS],
    ] as const) {
      await seedEvent(db, { id: `ev-${id}`, organizerId: 'u1', startAt: endAt - HOUR_MS, endAt });
      await db
        .prepare(
          `INSERT INTO google_event_links
             (id, user_id, event_id, occurrence_date, google_event_id, synced_title, synced_start_at, synced_end_at, synced_at)
           VALUES (?, 'u1', ?, '', ?, 'Session', ?, ?, ?)`,
        )
        .bind(id, `ev-${id}`, `g-${id}`, endAt - HOUR_MS, endAt, now)
        .run();
    }

    const res = await call(env, '/google', {
      method: 'PATCH',
      headers: await authHeader(env, 'u1'),
      body: JSON.stringify({ calendarId: 'games@group.calendar.google.com' }),
    });
    expect(res.status).toBe(200);

    // The upcoming mapping is gone, so the sweep will write that occurrence
    // into the new calendar; the historical one stays as the record of where
    // an entry that already happened actually lives.
    expect(await countRows(db, 'google_event_links', 'id = ?', 'link-future')).toBe(0);
    expect(await countRows(db, 'google_event_links', 'id = ?', 'link-past')).toBe(1);
  });

  // R18. Only 'unauthorized' ended the sync or recorded anything; a 403, a
  // rate limit or a 5xx was ignored, and execution then stamped last_synced_at
  // and cleared last_error -- reporting a fresh successful sync for a calendar
  // that had accepted nothing.
  it('records a rejected write instead of reporting a clean sync', async () => {
    const { db, env: base } = setup();
    const env = googleEnv(base);
    await seedReadConnection(db, 'u1');

    const now = Date.now();
    await seedEvent(db, {
      id: 'ev-1',
      organizerId: 'u1',
      startAt: now + 2 * DAY_MS,
      endAt: now + 2 * DAY_MS + HOUR_MS,
    });
    await seedInvite(db, 'ev-1', 'u1');
    await seedAttendance(db, 'ev-1', 'u1', 'accepted');

    fetchStub = stubFetch([
      TOKEN_RULE,
      // The insert is refused -- write access to the calendar was withdrawn.
      { match: '/calendars/primary/events', status: 403, body: { error: { message: 'forbidden' } } },
      { match: '/events', status: 200, body: { timeZone: 'UTC', items: [] } },
    ]);

    await sweepGoogleCalendar(env, new TickBudget('paid'));

    const conn = await db
      .prepare(`SELECT last_synced_at, last_error FROM google_calendar_connections WHERE user_id = 'u1'`)
      .first<{ last_synced_at: number | null; last_error: string | null }>();
    // No link row was created, because nothing was written.
    expect(await countRows(db, 'google_event_links')).toBe(0);
    // And Settings is told so rather than shown a fresh, clean sync.
    expect(conn?.last_error).toMatch(/could not be written/i);
  });
});

// ---------------------------------------------------------------------------
// R15
// ---------------------------------------------------------------------------

// Every API route runs requirePolicyAcceptance, so someone who has not
// accepted the current Privacy Policy is refused at the door -- GET
// /google/status answers 403. The cron never joined that check, so it went on
// reading their calendar, storing real titles and descriptions, and sending
// their sessions to Google on their behalf. A gate the person meets on their
// next request but their data does not is not a gate, and it matters most
// across exactly the change this release makes: lib/policy describes v4 as
// opaque busy/free and v5 as retaining real titles and descriptions.
describe('Google background processing waits for the current policy to be accepted (R15)', () => {
  const ENCRYPTION_KEY = 'test-google-encryption-key-at-least-32-chars';

  const googleEnv = (base: Env): Env => ({
    ...base,
    GOOGLE_SYNC_MODE: 'live',
    GOOGLE_CLIENT_ID: 'google-client-id',
    GOOGLE_CLIENT_SECRET: 'google-client-secret',
    GOOGLE_TOKEN_ENCRYPTION_KEY: ENCRYPTION_KEY,
  });

  async function seedStaleAcceptance(db: ShimDatabase, userId: string, status = 'active'): Promise<void> {
    const sealed = await seal('stored-refresh-token', ENCRYPTION_KEY);
    const now = Date.now();
    await seedGuild(db);
    await seedUser(db, userId);
    await seedMembership(db, userId, 'guild-1');
    // Accepted the *previous* policy -- the state a version bump creates for
    // everybody until each person accepts again.
    await db
      .prepare(`UPDATE users SET accepted_policy_version = ? WHERE id = ?`)
      .bind(CURRENT_POLICY_VERSION - 1, userId)
      .run();
    await db
      .prepare(
        `INSERT INTO google_calendar_connections
           (user_id, refresh_token_ciphertext, refresh_token_iv, access_token_ciphertext, access_token_iv,
            access_token_expires_at, google_account_email, calendar_id, read_calendar_id, sync_enabled, status,
            last_synced_at, disconnect_attempts, connected_at, updated_at)
         VALUES (?, ?, ?, NULL, NULL, NULL, 'someone@gmail.com', 'primary', 'primary', 1, ?, NULL, 0, ?, ?)`,
      )
      .bind(userId, sealed.ciphertext, sealed.iv, status, now, now)
      .run();
  }

  it('imports nothing for a user who has not accepted the current policy', async () => {
    const { db, env: base } = setup();
    const env = googleEnv(base);
    await seedStaleAcceptance(db, 'u1');

    const now = Date.now();
    fetchStub = stubFetch([
      { match: 'oauth2.googleapis.com/token', status: 200, body: { access_token: 'a', expires_in: 3600 } },
      {
        match: '/events',
        status: 200,
        body: {
          timeZone: 'UTC',
          items: [
            {
              id: 'g-1',
              summary: 'Therapy',
              description: 'private',
              start: { dateTime: new Date(now + DAY_MS).toISOString() },
              end: { dateTime: new Date(now + DAY_MS + HOUR_MS).toISOString() },
            },
          ],
        },
      },
    ]);

    expect(await googleSyncDue(env)).toBe(false);
    await sweepGoogleCalendar(env, new TickBudget('paid'));

    expect(await countRows(db, 'personal_events', 'google_event_id IS NOT NULL')).toBe(0);
    // Not even asked for: nothing left this deployment on their behalf.
    expect(fetchStub.calls.some((u) => u.includes('/events'))).toBe(false);
  });

  it('resumes the moment they accept', async () => {
    const { db, env: base } = setup();
    const env = googleEnv(base);
    await seedStaleAcceptance(db, 'u1');
    await db
      .prepare(`UPDATE users SET accepted_policy_version = ? WHERE id = 'u1'`)
      .bind(CURRENT_POLICY_VERSION)
      .run();

    const now = Date.now();
    fetchStub = stubFetch([
      { match: 'oauth2.googleapis.com/token', status: 200, body: { access_token: 'a', expires_in: 3600 } },
      {
        match: '/events',
        status: 200,
        body: {
          timeZone: 'UTC',
          items: [
            {
              id: 'g-1',
              summary: 'Therapy',
              start: { dateTime: new Date(now + DAY_MS).toISOString() },
              end: { dateTime: new Date(now + DAY_MS + HOUR_MS).toISOString() },
            },
          ],
        },
      },
    ]);

    expect(await googleSyncDue(env)).toBe(true);
    await sweepGoogleCalendar(env, new TickBudget('paid'));
    expect(await countRows(db, 'personal_events', 'google_event_id IS NOT NULL')).toBe(1);
  });

  // Withdrawal is not processing. Someone who declines a new policy must still
  // be able to disconnect, and a cleanup that stalled waiting for acceptance
  // would trap exactly the people most likely to want it.
  it('still finishes a disconnect for someone who has not accepted', async () => {
    const { db, env: base } = setup();
    const env = googleEnv(base);
    await seedStaleAcceptance(db, 'u1', 'disconnecting');

    fetchStub = stubFetch([
      { match: 'oauth2.googleapis.com/token', status: 200, body: { access_token: 'a', expires_in: 3600 } },
      { match: 'oauth2.googleapis.com/revoke', status: 200, body: {} },
    ]);

    expect(await googleSyncDue(env)).toBe(true);
    await sweepGoogleCalendar(env, new TickBudget('paid'));

    expect(await countRows(db, 'google_calendar_connections')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// F-21 / R13
// ---------------------------------------------------------------------------

// GET /me/export's fixed table map left out most of what the app holds about
// someone, against a policy that says the download "returns everything the
// service holds about you" -- and which discloses several of the missing
// categories by name earlier in the same document, so this was more than
// loose wording. Recurrence rules and overrides are the worst of it: without
// them an exported recurring event carries no schedule at all.
describe('the data export returns everything held about the caller (F-21 / R13)', () => {
  const app = buildApp();
  const call = (env: Env, path: string, init: RequestInit = {}) =>
    app.request(`https://worker.test${path}`, init, env);

  it('includes every category the policy says it does', async () => {
    const { db, env } = setup();
    await seedGuild(db);
    await seedUser(db, 'alice');
    await seedUser(db, 'bob');
    await seedMembership(db, 'alice', 'guild-1');
    await seedMembership(db, 'bob', 'guild-1');

    const now = Date.now();
    // A session, which the export is issued through anyway.
    const { id: sessionId } = await createSession(env, 'alice');
    const token = await signJwt('alice', sessionId, env.JWT_SIGNING_KEY);

    // A recurring event alice organizes, with an override.
    await seedEvent(db, { id: 'ev-rec', organizerId: 'alice', isRecurring: 1, startAt: null, endAt: null });
    await db
      .prepare(
        `INSERT INTO event_recurrence_rules (event_id, freq, interval, start_date, start_time, duration_minutes, end_type)
         VALUES ('ev-rec', 'WEEKLY', 1, '2026-09-01', '19:00', 120, 'never')`,
      )
      .run();
    await db
      .prepare(
        `INSERT INTO event_occurrence_overrides (id, event_id, occurrence_date, is_cancelled) VALUES ('ovr', 'ev-rec', '2026-09-08', 1)`,
      )
      .run();

    // A recurring personal block with an override of its own.
    await db
      .prepare(
        `INSERT INTO personal_events (id, user_id, title, timezone, start_at, end_at, status, availability, is_recurring, created_at, updated_at)
         VALUES ('pe-1', 'alice', 'Gym', 'UTC', NULL, NULL, 'active', 'busy', 1, ?, ?)`,
      )
      .bind(now, now)
      .run();
    await db
      .prepare(
        `INSERT INTO personal_event_overrides (id, personal_event_id, occurrence_date, is_cancelled) VALUES ('pov', 'pe-1', '2026-09-09', 1)`,
      )
      .run();

    // A change request alice filed on bob's event, with her own free text.
    await seedEvent(db, { id: 'ev-bob', organizerId: 'bob' });
    await db
      .prepare(
        `INSERT INTO event_change_requests
           (id, event_id, requester_id, kind, proposed_start_at, proposed_end_at, message, event_revision, created_at)
         VALUES ('cr-1', 'ev-bob', 'alice', 'time_change', ?, ?, 'can we push this an hour?', 0, ?)`,
      )
      .bind(now + DAY_MS, now + DAY_MS + HOUR_MS, now)
      .run();
    await db
      .prepare(`INSERT INTO event_change_request_votes (request_id, user_id, vote, voted_at) VALUES ('cr-1', 'alice', 'yes', ?)`)
      .bind(now)
      .run();
    await db
      .prepare(
        `INSERT INTO change_request_log (id, request_id, user_id, notification_type, sent_at)
         VALUES ('crl-1', 'cr-1', 'alice', 'change_request_opened', ?)`,
      )
      .bind(now)
      .run();

    // An RSVP notice she triggered on someone else's event.
    await db
      .prepare(
        `INSERT INTO organizer_rsvp_notice_log
           (id, organizer_id, event_id, occurrence_date, responder_id, responded_at, sent_at)
         VALUES ('rsvp-1', 'bob', 'ev-bob', '', 'alice', ?, ?)`,
      )
      .bind(now, now)
      .run();

    // An inactivity warning, and a server request carrying a name she typed.
    await db
      .prepare(
        `INSERT INTO account_purge_warnings (id, user_id, last_login_at, warning_type, sent_at) VALUES ('apw', 'alice', ?, 'stale_2wk', ?)`,
      )
      .bind(now, now)
      .run();
    await db
      .prepare(
        `INSERT INTO guild_add_requests (id, guild_id, guild_name, requested_by, status, requested_at)
         VALUES ('gar', 'guild-9', 'A Very Private Server', 'alice', 'pending', ?)`,
      )
      .bind(now)
      .run();

    const res = await call(env, '/me/export', { headers: { Authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown[]>;

    for (const key of [
      'sessions',
      'changeRequestsFiled',
      'changeRequestVotes',
      'changeRequestNotifications',
      'rsvpNoticesYouTriggered',
      'inactivityWarnings',
      'serverRequests',
      'recurrenceRules',
      'occurrenceOverrides',
      'personalEventOverrides',
    ]) {
      expect(body[key], `expected ${key} in the export`).toHaveLength(1);
    }

    // The specific things a reader would look for, rather than only the
    // shape: her own words, and the schedule without which the recurring
    // event cannot be reconstructed.
    const whole = JSON.stringify(body);
    expect(whole).toContain('can we push this an hour?');
    expect(whole).toContain('A Very Private Server');
    expect(whole).toContain('WEEKLY');
  });

  // The one thing that must NOT be in there, and the reason the Google block
  // lists its columns rather than using SELECT *.
  it('still never exports credential material', async () => {
    const { db, env } = setup();
    await seedGuild(db);
    await seedUser(db, 'alice');
    await seedMembership(db, 'alice', 'guild-1');
    const sealed = await seal('super-secret-refresh-token', 'test-google-encryption-key-at-least-32-chars');
    const now = Date.now();
    await db
      .prepare(
        `INSERT INTO google_calendar_connections
           (user_id, refresh_token_ciphertext, refresh_token_iv, access_token_ciphertext, access_token_iv,
            access_token_expires_at, google_account_email, calendar_id, read_calendar_id, sync_enabled, status,
            last_synced_at, disconnect_attempts, connected_at, updated_at)
         VALUES ('alice', ?, ?, NULL, NULL, NULL, 'a@gmail.com', 'primary', 'primary', 1, 'active', NULL, 0, ?, ?)`,
      )
      .bind(sealed.ciphertext, sealed.iv, now, now)
      .run();

    const { id: sessionId } = await createSession(env, 'alice');
    const token = await signJwt('alice', sessionId, env.JWT_SIGNING_KEY);
    const res = await call(env, '/me/export', { headers: { Authorization: `Bearer ${token}` } });
    const whole = JSON.stringify(await res.json());

    expect(whole).not.toContain(sealed.ciphertext);
    expect(whole).not.toContain('refresh_token');
    // But the read calendar and last error -- the person's own settings --
    // are there now, which they were not before.
    expect(whole).toContain('read_calendar_id');
  });
});

// ---------------------------------------------------------------------------
// R20, R21
// ---------------------------------------------------------------------------

// Two limits that were enforced against the wrong thing.
describe('RSVPs on a resolved poll, and the invitee cap (R20, R21)', () => {
  const app = buildApp();
  const call = (env: Env, path: string, init: RequestInit = {}) =>
    app.request(`https://worker.test${path}`, init, env);

  async function authHeader(env: Env, userId: string): Promise<Record<string, string>> {
    const { id: sessionId } = await createSession(env, userId);
    return {
      Authorization: `Bearer ${await signJwt(userId, sessionId, env.JWT_SIGNING_KEY)}`,
      'Content-Type': 'application/json',
    };
  }

  // R20. A single-winner poll that resolves deliberately keeps
  // event_type='poll' and status='resolved'; the cron sends rsvpControls for
  // exactly that state, and the attendance reader is built so an RSVP
  // overrides a prior vote. The blanket `status !== 'active'` guard made every
  // one of those advertised buttons answer event_not_active.
  it('accepts an RSVP on a resolved poll', async () => {
    const { db, env } = setup();
    await seedGuild(db);
    await seedUser(db, 'organizer');
    await seedUser(db, 'voter');
    await seedMembership(db, 'organizer', 'guild-1');
    await seedMembership(db, 'voter', 'guild-1');

    const start = Date.now() + 3 * DAY_MS;
    await seedEvent(db, {
      id: 'poll-1',
      organizerId: 'organizer',
      eventType: 'poll',
      status: 'resolved',
      startAt: start,
      endAt: start + 2 * HOUR_MS,
    });
    await seedInvite(db, 'poll-1', 'voter');

    // The person voted yes earlier and now wants out -- the exact case the
    // resolved-poll DM's buttons offer.
    await expect(recordRsvp(env, 'voter', 'poll-1', '', 'declined')).resolves.toBe('recorded');
    expect(await countRows(db, 'event_attendance', 'user_id = ? AND rsvp_status = ?', 'voter', 'declined')).toBe(1);
  });

  // The state the guard actually exists for stays refused.
  it('still refuses an RSVP on a cancelled event', async () => {
    const { db, env } = setup();
    await seedGuild(db);
    await seedUser(db, 'organizer');
    await seedUser(db, 'voter');
    await seedMembership(db, 'organizer', 'guild-1');
    await seedMembership(db, 'voter', 'guild-1');
    await seedEvent(db, { id: 'ev-cancelled', organizerId: 'organizer', status: 'cancelled' });
    await seedInvite(db, 'ev-cancelled', 'voter');

    await expect(recordRsvp(env, 'voter', 'ev-cancelled', '', 'accepted')).resolves.toBe('event_not_active');
    expect(await countRows(db, 'event_attendance')).toBe(0);
  });

  // R21. resolveInviteeUserIds caps the set *this request* resolves; nothing
  // checked existing-plus-new, so repeated calls walked an event past the
  // limit every downstream fan-out query assumes.
  it('refuses an additive invite that would take the event past the cap', async () => {
    const { db, env } = setup();
    await seedGuild(db);
    await seedUser(db, 'organizer');
    await seedMembership(db, 'organizer', 'guild-1');
    const members = ids('m', LIMITS.MAX_RESOLVED_INVITEES + 1);
    for (const id of members) {
      await seedUser(db, id);
      await seedMembership(db, id, 'guild-1');
    }
    await seedEvent(db, { id: 'ev-1', organizerId: 'organizer' });
    await seedInvite(db, 'ev-1', 'organizer');

    fetchStub = stubFetch([membershipRule(200)]);
    const headers = await authHeader(env, 'organizer');

    // Fill the event to the cap in one call...
    const first = await call(env, '/events/ev-1/invites', {
      method: 'POST',
      headers,
      body: JSON.stringify({ userIds: members.slice(0, LIMITS.MAX_RESOLVED_INVITEES - 1), groupIds: [] }),
    });
    expect(first.status).toBe(200);
    expect(await countRows(db, 'event_invites', 'event_id = ?', 'ev-1')).toBe(LIMITS.MAX_RESOLVED_INVITEES);

    // ...then one more, which is the bypass.
    const second = await call(env, '/events/ev-1/invites', {
      method: 'POST',
      headers,
      body: JSON.stringify({ userIds: [members[LIMITS.MAX_RESOLVED_INVITEES]], groupIds: [] }),
    });
    expect(second.status).toBe(400);
    expect(await countRows(db, 'event_invites', 'event_id = ?', 'ev-1')).toBe(LIMITS.MAX_RESOLVED_INVITEES);
  });

  // The write-side guard, which is what holds when two additions race and
  // both preflights pass. Exercised directly, since a race cannot be staged
  // through the route.
  it('will not write past the cap even when the preflight is bypassed', async () => {
    const { db, env } = setup();
    await seedGuild(db);
    await seedUser(db, 'organizer');
    await seedMembership(db, 'organizer', 'guild-1');
    const members = ids('m', LIMITS.MAX_RESOLVED_INVITEES + 2);
    for (const id of members) {
      await seedUser(db, id);
      await seedMembership(db, id, 'guild-1');
    }
    await seedEvent(db, { id: 'ev-1', organizerId: 'organizer' });
    for (const id of members.slice(0, LIMITS.MAX_RESOLVED_INVITEES)) {
      await seedInvite(db, 'ev-1', id);
    }

    // Straight to the statement builder, standing in for the loser of a race
    // whose preflight passed against a smaller count.
    await env.DB.batch(
      inviteStatements(
        env,
        'ev-1',
        [{ userId: members[LIMITS.MAX_RESOLVED_INVITEES], invitedVia: 'individual', sourceGroupId: null, rsvpStatus: 'pending' }],
        false,
        null,
        LIMITS.MAX_RESOLVED_INVITEES,
      ),
    );

    expect(await countRows(db, 'event_invites', 'event_id = ?', 'ev-1')).toBe(LIMITS.MAX_RESOLVED_INVITEES);
  });
});

// ---------------------------------------------------------------------------
// R22
// ---------------------------------------------------------------------------

// `after_count` was measured against the wrong thing in both non-daily
// branches -- months for MONTHLY, week slots for WEEKLY -- so a series ended
// before it should have. The consequences are not cosmetic: a missing
// occurrence is a commitment reported as free time, and one that never gets
// its reminders.
describe('a recurring series counts its own occurrences (R22)', () => {
  const RULE = {
    freq: 'MONTHLY' as const,
    interval: 1,
    byWeekday: null,
    byMonthDay: 31,
    startDate: '2026-01-31',
    startTime: '19:00',
    durationMinutes: 60,
    endType: 'after_count' as const,
    endDate: null,
    endCount: 3,
  };

  const at = (iso: string) => DateTime.fromISO(iso, { zone: 'UTC' }).toMillis();

  // The reviewer's own reproduction. January has a 31st, February does not --
  // and February was counted anyway, so the third occurrence was never
  // reached.
  it('does not count months that cannot contain the chosen day', () => {
    const occurrences = expandOccurrences(RULE, 'UTC', at('2026-01-01'), at('2026-07-31T23:59'), []);
    expect(occurrences.map((o) => o.date)).toEqual(['2026-01-31', '2026-03-31', '2026-05-31']);
  });

  // WEEKLY: the first week is partial whenever the series starts on anything
  // but its earliest selected weekday, and those earlier slots are not
  // occurrences. Counting them made the series end early -- by an amount that
  // depended on how far the fast-forward jumped, so the same series expanded
  // over two overlapping windows disagreed about which dates exist.
  const WEEKLY = {
    freq: 'WEEKLY' as const,
    interval: 1,
    byWeekday: '0,2', // Monday and Wednesday
    byMonthDay: null,
    startDate: '2026-01-07', // a Wednesday: that week's Monday is not an occurrence
    startTime: '19:00',
    durationMinutes: 60,
    endType: 'after_count' as const,
    endDate: null,
    endCount: 5,
  };

  it('gives the same answer whatever window it is asked about', () => {
    const wholeMonth = expandOccurrences(WEEKLY, 'UTC', at('2026-01-01'), at('2026-01-31T23:59'), []);
    const fromThe19th = expandOccurrences(WEEKLY, 'UTC', at('2026-01-19'), at('2026-01-31T23:59'), []);

    // Five occurrences from Wed 7 Jan: 7th, 12th, 14th, 19th, 21st.
    expect(wholeMonth.map((o) => o.date)).toEqual([
      '2026-01-07',
      '2026-01-12',
      '2026-01-14',
      '2026-01-19',
      '2026-01-21',
    ]);
    // The narrower window has to agree about the ones it covers. It used to
    // drop the 21st, because the fast-forward had already counted the Monday
    // before the series began.
    expect(fromThe19th.map((o) => o.date)).toEqual(['2026-01-19', '2026-01-21']);
  });
});

// ---------------------------------------------------------------------------
// R23
// ---------------------------------------------------------------------------

// The recurring minimum-attendees auto-cancellation marked the occurrence
// cancelled and then notified only as many attendees as the tick could afford
// -- and everyone past that cut got no notification_log row at all. Once the
// occurrence is cancelled expandOccurrences stops returning it, so
// resolveMinimumAttendeesDeadline is never called for it again; the general
// cancellation sweep deliberately skips recurring events; and the
// source-independent retry consumer only helps rows that exist. So those
// people were never told their session was cancelled -- not late, never.
describe('a recurring auto-cancellation tells everyone eventually (R23)', () => {
  it('records the obligation for every attendee, not just the affordable ones', async () => {
    vi.useFakeTimers();
    let base = Date.UTC(2026, 8, 10, 12, 0, 0);
    vi.setSystemTime(base);

    // Free plan deliberately, and this is the whole point of the test. On a
    // paid plan one tick can afford to DM everybody, so the old code looked
    // fine -- the bug only appears when the tick's allowance is smaller than
    // the recipient list, which is when `deliveriesAffordable` was silently
    // deciding who would ever be told.
    const { db, env } = setup('free');
    await seedGuild(db);
    await seedUser(db, 'organizer');
    await seedMembership(db, 'organizer', 'guild-1');

    // The reviewer's scenario: 25 current invited members, 20 accepted and 5
    // declined, on a recurring occurrence six hours out with a 24h deadline
    // and a minimum it cannot meet.
    const attendees = ids('att', 20);
    const decliners = ids('dec', 5);
    for (const id of [...attendees, ...decliners]) {
      await seedUser(db, id);
      await seedMembership(db, id, 'guild-1');
    }

    const firstStart = base + 6 * HOUR_MS;
    const s = new Date(firstStart);
    const startDate = s.toISOString().slice(0, 10);
    const startTime = `${String(s.getUTCHours()).padStart(2, '0')}:${String(s.getUTCMinutes()).padStart(2, '0')}`;

    await seedEvent(db, { id: 'rec-1', organizerId: 'organizer', isRecurring: 1, startAt: null, endAt: null });
    await db
      .prepare(
        `UPDATE events SET timezone = 'UTC', minimum_attendees = 25, auto_cancel_below_minimum = 1,
           minimum_attendees_deadline_hours_before = 24 WHERE id = 'rec-1'`,
      )
      .run();
    await db
      .prepare(
        `INSERT INTO event_recurrence_rules (event_id, freq, interval, start_date, start_time, duration_minutes, end_type)
         VALUES ('rec-1', 'DAILY', 1, ?, ?, 60, 'never')`,
      )
      .bind(startDate, startTime)
      .run();

    const occurrenceDate = startDate;
    for (const id of [...attendees, ...decliners]) await seedInvite(db, 'rec-1', id);
    for (const id of attendees) await seedAttendance(db, 'rec-1', id, 'accepted', occurrenceDate);
    for (const id of decliners) await seedAttendance(db, 'rec-1', id, 'declined', occurrenceDate);

    fetchStub = stubFetch([DM_CHANNEL_RULE, dmSendRule(200), membershipRule(200)]);

    // Several ticks, which is what the outbox is for -- the point is that
    // everyone is eventually told, not that one tick manages it.
    for (let tick = 0; tick < 3; tick++) {
      await runReminderSweep(env);
      base += 15 * 60 * 1000;
      vi.setSystemTime(base);
    }

    // The occurrence really was cancelled...
    expect(
      await countRows(db, 'event_occurrence_overrides', 'event_id = ? AND is_cancelled = 1', 'rec-1'),
    ).toBe(1);
    // ...and everyone owed a notice has a durable row for it: the twenty who
    // accepted, plus the organizer, who counts as attending their own session
    // unless they declined it.
    //
    // Rows, not deliveries, is the assertion that matters. Whether a given
    // tick can afford to send is the budget's business and always was; what
    // was broken is that the people it could not afford had nothing recorded,
    // so no later tick could pick them up either -- the occurrence is
    // cancelled by then, expandOccurrences stops returning it, and the retry
    // consumer only scans rows that exist. Before the fix this count stops at
    // whatever the first tick could pay for and never grows again, however
    // many ticks run.
    expect(
      await countRows(
        db,
        'notification_log',
        'event_id = ? AND notification_type = ?',
        'rec-1',
        'event_cancelled_below_minimum',
      ),
    ).toBe(attendees.length + 1);
  });
});

// ---------------------------------------------------------------------------
// F-19, F-24
// ---------------------------------------------------------------------------

describe('an emailed decision needs a person, and a refused login leaves nothing (F-19, F-24)', () => {
  const app = buildApp();
  const call = (env: Env, path: string, init: RequestInit = {}) =>
    app.request(`https://worker.test${path}`, init, env);

  // F-19. Outlook Safe Links, Gmail's proxies and corporate mail gateways
  // fetch the URLs in inbound mail before any human sees them, and this app's
  // decision email lists Approve first. Since `guilds` is the entire admission
  // control -- everyone in an allow-listed server can log in -- a prefetch
  // could hand a whole Discord server accounts here with nobody deciding
  // anything. And because the decision is one-shot, the owner's later click
  // would report it "already decided", with no clue by what.
  it('does not decide anything when the approve link is merely fetched', async () => {
    const { db, env } = setup();
    await seedUser(db, 'requester');
    const now = Date.now();
    await db
      .prepare(
        `INSERT INTO guild_add_requests (id, guild_id, guild_name, requested_by, status, requested_at)
         VALUES ('req-1', 'g-new', 'Someone Else''s Server', 'requester', 'pending', ?)`,
      )
      .bind(now)
      .run();
    const token = await signToken(
      'guild_request_decision',
      { requestId: 'req-1', action: 'approve' },
      env.JWT_SIGNING_KEY,
      600,
    );

    // Exactly what a link-scanner does.
    const res = await call(env, `/guild-requests/${token}/decide`);

    expect(res.status).toBe(200);
    // Nothing decided, nothing allow-listed.
    expect(await countRows(db, 'guild_add_requests', "id = 'req-1' AND status = 'pending'")).toBe(1);
    expect(await countRows(db, 'guilds', "id = 'g-new'")).toBe(0);

    // What came back is a confirmation a person has to submit.
    const html = await res.text();
    expect(html).toContain('<form method="post"');
    // And the guild name is escaped rather than interpolated raw -- this is
    // the one place in the app that builds HTML by hand.
    expect(html).toContain('Someone Else&#39;s Server');
  });

  it('decides once the form is actually submitted', async () => {
    const { db, env } = setup();
    await seedUser(db, 'requester');
    await db
      .prepare(
        `INSERT INTO guild_add_requests (id, guild_id, guild_name, requested_by, status, requested_at)
         VALUES ('req-1', 'g-new', 'A Server', 'requester', 'pending', ?)`,
      )
      .bind(Date.now())
      .run();
    const token = await signToken(
      'guild_request_decision',
      { requestId: 'req-1', action: 'approve' },
      env.JWT_SIGNING_KEY,
      600,
    );

    const res = await call(env, `/guild-requests/${token}/decide`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(await countRows(db, 'guilds', "id = 'g-new' AND is_active = 1")).toBe(1);
  });

  // F-24. upsertUser ran before the allow-list check, so someone who shares no
  // allow-listed server was refused a session and kept a full profile row --
  // id, username, display name, avatar hash -- shown on the owner's user list,
  // undisclosed to them, and not deletable by them since they cannot log in.
  it('keeps no profile for a login it refuses', async () => {
    const { db, env } = setup();
    await seedGuild(db, 'guild-1');

    fetchStub = stubFetch([
      { match: '/oauth2/token', status: 200, body: { access_token: 'a', token_type: 'Bearer' } },
      { match: '/users/@me/guilds', status: 200, body: [{ id: 'some-other-server' }] },
      { match: '/users/@me', status: 200, body: { id: 'stranger', username: 'stranger', global_name: 'A Stranger', avatar: 'abc' } },
    ]);

    const state = 'a-state-value';
    const challenge = base64UrlEncode(
      new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('verifier'))),
    );
    const res = await call(env, `/auth/callback?code=abc&state=${state}`, {
      headers: { Cookie: `oauth_state=${state}:${challenge}` },
    });

    expect(res.status).toBe(403);
    // The whole finding: no row at all for someone who cannot use the app.
    expect(await countRows(db, 'users', 'id = ?', 'stranger')).toBe(0);
  });

  // The other half of the same decision. Migration 0018 exists so the owner
  // can tell "logged in" from "tried and was turned away", and that stays true
  // for someone who actually has an account -- a returning user who has since
  // left every allow-listed server. Their record is their own, and it appears
  // in their export.
  it('still records the attempt for a returning user who has lost access', async () => {
    const { db, env } = setup();
    await seedGuild(db, 'guild-1');
    await seedUser(db, 'former');
    await db.prepare(`UPDATE users SET last_login_attempt_at = NULL WHERE id = 'former'`).run();

    fetchStub = stubFetch([
      { match: '/oauth2/token', status: 200, body: { access_token: 'a', token_type: 'Bearer' } },
      { match: '/users/@me/guilds', status: 200, body: [{ id: 'some-other-server' }] },
      { match: '/users/@me', status: 200, body: { id: 'former', username: 'former', global_name: null, avatar: null } },
    ]);

    const state = 'a-state-value';
    const challenge = base64UrlEncode(
      new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('verifier'))),
    );
    const res = await call(env, `/auth/callback?code=abc&state=${state}`, {
      headers: { Cookie: `oauth_state=${state}:${challenge}` },
    });

    expect(res.status).toBe(403);
    expect(await countRows(db, 'users', 'id = ? AND last_login_attempt_at IS NOT NULL', 'former')).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// F-20
// ---------------------------------------------------------------------------

// /auth/refresh accepts an expired JWT by design -- that is what refresh is
// for -- but rotateSession only bumped last_used_at, so the token handed back
// carried the same sid and was interchangeable with the one presented. A
// captured token could therefore be refreshed for the whole seven-day session,
// and the 30-minute access lifetime that jwt.ts and README section 4 both
// describe as bounding a theft bounded nothing. The token lives in
// localStorage, so any script on the frontend origin got a week rather than
// half an hour.
describe('refreshing rotates the session rather than reissuing it (F-20)', () => {
  const app = buildApp();
  const call = (env: Env, path: string, init: RequestInit = {}) =>
    app.request(`https://worker.test${path}`, init, env);

  async function refresh(env: Env, token: string): Promise<Response> {
    return call(env, '/auth/refresh', { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
  }

  it('issues a token naming a different session', async () => {
    const { db, env } = setup();
    await seedGuild(db);
    await seedUser(db, 'alice');
    await seedMembership(db, 'alice', 'guild-1');

    const { id: sessionId } = await createSession(env, 'alice');
    await ageSession(db, sessionId);
    const original = await signJwt('alice', sessionId, env.JWT_SIGNING_KEY);

    const res = await refresh(env, original);
    expect(res.status).toBe(200);
    const { token: rotated } = (await res.json()) as { token: string };

    const before = JSON.parse(atob(original.split('.')[1])) as { sid: string };
    const after = JSON.parse(atob(rotated.split('.')[1])) as { sid: string };
    expect(after.sid).not.toBe(before.sid);

    // And the new one authenticates.
    const me = await call(env, '/me', { headers: { Authorization: `Bearer ${rotated}` } });
    expect(me.status).toBe(200);
  });

  // The finding itself: a captured token must stop working, rather than
  // remaining exchangeable for the rest of the week.
  it('stops the old token once the rotation grace has passed', async () => {
    vi.useFakeTimers();
    const base = Date.UTC(2026, 8, 10, 12, 0, 0);
    vi.setSystemTime(base);

    const { db, env } = setup();
    await seedGuild(db);
    await seedUser(db, 'alice');
    await seedMembership(db, 'alice', 'guild-1');

    const { id: sessionId } = await createSession(env, 'alice');
    await ageSession(db, sessionId);
    const captured = await signJwt('alice', sessionId, env.JWT_SIGNING_KEY);

    // The legitimate holder refreshes.
    expect((await refresh(env, captured)).status).toBe(200);

    // Two minutes later -- past the grace -- the captured token is dead, both
    // as a credential and as something to refresh with.
    vi.setSystemTime(base + 2 * 60 * 1000);
    expect((await call(env, '/me', { headers: { Authorization: `Bearer ${captured}` } })).status).toBe(401);
    expect((await refresh(env, captured)).status).toBe(401);
  });

  // Why the grace exists. Two tabs can hit a 401 at the same moment and both
  // call refresh with the same token; without a window the loser gets a 401
  // from refresh itself, and the frontend's API client treats that as terminal
  // -- it clears the stored token and bounces to login, throwing away the good
  // token the winning tab just wrote. Both tabs end up logged out over an
  // ordinary race.
  it('lets a second tab mid-flight refresh too', async () => {
    const { db, env } = setup();
    await seedGuild(db);
    await seedUser(db, 'alice');
    await seedMembership(db, 'alice', 'guild-1');

    const { id: sessionId } = await createSession(env, 'alice');
    const shared = await signJwt('alice', sessionId, env.JWT_SIGNING_KEY);

    expect((await refresh(env, shared)).status).toBe(200);
    // Immediately after, which is the racing tab.
    expect((await refresh(env, shared)).status).toBe(200);
  });

  // Rotation must not become a way to hold a session open forever: the
  // successor inherits the original expiry rather than starting a new week.
  it('does not extend the absolute session lifetime', async () => {
    const { db, env } = setup();
    await seedGuild(db);
    await seedUser(db, 'alice');
    await seedMembership(db, 'alice', 'guild-1');

    const { id: sessionId } = await createSession(env, 'alice');
    const original = await db
      .prepare(`SELECT expires_at FROM sessions WHERE id = ?`)
      .bind(sessionId)
      .first<{ expires_at: number }>();

    const res = await refresh(env, await signJwt('alice', sessionId, env.JWT_SIGNING_KEY));
    const { token } = (await res.json()) as { token: string };
    const { sid } = JSON.parse(atob(token.split('.')[1])) as { sid: string };

    const successor = await db
      .prepare(`SELECT expires_at FROM sessions WHERE id = ?`)
      .bind(sid)
      .first<{ expires_at: number }>();
    expect(successor!.expires_at).toBe(original!.expires_at);
  });

  // Logout stays absolute -- the grace is for rotation only, and must not
  // soften revocation.
  it('does not grace a revoked session', async () => {
    const { db, env } = setup();
    await seedGuild(db);
    await seedUser(db, 'alice');
    await seedMembership(db, 'alice', 'guild-1');

    const { id: sessionId } = await createSession(env, 'alice');
    const token = await signJwt('alice', sessionId, env.JWT_SIGNING_KEY);

    expect((await call(env, '/auth/logout', { method: 'POST', headers: { Authorization: `Bearer ${token}` } })).status).toBe(200);
    expect((await refresh(env, token)).status).toBe(401);
  });
});
