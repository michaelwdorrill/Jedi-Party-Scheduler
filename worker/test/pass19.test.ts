import { describe, expect, it } from 'vitest';
import type { EventRow } from '../src/lib/events';
import { buildNoticeboard } from '../src/lib/noticeboard';
import { checkThresholdAndResolve, resolvePastDeadlinePolls } from '../src/lib/polls';
import type { ShimDatabase } from './d1shim';
import { seedEvent, seedGuild, seedMembership, seedUser, setup } from './helpers';

// Pass 19 review. P19-01 is the third regression in three passes from the same
// place, and the third of the same SHAPE: a fixed page of candidate rows cut
// BEFORE anything expands, so rows that expand to nothing evict rows that do
// not. P17-07 was finished series doing it, P18-02 is count-exhausted series
// doing it, and P19-01 was series holding overrides that a rule edit had
// orphaned -- admitted by the override arm I added in b8711a0 to fix P18-01.
//
// The fix is no longer in the predicate. Candidates are paged and counted
// AFTER expansion, and the response says when the scan stopped early.
const WINDOW_FROM = Date.UTC(2026, 8, 15);
const WINDOW_TO = Date.UTC(2026, 8, 17, 23, 59);

async function guild(plan: 'paid' | 'free' = 'paid'): Promise<ReturnType<typeof setup>> {
  const ctx = setup(plan);
  await seedGuild(ctx.db, 'guild-1');
  await seedUser(ctx.db, 'owner');
  await seedMembership(ctx.db, 'owner', 'guild-1');
  return ctx;
}

// A series that ends 2026-09-12 but still stores an override for 2026-09-13
// moving that occurrence into the window. The 13th is no longer a date the
// rule produces, so isSeriesOccurrence (P14-13) correctly refuses it and the
// series expands to nothing -- which is right, and is exactly why admitting it
// as a candidate must not cost an event slot.
async function seedOrphanedOverrideSeries(db: ShimDatabase, id: string): Promise<void> {
  await seedEvent(db, { id, organizerId: 'owner', startAt: null, endAt: null, isRecurring: 1 });
  await db
    .prepare(
      `INSERT INTO event_recurrence_rules
         (event_id, freq, interval, by_weekday, by_month_day, start_date, start_time,
          duration_minutes, end_type, end_date, end_count)
       VALUES (?, 'DAILY', 1, NULL, NULL, '2026-09-12', '19:00', 120, 'on_date', '2026-09-12', NULL)`,
    )
    .bind(id)
    .run();
  await db
    .prepare(
      `INSERT INTO event_occurrence_overrides
         (id, event_id, occurrence_date, is_cancelled, override_start_at, override_end_at)
       VALUES (?, ?, '2026-09-13', 0, ?, ?)`,
    )
    .bind(`ov-${id}`, id, Date.UTC(2026, 8, 16, 19, 0), Date.UTC(2026, 8, 16, 21, 0))
    .run();
}

// A finite series whose single occurrence is long past, with no end_date at
// all -- `after_count` with count 1. This is P18-02's shape, and no date-only
// predicate can exclude it, because there is no date to test.
async function seedExhaustedCountSeries(db: ShimDatabase, id: string): Promise<void> {
  await seedEvent(db, { id, organizerId: 'owner', startAt: null, endAt: null, isRecurring: 1 });
  await db
    .prepare(
      `INSERT INTO event_recurrence_rules
         (event_id, freq, interval, by_weekday, by_month_day, start_date, start_time,
          duration_minutes, end_type, end_date, end_count)
       VALUES (?, 'DAILY', 1, NULL, NULL, '2026-07-01', '19:00', 120, 'after_count', NULL, 1)`,
    )
    .bind(id)
    .run();
}

async function seedRealEvent(db: ShimDatabase): Promise<void> {
  await seedEvent(db, {
    id: 'real',
    organizerId: 'owner',
    title: 'Actually Happening',
    startAt: Date.UTC(2026, 8, 16, 12, 0),
    endAt: Date.UTC(2026, 8, 16, 14, 0),
  });
}

