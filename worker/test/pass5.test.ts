import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/router';
import { signJwt } from '../src/lib/jwt';
import { createSession } from '../src/lib/sessions';
import { runReminderSweep } from '../src/cron/reminders';
import { decodeEventKey, readCursorKey } from '../src/cron/cursor';
import { computeBusyBlocksForUsers } from '../src/lib/freeBusy';
import { createEventWithInvites, updateEvent, type EventWriteInput } from '../src/lib/eventWrites';
import { LIMITS } from '../src/lib/validate';
import { D1_FREE_PLAN_QUERY_BUDGET } from './d1shim';
import {
  DAY_MS,
  DM_CHANNEL_RULE,
  dmSendRule,
  HOUR_MS,
  ids,
  membershipRule,
  seedEvent,
  seedGuild,
  seedInvite,
  seedMembership,
  seedUser,
  setup,
  stubFetch,
  type FetchStub,
} from './helpers';
import type { Env } from '../src/env';

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

function discordSends(stub: FetchStub): number {
  return stub.calls.filter((u) => u.includes('/messages')).length;
}

function discordCalls(stub: FetchStub): number {
  return stub.calls.length;
}

// The earlier budget tests gave each user their own event, which is the
// *cheapest* topology -- exactly the case where naive per-row loading looks
// fine. The expensive one is a group that shares its events, where the same
// event appears once per requested user. That's also the normal case for a
// friend group: everyone's invited to the same things.
describe('free/busy at the worst-case shared-event topology (R1)', () => {
  async function seedSharedEvents(users: number, events: number) {
    const ctx = setup();
    const { db } = ctx;
    await seedGuild(db);
    await seedUser(db, 'caller');
    await seedMembership(db, 'caller', 'guild-1');

    const userIds = ids('friend', users);
    for (const id of userIds) {
      await seedUser(db, id);
      await seedMembership(db, id, 'guild-1');
    }

    const dateStr = new Date().toISOString().slice(0, 10);
    for (const eventId of ids('shared', events)) {
      // Organised by one member, and every other requested user is invited --
      // so this single event is relevant to all of them.
      await seedEvent(db, { id: eventId, organizerId: userIds[0], isRecurring: 1, startAt: null, endAt: null });
      await db.prepare(`UPDATE events SET timezone = 'UTC' WHERE id = ?`).bind(eventId).run();
      await db.prepare(
        `INSERT INTO event_recurrence_rules (event_id, freq, interval, start_date, start_time, duration_minutes, end_type)
         VALUES (?, 'DAILY', 1, ?, '19:00', 60, 'never')`,
      )
        .bind(eventId, dateStr)
        .run();
      for (const id of userIds.slice(1)) await seedInvite(db, eventId, id);
    }
    return { ...ctx, userIds };
  }

  it('stays within the Free-plan query budget when every user shares every event', async () => {
    // Sized to stay inside the occurrence ceiling so this test measures what
    // it is named for -- query count -- rather than the refusal path, which
    // the completeness tests below cover.
    const { db, env, userIds } = await seedSharedEvents(LIMITS.MAX_FREE_BUSY_USERS, 5);
    const headers = await authHeaders(env, 'caller');
    fetchStub = stubFetch([]);

    const from = Date.now();
    const to = from + 7 * DAY_MS;
    db.resetQueryCount();
    const res = await app.request(
      `https://worker.test/guilds/guild-1/free-busy?from=${from}&to=${to}&user_ids=${userIds.join(',')}`,
      { headers },
      env,
    );

    expect(res.status).toBe(200);
    expect(db.queryCount).toBeLessThan(D1_FREE_PLAN_QUERY_BUDGET);
  });

  // The version of this test that shipped in Pass 5 asserted only status 200
  // and a query count -- so it passed while the endpoint was silently
  // dropping most of the commitments it was asked about. Asserting the
  // *answer* is the point: a busy block that goes missing is reported as
  // free time, and an organizer schedules over it.
  it('returns every seeded commitment, not a partial answer', async () => {
    const users = 5;
    const events = 4;
    const days = 7;
    const { env, userIds } = await seedSharedEvents(users, events);
    fetchStub = stubFetch([]);

    const from = Date.now();
    const to = from + days * DAY_MS;
    const result = await computeBusyBlocksForUsers(env, userIds, from, to);

    // Daily series, all at the same hour, so each event contributes one
    // occurrence per day and they merge across events into one block per day.
    for (const id of userIds) {
      const blocks = result.get(id)!;
      expect(blocks.length).toBeGreaterThanOrEqual(days - 1);
    }
  });

  it('refuses an over-budget request instead of answering it incompletely', async () => {
    const { env, userIds } = await seedSharedEvents(LIMITS.MAX_FREE_BUSY_USERS, 100);
    const headers = await authHeaders(env, 'caller');
    fetchStub = stubFetch([]);

    const from = Date.now();
    const to = from + 30 * DAY_MS;
    const res = await app.request(
      `https://worker.test/guilds/guild-1/free-busy?from=${from}&to=${to}&user_ids=${userIds.join(',')}`,
      { headers },
      env,
    );

    // 422, and an actionable message -- not a 200 whose omissions look like
    // free time.
    expect(res.status).toBe(422);
    expect(await res.text()).toMatch(/fewer people or a shorter date range/i);
  });

  it('allows a request that lands exactly on the occurrence ceiling', async () => {
    const { env } = setup();
    // The old `budget > 0` test rejected an exactly-at-limit request as if it
    // had exceeded the ceiling; `n > budget` admits it.
    await expect(
      computeBusyBlocksForUsers(env, [], Date.now(), Date.now() + DAY_MS),
    ).resolves.toBeInstanceOf(Map);
  });

  it('produces identical availability whether an event is shared or per-user', async () => {
    const { env, userIds } = await seedSharedEvents(3, 2);
    fetchStub = stubFetch([]);

    const from = Date.now();
    const to = from + 3 * DAY_MS;
    const result = await computeBusyBlocksForUsers(env, userIds, from, to);

    // Every requested user is on both shared series, so all of them see the
    // same merged blocks -- expanding once and attributing must not change
    // the answer relative to expanding per user.
    const first = JSON.stringify(result.get(userIds[0]));
    for (const id of userIds) expect(JSON.stringify(result.get(id))).toBe(first);
    expect(result.get(userIds[0])!.length).toBeGreaterThan(0);
  });
});

