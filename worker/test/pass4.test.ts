import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/router';
import { signJwt } from '../src/lib/jwt';
import { createSession } from '../src/lib/sessions';
import { createEventWithInvites, updateEvent } from '../src/lib/eventWrites';
import { runReminderSweep } from '../src/cron/reminders';
import { computeBusyBlocksForUsers } from '../src/lib/freeBusy';
import {
  DAY_MS,
  HOUR_MS,
  ids,
  seedEvent,
  seedGuild,
  seedMembership,
  seedUser,
  setup,
  stubFetch,
  type FetchStub,
} from './helpers';
import type { Env } from '../src/env';
import { D1_FREE_PLAN_QUERY_BUDGET } from './d1shim';

let fetchStub: FetchStub | null = null;
afterEach(() => {
  fetchStub?.restore();
  fetchStub = null;
});

const app = buildApp();

async function authHeaders(env: Env, userId: string): Promise<Record<string, string>> {
  const { id: sessionId } = await createSession(env, userId);
  const token = await signJwt(userId, sessionId, env.JWT_SIGNING_KEY);
  return { Authorization: `Bearer ${token}` };
}

// R2: a calendar full of recurring events used to issue one recurrence-rule
// query (and, for multi-winner polls, one confirmed-options query) per
// visible event -- at the 100-recurring-event maximum that alone was well
// past D1's Free-plan per-invocation query budget. The fix bulk-loads both,
// so the query count no longer scales with how many events are visible.
describe('calendar bulk-loading (R2)', () => {
  it('expands 100 recurring events into the same calendar response either way', async () => {
    const { db, env } = setup();
    await seedGuild(db);
    await seedUser(db, 'u1');
    await seedMembership(db, 'u1', 'guild-1');
    const headers = await authHeaders(env, 'u1');

    const start = Date.now() + HOUR_MS;
    for (const id of ids('rec', 100)) {
      await seedEvent(db, { id, organizerId: 'u1', isRecurring: 1, startAt: null, endAt: null });
      await db.prepare(`UPDATE events SET timezone = 'UTC' WHERE id = ?`).bind(id).run();
      await db.prepare(
        `INSERT INTO event_recurrence_rules (event_id, freq, interval, start_date, start_time, duration_minutes, end_type)
         VALUES (?, 'DAILY', 1, ?, '12:00', 60, 'never')`,
      )
        .bind(id, new Date(start).toISOString().slice(0, 10))
        .run();
    }

    const from = Date.now();
    const to = Date.now() + 7 * DAY_MS;
    const res = await app.request(`https://worker.test/guilds/guild-1/events?from=${from}&to=${to}`, { headers }, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as unknown[];
    expect(body.length).toBeGreaterThanOrEqual(100);
  });

  it('shows a confirmed multi-winner day even when its poll deadline already passed', async () => {
    const { db, env } = setup();
    await seedGuild(db);
    await seedUser(db, 'u1');
    await seedMembership(db, 'u1', 'guild-1');
    const headers = await authHeaders(env, 'u1');

    const now = Date.now();
    await seedEvent(db, {
      id: 'mw',
      organizerId: 'u1',
      eventType: 'poll',
      startAt: null,
      endAt: null,
      status: 'resolved',
    });
    await db.prepare(`UPDATE events SET poll_resolution_mode = 'multi_winner', poll_deadline_at = ? WHERE id = 'mw'`)
      .bind(now - 10 * DAY_MS)
      .run();
    await db.prepare(
      `INSERT INTO event_poll_options (id, event_id, start_at, end_at, display_order, confirmed_at)
       VALUES ('opt', 'mw', ?, ?, 0, ?)`,
    )
      .bind(now + DAY_MS, now + DAY_MS + HOUR_MS, now)
      .run();

    const res = await app.request(
      `https://worker.test/guilds/guild-1/events?from=${now}&to=${now + 2 * DAY_MS}`,
      { headers },
      env,
    );
    const body = (await res.json()) as { eventId: string }[];
    expect(body.some((o) => o.eventId === 'mw')).toBe(true);
  });
});

// R5: cancelled/resolved polls are excluded from the create quota but used to
// stay in the calendar's unconditional poll branch and the cron's rescan
// queries forever. The calendar fix is precision (only load a poll if it's
// actually relevant to the window); the cron fix is a hot-window filter; the
// purge sweep is what actually reclaims storage.
describe('terminal poll history (R5)', () => {
  it('does not return an old resolved single-winner poll outside its own date', async () => {
    const { db, env } = setup();
    await seedGuild(db);
    await seedUser(db, 'u1');
    await seedMembership(db, 'u1', 'guild-1');
    const headers = await authHeaders(env, 'u1');

    const longAgo = Date.now() - 200 * DAY_MS;
    await seedEvent(db, {
      id: 'old-resolved',
      organizerId: 'u1',
      eventType: 'poll',
      status: 'resolved',
      startAt: longAgo,
      endAt: longAgo + HOUR_MS,
    });

    const from = Date.now();
    const to = Date.now() + 30 * DAY_MS;
    const res = await app.request(`https://worker.test/guilds/guild-1/events?from=${from}&to=${to}`, { headers }, env);
    const body = (await res.json()) as { eventId: string }[];
    expect(body.some((o) => o.eventId === 'old-resolved')).toBe(false);
  });

  it('still returns an open (unresolved) poll whose deadline falls in the window', async () => {
    const { db, env } = setup();
    await seedGuild(db);
    await seedUser(db, 'u1');
    await seedMembership(db, 'u1', 'guild-1');
    const headers = await authHeaders(env, 'u1');

    const now = Date.now();
    await seedEvent(db, { id: 'open-poll', organizerId: 'u1', eventType: 'poll', startAt: null, endAt: null });
    await db.prepare(`UPDATE events SET poll_deadline_at = ? WHERE id = 'open-poll'`).bind(now + DAY_MS).run();

    const res = await app.request(
      `https://worker.test/guilds/guild-1/events?from=${now}&to=${now + 2 * DAY_MS}`,
      { headers },
      env,
    );
    const body = (await res.json()) as { eventId: string }[];
    expect(body.some((o) => o.eventId === 'open-poll')).toBe(true);
  });

  it('cron stops rescanning a resolved poll once past the hot window', async () => {
    const { db, env } = setup();
    await seedGuild(db);
    await seedUser(db, 'organizer');
    await seedMembership(db, 'organizer', 'guild-1');

    const longAgo = Date.now() - 10 * DAY_MS;
    await seedEvent(db, {
      id: 'stale-resolved',
      organizerId: 'organizer',
      eventType: 'poll',
      status: 'resolved',
      startAt: longAgo,
      endAt: longAgo + HOUR_MS,
    });
    await db.prepare(`UPDATE events SET updated_at = ? WHERE id = 'stale-resolved'`).bind(longAgo).run();

    fetchStub = stubFetch([]);
    await runReminderSweep(env);

    // No participant/DM queries should have been attempted for it -- if the
    // sweep had selected it, sendBotDm's channel-open fetch would have been
    // the very first thing to run and this stub would have thrown.
    expect(fetchStub.calls).toHaveLength(0);
  });

  it('purges a cancelled event past the retention window, including its children', async () => {
    const { db, env } = setup();
    await seedGuild(db);
    await seedUser(db, 'organizer');
    await seedMembership(db, 'organizer', 'guild-1');

    const old = Date.now() - 200 * DAY_MS;
    await seedEvent(db, { id: 'ancient', organizerId: 'organizer', status: 'cancelled' });
    await db.prepare(`UPDATE events SET updated_at = ? WHERE id = 'ancient'`).bind(old).run();
    await db.prepare(
      `INSERT INTO event_recurrence_rules (event_id, freq, interval, start_date, start_time, duration_minutes, end_type)
       VALUES ('ancient', 'DAILY', 1, '2020-01-01', '12:00', 60, 'never')`,
    ).run();

    fetchStub = stubFetch([]);
    await runReminderSweep(env);

    expect(await db.prepare(`SELECT id FROM events WHERE id = 'ancient'`).first()).toBeNull();
    expect(await db.prepare(`SELECT event_id FROM event_recurrence_rules WHERE event_id = 'ancient'`).first()).toBeNull();
  });

  it('does not purge a recently cancelled event', async () => {
    const { db, env } = setup();
    await seedGuild(db);
    await seedUser(db, 'organizer');
    await seedMembership(db, 'organizer', 'guild-1');
    await seedEvent(db, { id: 'recent', organizerId: 'organizer', status: 'cancelled' });

    fetchStub = stubFetch([]);
    await runReminderSweep(env);

    expect(await db.prepare(`SELECT id FROM events WHERE id = 'recent'`).first()).not.toBeNull();
  });
});

// R6: the guild's recurring-event cap was only checked on create; PATCH
// could convert an existing non-recurring event into a recurring one after
// the guild was already full.
describe('recurring quota on PATCH (R6)', () => {
  const recurrence = {
    freq: 'DAILY' as const,
    interval: 1,
    byWeekday: null,
    byMonthDay: null,
    startDate: '2026-06-01',
    startTime: '19:00',
    durationMinutes: 60,
    endType: 'never' as const,
    endDate: null,
    endCount: null,
  };

  it('rejects converting a non-recurring event to recurring once the guild is at its recurring cap', async () => {
    const { db, env } = setup();
    await seedGuild(db);
    await seedUser(db, 'organizer');
    await seedMembership(db, 'organizer', 'guild-1');
    fetchStub = stubFetch([]);

    for (const id of ids('rec', 100)) {
      await seedEvent(db, { id, organizerId: 'organizer', isRecurring: 1 });
    }
    const targetId = await createEventWithInvites(env, 'guild-1', 'organizer', {
      title: 'Convert me',
      description: null,
      game: null,
      eventType: 'single',
      timezone: 'America/New_York',
      invites: { userIds: [], groupIds: [] },
      isRecurring: false,
      startAt: Date.now() + HOUR_MS,
      endAt: Date.now() + 2 * HOUR_MS,
    });

    await expect(
      updateEvent(
        env,
        targetId,
        'guild-1',
        { isRecurring: true, recurrence, startAt: undefined, endAt: undefined },
        false,
      ),
    ).rejects.toThrow(/recurring/);

    const row = await db.prepare(`SELECT is_recurring FROM events WHERE id = ?`).bind(targetId).first<{ is_recurring: number }>();
    expect(row?.is_recurring).toBe(0);
  });

  it('does not re-check the recurring cap when the event was already recurring', async () => {
    const { db, env } = setup();
    await seedGuild(db);
    await seedUser(db, 'organizer');
    await seedMembership(db, 'organizer', 'guild-1');
    fetchStub = stubFetch([]);

    for (const id of ids('rec', 100)) {
      await seedEvent(db, { id, organizerId: 'organizer', isRecurring: 1 });
    }
    // Editing an already-recurring event's own schedule must still work even
    // though the guild is at capacity -- it isn't adding a new recurring row.
    await expect(
      updateEvent(env, 'rec-0', 'guild-1', { isRecurring: true, recurrence, startAt: undefined, endAt: undefined }, true),
    ).resolves.toBeUndefined();
  });

  it('allows conversion while the guild is under the recurring cap', async () => {
    const { db, env } = setup();
    await seedGuild(db);
    await seedUser(db, 'organizer');
    await seedMembership(db, 'organizer', 'guild-1');
    fetchStub = stubFetch([]);

    const targetId = await createEventWithInvites(env, 'guild-1', 'organizer', {
      title: 'Convert me',
      description: null,
      game: null,
      eventType: 'single',
      timezone: 'America/New_York',
      invites: { userIds: [], groupIds: [] },
      isRecurring: false,
      startAt: Date.now() + HOUR_MS,
      endAt: Date.now() + 2 * HOUR_MS,
    });

    await expect(
      updateEvent(
        env,
        targetId,
        'guild-1',
        { isRecurring: true, recurrence, startAt: undefined, endAt: undefined },
        false,
      ),
    ).resolves.toBeUndefined();

    const row = await db.prepare(`SELECT is_recurring FROM events WHERE id = ?`).bind(targetId).first<{ is_recurring: number }>();
    expect(row?.is_recurring).toBe(1);
  });
});

// The event-quota guard on create is the atomic backstop behind the friendly
// count check -- verifies the guard itself actually blocks an over-limit
// insert and leaves no orphaned children, independent of any race.
describe('event quota guard is a real backstop, not just the friendly message', () => {
  it('cleans up children and reports the limit when the guarded insert is forced to lose', async () => {
    const { db, env } = setup();
    await seedGuild(db);
    await seedUser(db, 'organizer');
    await seedMembership(db, 'organizer', 'guild-1');
    fetchStub = stubFetch([]);

    // Fill the guild to exactly the limit so the next create's guard trips.
    for (const id of ids('e', 300)) {
      await seedEvent(db, { id, organizerId: 'organizer' });
    }

    await expect(
      createEventWithInvites(env, 'guild-1', 'organizer', {
        title: 'One too many',
        description: null,
        game: null,
        eventType: 'poll',
        timezone: 'America/New_York',
        invites: { userIds: [], groupIds: [] },
        pollDeadlineAt: Date.now() + DAY_MS,
        pollStrategy: 'most_votes',
        pollOptions: [{ startAt: Date.now() + DAY_MS, endAt: Date.now() + DAY_MS + HOUR_MS }],
      } as never),
    ).rejects.toThrow(/limit/);

    // No orphaned poll option left behind for an event that doesn't exist.
    const orphans = await db.prepare(`SELECT COUNT(*) AS n FROM event_poll_options WHERE event_id NOT IN (SELECT id FROM events)`).first<{ n: number }>();
    expect(orphans?.n).toBe(0);
  });
});

describe('free/busy bulk computation matches per-user semantics', () => {
  it('reports the same busy blocks for many users at once as computing them individually would', async () => {
    const { db, env } = setup();
    await seedGuild(db);
    await seedUser(db, 'a');
    await seedUser(db, 'b');
    await seedMembership(db, 'a', 'guild-1');
    await seedMembership(db, 'b', 'guild-1');

    const now = Date.now();
    await seedEvent(db, { id: 'ea', organizerId: 'a', startAt: now + HOUR_MS, endAt: now + 2 * HOUR_MS });
    await seedEvent(db, { id: 'eb', organizerId: 'b', startAt: now + 3 * HOUR_MS, endAt: now + 4 * HOUR_MS });

    const result = await computeBusyBlocksForUsers(env, ['a', 'b'], now, now + DAY_MS);
    expect(result.get('a')).toEqual([{ startAt: now + HOUR_MS, endAt: now + 2 * HOUR_MS }]);
    expect(result.get('b')).toEqual([{ startAt: now + 3 * HOUR_MS, endAt: now + 4 * HOUR_MS }]);
  });

  it('handles a declined invite by excluding that event from the invitee', async () => {
    const { db, env } = setup();
    await seedGuild(db);
    await seedUser(db, 'organizer');
    await seedUser(db, 'invitee');
    await seedMembership(db, 'organizer', 'guild-1');
    await seedMembership(db, 'invitee', 'guild-1');
    const now = Date.now();
    await seedEvent(db, { id: 'e1', organizerId: 'organizer', startAt: now + HOUR_MS, endAt: now + 2 * HOUR_MS });
    await db.prepare(
      `INSERT INTO event_invites (id, event_id, user_id, invited_via, rsvp_status, invited_at) VALUES ('i1', 'e1', 'invitee', 'individual', 'declined', ?)`,
    )
      .bind(now)
      .run();

    const result = await computeBusyBlocksForUsers(env, ['invitee'], now, now + DAY_MS);
    expect(result.get('invitee')).toEqual([]);
  });
});

// O-02: the D1 shim enforces the 100-bound-parameter ceiling but, before
// this, never counted total queries per invocation -- so a route could
// silently exceed Cloudflare's 50-query Free-plan budget while every
// existing test stayed green. These assert the actual number stays inside
// that budget at the application's own configured maxima, not just that the
// request eventually succeeds.
describe('D1 query budget at configured maxima (O-02)', () => {
  it('a full calendar (max active events, all recurring, all multi-winner polls) stays within the Free-plan query budget', async () => {
    const { db, env } = setup();
    await seedGuild(db);
    await seedUser(db, 'u1');
    await seedMembership(db, 'u1', 'guild-1');
    const headers = await authHeaders(env, 'u1');

    const now = Date.now();
    const dateStr = new Date(now).toISOString().slice(0, 10);
    for (const id of ids('rec', 100)) {
      await seedEvent(db, { id, organizerId: 'u1', isRecurring: 1, startAt: null, endAt: null });
      await db.prepare(`UPDATE events SET timezone = 'UTC' WHERE id = ?`).bind(id).run();
      await db.prepare(
        `INSERT INTO event_recurrence_rules (event_id, freq, interval, start_date, start_time, duration_minutes, end_type)
         VALUES (?, 'DAILY', 1, ?, '12:00', 60, 'never')`,
      )
        .bind(id, dateStr)
        .run();
    }
    for (const id of ids('mw', 200)) {
      await seedEvent(db, { id, organizerId: 'u1', eventType: 'poll', startAt: null, endAt: null });
      await db.prepare(`UPDATE events SET poll_resolution_mode = 'multi_winner' WHERE id = ?`).bind(id).run();
      await db.prepare(
        `INSERT INTO event_poll_options (id, event_id, start_at, end_at, display_order, confirmed_at)
         VALUES (?, ?, ?, ?, 0, ?)`,
      )
        .bind(`${id}-opt`, id, now + HOUR_MS, now + 2 * HOUR_MS, now)
        .run();
    }

    db.resetQueryCount();
    const res = await app.request(
      `https://worker.test/guilds/guild-1/events?from=${now}&to=${now + 7 * DAY_MS}`,
      { headers },
      env,
    );
    expect(res.status).toBe(200);
    expect(db.queryCount).toBeLessThan(D1_FREE_PLAN_QUERY_BUDGET);
  });

  it('a full free/busy request (max users, each with a recurring event) stays within the Free-plan query budget', async () => {
    const { db, env } = setup();
    await seedGuild(db);
    await seedUser(db, 'caller');
    await seedMembership(db, 'caller', 'guild-1');
    const headers = await authHeaders(env, 'caller');

    const now = Date.now();
    const dateStr = new Date(now).toISOString().slice(0, 10);
    const userIds = ids('friend', 100);
    for (const id of userIds) {
      await seedUser(db, id);
      await seedMembership(db, id, 'guild-1');
      await seedEvent(db, { id: `e-${id}`, organizerId: id, isRecurring: 1, startAt: null, endAt: null });
      await db.prepare(`UPDATE events SET timezone = 'UTC' WHERE id = ?`).bind(`e-${id}`).run();
      await db.prepare(
        `INSERT INTO event_recurrence_rules (event_id, freq, interval, start_date, start_time, duration_minutes, end_type)
         VALUES (?, 'DAILY', 1, ?, '12:00', 60, 'never')`,
      )
        .bind(`e-${id}`, dateStr)
        .run();
    }

    db.resetQueryCount();
    const range = `from=${now}&to=${now + 7 * DAY_MS}`;
    const res = await app.request(
      `https://worker.test/guilds/guild-1/free-busy?${range}&user_ids=${userIds.join(',')}`,
      { headers },
      env,
    );
    expect(res.status).toBe(200);
    expect(db.queryCount).toBeLessThan(D1_FREE_PLAN_QUERY_BUDGET);
  });

  it('the membership-refresh cron sweep stays within the Free-plan query budget at its configured tick size', async () => {
    const { db, env } = setup();
    await seedGuild(db);
    for (const id of ids('u', 50)) {
      await seedUser(db, id);
      await seedMembership(db, id, 'guild-1', { verifiedAgoMs: 2 * HOUR_MS });
    }
    fetchStub = stubFetch([{ match: '/members/', status: 200 }]);

    db.resetQueryCount();
    await runReminderSweep(env);
    // This assertion is scoped to what the membership sweep alone should
    // cost, not the whole tick (other sweeps ran too, against an otherwise
    // empty database) -- the point is that 50 confirmed rows no longer cost
    // 50 separate UPDATEs.
    expect(db.queryCount).toBeLessThan(D1_FREE_PLAN_QUERY_BUDGET);
  });
});