describe('candidates that expand to nothing must not evict a real event (P19-01, P18-02)', () => {
  it('returns the event behind a full page of series whose overrides were orphaned', async () => {
    const { db, env } = await guild();
    for (let i = 0; i < 100; i++) await seedOrphanedOverrideSeries(db, `stale-${i}`);
    await seedRealEvent(db);

    const board = await buildNoticeboard(env, 'guild-1', WINDOW_FROM, WINDOW_TO);

    expect(
      board.occurrences.some((o) => o.eventId === 'real'),
      'a hundred series holding overrides a rule edit had orphaned hid a real event, and the board came back empty',
    ).toBe(true);
    expect(board.complete, 'the scan examined every candidate, so it should say the answer is complete').toBe(true);
  });

  it('returns the event behind a full page of count-exhausted series', async () => {
    const { db, env } = await guild();
    for (let i = 0; i < 100; i++) await seedExhaustedCountSeries(db, `spent-${i}`);
    await seedRealEvent(db);

    const board = await buildNoticeboard(env, 'guild-1', WINDOW_FROM, WINDOW_TO);

    expect(
      board.occurrences.some((o) => o.eventId === 'real'),
      'a hundred after_count series with no end_date hid a real event -- P18-02, which no date filter can close',
    ).toBe(true);
    expect(board.complete).toBe(true);
  });

  // 60 + 60 rather than 40 + 40, and the reason is worth keeping: at 40 + 40
  // the two shapes the old predicate ADMITS total 80, the finished series are
  // excluded by its date test, and 81 candidates never reach the hundred-row
  // cut -- so this passed on the unfixed tree and proved nothing. Sized to
  // exceed the cut with admitted rows alone.
  it('returns the event behind a mixed page of both shapes plus finished series', async () => {
    const { db, env } = await guild();
    for (let i = 0; i < 60; i++) await seedOrphanedOverrideSeries(db, `stale-${i}`);
    for (let i = 0; i < 60; i++) await seedExhaustedCountSeries(db, `spent-${i}`);
    for (let i = 0; i < 40; i++) {
      const id = `done-${i}`;
      await seedEvent(db, { id, organizerId: 'owner', startAt: null, endAt: null, isRecurring: 1 });
      await db
        .prepare(
          `INSERT INTO event_recurrence_rules
             (event_id, freq, interval, by_weekday, by_month_day, start_date, start_time,
              duration_minutes, end_type, end_date, end_count)
           VALUES (?, 'WEEKLY', 1, '5', NULL, '2026-07-01', '19:00', 120, 'on_date', '2026-08-01', NULL)`,
        )
        .bind(id)
        .run();
    }
    await seedRealEvent(db);

    const board = await buildNoticeboard(env, 'guild-1', WINDOW_FROM, WINDOW_TO);

    expect(board.occurrences.some((o) => o.eventId === 'real')).toBe(true);
    expect(board.complete).toBe(true);
  });
});

describe('the board says so when it stopped looking (IDEAS item 79)', () => {
  it('reports incomplete when the scan cap is reached with candidates left', async () => {
    const { db, env } = await guild();
    // MAX_CANDIDATES_SCANNED is 500. Written as a literal rather than imported
    // from the module under test: importing MAX_NOTICEBOARD_EVENTS is what made
    // the first P17-07 fixture pass on an unfixed tree, because reverting the
    // module removed the export and the count arrived as undefined.
    for (let i = 0; i < 520; i++) await seedOrphanedOverrideSeries(db, `stale-${String(i).padStart(4, '0')}`);
    await seedRealEvent(db);

    const board = await buildNoticeboard(env, 'guild-1', WINDOW_FROM, WINDOW_TO);

    // The honest outcome: we could not prove there is nothing, so we do not
    // claim there is nothing. Silently returning [] here is the exact failure
    // that hid three regressions from three reviews.
    expect(
      board.complete,
      'the scan gave up with candidates unexamined and still reported a complete answer',
    ).toBe(false);
  });

  it('reports complete for an ordinary board', async () => {
    const { db, env } = await guild();
    await seedRealEvent(db);

    const board = await buildNoticeboard(env, 'guild-1', WINDOW_FROM, WINDOW_TO);

    expect(board.occurrences).toHaveLength(1);
    expect(board.complete).toBe(true);
  });

  it('reports complete for a genuinely empty server', async () => {
    const { env } = await guild();

    const board = await buildNoticeboard(env, 'guild-1', WINDOW_FROM, WINDOW_TO);

    // An empty board that IS the whole answer must still say so, or the
    // frontend cannot tell the two apart in the other direction either.
    expect(board.occurrences).toHaveLength(0);
    expect(board.complete).toBe(true);
  });
});