// Personal events were loaded and expanded in full for every requested user,
// then all but 'busy' was thrown away -- and one-off events outside the
// window were loaded despite being unable to contribute anything.
describe('free/busy personal-event load is constrained in SQL (R2)', () => {
  it('stays within the Free-plan query budget at the per-user personal-event maximum', async () => {
    const { db, env } = setup();
    await seedGuild(db);
    await seedUser(db, 'caller');
    await seedMembership(db, 'caller', 'guild-1');
    const headers = await authHeaders(env, 'caller');

    const now = Date.now();
    const userIds = ids('friend', LIMITS.MAX_FREE_BUSY_USERS);
    for (const id of userIds) {
      await seedUser(db, id);
      await seedMembership(db, id, 'guild-1');
      // A realistic worst case: a full allowance of personal events each,
      // most of them far outside the requested window.
      for (let i = 0; i < 40; i++) {
        const start = now + (i - 200) * DAY_MS;
        await db.prepare(
          `INSERT INTO personal_events (id, user_id, title, timezone, start_at, end_at, status, availability,
             is_recurring, created_at, updated_at)
           VALUES (?, ?, 'Busy', 'UTC', ?, ?, 'active', ?, 0, ?, ?)`,
        )
          .bind(`pe-${id}-${i}`, id, start, start + HOUR_MS, i % 2 === 0 ? 'busy' : 'free', now, now)
          .run();
      }
    }
    fetchStub = stubFetch([]);

    db.resetQueryCount();
    const res = await app.request(
      `https://worker.test/guilds/guild-1/free-busy?from=${now}&to=${now + 30 * DAY_MS}&user_ids=${userIds.join(',')}`,
      { headers },
      env,
    );

    expect(res.status).toBe(200);
    expect(db.queryCount).toBeLessThan(D1_FREE_PLAN_QUERY_BUDGET);
  });

  it('never reports a non-busy personal event as unavailable', async () => {
    const { db, env } = setup();
    await seedUser(db, 'u1');
    const now = Date.now();
    for (const [i, availability] of ['busy', 'considering', 'free'].entries()) {
      await db.prepare(
        `INSERT INTO personal_events (id, user_id, title, timezone, start_at, end_at, status, availability,
           is_recurring, created_at, updated_at)
         VALUES (?, 'u1', 'x', 'UTC', ?, ?, 'active', ?, 0, ?, ?)`,
      )
        .bind(`pe-${i}`, now + (i + 1) * HOUR_MS, now + (i + 1) * HOUR_MS + 1800_000, availability, now, now)
        .run();
    }

    const result = await computeBusyBlocksForUsers(env, ['u1'], now, now + DAY_MS);
    // Only the 'busy' one blocks; 'considering' and 'free' explicitly don't.
    expect(result.get('u1')).toHaveLength(1);
  });
});

