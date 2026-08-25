// Windowed candidates (IDEAS 40, specs/0013).
//
// A poll's candidates become windows with a minimum session length, and the
// two poll modes that exist today become presets of that one shape:
//
//   * no minimum            -> the candidate's span *is* the session (today's
//                              options poll, voted yes/no/maybe)
//   * one candidate + a minimum -> today's window poll
//
// Which is why the first thing tested here is that both of those still
// behave exactly as they did. "This is a merge, not a third mode" is only a
// true claim if the special cases survive it.
import { describe, expect, it } from 'vitest';
import { applyMigration, createTestDb } from './d1shim';

const MIGRATION = '0021_window_availability_per_option.sql';

describe('migration 0021 -- window availability moves onto the option', () => {
  function legacyDb() {
    // Stops before 0021, so there is a real "before" to convert. This
    // migration recreates a table, so it cannot be applied twice the way the
    // idempotent backfills can.
    const db = createTestDb(MIGRATION);
    db.raw.exec(`
      INSERT INTO guilds (id, name, is_active, added_at) VALUES ('g', 'G', 1, 1);
      INSERT INTO users (id, username, timezone, notifications_enabled, created_at, updated_at)
        VALUES ('u1', 'one', 'UTC', 1, 1, 1), ('u2', 'two', 'UTC', 1, 1, 1);
      INSERT INTO events (id, guild_id, organizer_id, title, event_type, timezone, status,
        poll_strategy, poll_threshold_count, poll_deadline_at, poll_mode, poll_resolution_mode,
        window_start_at, window_end_at, window_block_minutes, is_recurring, created_at, updated_at)
      VALUES ('w1', 'g', 'u1', 'Old window poll', 'poll', 'UTC', 'active',
        'threshold', 2, 9999, 'window', 'single_winner', 1000, 100000, 60, 0, 1, 1);
      INSERT INTO event_window_availability (event_id, user_id, avail_start_at, avail_end_at, submitted_at)
      VALUES ('w1', 'u1', 2000, 50000, 1), ('w1', 'u2', 3000, 60000, 1);
    `);
    return db;
  }

  it('gives every existing window poll a candidate spanning its window', () => {
    const db = legacyDb();
    applyMigration(db.raw, MIGRATION);

    const opt = db.raw
      .prepare(`SELECT id, start_at, end_at, display_order, confirmed_at FROM event_poll_options WHERE event_id = 'w1'`)
      .all() as { id: string; start_at: number; end_at: number; display_order: number; confirmed_at: number | null }[];
    expect(opt).toHaveLength(1);
    expect(opt[0].start_at).toBe(1000);
    expect(opt[0].end_at).toBe(100000);
    // Not confirmed: a resolved window poll records its winner on the event,
    // and a confirmed candidate would make it look multi-winner.
    expect(opt[0].confirmed_at).toBeNull();
  });

  it('carries every submission across, pointed at that candidate', () => {
    const db = legacyDb();
    applyMigration(db.raw, MIGRATION);

    const rows = db.raw
      .prepare(`SELECT option_id, event_id, user_id, avail_start_at, avail_end_at FROM event_window_availability ORDER BY user_id`)
      .all() as { option_id: string; event_id: string; user_id: string; avail_start_at: number; avail_end_at: number }[];
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ event_id: 'w1', user_id: 'u1', avail_start_at: 2000, avail_end_at: 50000 });
    expect(rows[1].option_id).toBe(rows[0].option_id);

    const optionId = db.raw.prepare(`SELECT id FROM event_poll_options WHERE event_id = 'w1'`).get() as { id: string };
    expect(rows[0].option_id).toBe(optionId.id);
  });

  it('lets two candidates hold a submission from the same person', () => {
    // The whole point of the move. Under the old (event_id, user_id) key the
    // second insert replaced the first, so a poll could only ever hold one
    // answer per person however many windows it offered.
    const db = legacyDb();
    applyMigration(db.raw, MIGRATION);
    db.raw.exec(`
      INSERT INTO event_poll_options (id, event_id, start_at, end_at, display_order)
      VALUES ('opt-b', 'w1', 200000, 300000, 1);
      INSERT INTO event_window_availability (option_id, event_id, user_id, avail_start_at, avail_end_at, submitted_at)
      VALUES ('opt-b', 'w1', 'u1', 210000, 260000, 1);
    `);
    const n = db.raw
      .prepare(`SELECT COUNT(*) AS n FROM event_window_availability WHERE event_id = 'w1' AND user_id = 'u1'`)
      .get() as { n: number };
    expect(n.n).toBe(2);
  });

  it('keeps both indexes -- rebuilding a table in SQLite drops them', () => {
    // Migration 0016 exists because exactly this was missed once, by hand,
    // against production, and the index stayed missing for three releases.
    const db = legacyDb();
    applyMigration(db.raw, MIGRATION);
    const idx = db.raw
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'event_window_availability' AND name LIKE 'idx_%' ORDER BY name`)
      .all() as { name: string }[];
    expect(idx.map((i) => i.name)).toEqual(['idx_window_avail_event', 'idx_window_avail_option']);
  });

  it('cascades from the candidate as well as from the event', () => {
    const db = legacyDb();
    applyMigration(db.raw, MIGRATION);
    db.raw.exec(`DELETE FROM event_poll_options WHERE event_id = 'w1'`);
    const n = db.raw.prepare(`SELECT COUNT(*) AS n FROM event_window_availability`).get() as { n: number };
    expect(n.n).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The resolution algorithm.
//
// This is the one genuinely new behaviour in specs/0013 -- everything else is
// bookkeeping. `bestWindowBlock` slides a block of *exactly* blockMinutes and
// returns the position most people cover. `bestWindowSpan` keeps that
// coverage and then stretches the block as far as it will go.
import { bestWindowBlock, bestWindowSpan } from '../src/lib/polls';

const H = 60 * 60 * 1000;
// Times are plain offsets from 0; only the arithmetic matters here.
const win = (hours: number) => hours * H;

describe('bestWindowSpan', () => {
  it('returns the minimum when that is all the overlap there is', () => {
    // Three people, each free for a different 2.5 hours, overlapping only in
    // the middle. Nothing to stretch into.
    const best = bestWindowSpan(win(0), win(12), 150, [
      { startAt: win(0), endAt: win(3) },
      { startAt: win(0.25), endAt: win(3.25) },
      { startAt: win(0.5), endAt: win(3.5) },
    ]);
    expect(best).not.toBeNull();
    expect(best!.count).toBe(3);
    expect(best!.endAt - best!.startAt).toBe(150 * 60 * 1000);
  });

  it('gives the longer session when everyone can stay', () => {
    // The ask, in one test: 2.5 hours is a floor, and four hours of shared
    // availability means a four-hour session.
    const best = bestWindowSpan(win(13), win(23), 150, [
      { startAt: win(13), endAt: win(17) },
      { startAt: win(13), endAt: win(17) },
      { startAt: win(13), endAt: win(17) },
    ]);
    expect(best).toEqual({ startAt: win(13), endAt: win(17), count: 3 });
  });

  it('prefers more people over a longer session', () => {
    // Four people free for five hours, five people free for two and a half.
    // The five-person block wins, even though it is half the length --
    // trading a player for extra time is the wrong way round.
    const best = bestWindowSpan(win(0), win(12), 150, [
      { startAt: win(0), endAt: win(5) },
      { startAt: win(0), endAt: win(5) },
      { startAt: win(0), endAt: win(5) },
      { startAt: win(0), endAt: win(5) },
      { startAt: win(0), endAt: win(2.5) },
    ]);
    expect(best!.count).toBe(5);
    expect(best!.endAt - best!.startAt).toBe(150 * 60 * 1000);
  });

  it('breaks a tie on length by taking the earlier start', () => {
    // Two disjoint three-hour blocks, both covered by both people.
    const best = bestWindowSpan(win(0), win(24), 180, [
      { startAt: win(1), endAt: win(4) },
      { startAt: win(1), endAt: win(4) },
    ]);
    expect(best!.startAt).toBe(win(1));
  });

  it('never runs past the end of the window', () => {
    const best = bestWindowSpan(win(0), win(4), 120, [
      { startAt: win(0), endAt: win(100) },
      { startAt: win(0), endAt: win(100) },
    ]);
    expect(best!.endAt).toBe(win(4));
  });

  it('agrees with bestWindowBlock when nobody has submitted', () => {
    // The no-submissions case decides whether a past-deadline poll resolves
    // or cancels, so it must not start reporting a full-window "session".
    const spread = bestWindowSpan(win(0), win(12), 150, []);
    expect(spread).toEqual(bestWindowBlock(win(0), win(12), 150, []));
    expect(spread!.count).toBe(0);
  });

  it('refuses a window too large to search, exactly as the block search does', () => {
    // Well past MAX_WINDOW_SPAN_MS, so only a row predating that validation
    // could get here -- which is the case the ceiling exists for.
    const huge = bestWindowSpan(0, 600 * 24 * H, 30, [{ startAt: 0, endAt: 600 * 24 * H }]);
    expect(huge).toBeNull();
  });

  it('reaches the same coverage the block search found, on random inputs', () => {
    // The property that makes "coverage first" a claim rather than a hope:
    // whatever the block search can cover, the span search covers too.
    let seed = 42;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let trial = 0; trial < 200; trial++) {
      const subs = Array.from({ length: 1 + Math.floor(rnd() * 6) }, () => {
        const s = Math.floor(rnd() * 16) * (H / 2);
        return { startAt: s, endAt: s + (1 + Math.floor(rnd() * 8)) * (H / 2) };
      });
      const block = bestWindowBlock(win(0), win(12), 60, subs);
      const span = bestWindowSpan(win(0), win(12), 60, subs);
      expect(span!.count).toBe(block!.count);
      // And it is never shorter than the minimum it was given.
      if (span!.count > 0) expect(span!.endAt - span!.startAt).toBeGreaterThanOrEqual(H);
      // Everyone counted really can make the whole span.
      const actual = subs.filter((s) => s.startAt <= span!.startAt && s.endAt >= span!.endAt).length;
      if (span!.count > 0) expect(actual).toBe(span!.count);
    }
  });
});

// ---------------------------------------------------------------------------
// The two presets, and the poll resolution that runs on them.
//
// specs/0013 claims the merged model is a *merge*: an options poll and a
// window poll are the same object with `window_block_minutes` unset or set.
// That is a hopeful claim until both special cases are pinned, so they are
// the first two tests here.
import { checkThresholdAndResolve, checkWindowThresholdAndResolve, resolvePastDeadlinePolls } from '../src/lib/polls';
import { createEventWithInvites, updateEvent } from '../src/lib/eventWrites';
import { ValidationError } from '../src/lib/validate';
import { DAY_MS, HOUR_MS, loadEventRow, seedGuild, seedMembership, seedUser, setup } from './helpers';

async function pollFixture(opts: { blockMinutes?: number | null; multiWinner?: boolean } = {}) {
  const ctx = setup();
  await seedGuild(ctx.db);
  for (const id of ['org', 'a', 'b', 'c']) {
    await seedUser(ctx.db, id);
    await seedMembership(ctx.db, id, 'guild-1');
  }
  const base = Date.now() + DAY_MS;
  const eventId = await createEventWithInvites(ctx.env, 'guild-1', 'org', {
    title: 'Which night?',
    description: null,
    game: null,
    timezone: 'America/New_York',
    eventType: 'poll',
    pollStrategy: 'threshold',
    pollThresholdCount: 3,
    pollDeadlineAt: Date.now() + 7 * DAY_MS,
    pollResolutionMode: opts.multiWinner ? 'multi_winner' : 'single_winner',
    windowBlockMinutes: opts.blockMinutes ?? undefined,
    pollOptions: [
      { startAt: base, endAt: base + 10 * HOUR_MS },
      { startAt: base + DAY_MS, endAt: base + DAY_MS + 10 * HOUR_MS },
    ],
    invites: { userIds: ['a', 'b', 'c'], groupIds: [] },
  });
  const options = await ctx.db
    .prepare(`SELECT id, start_at, end_at FROM event_poll_options WHERE event_id = ? ORDER BY display_order`)
    .bind(eventId)
    .all<{ id: string; start_at: number; end_at: number }>();
  return { ...ctx, eventId, base, options: options.results };
}

async function submit(ctx: Awaited<ReturnType<typeof pollFixture>>, optionId: string, userId: string, startAt: number, endAt: number) {
  await ctx.db
    .prepare(
      `INSERT INTO event_window_availability (option_id, event_id, user_id, avail_start_at, avail_end_at, submitted_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(optionId, ctx.eventId, userId, startAt, endAt, Date.now())
    .run();
}

async function vote(ctx: Awaited<ReturnType<typeof pollFixture>>, optionId: string, userId: string, v = 'yes') {
  await ctx.db
    .prepare(`INSERT INTO event_poll_votes (option_id, user_id, vote, voted_at) VALUES (?, ?, ?, ?)`)
    .bind(optionId, userId, v, Date.now())
    .run();
}

describe('the fixed-slot preset still behaves exactly as an options poll', () => {
  it('resolves on the threshold, to the candidate itself', async () => {
    const ctx = await pollFixture();
    const [first] = ctx.options;
    for (const u of ['a', 'b', 'c']) await vote(ctx, first.id, u);

    const resolved = await checkThresholdAndResolve(ctx.env, await loadEventRow(ctx.db, ctx.eventId));
    expect(resolved).toEqual([first.id]);

    const event = await loadEventRow(ctx.db, ctx.eventId);
    expect(event.status).toBe('resolved');
    expect(event.resolved_option_id).toBe(first.id);
    // The candidate *is* the session -- no span search, no narrowing.
    expect(event.start_at).toBe(first.start_at);
    expect(event.end_at).toBe(first.end_at);
  });

  it('is left alone by the windowed resolution path', async () => {
    const ctx = await pollFixture();
    expect(await checkWindowThresholdAndResolve(ctx.env, await loadEventRow(ctx.db, ctx.eventId))).toEqual([]);
  });
});

describe('the single-candidate preset still behaves exactly as a window poll', () => {
  it('resolves to the block everyone can make', async () => {
    const ctx = await pollFixture({ blockMinutes: 150 });
    const [win] = ctx.options;
    // All three free for the same three hours in the middle of the window.
    for (const u of ['a', 'b', 'c']) await submit(ctx, win.id, u, win.start_at + HOUR_MS, win.start_at + 4 * HOUR_MS);

    const resolved = await checkWindowThresholdAndResolve(ctx.env, await loadEventRow(ctx.db, ctx.eventId));
    expect(resolved).toEqual([win.id]);

    const event = await loadEventRow(ctx.db, ctx.eventId);
    expect(event.status).toBe('resolved');
    expect(event.resolved_option_id).toBe(win.id);
    // Three hours, not the 2.5-hour minimum: the minimum is a floor.
    expect(event.end_at! - event.start_at!).toBe(3 * HOUR_MS);
  });

  it('is left alone by the fixed-slot resolution path', async () => {
    const ctx = await pollFixture({ blockMinutes: 150 });
    expect(await checkThresholdAndResolve(ctx.env, await loadEventRow(ctx.db, ctx.eventId))).toEqual([]);
  });
});

describe('windowed candidates resolve independently of each other', () => {
  it('a submission on one candidate does not help another', async () => {
    const ctx = await pollFixture({ blockMinutes: 120 });
    const [first, second] = ctx.options;
    // Everyone free on the first night; nobody has answered about the second.
    for (const u of ['a', 'b', 'c']) await submit(ctx, first.id, u, first.start_at, first.start_at + 5 * HOUR_MS);
    // And one person free on the second, which must not be enough.
    await submit(ctx, second.id, 'a', second.start_at, second.start_at + 5 * HOUR_MS);

    const resolved = await checkWindowThresholdAndResolve(ctx.env, await loadEventRow(ctx.db, ctx.eventId));
    expect(resolved).toEqual([first.id]);
    const event = await loadEventRow(ctx.db, ctx.eventId);
    expect(event.start_at).toBe(first.start_at);
    expect(event.end_at).toBe(first.start_at + 5 * HOUR_MS);
  });

  it('confirms each qualifying candidate on its own in multi-winner mode', async () => {
    const ctx = await pollFixture({ blockMinutes: 120, multiWinner: true });
    const [first, second] = ctx.options;
    for (const u of ['a', 'b', 'c']) {
      await submit(ctx, first.id, u, first.start_at, first.start_at + 3 * HOUR_MS);
      await submit(ctx, second.id, u, second.start_at, second.start_at + 6 * HOUR_MS);
    }

    const confirmed = await checkWindowThresholdAndResolve(ctx.env, await loadEventRow(ctx.db, ctx.eventId));
    expect(confirmed.sort()).toEqual([first.id, second.id].sort());

    // Confirming a window narrows it to the span that won -- the row stops
    // being "any time in here" and becomes the session.
    const rows = await ctx.db
      .prepare(`SELECT id, start_at, end_at, confirmed_at FROM event_poll_options WHERE event_id = ? ORDER BY display_order`)
      .bind(ctx.eventId)
      .all<{ id: string; start_at: number; end_at: number; confirmed_at: number | null }>();
    expect(rows.results[0].end_at - rows.results[0].start_at).toBe(3 * HOUR_MS);
    expect(rows.results[1].end_at - rows.results[1].start_at).toBe(6 * HOUR_MS);
    expect(rows.results.every((r) => r.confirmed_at !== null)).toBe(true);

    // The parent poll keeps collecting; multi-winner never resolves as a whole
    // outside the deadline sweep.
    expect((await loadEventRow(ctx.db, ctx.eventId)).status).toBe('active');
  });

  it('confirms nothing twice', async () => {
    const ctx = await pollFixture({ blockMinutes: 120, multiWinner: true });
    const [first] = ctx.options;
    for (const u of ['a', 'b', 'c']) await submit(ctx, first.id, u, first.start_at, first.start_at + 3 * HOUR_MS);
    const once = await checkWindowThresholdAndResolve(ctx.env, await loadEventRow(ctx.db, ctx.eventId));
    const twice = await checkWindowThresholdAndResolve(ctx.env, await loadEventRow(ctx.db, ctx.eventId));
    expect(once).toEqual([first.id]);
    expect(twice).toEqual([]);
  });
});

describe('the deadline sweep on a windowed poll', () => {
  it('takes the candidate with the most coverage, whatever the threshold', async () => {
    const ctx = await pollFixture({ blockMinutes: 120 });
    const [first, second] = ctx.options;
    // Coverage and length deliberately disagree, and coverage has to win: one
    // person free all evening on the first night, two people free for three
    // hours on the second. Neither reaches the threshold of three -- past the
    // deadline there is no bar left to clear, only a best answer to pick.
    await submit(ctx, first.id, 'a', first.start_at, first.start_at + 8 * HOUR_MS);
    await submit(ctx, second.id, 'a', second.start_at, second.start_at + 3 * HOUR_MS);
    await submit(ctx, second.id, 'b', second.start_at, second.start_at + 3 * HOUR_MS);

    await ctx.db.prepare(`UPDATE events SET poll_deadline_at = ? WHERE id = ?`).bind(Date.now() - 1000, ctx.eventId).run();
    await resolvePastDeadlinePolls(ctx.env);

    const event = await loadEventRow(ctx.db, ctx.eventId);
    expect(event.status).toBe('resolved');
    expect(event.resolved_option_id).toBe(second.id);
    expect(event.end_at! - event.start_at!).toBe(3 * HOUR_MS);
  });

  it('breaks a coverage tie on the longer session', async () => {
    const ctx = await pollFixture({ blockMinutes: 120 });
    const [first, second] = ctx.options;
    await submit(ctx, first.id, 'a', first.start_at, first.start_at + 3 * HOUR_MS);
    await submit(ctx, second.id, 'a', second.start_at, second.start_at + 6 * HOUR_MS);

    await ctx.db.prepare(`UPDATE events SET poll_deadline_at = ? WHERE id = ?`).bind(Date.now() - 1000, ctx.eventId).run();
    await resolvePastDeadlinePolls(ctx.env);

    expect((await loadEventRow(ctx.db, ctx.eventId)).resolved_option_id).toBe(second.id);
  });

  it('cancels when nobody submitted anything', async () => {
    const ctx = await pollFixture({ blockMinutes: 120 });
    await ctx.db.prepare(`UPDATE events SET poll_deadline_at = ? WHERE id = ?`).bind(Date.now() - 1000, ctx.eventId).run();
    await resolvePastDeadlinePolls(ctx.env);
    expect((await loadEventRow(ctx.db, ctx.eventId)).status).toBe('cancelled');
  });
});

describe('creating a windowed poll', () => {
  it('refuses a window shorter than the minimum session it demands', async () => {
    const ctx = setup();
    await seedGuild(ctx.db);
    await seedUser(ctx.db, 'org');
    await seedMembership(ctx.db, 'org', 'guild-1');
    const base = Date.now() + DAY_MS;
    await expect(
      createEventWithInvites(ctx.env, 'guild-1', 'org', {
        title: 'Impossible',
        description: null,
        game: null,
        timezone: 'America/New_York',
        eventType: 'poll',
        pollStrategy: 'threshold',
        pollThresholdCount: 2,
        pollDeadlineAt: Date.now() + DAY_MS,
        windowBlockMinutes: 180,
        pollOptions: [{ startAt: base, endAt: base + HOUR_MS }],
        invites: { userIds: [], groupIds: [] },
      }),
    ).rejects.toThrow(ValidationError);
  });

  it('accepts the legacy window request shape as a one-candidate poll', async () => {
    // The Worker deploys before Pages does, so for a few minutes the old
    // frontend is still creating polls the old way.
    const ctx = setup();
    await seedGuild(ctx.db);
    await seedUser(ctx.db, 'org');
    await seedMembership(ctx.db, 'org', 'guild-1');
    const base = Date.now() + DAY_MS;
    const eventId = await createEventWithInvites(ctx.env, 'guild-1', 'org', {
      title: 'Legacy',
      description: null,
      game: null,
      timezone: 'America/New_York',
      eventType: 'poll',
      pollMode: 'window',
      pollStrategy: 'threshold',
      pollThresholdCount: 2,
      pollDeadlineAt: Date.now() + DAY_MS,
      windowStartAt: base,
      windowEndAt: base + 8 * HOUR_MS,
      windowBlockMinutes: 120,
      invites: { userIds: [], groupIds: [] },
    });

    const options = await ctx.db
      .prepare(`SELECT start_at, end_at FROM event_poll_options WHERE event_id = ?`)
      .bind(eventId)
      .all<{ start_at: number; end_at: number }>();
    expect(options.results).toEqual([{ start_at: base, end_at: base + 8 * HOUR_MS }]);
    const event = await loadEventRow(ctx.db, eventId);
    expect(event.window_block_minutes).toBe(120);
  });
});

describe('editing a windowed poll', () => {
  it('does not un-window it when only the candidates are re-ordered', async () => {
    // The same F-08-A trap the strategy/threshold/deadline fields already
    // carry, and a sharper version of it: this field decides what the
    // candidates *mean*, so losing it silently turns every window into a
    // fixed slot and makes every submitted range meaningless.
    const ctx = await pollFixture({ blockMinutes: 150 });
    const stored = await loadEventRow(ctx.db, ctx.eventId);
    await updateEvent(ctx.env, ctx.eventId, 'guild-1', {
      pollOptions: [...ctx.options].reverse().map((o) => ({ startAt: o.start_at, endAt: o.end_at })),
      revision: stored.revision,
    }, stored);

    expect((await loadEventRow(ctx.db, ctx.eventId)).window_block_minutes).toBe(150);
  });

  it('turns the windows off when the minimum is explicitly cleared', async () => {
    const ctx = await pollFixture({ blockMinutes: 150 });
    const [first] = ctx.options;
    await submit(ctx, first.id, 'a', first.start_at, first.start_at + 5 * HOUR_MS);
    const stored = await loadEventRow(ctx.db, ctx.eventId);
    await updateEvent(ctx.env, ctx.eventId, 'guild-1', { windowBlockMinutes: null, revision: stored.revision }, stored);

    expect((await loadEventRow(ctx.db, ctx.eventId)).window_block_minutes).toBeNull();
    // The submitted ranges go with it: the candidate is the session now, and
    // there is nothing left to have submitted a range within.
    const left = await ctx.db
      .prepare(`SELECT COUNT(*) AS n FROM event_window_availability WHERE event_id = ?`)
      .bind(ctx.eventId)
      .first<{ n: number }>();
    expect(left?.n).toBe(0);
  });
});