// An invariant guard, not a reproduction: it passes on the unfixed tree too,
// because that tree ran one candidate query instead of five pages. It is here
// because affordability is the risk this fix carries -- correctness bought by
// tripling the statement count in a request path would be a bad trade, and
// nothing else in the suite would notice.
describe('the paged scan stays inside a Free-plan invocation', () => {
  it('costs well under the 50-statement ceiling at the scan cap', async () => {
    const { db, env } = await guild('free');
    for (let i = 0; i < 520; i++) await seedOrphanedOverrideSeries(db, `stale-${String(i).padStart(4, '0')}`);
    await seedRealEvent(db);

    db.resetQueryCount();
    await buildNoticeboard(env, 'guild-1', WINDOW_FROM, WINDOW_TO);
    const used = db.queryCount;

    // This is a REQUEST path, so D1's documented Free limit of 50 statements
    // per invocation applies to it exactly as it does to the cron. Paging cost
    // three statements per page (candidates, overrides, rules) where the old
    // single cut cost one, so this guard is the price of the fix being
    // affordable rather than merely correct.
    expect(used, `the paged noticeboard scan used ${used} statements`).toBeLessThan(50);
  });
});

// ---------------------------------------------------------------------------
// P19-02. A poll's winner is computed from a tally read, then committed by a
// separate UPDATE. An organizer can legitimately edit the candidates in
// between, through the ordinary authorized route, while the poll is still
// active and still collecting votes.
//
// The interleaving is modelled the way production produces it rather than by
// patching the database mid-statement: checkThresholdAndResolve takes an
// already-loaded EventRow, so a row loaded before the edit IS the stale read
// the race hands it. Nothing here is forged -- the vote is a real row, the
// deletion is what eventWrites does to a removed candidate, and the revision
// bump is what its guarded batch does to the parent event.
describe('a poll must not resolve to a candidate that was just removed (P19-02)', () => {
  async function seedThresholdPoll(db: ShimDatabase): Promise<void> {
    await seedEvent(db, {
      id: 'poll-1',
      organizerId: 'owner',
      title: 'Which night?',
      eventType: 'poll',
      startAt: null,
      endAt: null,
    });
    await db
      .prepare(
        `UPDATE events SET poll_strategy = 'threshold', poll_threshold_count = 1,
           poll_resolution_mode = 'single_winner', window_block_minutes = NULL, revision = 0
         WHERE id = 'poll-1'`,
      )
      .run();
    await db
      .prepare(
        `INSERT INTO event_poll_options (id, event_id, start_at, end_at, display_order) VALUES
           ('opt-a', 'poll-1', ?, ?, 0),
           ('opt-b', 'poll-1', ?, ?, 1)`,
      )
      .bind(
        Date.UTC(2026, 8, 20, 19, 0), Date.UTC(2026, 8, 20, 21, 0),
        Date.UTC(2026, 8, 21, 19, 0), Date.UTC(2026, 8, 21, 21, 0),
      )
      .run();
  }

  // The edit has to land BETWEEN the tally read and the commit, and getting
  // that wrong is how the first version of this test passed on the unfixed
  // tree -- the sixth fixture in this cycle to pass for a reason unrelated to
  // what it asserts. Deleting the candidate before calling the resolver means
  // getOptionTallies never sees it, so there is no winner to commit and the
  // poll stays active for a reason that has nothing to do with the guard.
  //
  // So the edit is fired from the tally statement's own completion. Nothing is
  // forged: the driver only decides WHEN two ordinary statements interleave,
  // which is the whole content of the finding.
  function editAfterTallyRead(env: { DB: unknown }, edit: string): void {
    const db = env.DB as ShimDatabase;
    const realPrepare = db.prepare.bind(db);
    let fired = false;
    (db as unknown as { prepare: (sql: string) => unknown }).prepare = (sql: string) => {
      const statement = realPrepare(sql);
      if (fired || !sql.includes('FROM event_poll_options o')) return statement;
      const realAll = statement.all.bind(statement);
      (statement as unknown as { all: () => Promise<unknown> }).all = async () => {
        const out = await realAll();
        if (!fired) {
          fired = true;
          realPrepare(edit).run();
          realPrepare(`UPDATE events SET revision = revision + 1 WHERE id = 'poll-1'`).run();
        }
        return out;
      };
      return statement;
    };
  }

  it('refuses the decision when the winning candidate was deleted after the read', async () => {
    const { db, env } = await guild();
    await seedUser(db, 'voter');
    await seedMembership(db, 'voter', 'guild-1');
    await seedThresholdPoll(db);

    // The stale read: what a vote handler is holding when it calls the
    // resolver, taken before the organizer's edit commits.
    const staleEvent = await db.prepare(`SELECT * FROM events WHERE id = 'poll-1'`).first<EventRow>();
    expect(staleEvent).not.toBeNull();

    await db
      .prepare(`INSERT INTO event_poll_votes (option_id, user_id, vote, voted_at) VALUES ('opt-a', 'voter', 'yes', ?)`)
      .bind(Date.now())
      .run();

    // The organizer's edit lands after the winner has been computed: candidate
    // A is gone and the event's optimistic-concurrency token has moved on.
    editAfterTallyRead(env, `DELETE FROM event_poll_options WHERE id = 'opt-a'`);

    await checkThresholdAndResolve(env, staleEvent!);

    const after = await db
      .prepare(`SELECT status, resolved_option_id, start_at FROM events WHERE id = 'poll-1'`)
      .first<{ status: string; resolved_option_id: string | null; start_at: number | null }>();

    expect(
      after?.status,
      'the poll resolved to a candidate the organizer had already removed, and the board would advertise that time',
    ).toBe('active');
    expect(after?.resolved_option_id, 'resolved_option_id is plain TEXT, so a deleted id commits and dangles').toBeNull();
    expect(after?.start_at).toBeNull();
  });

  // The control, and the one that matters most: the guard must not stop an
  // ordinary poll from resolving. If this ever fails, every threshold poll in
  // the app has silently stopped settling and nothing else would say so.
  it('still resolves normally when nothing changed underneath it', async () => {
    const { db, env } = await guild();
    await seedUser(db, 'voter');
    await seedMembership(db, 'voter', 'guild-1');
    await seedThresholdPoll(db);

    const event = await db.prepare(`SELECT * FROM events WHERE id = 'poll-1'`).first<EventRow>();
    await db
      .prepare(`INSERT INTO event_poll_votes (option_id, user_id, vote, voted_at) VALUES ('opt-a', 'voter', 'yes', ?)`)
      .bind(Date.now())
      .run();

    const settled = await checkThresholdAndResolve(env, event!);

    expect(settled).toEqual(['opt-a']);
    const after = await db
      .prepare(`SELECT status, resolved_option_id FROM events WHERE id = 'poll-1'`)
      .first<{ status: string; resolved_option_id: string | null }>();
    expect(after?.status).toBe('resolved');
    expect(after?.resolved_option_id).toBe('opt-a');
  });

  // A different edit, same principle: the candidate survives but the threshold
  // changed. Option existence alone would let this through, which is why the
  // revision is the mechanism and the EXISTS is only defence in depth.
  it('refuses the decision when the threshold was raised after the read', async () => {
    const { db, env } = await guild();
    await seedUser(db, 'voter');
    await seedMembership(db, 'voter', 'guild-1');
    await seedThresholdPoll(db);

    const staleEvent = await db.prepare(`SELECT * FROM events WHERE id = 'poll-1'`).first<EventRow>();
    await db
      .prepare(`INSERT INTO event_poll_votes (option_id, user_id, vote, voted_at) VALUES ('opt-a', 'voter', 'yes', ?)`)
      .bind(Date.now())
      .run();

    editAfterTallyRead(env, `UPDATE events SET poll_threshold_count = 5 WHERE id = 'poll-1'`);

    await checkThresholdAndResolve(env, staleEvent!);

    const after = await db.prepare(`SELECT status FROM events WHERE id = 'poll-1'`).first<{ status: string }>();
    expect(
      after?.status,
      'one vote settled a poll whose organizer had just raised the threshold to five',
    ).toBe('active');
  });
});