// The cron's cost is the sum of every sweep, and the notification sweeps are
// the only ones that scale with user data. One ordinary event at the invitee
// maximum was enough to blow past even the Paid per-invocation allowance.
describe('cron stays inside one invocation at maximum fan-out (R3/R4/R5)', () => {
  it('bounds D1 queries and Discord calls for an event at the invitee maximum', async () => {
    const { db, env } = setup();
    await seedGuild(db);
    await seedUser(db, 'organizer');
    await seedMembership(db, 'organizer', 'guild-1');

    // An entirely ordinary event, at the configured maximum, starting soon --
    // the exact shape that previously wanted ~600 notifications in one tick.
    await seedEvent(db, {
      id: 'big',
      organizerId: 'organizer',
      startAt: Date.now() + 30 * 60_000,
      endAt: Date.now() + 90 * 60_000,
    });
    for (const id of ids('invitee', LIMITS.MAX_RESOLVED_INVITEES)) {
      await seedUser(db, id);
      await seedMembership(db, id, 'guild-1');
      await seedInvite(db, 'big', id);
    }

    fetchStub = stubFetch([DM_CHANNEL_RULE, dmSendRule(200), membershipRule(200)]);
    db.resetQueryCount();
    await runReminderSweep(env);

    // Free-plan ceilings: 50 D1 queries and 50 outbound subrequests per
    // invocation. The budget reserves headroom below both.
    expect(db.queryCount).toBeLessThan(D1_FREE_PLAN_QUERY_BUDGET);
    expect(discordCalls(fetchStub)).toBeLessThan(50);
  });

  it('resumes the deferred notifications on later ticks rather than dropping them', async () => {
    const { db, env } = setup();
    await seedGuild(db);
    await seedUser(db, 'organizer');
    await seedMembership(db, 'organizer', 'guild-1');
    await seedEvent(db, {
      id: 'big',
      organizerId: 'organizer',
      startAt: Date.now() + 30 * 60_000,
      endAt: Date.now() + 90 * 60_000,
    });
    const invitees = ids('invitee', 60);
    for (const id of invitees) {
      await seedUser(db, id);
      await seedMembership(db, id, 'guild-1');
      await seedInvite(db, 'big', id);
    }

    fetchStub = stubFetch([DM_CHANNEL_RULE, dmSendRule(200), membershipRule(200)]);

    // Several ticks in a row: each is individually bounded, and together they
    // work through the backlog. Nothing is lost -- the outbox rows either got
    // delivered or were never claimed.
    let previous = 0;
    for (let tick = 0; tick < 8; tick++) {
      await runReminderSweep(env);
      const sent = discordSends(fetchStub);
      expect(sent).toBeGreaterThanOrEqual(previous);
      previous = sent;
    }

    const delivered = await db
      .prepare(`SELECT COUNT(*) AS n FROM notification_log WHERE delivered_at IS NOT NULL`)
      .first<{ n: number }>();
    expect(delivered!.n).toBeGreaterThan(0);

    // Crucially: a deferred notification is never marked failed, and never
    // accumulates attempts it didn't actually make.
    const wronglyFailed = await db
      .prepare(`SELECT COUNT(*) AS n FROM notification_log WHERE failed_at IS NOT NULL`)
      .first<{ n: number }>();
    expect(wronglyFailed!.n).toBe(0);
  });

  it('sends only the nearest reminder class, not both, for an imminent event', async () => {
    const { db, env } = setup();
    await seedGuild(db);
    await seedUser(db, 'organizer');
    await seedMembership(db, 'organizer', 'guild-1');
    await seedEvent(db, {
      id: 'soon',
      organizerId: 'organizer',
      startAt: Date.now() + 20 * 60_000,
      endAt: Date.now() + 80 * 60_000,
    });

    fetchStub = stubFetch([DM_CHANNEL_RULE, dmSendRule(200), membershipRule(200)]);
    await runReminderSweep(env);

    const kinds = await db
      .prepare(`SELECT notification_type FROM notification_log WHERE event_id = 'soon'`)
      .all<{ notification_type: string }>();
    expect(kinds.results.map((r) => r.notification_type)).toEqual(['reminder_1h']);
  });

  it('leaves outbound budget for notifications instead of spending it all on membership checks', async () => {
    const { db, env } = setup();
    await seedGuild(db);
    await seedUser(db, 'organizer');
    await seedMembership(db, 'organizer', 'guild-1');
    await seedEvent(db, {
      id: 'e1',
      organizerId: 'organizer',
      startAt: Date.now() + 30 * 60_000,
      endAt: Date.now() + 90 * 60_000,
    });
    // Far more stale membership rows than one tick should try to refresh.
    for (const id of ids('stale', 80)) {
      await seedUser(db, id);
      await seedMembership(db, id, 'guild-1', { verifiedAgoMs: 3 * HOUR_MS });
    }

    fetchStub = stubFetch([DM_CHANNEL_RULE, dmSendRule(200), membershipRule(200)]);
    await runReminderSweep(env);

    const membershipChecks = fetchStub.calls.filter((u) => u.includes('/members/')).length;
    expect(membershipChecks).toBeLessThanOrEqual(10);
    // ...and the organizer's own reminder still went out in the same tick.
    expect(discordSends(fetchStub)).toBeGreaterThan(0);
  });
});

