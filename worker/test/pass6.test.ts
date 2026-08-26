import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/router';
import { signJwt } from '../src/lib/jwt';
import { createSession } from '../src/lib/sessions';
import { runReminderSweep } from '../src/cron/reminders';
import { getOptionTallies, resolvePastDeadlinePolls } from '../src/lib/polls';
import { createEventWithInvites, updateEvent, type EventWriteInput } from '../src/lib/eventWrites';
import { LIMITS } from '../src/lib/validate';
import { conditionalRowsSql } from '../src/lib/d1';
import { D1_FREE_PLAN_QUERY_BUDGET, type ShimDatabase } from './d1shim';
import {
  DM_CHANNEL_RULE,
  dmSendRule,
  HOUR_MS,
  ids,
  loadEventRow,
  membershipRule,
  seedGuild,
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

function maxOptions(): { startAt: number; endAt: number }[] {
  const base = Date.now() + 7 * 24 * HOUR_MS;
  return Array.from({ length: LIMITS.MAX_POLL_OPTIONS }, (_, i) => ({
    startAt: base + i * 24 * HOUR_MS,
    endAt: base + i * 24 * HOUR_MS + HOUR_MS,
  }));
}

async function seedOrganizer(db: ShimDatabase) {
  await seedGuild(db);
  await seedUser(db, 'organizer');
  await seedMembership(db, 'organizer', 'guild-1');
}

// Every one of these was over the Free plan's 50-statement invocation ceiling
// using data entirely within the app's own configured limits. The limits are
// the contract; if a shape the app admits cannot be served, either the limit
// or the implementation is wrong -- and here it was the implementation.
describe('a maximum-size option poll fits inside one Free-plan invocation', () => {
  async function seedMaxPoll(env: Env): Promise<string> {
    const input: EventWriteInput = {
      title: 'Max poll',
      timezone: 'UTC',
      eventType: 'poll',
      pollMode: 'options',
      pollResolutionMode: 'single_winner',
      pollStrategy: 'threshold',
      pollThresholdCount: 3,
      pollDeadlineAt: Date.now() + 24 * HOUR_MS,
      pollOptions: maxOptions(),
      invites: { userIds: [], groupIds: [] },
    } as unknown as EventWriteInput;
    return createEventWithInvites(env, 'guild-1', 'organizer', input);
  }

  it('creates one with the maximum options', async () => {
    const { db, env } = setup();
    await seedOrganizer(db);

    db.resetQueryCount();
    const eventId = await seedMaxPoll(env);
    expect(db.queryCount).toBeLessThan(D1_FREE_PLAN_QUERY_BUDGET);

    const n = await db
      .prepare(`SELECT COUNT(*) AS n FROM event_poll_options WHERE event_id = ?`)
      .bind(eventId)
      .first<{ n: number }>();
    expect(n?.n).toBe(LIMITS.MAX_POLL_OPTIONS);
  });

  it('creates one with the maximum options AND the maximum invitees', async () => {
    const { db, env } = setup();
    await seedOrganizer(db);
    // One short of the cap: the organizer's own row (idea 26) is the last of
    // the MAX_RESOLVED_INVITEES rows, and the budget this asserts is for that
    // full set of rows, not for the names submitted.
    const invitees = ids('invitee', LIMITS.MAX_INVITEES - 1);
    for (const id of invitees) {
      await seedUser(db, id);
      await seedMembership(db, id, 'guild-1');
    }
    fetchStub = stubFetch([membershipRule(200)]);

    db.resetQueryCount();
    await createEventWithInvites(env, 'guild-1', 'organizer', {
      title: 'Max poll with invites',
      timezone: 'UTC',
      eventType: 'poll',
      pollMode: 'options',
      pollResolutionMode: 'single_winner',
      pollStrategy: 'threshold',
      pollThresholdCount: 3,
      pollDeadlineAt: Date.now() + 24 * HOUR_MS,
      pollOptions: maxOptions(),
      invites: { userIds: invitees, groupIds: [] },
    } as unknown as EventWriteInput);

    expect(db.queryCount).toBeLessThan(D1_FREE_PLAN_QUERY_BUDGET);
  });

  it('tallies one in a single query', async () => {
    const { db, env } = setup();
    await seedOrganizer(db);
    const eventId = await seedMaxPoll(env);

    db.resetQueryCount();
    const tallies = await getOptionTallies(env, eventId);
    expect(db.queryCount).toBe(1);
    expect(tallies).toHaveLength(LIMITS.MAX_POLL_OPTIONS);
    // Options with no votes must still appear -- an INNER JOIN would drop them.
    expect(tallies.every((t) => t.yes === 0 && t.no === 0 && t.maybe === 0)).toBe(true);
  });

  it('serves a GET of one', async () => {
    const { db, env } = setup();
    await seedOrganizer(db);
    const eventId = await seedMaxPoll(env);
    const headers = await authHeaders(env, 'organizer');
    fetchStub = stubFetch([membershipRule(200)]);

    db.resetQueryCount();
    const res = await app.request(`https://worker.test/events/${eventId}/poll`, { headers }, env);

    expect(res.status).toBe(200);
    expect(db.queryCount).toBeLessThan(D1_FREE_PLAN_QUERY_BUDGET);
  });

  it('records a threshold vote on one', async () => {
    const { db, env } = setup();
    await seedOrganizer(db);
    const eventId = await seedMaxPoll(env);
    const headers = await authHeaders(env, 'organizer');
    fetchStub = stubFetch([membershipRule(200)]);

    const optionRow = await db
      .prepare(`SELECT id FROM event_poll_options WHERE event_id = ? ORDER BY display_order LIMIT 1`)
      .bind(eventId)
      .first<{ id: string }>();

    db.resetQueryCount();
    const res = await app.request(
      `https://worker.test/events/${eventId}/poll/vote`,
      {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ optionId: optionRow!.id, vote: 'yes' }),
      },
      env,
    );

    expect(res.status).toBe(200);
    expect(db.queryCount).toBeLessThan(D1_FREE_PLAN_QUERY_BUDGET);
  });

  it('replaces the option set on PATCH', async () => {
    const { db, env } = setup();
    await seedOrganizer(db);
    const eventId = await seedMaxPoll(env);

    db.resetQueryCount();
    await updateEvent(env, eventId, 'guild-1', { pollOptions: maxOptions() } as Partial<EventWriteInput>, await loadEventRow(db, eventId));
    expect(db.queryCount).toBeLessThan(D1_FREE_PLAN_QUERY_BUDGET);
  });

  it('resolves one at its deadline inside the cron budget', async () => {
    const { db, env } = setup();
    await seedOrganizer(db);
    const eventId = await seedMaxPoll(env);
    await db.prepare(`UPDATE events SET poll_deadline_at = ? WHERE id = ?`).bind(Date.now() - 1000, eventId).run();

    db.resetQueryCount();
    await resolvePastDeadlinePolls(env);
    expect(db.queryCount).toBeLessThan(D1_FREE_PLAN_QUERY_BUDGET);
  });
});

