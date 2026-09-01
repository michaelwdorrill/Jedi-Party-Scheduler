import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/router';
import { signJwt } from '../src/lib/jwt';
import { createSession } from '../src/lib/sessions';
import { runReminderSweep } from '../src/cron/reminders';
import { computeBusyBlocksForUsers } from '../src/lib/freeBusy';
import { resolvePastDeadlinePolls } from '../src/lib/polls';
import { updateEvent, type EventWriteInput } from '../src/lib/eventWrites';
import { FreeBusyTooLargeError, LIMITS } from '../src/lib/validate';
import { D1_FREE_PLAN_QUERY_BUDGET, type ShimDatabase } from './d1shim';
import {
  DAY_MS,
  DM_CHANNEL_RULE,
  dmSendRule,
  HOUR_MS,
  ids,
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

async function seedPoll(
  db: ShimDatabase,
  eventId: string,
  {
    guildId = 'guild-1',
    organizerId = 'organizer',
    resolutionMode = 'multi_winner',
    status = 'active',
    deadlineAt = null as number | null,
    voiceChannelId = null as string | null,
  } = {},
): Promise<void> {
  const now = Date.now();
  await db.prepare(
    `INSERT INTO events (id, guild_id, organizer_id, title, event_type, timezone, status,
       poll_mode, poll_resolution_mode, poll_deadline_at, is_recurring, voice_channel_id,
       voice_channel_name, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'poll', 'UTC', ?, 'options', ?, ?, 0, ?, ?, ?, ?)`,
  )
    .bind(
      eventId,
      guildId,
      organizerId,
      `Poll ${eventId}`,
      status,
      resolutionMode,
      deadlineAt,
      voiceChannelId,
      voiceChannelId ? 'Voice' : null,
      now,
      now,
    )
    .run();
}

async function seedOption(
  db: ShimDatabase,
  optionId: string,
  eventId: string,
  order: number,
  { confirmed = false } = {},
): Promise<void> {
  const start = Date.now() + 7 * DAY_MS + order * HOUR_MS;
  await db.prepare(
    `INSERT INTO event_poll_options (id, event_id, start_at, end_at, display_order, confirmed_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(optionId, eventId, start, start + HOUR_MS, order, confirmed ? Date.now() : null)
    .run();
}

// R1. The shared tally helper was made set-based in an earlier pass, but this
// route never used it and kept its own per-option loop -- so the fix landed
// beside the problem rather than on it. A helper-level test could not have
// caught that; only calling the actual authenticated route can.
describe('maximum option-poll event detail fits one Free-plan invocation (F-04-D)', () => {
  it('serves a 50-option poll through the real route without an N+1 vote loop', async () => {
    const { db, env } = setup();
    await seedGuild(db);
    await seedUser(db, 'organizer');
    await seedMembership(db, 'organizer', 'guild-1');
    await seedPoll(db, 'poll-1');

    // Every option confirmed and voted on, so the response carries the
    // heaviest shape it can: tallies, the viewer's own vote, and a named
    // confirmed-attendee list per option.
    const voters = ids('voter', 12);
    for (const id of voters) {
      await seedUser(db, id);
      await seedMembership(db, id, 'guild-1');
      await seedInvite(db, 'poll-1', id);
    }
    for (let i = 0; i < LIMITS.MAX_POLL_OPTIONS; i++) {
      const optionId = `opt-${i}`;
      await seedOption(db, optionId, 'poll-1', i, { confirmed: true });
      for (const voter of [...voters, 'organizer']) {
        await db.prepare(
          `INSERT INTO event_poll_votes (option_id, user_id, vote, voted_at) VALUES (?, ?, 'yes', ?)`,
        )
          .bind(optionId, voter, Date.now())
          .run();
      }
    }

    const headers = await authHeaders(env, 'organizer');
    fetchStub = stubFetch([membershipRule(200)]);
    db.resetQueryCount();
    const res = await app.request('https://worker.test/events/poll-1', { headers }, env);

    expect(res.status).toBe(200);
    expect(db.queryCount).toBeLessThan(D1_FREE_PLAN_QUERY_BUDGET);

    // Complete, not merely cheap: the old loop produced correct data
    // expensively, so a query-count assertion alone could be satisfied by
    // dropping options on the floor.
    const body = (await res.json()) as {
      pollOptions: {
        id: string;
        tally: { yes: number; no: number; maybe: number };
        myVote: string | null;
        confirmedUsers: { userId: string }[];
      }[];
    };
    expect(body.pollOptions).toHaveLength(LIMITS.MAX_POLL_OPTIONS);
    for (const option of body.pollOptions) {
      expect(option.tally.yes).toBe(voters.length + 1);
      expect(option.myVote).toBe('yes');
      expect(option.confirmedUsers).toHaveLength(voters.length + 1);
    }
  });
});

// R2. A LIMIT bounds one read; it says nothing about which rows that read
// returns. With a fixed ORDER BY and no cursor these scans handed back the
// identical prefix on every tick, so the row past the limit was selected on
// no tick ever -- and unlike the reminder scans, whose predicate moves with
// the clock, a delivered notification does not stop its row matching.
describe('global cron scans make progress past their page limit (F-04-E)', () => {
  it('eventually reaches the row after GLOBAL_SCAN_LIMIT confirmed options', async () => {
    const { db, env } = setup('paid');
    await seedGuild(db);
    await seedUser(db, 'organizer');
    await seedMembership(db, 'organizer', 'guild-1');

    // 201 confirmed options across five multi-winner polls: one more than the
    // scan's page size, which is the whole point.
    const total = 201;
    let made = 0;
    for (let p = 0; made < total; p++) {
      const eventId = `poll-${p}`;
      await seedPoll(db, eventId);
      await seedInvite(db, eventId, 'organizer');
      for (let i = 0; i < 50 && made < total; i++, made++) {
        const optionId = `p${p}-o${String(i).padStart(3, '0')}`;
        await seedOption(db, optionId, eventId, i, { confirmed: true });
        await db.prepare(
          `INSERT INTO event_poll_votes (option_id, user_id, vote, voted_at) VALUES (?, ?, 'yes', ?)`,
        )
          .bind(optionId, 'organizer', Date.now())
          .run();
      }
    }
    expect(made).toBe(total);

    fetchStub = stubFetch([DM_CHANNEL_RULE, dmSendRule(200), membershipRule(200)]);

    // specs/0014 stage 3: sweepConfirmedMultiWinnerOptions now fans a
    // confirmed option out into its own event rather than sending a
    // per-option notification, so "processed" means created_from_option_id
    // is set, not a notification_log row.
    const fannedOutOptions = async (): Promise<number> => {
      const row = await db
        .prepare(`SELECT COUNT(*) AS n FROM events WHERE created_from_option_id IS NOT NULL`)
        .first<{ n: number }>();
      return row?.n ?? 0;
    };

    // Enough ticks to wrap the scan more than once. Without a cursor this
    // plateaus at 200 forever; the assertion is that it does not.
    for (let tick = 0; tick < 12 && (await fannedOutOptions()) < total; tick++) {
      await runReminderSweep(env);
    }

    expect(await fannedOutOptions()).toBe(total);
  });
});

// R3. A poll that fails to resolve stays active and stays past its deadline,
// so it matched the page again next tick in the same position. Twenty-five of
// them held the page forever and nothing behind them was ever selected again.
describe('a permanently failing deadline prefix cannot starve later polls (F-04-E)', () => {
  it('resolves the 26th poll despite 25 rows that always fail', async () => {
    const { db, env } = setup('paid');
    await seedGuild(db);
    await seedUser(db, 'organizer');
    await seedMembership(db, 'organizer', 'guild-1');

    const past = Date.now() - DAY_MS;
    // The 25 earliest deadlines are broken: multi_winner polls whose option
    // rows are unreadable, which is what makes resolution throw for them
    // specifically rather than for the sweep as a whole.
    for (let i = 0; i < 25; i++) {
      await seedPoll(db, `broken-${String(i).padStart(2, '0')}`, { deadlineAt: past + i });
    }
    // ...and one healthy poll behind them, with the latest deadline of all.
    await seedPoll(db, 'healthy', { deadlineAt: past + 100, resolutionMode: 'single_winner' });
    await seedOption(db, 'healthy-opt', 'healthy', 0);
    await db.prepare(`INSERT INTO event_poll_votes (option_id, user_id, vote, voted_at) VALUES (?, ?, 'yes', ?)`)
      .bind('healthy-opt', 'organizer', Date.now())
      .run();

    // Make exactly the broken polls throw, by pointing their tally read at a
    // table that is dropped out from under it.
    const originalPrepare = env.DB.prepare.bind(env.DB);
    (env.DB as unknown as { prepare: typeof originalPrepare }).prepare = ((sql: string) => {
      const stmt = originalPrepare(sql);
      if (!sql.includes('event_poll_options')) return stmt;
      const originalBind = stmt.bind.bind(stmt);
      return {
        ...stmt,
        bind: (...args: unknown[]) => {
          const bound = originalBind(...args);
          if (!args.some((a) => typeof a === 'string' && a.startsWith('broken-'))) return bound;
          return {
            ...bound,
            all: () => Promise.reject(new Error('simulated per-row D1 failure')),
            first: () => Promise.reject(new Error('simulated per-row D1 failure')),
            run: () => Promise.reject(new Error('simulated per-row D1 failure')),
          };
        },
      } as unknown as ReturnType<typeof originalPrepare>;
    }) as typeof originalPrepare;

    // Several passes: the failing rows are retried, accumulate failures, and
    // sink behind the healthy poll rather than permanently outranking it.
    for (let i = 0; i < 6; i++) await resolvePastDeadlinePolls(env);

    const healthy = await db.prepare(`SELECT status FROM events WHERE id = 'healthy'`).first<{ status: string }>();
    expect(healthy?.status).not.toBe('active');

    // The broken rows are not abandoned either -- still active, still retried,
    // with their failures recorded for an operator to find.
    const stuck = await db
      .prepare(`SELECT COUNT(*) AS n FROM events WHERE id LIKE 'broken-%' AND poll_resolution_failures > 0`)
      .first<{ n: number }>();
    expect(stuck?.n).toBe(25);
  });
});

// R4. The previous pass moved the recurring quota claim into the batch, which
// closed the crash window but left every sibling statement unconditional --
// so a conversion that lost the quota race still replaced child rows and then
// reported failure. batch() rolls back on error, and a statement matching
// zero rows is not an error.
//
// Uses invite siblings rather than poll siblings: a poll can no longer be
// made recurring at all (see the cross-mode tests below), so the original
// combination is now rejected before it reaches the batch.
describe('a quota-losing recurring conversion mutates nothing (F-08)', () => {
  it('leaves the event and its invite list exactly as they were', async () => {
    const { db, env } = setup();
    await seedGuild(db);
    await seedUser(db, 'organizer');
    await seedMembership(db, 'organizer', 'guild-1');
    for (const id of ['keep', 'added']) {
      await seedUser(db, id);
      await seedMembership(db, id, 'guild-1');
    }

    // Fill the guild's recurring quota so the conversion below must lose.
    for (let i = 0; i < LIMITS.MAX_RECURRING_EVENTS_PER_GUILD; i++) {
      await seedEvent(db, { id: `rec-${i}`, organizerId: 'organizer', isRecurring: 1, startAt: null, endAt: null });
    }

    await seedEvent(db, { id: 'target', organizerId: 'organizer' });
    await seedInvite(db, 'target', 'keep');

    const before = await db
      .prepare(`SELECT is_recurring, start_at, end_at, revision FROM events WHERE id = 'target'`)
      .first<{ is_recurring: number; start_at: number | null; end_at: number | null; revision: number }>();

    fetchStub = stubFetch([membershipRule(200)]);
    await expect(
      updateEvent(
        env,
        'target',
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
          // The sibling writes that used to commit regardless: this would
          // drop 'keep' from the invite list and add 'added'.
          invites: { userIds: ['added'], groupIds: [] },
        } as Partial<EventWriteInput>,
        await loadEventRow(db, 'target'),
      ),
    ).rejects.toThrow(/limit of recurring events/i);

    const after = await db
      .prepare(`SELECT is_recurring, start_at, end_at, revision FROM events WHERE id = 'target'`)
      .first<{ is_recurring: number; start_at: number | null; end_at: number | null; revision: number }>();
    expect(after).toEqual(before);

    const invites = await db
      .prepare(`SELECT user_id FROM event_invites WHERE event_id = 'target' ORDER BY user_id`)
      .all<{ user_id: string }>();
    expect(invites.results.map((i) => i.user_id)).toEqual(['keep']);

    const rules = await db
      .prepare(`SELECT COUNT(*) AS n FROM event_recurrence_rules WHERE event_id = 'target'`)
      .first<{ n: number }>();
    expect(rules?.n).toBe(0);
  });
});

// R5. Every field in `{isRecurring: true}` is individually valid, so a
// per-field validator accepts it -- and applying it stores a series with no
// rule, no start and no end, which the create path would have rejected.
describe('a partial schedule PATCH cannot store an incoherent event (F-08)', () => {
  it('rejects isRecurring:true with no recurrence rule', async () => {
    const { db, env } = setup();
    await seedGuild(db);
    await seedUser(db, 'organizer');
    await seedMembership(db, 'organizer', 'guild-1');
    await seedEvent(db, { id: 'single', organizerId: 'organizer' });

    await expect(
      updateEvent(env, 'single', 'guild-1', { isRecurring: true } as Partial<EventWriteInput>, await loadEventRow(db, 'single')),
    ).rejects.toThrow(/recurrence is required/i);

    const row = await db
      .prepare(`SELECT is_recurring, start_at, end_at FROM events WHERE id = 'single'`)
      .first<{ is_recurring: number; start_at: number | null; end_at: number | null }>();
    expect(row?.is_recurring).toBe(0);
    expect(row?.start_at).not.toBeNull();
  });

  it('rejects isRecurring:false with no concrete schedule', async () => {
    const { db, env } = setup();
    await seedGuild(db);
    await seedUser(db, 'organizer');
    await seedMembership(db, 'organizer', 'guild-1');
    await seedEvent(db, { id: 'series', organizerId: 'organizer', isRecurring: 1, startAt: null, endAt: null });

    await expect(
      updateEvent(env, 'series', 'guild-1', { isRecurring: false } as Partial<EventWriteInput>, await loadEventRow(db, 'series')),
    ).rejects.toThrow(/startAt and endAt are required/i);

    const row = await db.prepare(`SELECT is_recurring FROM events WHERE id = 'series'`).first<{ is_recurring: number }>();
    expect(row?.is_recurring).toBe(1);
  });
});

// R6. Every quota in the app is per guild, and one user can be in many
// guilds. The occurrence ceiling could only be consulted after the source
// events had been read and had their overrides looked up -- so a user in
// fourteen guilds crossed the Free plan's whole query allowance on input,
// for events a year outside the window that would expand to nothing.
describe('free/busy bounds its input, not just its output (F-04-F)', () => {
  async function seedManyGuilds(
    guilds: number,
    eventsPerGuild: number,
    { inRange = false, spacingMs = 2 * HOUR_MS } = {},
  ) {
    const ctx = setup();
    await seedUser(ctx.db, 'viewer');
    const from = Date.now();
    // Spaced two hours apart across all guilds so in-range events stay
    // distinct blocks -- adjacent ones would merge, and a merge would hide
    // exactly the dropped-event bug these tests are here to catch.
    let slot = 0;
    for (let g = 0; g < guilds; g++) {
      const guildId = `guild-${g}`;
      await seedGuild(ctx.db, guildId);
      await seedMembership(ctx.db, 'viewer', guildId);
      const organizerId = `org-${g}`;
      await seedUser(ctx.db, organizerId);
      await seedMembership(ctx.db, organizerId, guildId);
      for (let i = 0; i < eventsPerGuild; i++) {
        const eventId = `${guildId}-e${i}`;
        const startAt = inRange ? from + HOUR_MS + slot++ * spacingMs : from + 365 * DAY_MS;
        await seedEvent(ctx.db, {
          id: eventId,
          guildId,
          organizerId,
          startAt,
          endAt: startAt + HOUR_MS,
        });
        await seedInvite(ctx.db, eventId, 'viewer');
      }
    }
    return ctx;
  }

  it('does not read or preload events outside the requested range', async () => {
    // 14 guilds x 300 events, every one a year away: the reviewed
    // reproduction, which cost 55 D1 statements before the budget could
    // reject anything.
    const { db, env } = await seedManyGuilds(14, 300);

    const from = Date.now();
    const to = from + 7 * DAY_MS;
    db.resetQueryCount();
    const result = await computeBusyBlocksForUsers(env, ['viewer'], from, to);

    expect(db.queryCount).toBeLessThan(D1_FREE_PLAN_QUERY_BUDGET);
    expect(result.get('viewer')).toEqual([]);
  });

  it('refuses rather than silently truncating when the in-range set is too large', async () => {
    const perGuild = 100;
    const guilds = Math.ceil((LIMITS.MAX_FREE_BUSY_SOURCE_EVENTS + perGuild) / perGuild);
    // Packed tightly so every one of them genuinely falls inside the window --
    // this test is about the source-set cap, not about the range filter.
    const { db, env } = await seedManyGuilds(guilds, perGuild, { inRange: true, spacingMs: 60_000 });

    const from = Date.now();
    const to = from + 30 * DAY_MS;
    db.resetQueryCount();

    // The one outcome that is never acceptable is a 200 listing a subset:
    // a missing busy block reads as free time and gets scheduled over.
    await expect(computeBusyBlocksForUsers(env, ['viewer'], from, to)).rejects.toThrow(FreeBusyTooLargeError);
    expect(db.queryCount).toBeLessThan(D1_FREE_PLAN_QUERY_BUDGET);
  });

  it('still returns every in-range commitment when the request is admissible', async () => {
    const { db, env } = await seedManyGuilds(3, 5, { inRange: true });
    const from = Date.now();
    const to = from + 7 * DAY_MS;
    db.resetQueryCount();
    const result = await computeBusyBlocksForUsers(env, ['viewer'], from, to);

    expect(db.queryCount).toBeLessThan(D1_FREE_PLAN_QUERY_BUDGET);
    expect(result.get('viewer')).toHaveLength(15);
  });
});