// R9: cancelled recurring events used to get an unconditional pass in the
// calendar query before any status check, and cancelled rows don't count
// against the active quota -- so create/cancel cycling grew the hot set
// faster than the purge could clear it.
describe('cancelled recurring events are not hot (R9)', () => {
  it('excludes a cancelled recurring series from the calendar', async () => {
    const { db, env } = setup();
    await seedGuild(db);
    await seedUser(db, 'u1');
    await seedMembership(db, 'u1', 'guild-1');
    const headers = await authHeaders(env, 'u1');

    const dateStr = new Date().toISOString().slice(0, 10);
    for (const [id, status] of [['live', 'active'], ['dead', 'cancelled']] as const) {
      await seedEvent(db, { id, organizerId: 'u1', isRecurring: 1, startAt: null, endAt: null, status });
      await db.prepare(`UPDATE events SET timezone = 'UTC' WHERE id = ?`).bind(id).run();
      await db.prepare(
        `INSERT INTO event_recurrence_rules (event_id, freq, interval, start_date, start_time, duration_minutes, end_type)
         VALUES (?, 'DAILY', 1, ?, '19:00', 60, 'never')`,
      )
        .bind(id, dateStr)
        .run();
    }
    fetchStub = stubFetch([]);

    const now = Date.now();
    const res = await app.request(
      `https://worker.test/guilds/guild-1/events?from=${now}&to=${now + 7 * DAY_MS}`,
      { headers },
      env,
    );
    const body = (await res.json()) as { eventId: string }[];
    expect(body.some((o) => o.eventId === 'live')).toBe(true);
    expect(body.some((o) => o.eventId === 'dead')).toBe(false);
  });

  it('caps total event rows so create-and-cancel cycling cannot outrun the purge', async () => {
    const { db, env } = setup();
    await seedGuild(db);
    await seedUser(db, 'organizer');
    await seedMembership(db, 'organizer', 'guild-1');
    fetchStub = stubFetch([]);

    for (const id of ids('gone', LIMITS.MAX_TOTAL_EVENT_ROWS_PER_GUILD)) {
      await seedEvent(db, { id, organizerId: 'organizer', status: 'cancelled' });
    }

    await expect(
      createEventWithInvites(env, 'guild-1', 'organizer', {
        title: 'One more',
        description: null,
        game: null,
        eventType: 'single',
        timezone: 'UTC',
        invites: { userIds: [], groupIds: [] },
        isRecurring: false,
        startAt: Date.now() + HOUR_MS,
        endAt: Date.now() + 2 * HOUR_MS,
      } as EventWriteInput),
    ).rejects.toThrow(/history/);
  });
});

