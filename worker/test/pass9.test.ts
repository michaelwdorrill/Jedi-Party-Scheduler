import { afterEach, describe, expect, it, vi } from 'vitest';
import { runReminderSweep } from '../src/cron/reminders';
import { readCursorKey } from '../src/cron/cursor';
import { updateEvent, type EventWriteInput } from '../src/lib/eventWrites';
import { ConflictError, ValidationError } from '../src/lib/validate';
import { D1_FREE_PLAN_QUERY_BUDGET, type ShimDatabase } from './d1shim';
import {
  DAY_MS,
  DM_CHANNEL_RULE,
  dmSendRule,
  HOUR_MS,
  loadEventRow,
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

let fetchStub: FetchStub | null = null;
afterEach(() => {
  fetchStub?.restore();
  fetchStub = null;
  vi.useRealTimers();
});

const CRON_INTERVAL_MS = 15 * 60 * 1000;

async function seedConfirmedOptions(db: ShimDatabase, total: number): Promise<void> {
  const now = Date.now();
  let made = 0;
  for (let p = 0; made < total; p++) {
    const eventId = `poll-${p}`;
    await db.prepare(
      `INSERT INTO events (id, guild_id, organizer_id, title, event_type, timezone, status,
         poll_mode, poll_resolution_mode, is_recurring, created_at, updated_at)
       VALUES (?, 'guild-1', 'organizer', ?, 'poll', 'UTC', 'active', 'options', 'multi_winner', 0, ?, ?)`,
    )
      .bind(eventId, eventId, now, now)
      .run();
    await seedInvite(db, eventId, 'organizer');
    for (let i = 0; i < 50 && made < total; i++, made++) {
      const optionId = `p${p}-o${String(i).padStart(3, '0')}`;
      await db.prepare(
        `INSERT INTO event_poll_options (id, event_id, start_at, end_at, display_order, confirmed_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
        .bind(optionId, eventId, now + 7 * DAY_MS + i * HOUR_MS, now + 7 * DAY_MS + (i + 1) * HOUR_MS, i, now)
        .run();
      await db.prepare(
        `INSERT INTO event_poll_votes (option_id, user_id, vote, voted_at) VALUES (?, 'organizer', 'yes', ?)`,
      )
        .bind(optionId, now)
        .run();
    }
  }
}

// R1/R6. The budget modelled its own spending and the tick was measured
// against that model, not against the database. Two things made the model
// wrong: every recipient source that could not filter settled rows itself
// issued an extra, uncharged `settledRecipients()` query, and cursor
// persistence built one prepared statement per dirty cursor while a comment
// claimed the batch made it one. A valid state measured 69 actual statements
// against a Free-plan ceiling of 50, while the tick logged that it had
// stopped safely.
describe('a whole cron tick stays inside the Free-plan D1 ceiling (F-04-G1)', () => {
  it('measures actual statements, not the budget it thinks it spent', async () => {
    const { db, env } = setup();
    await seedGuild(db);
    await seedUser(db, 'organizer');
    await seedMembership(db, 'organizer', 'guild-1');
    await seedConfirmedOptions(db, 200);

    fetchStub = stubFetch([DM_CHANNEL_RULE, dmSendRule(200), membershipRule(200)]);

    // Several consecutive ticks: the first dirties every cursor from scratch,
    // later ones run against already-settled notifications, which is the
    // shape that produced the most uncharged lookups.
    for (let tick = 0; tick < 5; tick++) {
      db.resetQueryCount();
      await runReminderSweep(env);
      expect(db.queryCount).toBeLessThanOrEqual(D1_FREE_PLAN_QUERY_BUDGET);
    }
  });

  it('keeps an empty tick inside the fixed reserve', async () => {
    const { db, env } = setup();
    await seedGuild(db);
    await seedUser(db, 'organizer');
    await seedMembership(db, 'organizer', 'guild-1');
    fetchStub = stubFetch([]);

    // The first tick is the expensive one: every global cursor is absent and
    // gets written. If that costs one statement per cursor rather than one
    // for all of them, this is where it shows.
    db.resetQueryCount();
    await runReminderSweep(env);
    const firstTick = db.queryCount;

    db.resetQueryCount();
    await runReminderSweep(env);
    const secondTick = db.queryCount;

    // RESERVED_QUERIES in cron/budget.ts is what the tick sets aside for
    // fixed work; an empty tick must fit inside it or the reserve is a
    // fiction and scans are eating the deliveries' allowance. Bumped from 22
    // to 24 alongside RESERVED_QUERIES when the two invitee-change-request
    // sweeps (docs/specs/0003) added two more fixed per-tick queries.
    expect(firstTick).toBeLessThanOrEqual(24);
    expect(secondTick).toBeLessThanOrEqual(24);
    // One flush statement, not ten: the ten fresh cursors cost the first tick
    // barely more than the second, which has none to write.
    expect(firstTick - secondTick).toBeLessThanOrEqual(2);
  });
});

// R2. The cursor was written the moment the page came back, before the caller
// had processed any of it -- so a tick with budget for one row still recorded
// progress past all two hundred. For a moving-window predicate the skipped
// rows can leave the window before the next tick, and the eventual wrap does
// not bring them back.
describe('a global cursor records completed work, not read work (F-04-G2)', () => {
  it('does not advance past rows the tick never processed', async () => {
    const { db, env } = setup();
    await seedGuild(db);
    await seedUser(db, 'organizer');
    await seedMembership(db, 'organizer', 'guild-1');
    await seedConfirmedOptions(db, 200);

    fetchStub = stubFetch([DM_CHANNEL_RULE, dmSendRule(200), membershipRule(200)]);
    await runReminderSweep(env);

    // Whatever this tick managed, the cursor must sit at or before the last
    // option it actually notified -- never past options it never looked at.
    const cursor = await readCursorKey(env, 'confirmed_options');
    const notified = await db
      .prepare(
        `SELECT occurrence_date FROM notification_log
         WHERE notification_type = 'poll_resolved' AND occurrence_date != ''
         ORDER BY occurrence_date DESC LIMIT 1`,
      )
      .first<{ occurrence_date: string }>();

    if (cursor !== null) {
      expect(notified).not.toBeNull();
      expect(cursor <= notified!.occurrence_date).toBe(true);
    }
  });

  it('eventually notifies every option rather than skipping the unprocessed tail', async () => {
    const { db, env } = setup();
    await seedGuild(db);
    await seedUser(db, 'organizer');
    await seedMembership(db, 'organizer', 'guild-1');
    await seedConfirmedOptions(db, 200);

    fetchStub = stubFetch([DM_CHANNEL_RULE, dmSendRule(200), membershipRule(200)]);

    const notifiedCount = async (): Promise<number> => {
      const row = await db
        .prepare(
          `SELECT COUNT(DISTINCT occurrence_date) AS n FROM notification_log
           WHERE notification_type = 'poll_resolved' AND occurrence_date != ''`,
        )
        .first<{ n: number }>();
      return row?.n ?? 0;
    };

    for (let tick = 0; tick < 40 && (await notifiedCount()) < 200; tick++) {
      await runReminderSweep(env);
    }
    expect(await notifiedCount()).toBe(200);
  });
});

// R3. The voice sweep looked ten minutes ahead on a fifteen-minute trigger,
// so an event starting 11-15 minutes after a tick was outside the window at
// that tick and already in the past at the next one. Deterministic, on an
// idle database, with the budget untouched.
describe('every voice-invite start offset is observed across the cron cadence (F-04-G3)', () => {
  it('notifies an event starting at any minute offset within one interval', async () => {
    // Every offset in the interval, including the band that used to fall
    // between the lookahead window and the next tick.
    for (const offsetMinutes of [1, 5, 9, 10, 11, 12, 14, 15]) {
      const { db, env } = setup();
      const stub = stubFetch([DM_CHANNEL_RULE, dmSendRule(200), membershipRule(200)]);
      try {
        const base = Date.now();
        vi.useFakeTimers();
        vi.setSystemTime(base);

        await seedGuild(db);
        await seedUser(db, 'organizer');
        await seedMembership(db, 'organizer', 'guild-1');
        await seedEvent(db, {
          id: 'voice-event',
          organizerId: 'organizer',
          startAt: base + offsetMinutes * 60_000,
          endAt: base + offsetMinutes * 60_000 + HOUR_MS,
        });
        await db.prepare(
          `UPDATE events SET voice_channel_id = 'chan', voice_channel_name = 'Voice' WHERE id = 'voice-event'`,
        ).run();
        await db.prepare(
          `UPDATE event_invites SET rsvp_status = 'accepted' WHERE event_id = 'voice-event'`,
        ).run();

        // Two ticks a cron interval apart, bracketing the event's start.
        await runReminderSweep(env);
        vi.setSystemTime(base + CRON_INTERVAL_MS);
        await runReminderSweep(env);

        const row = await db
          .prepare(
            `SELECT COUNT(*) AS n FROM notification_log
             WHERE event_id = 'voice-event' AND notification_type = 'voice_channel_invite'`,
          )
          .first<{ n: number }>();
        expect(
          row?.n,
          `an event starting ${offsetMinutes} minutes after a tick should still be notified`,
        ).toBeGreaterThan(0);
      } finally {
        vi.useRealTimers();
        stub.restore();
      }
    }
  });
});

// R4. Guarding siblings on `is_recurring = 1` fixed the sequential loser but
// not the concurrent one: that condition is equally true when a *different*
// request just converted the event, so a stale loser's siblings ran on the
// back of the winner's success and a request that reported failure changed
// state anyway.
describe('a stale concurrent conversion has no side effects (F-08)', () => {
  const recurrence = {
    freq: 'DAILY' as const,
    interval: 1,
    byWeekday: null,
    byMonthDay: null,
    startDate: new Date().toISOString().slice(0, 10),
    startTime: '19:00',
    durationMinutes: 60,
    endType: 'never' as const,
    endDate: null,
    endCount: null,
  };

  it('the loser changes nothing the winner wrote', async () => {
    const { db, env } = setup();
    await seedGuild(db);
    await seedUser(db, 'organizer');
    await seedMembership(db, 'organizer', 'guild-1');
    for (const id of ['first-invitee', 'second-invitee']) {
      await seedUser(db, id);
      await seedMembership(db, id, 'guild-1');
    }
    await seedEvent(db, { id: 'target', organizerId: 'organizer' });

    fetchStub = stubFetch([membershipRule(200)]);

    // Both requests read the same revision, as two browser tabs would.
    const staleRow = await loadEventRow(db, 'target');

    // Request A wins.
    await updateEvent(
      env,
      'target',
      'guild-1',
      {
        isRecurring: true,
        recurrence,
        title: 'Winner',
        invites: { userIds: ['first-invitee'], groupIds: [] },
      } as Partial<EventWriteInput>,
      staleRow,
    );

    const afterWinner = await db
      .prepare(`SELECT title, is_recurring, revision FROM events WHERE id = 'target'`)
      .first<{ title: string; is_recurring: number; revision: number }>();
    const winnerInvites = await db
      .prepare(`SELECT user_id FROM event_invites WHERE event_id = 'target' ORDER BY user_id`)
      .all<{ user_id: string }>();
    const winnerRules = await db
      .prepare(`SELECT start_time FROM event_recurrence_rules WHERE event_id = 'target'`)
      .all<{ start_time: string }>();

    // Request B was built from the same stale read and has no idea A happened.
    await expect(
      updateEvent(
        env,
        'target',
        'guild-1',
        {
          isRecurring: true,
          recurrence: { ...recurrence, startTime: '20:00' },
          title: 'Loser',
          invites: { userIds: ['second-invitee'], groupIds: [] },
        } as Partial<EventWriteInput>,
        staleRow,
      ),
    ).rejects.toThrow(ConflictError);

    // Exact post-state equality: the loser touched nothing at all.
    expect(
      await db
        .prepare(`SELECT title, is_recurring, revision FROM events WHERE id = 'target'`)
        .first<{ title: string; is_recurring: number; revision: number }>(),
    ).toEqual(afterWinner);
    expect(
      (
        await db
          .prepare(`SELECT user_id FROM event_invites WHERE event_id = 'target' ORDER BY user_id`)
          .all<{ user_id: string }>()
      ).results,
    ).toEqual(winnerInvites.results);
    expect(
      (
        await db
          .prepare(`SELECT start_time FROM event_recurrence_rules WHERE event_id = 'target'`)
          .all<{ start_time: string }>()
      ).results,
    ).toEqual(winnerRules.results);
  });

  it('an ordinary edit from a stale read is refused rather than silently overwriting', async () => {
    const { db, env } = setup();
    await seedGuild(db);
    await seedUser(db, 'organizer');
    await seedMembership(db, 'organizer', 'guild-1');
    await seedEvent(db, { id: 'target', organizerId: 'organizer' });
    fetchStub = stubFetch([membershipRule(200)]);

    const staleRow = await loadEventRow(db, 'target');
    await updateEvent(env, 'target', 'guild-1', { title: 'First' }, staleRow);

    await expect(
      updateEvent(env, 'target', 'guild-1', { title: 'Second' }, staleRow),
    ).rejects.toThrow(ConflictError);

    const row = await db.prepare(`SELECT title FROM events WHERE id = 'target'`).first<{ title: string }>();
    expect(row?.title).toBe('First');
  });
});

// R5. Every field in a cross-mode delta is individually valid, so per-field
// validation accepted it and stored shapes the create path cannot produce --
// a single event carrying poll state, a poll carrying a recurrence rule.
describe('PATCH validates the merged event, not just the delta (F-08)', () => {
  async function seedOne(kind: 'single' | 'poll') {
    const ctx = setup();
    await seedGuild(ctx.db);
    await seedUser(ctx.db, 'organizer');
    await seedMembership(ctx.db, 'organizer', 'guild-1');
    if (kind === 'single') {
      await seedEvent(ctx.db, { id: 'ev', organizerId: 'organizer' });
    } else {
      const now = Date.now();
      await ctx.db.prepare(
        `INSERT INTO events (id, guild_id, organizer_id, title, event_type, timezone, status,
           poll_mode, poll_resolution_mode, poll_deadline_at, is_recurring, created_at, updated_at)
         VALUES ('ev', 'guild-1', 'organizer', 'Poll', 'poll', 'UTC', 'active', 'options',
                 'single_winner', ?, 0, ?, ?)`,
      )
        .bind(now + DAY_MS, now, now)
        .run();
    }
    return ctx;
  }

  it('rejects poll state on a single event', async () => {
    const { db, env } = await seedOne('single');
    await expect(
      updateEvent(
        env,
        'ev',
        'guild-1',
        {
          pollStrategy: 'threshold',
          pollThresholdCount: 2,
          pollOptions: [{ startAt: Date.now() + DAY_MS, endAt: Date.now() + DAY_MS + HOUR_MS }],
        } as Partial<EventWriteInput>,
        await loadEventRow(db, 'ev'),
      ),
    ).rejects.toThrow(ValidationError);

    const row = await db
      .prepare(`SELECT poll_strategy, poll_threshold_count FROM events WHERE id = 'ev'`)
      .first<{ poll_strategy: string | null; poll_threshold_count: number | null }>();
    expect(row?.poll_strategy).toBeNull();
    expect(row?.poll_threshold_count).toBeNull();
    const options = await db
      .prepare(`SELECT COUNT(*) AS n FROM event_poll_options WHERE event_id = 'ev'`)
      .first<{ n: number }>();
    expect(options?.n).toBe(0);
  });

  it('rejects making a poll recurring', async () => {
    const { db, env } = await seedOne('poll');
    await expect(
      updateEvent(
        env,
        'ev',
        'guild-1',
        {
          isRecurring: true,
          recurrence: {
            freq: 'DAILY',
            interval: 1,
            byWeekday: null,
            byMonthDay: null,
            startDate: new Date().toISOString().slice(0, 10),
            startTime: '19:00',
            durationMinutes: 60,
            endType: 'never',
            endDate: null,
            endCount: null,
          },
        } as Partial<EventWriteInput>,
        await loadEventRow(db, 'ev'),
      ),
    ).rejects.toThrow(ValidationError);

    const row = await db.prepare(`SELECT is_recurring FROM events WHERE id = 'ev'`).first<{ is_recurring: number }>();
    expect(row?.is_recurring).toBe(0);
    const rules = await db
      .prepare(`SELECT COUNT(*) AS n FROM event_recurrence_rules WHERE event_id = 'ev'`)
      .first<{ n: number }>();
    expect(rules?.n).toBe(0);
  });

  it('rejects changing an event between poll and single', async () => {
    const { db, env } = await seedOne('single');
    await expect(
      updateEvent(
        env,
        'ev',
        'guild-1',
        { eventType: 'poll' } as Partial<EventWriteInput>,
        await loadEventRow(db, 'ev'),
      ),
    ).rejects.toThrow(ValidationError);
  });

  it('still allows an ordinary in-mode edit', async () => {
    const { db, env } = await seedOne('single');
    await updateEvent(env, 'ev', 'guild-1', { title: 'Renamed' }, await loadEventRow(db, 'ev'));
    const row = await db.prepare(`SELECT title FROM events WHERE id = 'ev'`).first<{ title: string }>();
    expect(row?.title).toBe('Renamed');
  });
});