// 50 groups of 200 members each, all naming the same people, is admissible
// input: the deduplicated invite list stays under the 300 cap while every
// per-group query still runs.
describe('overlapping maximum groups resolve without one query per group', () => {
  it('stays within the Free-plan budget for MAX_GROUP_IDS groups sharing MAX_GROUP_MEMBERS members', async () => {
    const { db, env } = setup();
    await seedOrganizer(db);

    // Likewise one short: the groups fan into MAX_GROUP_MEMBERS - 1 people,
    // and the organizer's own row makes the resolved set exactly the cap.
    const members = ids('member', LIMITS.MAX_GROUP_MEMBERS - 1);
    for (const id of members) {
      await seedUser(db, id);
      await seedMembership(db, id, 'guild-1');
    }

    const groupIds = ids('group', LIMITS.MAX_GROUP_IDS);
    for (const groupId of groupIds) {
      await db.prepare(
        `INSERT INTO groups (id, guild_id, name, created_by, created_at)
         VALUES (?, 'guild-1', ?, 'organizer', ?)`,
      )
        .bind(groupId, `Group ${groupId}`, Date.now())
        .run();
      for (const userId of members) {
        await db.prepare(`INSERT INTO group_members (group_id, user_id, added_at) VALUES (?, ?, ?)`)
          .bind(groupId, userId, Date.now())
          .run();
      }
    }

    fetchStub = stubFetch([membershipRule(200)]);
    db.resetQueryCount();
    await createEventWithInvites(env, 'guild-1', 'organizer', {
      title: 'Everyone',
      timezone: 'UTC',
      eventType: 'single',
      startAt: Date.now() + 24 * HOUR_MS,
      endAt: Date.now() + 25 * HOUR_MS,
      invites: { userIds: [], groupIds },
    } as unknown as EventWriteInput);

    expect(db.queryCount).toBeLessThan(D1_FREE_PLAN_QUERY_BUDGET);
  });

  it('rejects an over-cap candidate set before paying to verify it', async () => {
    const { db, env } = setup();
    await seedOrganizer(db);

    // More distinct members than MAX_RESOLVED_INVITEES admits, spread over
    // two groups. The rejection must come before the membership filter, since
    // filtering can only shrink the set -- it can never bring it back under.
    const members = ids('member', LIMITS.MAX_RESOLVED_INVITEES + 50);
    for (const id of members) {
      await seedUser(db, id);
      await seedMembership(db, id, 'guild-1');
    }
    for (const [i, groupId] of ['g1', 'g2'].entries()) {
      await db.prepare(
        `INSERT INTO groups (id, guild_id, name, created_by, created_at)
         VALUES (?, 'guild-1', ?, 'organizer', ?)`,
      )
        .bind(groupId, groupId, Date.now())
        .run();
      for (const userId of members.slice(i * 200, (i + 1) * 200)) {
        await db.prepare(`INSERT INTO group_members (group_id, user_id, added_at) VALUES (?, ?, ?)`)
          .bind(groupId, userId, Date.now())
          .run();
      }
    }

    fetchStub = stubFetch([membershipRule(200)]);
    db.resetQueryCount();
    await expect(
      createEventWithInvites(env, 'guild-1', 'organizer', {
        title: 'Too many',
        timezone: 'UTC',
        eventType: 'single',
        startAt: Date.now() + 24 * HOUR_MS,
        endAt: Date.now() + 25 * HOUR_MS,
        invites: { userIds: [], groupIds: ['g1', 'g2'] },
      } as unknown as EventWriteInput),
    ).rejects.toThrow(/too large/i);
    expect(db.queryCount).toBeLessThan(D1_FREE_PLAN_QUERY_BUDGET);
  });
});