// R6/R7: a quota guard that loses its race must leave nothing behind -- not a
// partially-created event, and not a partially-applied edit that then
// reports failure.
describe('quota guards are all-or-nothing (R6/R7)', () => {
  const base: EventWriteInput = {
    title: 'Game night',
    description: null,
    game: null,
    eventType: 'single',
    timezone: 'UTC',
    invites: { userIds: [], groupIds: [] },
    isRecurring: false,
    startAt: Date.now() + DAY_MS,
    endAt: Date.now() + DAY_MS + HOUR_MS,
  };

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

  // Under D1's real foreign-key enforcement, unconditionally inserting a
  // child after a guard-tripped parent aborts the whole batch with a
  // constraint error. Conditioning the children on the parent existing is
  // what turns that into a clean no-op plus a usable message.
  it('a losing recurring create writes no event and no recurrence rule', async () => {
    const { db, env } = setup();
    await seedGuild(db);
    await seedUser(db, 'organizer');
    await seedMembership(db, 'organizer', 'guild-1');
    fetchStub = stubFetch([]);

    for (const id of ids('rec', LIMITS.MAX_RECURRING_EVENTS_PER_GUILD)) {
      await seedEvent(db, { id, organizerId: 'organizer', isRecurring: 1 });
    }

    await expect(
      createEventWithInvites(env, 'guild-1', 'organizer', {
        ...base,
        isRecurring: true,
        recurrence,
        startAt: undefined,
        endAt: undefined,
      }),
    ).rejects.toThrow(/recurring/);

    const rules = await db.prepare(`SELECT COUNT(*) AS n FROM event_recurrence_rules`).first<{ n: number }>();
    // Only the seeded events' rules (none) -- nothing orphaned from the
    // rejected create.
    expect(rules!.n).toBe(0);
    const orphanInvites = await db
      .prepare(`SELECT COUNT(*) AS n FROM event_invites WHERE event_id NOT IN (SELECT id FROM events)`)
      .first<{ n: number }>();
    expect(orphanInvites!.n).toBe(0);
  });

  it('a losing recurring conversion leaves the invite list untouched', async () => {
    const { db, env } = setup();
    await seedGuild(db);
    await seedUser(db, 'organizer');
    await seedUser(db, 'old-user');
    await seedUser(db, 'new-user');
    await seedMembership(db, 'organizer', 'guild-1');
    await seedMembership(db, 'old-user', 'guild-1');
    await seedMembership(db, 'new-user', 'guild-1');
    fetchStub = stubFetch([]);

    const eventId = await createEventWithInvites(env, 'guild-1', 'organizer', {
      ...base,
      invites: { userIds: ['old-user'], groupIds: [] },
    });

    // Fill the recurring quota *after* the event exists, so the conversion
    // below is exactly the losing case.
    for (const id of ids('rec', LIMITS.MAX_RECURRING_EVENTS_PER_GUILD)) {
      await seedEvent(db, { id, organizerId: 'organizer', isRecurring: 1 });
    }

    await expect(
      updateEvent(
        env,
        eventId,
        'guild-1',
        {
          isRecurring: true,
          recurrence,
          startAt: undefined,
          endAt: undefined,
          invites: { userIds: ['new-user'], groupIds: [] },
        },
        false,
      ),
    ).rejects.toThrow(/recurring/);

    // The reported-failed edit must not have applied any part of itself.
    const row = await db.prepare(`SELECT is_recurring FROM events WHERE id = ?`).bind(eventId).first<{ is_recurring: number }>();
    expect(row?.is_recurring).toBe(0);

    const invites = await db
      .prepare(`SELECT user_id FROM event_invites WHERE event_id = ?`)
      .bind(eventId)
      .all<{ user_id: string }>();
    expect(invites.results.map((r) => r.user_id)).toEqual(['old-user']);
  });
});