// ---------------------------------------------------------------------------
// P20-03. The Pass-19 pager used `(COALESCE(start_at, from), id)` as its
// cursor, and `start_at` is editable. An owner moving an event between two page
// reads could push it BEHIND the cursor -- never selected, while the response
// still claimed completeness -- or across it, selected twice with the same
// occurrence id appearing in the output twice.
//
// The pager is gone rather than guarded: candidates are read in one statement,
// so there is no second read for an edit to land between. These tests drive an
// edit at the moment the old design would have been between pages, and both
// are now structurally impossible rather than merely defended against.
//
// They are written against the observable contract -- what comes back, and
// whether `complete` is true -- so they keep meaning something if the internals
// change again, which on this file's record they will.
describe('an edit during the scan cannot duplicate or hide an event (P20-03)', () => {
  // Fires `edit` the first time a statement reads the events table, which is
  // exactly where the pager's second SELECT used to be. Under the snapshot
  // design this lands after the only candidate read; under the pager it landed
  // between two of them.
  function editDuringScan(env: { DB: unknown }, edit: () => Promise<void>): void {
    const db = env.DB as ShimDatabase;
    const realPrepare = db.prepare.bind(db);
    let seenCandidateRead = false;
    (db as unknown as { prepare: (sql: string) => unknown }).prepare = (sql: string) => {
      const statement = realPrepare(sql);
      if (!sql.includes('FROM events') || !sql.includes('is_recurring')) return statement;
      const realAll = statement.all.bind(statement);
      (statement as unknown as { all: () => Promise<unknown> }).all = async () => {
        const out = await realAll();
        if (!seenCandidateRead) {
          seenCandidateRead = true;
          await edit();
        }
        return out;
      };
      return statement;
    };
  }

  async function seedCrowd(db: ShimDatabase, n: number): Promise<void> {
    for (let i = 0; i < n; i++) await seedExhaustedCountSeries(db, `spent-${String(i).padStart(4, '0')}`);
  }

  it('never returns the same occurrence twice when an event is moved later', async () => {
    const { db, env } = await guild();
    await seedCrowd(db, 98);
    await seedEvent(db, { id: 'evt-a', organizerId: 'owner', title: 'A',
      startAt: Date.UTC(2026, 8, 16, 1, 0), endAt: Date.UTC(2026, 8, 16, 2, 0) });
    await seedEvent(db, { id: 'evt-b', organizerId: 'owner', title: 'B',
      startAt: Date.UTC(2026, 8, 16, 2, 0), endAt: Date.UTC(2026, 8, 16, 3, 0) });
    await seedEvent(db, { id: 'evt-d', organizerId: 'owner', title: 'D',
      startAt: Date.UTC(2026, 8, 16, 4, 0), endAt: Date.UTC(2026, 8, 16, 5, 0) });

    // A moves from +1h to +3h, i.e. past where the cursor had reached.
    editDuringScan(env, async () => {
      await db
        .prepare(`UPDATE events SET start_at = ?, end_at = ? WHERE id = 'evt-a'`)
        .bind(Date.UTC(2026, 8, 16, 3, 0), Date.UTC(2026, 8, 16, 4, 0))
        .run();
    });

    const board = await buildNoticeboard(env, 'guild-1', WINDOW_FROM, WINDOW_TO);
    const ids = board.occurrences.map((o) => o.occurrenceId);

    expect(
      new Set(ids).size,
      `the same occurrence was returned more than once: ${JSON.stringify(ids)}`,
    ).toBe(ids.length);
  });

  it('does not claim completeness after an event moves earlier mid-scan', async () => {
    const { db, env } = await guild();
    await seedCrowd(db, 99);
    await seedEvent(db, { id: 'evt-a', organizerId: 'owner', title: 'A',
      startAt: Date.UTC(2026, 8, 16, 1, 0), endAt: Date.UTC(2026, 8, 16, 2, 0) });
    await seedEvent(db, { id: 'evt-b', organizerId: 'owner', title: 'B',
      startAt: Date.UTC(2026, 8, 17, 1, 0), endAt: Date.UTC(2026, 8, 17, 2, 0) });

    // B moves earlier, staying inside the window -- behind the old cursor.
    editDuringScan(env, async () => {
      await db
        .prepare(`UPDATE events SET start_at = ?, end_at = ? WHERE id = 'evt-b'`)
        .bind(Date.UTC(2026, 8, 15, 1, 0), Date.UTC(2026, 8, 15, 2, 0))
        .run();
    });

    const board = await buildNoticeboard(env, 'guild-1', WINDOW_FROM, WINDOW_TO);
    const ids = board.occurrences.map((o) => o.eventId);

    // Either B is in the answer, or the answer does not claim to be whole. The
    // pager managed neither: it dropped B and reported complete: true.
    expect(
      ids.includes('evt-b') || !board.complete,
      'an event moved during the scan vanished from a board that still reported itself complete',
    ).toBe(true);
  });

  // An invariant guard: it passes on the paged tree too. Here because the
  // snapshot must not have quietly changed what an ordinary board contains.
  it('still returns every eligible event when nothing is edited', async () => {
    const { db, env } = await guild();
    await seedCrowd(db, 98);
    for (const [id, hour] of [['evt-a', 1], ['evt-b', 2], ['evt-d', 4]] as const) {
      await seedEvent(db, { id, organizerId: 'owner', title: id,
        startAt: Date.UTC(2026, 8, 16, hour, 0), endAt: Date.UTC(2026, 8, 16, hour + 1, 0) });
    }

    const board = await buildNoticeboard(env, 'guild-1', WINDOW_FROM, WINDOW_TO);

    expect(board.occurrences.map((o) => o.eventId).sort()).toEqual(['evt-a', 'evt-b', 'evt-d']);
    expect(board.complete).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// P20-02. Pass 19 gave `markResolved` a revision check and left the other four
// poll-decision writers alone, so the same class of stale decision moved next
// door. IDEAS item 83 predicted exactly this and the Pass-20 review found it,
// which is a reasonable argument for auditing a class rather than patching the
// instance that was reported.
//
// Two shapes, both from successful, authorized owner edits: raising a threshold
// immediately before a confirmation, and extending a deadline immediately
// before a close.
describe('every poll decision honours an edit that beat it (P20-02)', () => {
  async function seedMultiWinnerPoll(db: ShimDatabase): Promise<void> {
    await seedEvent(db, { id: 'poll-1', organizerId: 'owner', title: 'Which nights?',
      eventType: 'poll', startAt: null, endAt: null });
    await db.prepare(
      `UPDATE events SET poll_strategy = 'threshold', poll_threshold_count = 1,
         poll_resolution_mode = 'multi_winner', window_block_minutes = NULL, revision = 0
       WHERE id = 'poll-1'`,
    ).run();
    await db.prepare(
      `INSERT INTO event_poll_options (id, event_id, start_at, end_at, display_order)
       VALUES ('opt-a', 'poll-1', ?, ?, 0)`,
    ).bind(Date.UTC(2026, 8, 20, 19, 0), Date.UTC(2026, 8, 20, 21, 0)).run();
  }

  function editAfterTallyRead(env: { DB: unknown }, edit: string): void {
    const db = env.DB as ShimDatabase;
    const realPrepare = db.prepare.bind(db);
    let fired = false;
    (db as unknown as { prepare: (sql: string) => unknown }).prepare = (sql: string) => {
      const statement = realPrepare(sql);
      if (fired || !sql.includes('FROM event_poll_options o')) return statement;
      const realAll = statement.all.bind(statement);
      (statement as unknown as { all: () => Promise<unknown> }).all = async () => {
        const out = await realAll();
        if (!fired) {
          fired = true;
          realPrepare(edit).run();
          realPrepare(`UPDATE events SET revision = revision + 1 WHERE id = 'poll-1'`).run();
        }
        return out;
      };
      return statement;
    };
  }

  it('does not confirm a multi-winner option after the threshold was raised', async () => {
    const { db, env } = await guild();
    await seedUser(db, 'voter');
    await seedMembership(db, 'voter', 'guild-1');
    await seedMultiWinnerPoll(db);

    const staleEvent = await db.prepare(`SELECT * FROM events WHERE id = 'poll-1'`).first<EventRow>();
    await db.prepare(
      `INSERT INTO event_poll_votes (option_id, user_id, vote, voted_at) VALUES ('opt-a', 'voter', 'yes', ?)`,
    ).bind(Date.now()).run();

    editAfterTallyRead(env, `UPDATE events SET poll_threshold_count = 2 WHERE id = 'poll-1'`);
    await checkThresholdAndResolve(env, staleEvent!);

    const opt = await db
      .prepare(`SELECT confirmed_at FROM event_poll_options WHERE id = 'opt-a'`)
      .first<{ confirmed_at: number | null }>();
    expect(
      opt?.confirmed_at,
      'one vote confirmed a candidate after the owner had just raised the threshold to two',
    ).toBeNull();
  });

  it('still confirms a multi-winner option when nothing changed', async () => {
    const { db, env } = await guild();
    await seedUser(db, 'voter');
    await seedMembership(db, 'voter', 'guild-1');
    await seedMultiWinnerPoll(db);

    const event = await db.prepare(`SELECT * FROM events WHERE id = 'poll-1'`).first<EventRow>();
    await db.prepare(
      `INSERT INTO event_poll_votes (option_id, user_id, vote, voted_at) VALUES ('opt-a', 'voter', 'yes', ?)`,
    ).bind(Date.now()).run();

    const confirmed = await checkThresholdAndResolve(env, event!);

    expect(confirmed).toEqual(['opt-a']);
  });

  it('does not cancel an unanswered poll whose deadline was just extended', async () => {
    const { db, env } = await guild();
    await seedMultiWinnerPoll(db);
    await db.prepare(
      `UPDATE events SET poll_resolution_mode = 'single_winner', poll_deadline_at = ? WHERE id = 'poll-1'`,
    ).bind(Date.now() - 1000).run();

    // The owner extends the deadline while the sweep is mid-decision. Fired
    // from the tally read, which is the point the sweep has committed to a
    // no-winner outcome but has not written it.
    editAfterTallyRead(
      env,
      `UPDATE events SET poll_deadline_at = ${Date.now() + 7 * 24 * 60 * 60 * 1000} WHERE id = 'poll-1'`,
    );
    await resolvePastDeadlinePolls(env);

    const after = await db
      .prepare(`SELECT status, poll_deadline_at FROM events WHERE id = 'poll-1'`)
      .first<{ status: string; poll_deadline_at: number }>();
    expect(
      after?.status,
      'a poll was cancelled for having no answer after its owner had just given it another week',
    ).toBe('active');
    expect(after!.poll_deadline_at).toBeGreaterThan(Date.now());
  });

  it('still cancels an unanswered poll whose deadline really has passed', async () => {
    const { db, env } = await guild();
    await seedMultiWinnerPoll(db);
    await db.prepare(
      `UPDATE events SET poll_resolution_mode = 'single_winner', poll_deadline_at = ? WHERE id = 'poll-1'`,
    ).bind(Date.now() - 1000).run();

    await resolvePastDeadlinePolls(env);

    const after = await db.prepare(`SELECT status FROM events WHERE id = 'poll-1'`).first<{ status: string }>();
    expect(after?.status, 'the guard stopped ordinary deadline cancellation from working').toBe('cancelled');
  });
});