// The tick's fixed maintenance work and its scalable notification work were
// budgeted separately, so a full purge landing on an already-spent tick took
// the total past the ceiling.
describe('a full terminal purge and a spent notification budget still fit one tick', () => {
  it('stays within the Free-plan budget with both a backlog and a purge queue', async () => {
    const { db, env } = setup();
    await seedOrganizer(db);

    // Notification backlog: an event starting soon with many invitees.
    const startAt = Date.now() + 30 * 60_000;
    await db.prepare(
      `INSERT INTO events (id, guild_id, organizer_id, title, event_type, timezone, start_at, end_at,
         status, poll_mode, poll_resolution_mode, is_recurring, created_at, updated_at)
       VALUES ('soon', 'guild-1', 'organizer', 'Soon', 'single', 'UTC', ?, ?, 'active', 'options', 'single_winner', 0, ?, ?)`,
    )
      .bind(startAt, startAt + HOUR_MS, Date.now(), Date.now())
      .run();
    for (const id of ids('invitee', 120)) {
      await seedUser(db, id);
      await seedMembership(db, id, 'guild-1');
      await db.prepare(
        `INSERT INTO event_invites (id, event_id, user_id, invited_via, rsvp_status, invited_at)
         VALUES (?, 'soon', ?, 'individual', 'pending', ?)`,
      )
        .bind(`inv-${id}`, id, Date.now())
        .run();
    }

    // Purge queue: a full batch of long-expired cancelled events.
    const ancient = Date.now() - 200 * 24 * HOUR_MS;
    for (const id of ids('old', 100)) {
      await db.prepare(
        `INSERT INTO events (id, guild_id, organizer_id, title, event_type, timezone, start_at, end_at,
           status, poll_mode, poll_resolution_mode, is_recurring, created_at, updated_at)
         VALUES (?, 'guild-1', 'organizer', 'Old', 'single', 'UTC', ?, ?, 'cancelled', 'options', 'single_winner', 0, ?, ?)`,
      )
        .bind(id, ancient, ancient + HOUR_MS, ancient, ancient)
        .run();
    }

    fetchStub = stubFetch([DM_CHANNEL_RULE, dmSendRule(200), membershipRule(200)]);

    // Several ticks: the first spend their allowance on notifications and
    // defer the purge; a later, quieter one gets to it. Every one of them
    // stays inside the ceiling. Bumped from 30: the invitee-change-request
    // sweeps (docs/specs/0003) added two fixed queries to every tick's
    // reserve, leaving slightly less usable allowance and so slightly more
    // ticks before the 120-invitee reminder backlog fully drains and a tick
    // is quiet enough to fit the purge too.
    //
    // This test is also what proved IDEAS item 47 could not have a sweep of
    // its own: with one more fixed query per tick, the purge here never ran
    // at all -- not at 40 ticks, not at 200.
    for (let tick = 0; tick < 35; tick++) {
      db.resetQueryCount();
      await runReminderSweep(env);
      expect(db.queryCount).toBeLessThan(D1_FREE_PLAN_QUERY_BUDGET);
    }

    // And the purge is not starved forever by the notification work.
    const remaining = await db
      .prepare(`SELECT COUNT(*) AS n FROM events WHERE status = 'cancelled'`)
      .first<{ n: number }>();
    expect(remaining?.n).toBe(0);
  });
});