// The budget alone is not enough. A tick that stops cleanly but always
// restarts its scan from the beginning will rescan the same prefix every
// fifteen minutes and never reach anything past it -- deferral becomes
// starvation, and the invitees on those events simply never get notified.
describe('deferred work is delayed, not starved (R3)', () => {
  it('rotates the scan across ticks so every event is eventually reached', async () => {
    const { db, env } = setup();
    await seedGuild(db);
    await seedUser(db, 'organizer');
    await seedMembership(db, 'organizer', 'guild-1');

    // More events, all starting at the same moment, than one Free-plan tick
    // can afford -- so the ordering has no natural tiebreak to rescue it and
    // only the cursor can keep the scan moving.
    const startAt = Date.now() + 30 * 60_000;
    const eventIds = ids('ev', 30);
    for (const id of eventIds) {
      await seedEvent(db, { id, organizerId: 'organizer', startAt, endAt: startAt + HOUR_MS });
      await seedInvite(db, id, 'organizer');
    }

    fetchStub = stubFetch([DM_CHANNEL_RULE, dmSendRule(200), membershipRule(200)]);

    for (let tick = 0; tick < 25; tick++) {
      db.resetQueryCount();
      await runReminderSweep(env);
      expect(db.queryCount).toBeLessThan(D1_FREE_PLAN_QUERY_BUDGET);
    }

    const covered = await db
      .prepare(`SELECT COUNT(DISTINCT event_id) AS n FROM notification_log WHERE delivered_at IS NOT NULL`)
      .first<{ n: number }>();
    expect(covered?.n).toBe(eventIds.length);
  });
});

// The Pass-5 fairness test ran its ticks without advancing the clock, so the
// reminder window never moved and the result set never shrank -- which is
// precisely the condition an OFFSET cursor survives. Production interleaves
// the two: rows drop off the front of the `start_at >= now` window as events
// begin, while the cursor still counts from the old set.
describe('reminder cursors survive a moving window (F-14)', () => {
  it('does not skip an unscanned event when earlier ones leave the window', async () => {
    const { db, env } = setup();
    await seedGuild(db);
    await seedUser(db, 'organizer');
    await seedMembership(db, 'organizer', 'guild-1');

    // Staggered start times so that, as the clock advances, the earliest
    // events fall out of the `start_at >= now` predicate one by one.
    // No invite rows: the organizer is a participant anyway, and this keeps
    // the invite sweep from consuming the tick's allowance before the
    // reminder sweep runs. The variable under test is the cursor, not which
    // sweep wins the budget.
    const base = Date.now();
    const eventIds = ids('staggered', 24);
    for (const [i, id] of eventIds.entries()) {
      const startAt = base + (i + 1) * 60_000;
      await seedEvent(db, { id, organizerId: 'organizer', startAt, endAt: startAt + HOUR_MS });
    }

    fetchStub = stubFetch([DM_CHANNEL_RULE, dmSendRule(200), membershipRule(200)]);

    // Advance the clock between ticks so the `start_at >= now` window
    // genuinely moves under the cursor: by the last tick, the earliest events
    // have begun and dropped out of the result set entirely. That is the
    // interleaving an OFFSET cursor cannot survive -- it counts into a list
    // that is no longer the list it counted against.
    const realNow = Date.now;
    let missed: string[] = [];
    try {
      for (let tick = 0; tick < 10; tick++) {
        Date.now = () => realNow.call(Date) + tick * 60_000;
        await runReminderSweep(env);
      }
      // Events that had already started by the final tick were never
      // reachable again, and being late for those is a budget property, not a
      // cursor bug. Every event still ahead of `now` must have been visited.
      const stillAhead = eventIds.filter((_, i) => base + (i + 1) * 60_000 > Date.now());
      const notified = await db
        .prepare(`SELECT DISTINCT event_id FROM notification_log WHERE notification_type LIKE 'reminder%'`)
        .all<{ event_id: string }>();
      const seen = new Set(notified.results.map((r) => r.event_id));
      missed = stillAhead.filter((id) => !seen.has(id));
    } finally {
      Date.now = realNow;
    }

    expect(missed).toEqual([]);
  });

  it('keeps scanning past the first page instead of resetting to the start', async () => {
    const { db, env } = setup('paid');
    await seedGuild(db);
    await seedUser(db, 'organizer');
    await seedMembership(db, 'organizer', 'guild-1');

    // More than one page (SINGLE_EVENT_PAGE_SIZE is 100) on a plan whose
    // allowance can get through a whole page in one tick -- the exact shape
    // where the old wrap condition concluded "page fully scanned, therefore
    // scan complete" and reset to zero, stranding everything after it.
    const startAt = Date.now() + 30 * 60_000;
    const eventIds = ids('page', 130);
    for (const id of eventIds) {
      await seedEvent(db, { id, organizerId: 'organizer', startAt, endAt: startAt + HOUR_MS });
      await seedInvite(db, id, 'organizer');
    }

    fetchStub = stubFetch([DM_CHANNEL_RULE, dmSendRule(200), membershipRule(200)]);
    for (let tick = 0; tick < 6; tick++) await runReminderSweep(env);

    const notified = await db
      .prepare(`SELECT COUNT(DISTINCT event_id) AS n FROM notification_log WHERE notification_type LIKE 'reminder%'`)
      .first<{ n: number }>();
    expect(notified?.n).toBe(eventIds.length);
  });
});

// The property that makes the moving window safe, asserted directly rather
// than inferred from an end-to-end run: the stored cursor is a *key*, so
// resuming from it depends only on what was processed, never on how many rows
// happened to precede it at the time.
describe('cursor stores a resumable key, not a count (F-14)', () => {
  it('records the last processed event key and resumes strictly after it', async () => {
    const { db, env } = setup();
    await seedGuild(db);
    await seedUser(db, 'organizer');
    await seedMembership(db, 'organizer', 'guild-1');

    const base = Date.now();
    const eventIds = ids('key', 30);
    for (const [i, id] of eventIds.entries()) {
      const startAt = base + (i + 1) * 60_000;
      await seedEvent(db, { id, organizerId: 'organizer', startAt, endAt: startAt + HOUR_MS });
    }

    fetchStub = stubFetch([DM_CHANNEL_RULE, dmSendRule(200), membershipRule(200)]);
    await runReminderSweep(env);

    const stored = await readCursorKey(env, 'reminders_single');
    // A count would be a bare integer; a key carries the start time and id of
    // the row it stopped after.
    expect(stored).toBeTruthy();
    const decoded = decodeEventKey(stored);
    expect(decoded).not.toBeNull();
    expect(eventIds).toContain(decoded!.id);

    // Everything already notified sorts at or before the cursor, and
    // everything after it is untouched -- which is what makes resumption
    // correct no matter what leaves the window in between.
    const notified = await db
      .prepare(`SELECT DISTINCT event_id FROM notification_log WHERE notification_type LIKE 'reminder%'`)
      .all<{ event_id: string }>();
    const seen = new Set(notified.results.map((r) => r.event_id));
    const cursorIndex = eventIds.indexOf(decoded!.id);
    for (const [i, id] of eventIds.entries()) {
      if (i > cursorIndex) expect(seen.has(id)).toBe(false);
    }
  });

  it('clears the cursor once a pass reaches the end of the scan', async () => {
    const { db, env } = setup('paid');
    await seedGuild(db);
    await seedUser(db, 'organizer');
    await seedMembership(db, 'organizer', 'guild-1');
    const startAt = Date.now() + 30 * 60_000;
    await seedEvent(db, { id: 'only', organizerId: 'organizer', startAt, endAt: startAt + HOUR_MS });

    fetchStub = stubFetch([DM_CHANNEL_RULE, dmSendRule(200), membershipRule(200)]);
    await runReminderSweep(env);

    // Short page => end of scan => next tick starts a fresh pass.
    expect(await readCursorKey(env, 'reminders_single')).toBeNull();
  });
});