// Both of these are cases the Pass-5 quota tests missed by construction: the
// guard-loser test used an empty invite list, and there was no test at all
// for a failure arriving after the recurring slot was claimed.
describe('a failed write leaves the event exactly as it was (F-08)', () => {
  it('does not convert to recurring when target validation fails afterwards', async () => {
    const { db, env } = setup();
    await seedOrganizer(db);
    const startAt = Date.now() + 24 * HOUR_MS;
    await db.prepare(
      `INSERT INTO events (id, guild_id, organizer_id, title, event_type, timezone, start_at, end_at,
         status, poll_mode, poll_resolution_mode, is_recurring, created_at, updated_at)
       VALUES ('e1', 'guild-1', 'organizer', 'One-off', 'single', 'UTC', ?, ?, 'active', 'options', 'single_winner', 0, ?, ?)`,
    )
      .bind(startAt, startAt + HOUR_MS, Date.now(), Date.now())
      .run();

    fetchStub = stubFetch([membershipRule(200)]);

    // 'stranger' is not a member of this guild, so invitee resolution
    // rejects the request -- after the point where the recurring slot used
    // to have already been claimed.
    await expect(
      updateEvent(
        env,
        'e1',
        'guild-1',
        {
          isRecurring: true,
          recurrence: {
            freq: 'WEEKLY',
            interval: 1,
            byWeekday: [1],
            byMonthDay: null,
            startDate: new Date(startAt).toISOString().slice(0, 10),
            startTime: '19:00',
            durationMinutes: 60,
            endType: 'never',
            endDate: null,
            endCount: null,
          },
          invites: { userIds: ['stranger'], groupIds: [] },
        } as unknown as Partial<EventWriteInput>,
        await loadEventRow(db, 'e1'),
      ),
    ).rejects.toThrow(/not current members/i);

    const row = await db
      .prepare(`SELECT is_recurring, start_at, end_at FROM events WHERE id = 'e1'`)
      .first<{ is_recurring: number; start_at: number | null; end_at: number | null }>();
    // Untouched: still a one-off, still with its original times. The failure
    // mode this guards was is_recurring=1 with the old one-off times still
    // attached, no recurrence rule, and a quota slot consumed.
    expect(row?.is_recurring).toBe(0);
    expect(row?.start_at).toBe(startAt);

    const rules = await db
      .prepare(`SELECT COUNT(*) AS n FROM event_recurrence_rules WHERE event_id = 'e1'`)
      .first<{ n: number }>();
    expect(rules?.n).toBe(0);
  });

  it('makes invite children a clean no-op when the guarded parent is not written', async () => {
    const { db } = setup();
    await seedOrganizer(db);
    await seedUser(db, 'friend');

    // Exactly the statement shape createEventWithInvites builds for a create
    // whose quota guard writes zero rows: the parent never appears, so the
    // invite rows must simply not be written.
    //
    // D1 enforces foreign keys, so the unconditional version of this raised
    // an FK violation and aborted the batch -- the caller got an opaque
    // database error instead of the intended no-op plus quota message.
    const sql = conditionalRowsSql(
      'event_invites',
      ['id', 'event_id', 'user_id', 'invited_via', 'source_group_id', 'rsvp_status', 'invited_at'],
      2,
      'events',
      'ON CONFLICT(event_id, user_id) DO NOTHING',
    );

    await expect(
      db.batch([
        // Parent guard writes nothing, standing in for a lost quota race.
        db.prepare(`INSERT INTO events (id, guild_id, organizer_id, title, event_type, timezone,
             status, poll_mode, poll_resolution_mode, is_recurring, created_at, updated_at)
           SELECT 'ghost', 'guild-1', 'organizer', 'Ghost', 'single', 'UTC',
             'active', 'options', 'single_winner', 0, ?, ? WHERE 0`).bind(Date.now(), Date.now()),
        db
          .prepare(sql)
          .bind(
            'i1', 'ghost', 'friend', 'individual', null, 'pending', Date.now(),
            'i2', 'ghost', 'organizer', 'individual', null, 'pending', Date.now(),
            'ghost',
          ),
      ]),
    ).resolves.toBeDefined();

    const invites = await db.prepare(`SELECT COUNT(*) AS n FROM event_invites`).first<{ n: number }>();
    expect(invites?.n).toBe(0);
  });

  it('still writes the invite children when the guarded parent is written', async () => {
    const { db, env } = setup();
    await seedOrganizer(db);
    await seedUser(db, 'friend');
    await seedMembership(db, 'friend', 'guild-1');
    fetchStub = stubFetch([membershipRule(200)]);

    const now = Date.now();
    const eventId = await createEventWithInvites(env, 'guild-1', 'organizer', {
      title: 'Real',
      timezone: 'UTC',
      eventType: 'single',
      startAt: now + 24 * HOUR_MS,
      endAt: now + 25 * HOUR_MS,
      invites: { userIds: ['friend'], groupIds: [] },
    } as unknown as EventWriteInput);

    // The conditional form must not quietly suppress the normal case. Both
    // rows are the point: the invitee it was given, and the organizer it adds
    // for itself (idea 26).
    const invites = await db
      .prepare(`SELECT user_id FROM event_invites WHERE event_id = ?`)
      .bind(eventId)
      .all<{ user_id: string }>();
    expect(invites.results.map((r) => r.user_id).sort()).toEqual(['friend', 'organizer']);
  });
});
