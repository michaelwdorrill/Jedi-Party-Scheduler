import { describe, expect, it } from 'vitest';
import { buildNoticeboard } from '../src/lib/noticeboard';
import type { ShimDatabase } from './d1shim';
import { seedEvent, seedGuild, seedMembership, seedUser, setup } from './helpers';

// Pass 18 review. One finding, and it is a regression I introduced in
// 6d70872 while fixing P17-07: the recurring candidate filter excluded series
// that the tree before it returned.
//
// The window every test here uses is 15--17 September 2026, fixed rather than
// relative to `Date.now()`, because these assertions turn on the relationship
// between stored rule dates and the window. A relative window would make the
// suite's result depend on the day it runs -- which is exactly how
// googleDemoSeed.test.ts came to pass for weeks and then fail with nothing
// relevant changed.
const WINDOW_FROM = Date.UTC(2026, 8, 15);
const WINDOW_TO = Date.UTC(2026, 8, 17, 23, 59);

async function seedRule(
  db: ShimDatabase,
  eventId: string,
  {
    startDate,
    endDate,
    byWeekday,
    durationMinutes = 120,
  }: { startDate: string; endDate: string | null; byWeekday: string; durationMinutes?: number },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO event_recurrence_rules
         (event_id, freq, interval, by_weekday, by_month_day, start_date, start_time,
          duration_minutes, end_type, end_date, end_count)
       VALUES (?, 'WEEKLY', 1, ?, NULL, ?, '19:00', ?, ?, ?, NULL)`,
    )
    .bind(eventId, byWeekday, startDate, durationMinutes, endDate ? 'on_date' : 'never', endDate)
    .run();
}

async function seedMove(
  db: ShimDatabase,
  eventId: string,
  occurrenceDate: string,
  startAt: number,
  endAt: number,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO event_occurrence_overrides
         (id, event_id, occurrence_date, is_cancelled, override_start_at, override_end_at)
       VALUES (?, ?, ?, 0, ?, ?)`,
    )
    .bind(`ov-${eventId}`, eventId, occurrenceDate, startAt, endAt)
    .run();
}

async function guild(): Promise<ReturnType<typeof setup>> {
  const ctx = setup('paid');
  await seedGuild(ctx.db, 'guild-1');
  await seedUser(ctx.db, 'owner');
  await seedMembership(ctx.db, 'owner', 'guild-1');
  return ctx;
}

describe('the noticeboard filter must not exclude a real occurrence (P18-01)', () => {
  // All three of these are reproductions, verified by reverting the predicate
  // in src/lib/noticeboard.ts to its 6d70872 form: each returns an EMPTY
  // noticeboard there while the occurrence exists and is public.

  it('returns an occurrence moved forward into the window from a finished series', async () => {
    const { db, env } = await guild();

    // 12 September 2026 is a Saturday, which is what by_weekday '5' means --
    // an override whose date is not a date the rule produces is correctly
    // refused by isSeriesOccurrence (P14-13), so getting this wrong makes the
    // test pass for a reason that has nothing to do with the filter. It did,
    // on the first attempt.
    await seedEvent(db, { id: 'moved-fwd', organizerId: 'owner', startAt: null, endAt: null, isRecurring: 1 });
    await seedRule(db, 'moved-fwd', { startDate: '2026-09-12', endDate: '2026-09-12', byWeekday: '5' });
    await seedMove(db, 'moved-fwd', '2026-09-12', Date.UTC(2026, 8, 16, 19, 0), Date.UTC(2026, 8, 16, 21, 0));

    const board = await buildNoticeboard(env, 'guild-1', WINDOW_FROM, WINDOW_TO);

    expect(
      board.some((o) => o.eventId === 'moved-fwd'),
      'a series that ended on the 12th, whose occurrence an accepted change request moved to the 16th, was excluded from a window containing the 16th',
    ).toBe(true);
  });

  it('returns an occurrence moved back into the window from a series that has not started', async () => {
    const { db, env } = await guild();

    // 1 October 2026 is a Thursday: by_weekday '3'.
    await seedEvent(db, { id: 'moved-back', organizerId: 'owner', startAt: null, endAt: null, isRecurring: 1 });
    await seedRule(db, 'moved-back', { startDate: '2026-10-01', endDate: '2026-10-01', byWeekday: '3' });
    await seedMove(db, 'moved-back', '2026-10-01', Date.UTC(2026, 8, 16, 19, 0), Date.UTC(2026, 8, 16, 21, 0));

    const board = await buildNoticeboard(env, 'guild-1', WINDOW_FROM, WINDOW_TO);

    expect(
      board.some((o) => o.eventId === 'moved-back'),
      'a series starting in October, whose occurrence was moved back to the 16th, was excluded from a window containing the 16th',
    ).toBe(true);
  });

  it('returns a multi-day occurrence that starts before the window and runs into it', async () => {
    const { db, env } = await guild();

    // Six days. validate.ts allows up to a year, so this is nowhere near the
    // limit; the old predicate compared end_date as a point and dropped it.
    await seedEvent(db, { id: 'long-rec', organizerId: 'owner', startAt: null, endAt: null, isRecurring: 1 });
    await seedRule(db, 'long-rec', {
      startDate: '2026-09-12',
      endDate: '2026-09-12',
      byWeekday: '5',
      durationMinutes: 6 * 24 * 60,
    });

    const board = await buildNoticeboard(env, 'guild-1', WINDOW_FROM, WINDOW_TO);

    expect(
      board.some((o) => o.eventId === 'long-rec'),
      'a six-day occurrence beginning on the 12th and ending on the 18th was excluded from a window opening on the 15th',
    ).toBe(true);
  });

  // An invariant guard, not a reproduction: it passes on the unfixed tree too,
  // because that tree also excluded this series. It is here because the risk
  // this fix carries is the opposite of the bug -- widening the end bound by
  // the rule's duration could readmit everything, which would undo P17-07 and
  // reinstate the empty noticeboard it was written for. The deterministic
  // crowding test lives in pass17.test.ts, where the real event sorts AFTER
  // the series and is genuinely cut; a crowding fixture in this file would
  // have depended on tie order among NULL start_at rows, which the candidate
  // query does not define.
  it('still excludes an ordinary series that finished well before the window', async () => {
    const { db, env } = await guild();

    await seedEvent(db, { id: 'finished', organizerId: 'owner', startAt: null, endAt: null, isRecurring: 1 });
    await seedRule(db, 'finished', { startDate: '2026-07-01', endDate: '2026-08-01', byWeekday: '5' });

    const board = await buildNoticeboard(env, 'guild-1', WINDOW_FROM, WINDOW_TO);

    expect(
      board.some((o) => o.eventId === 'finished'),
      'the duration widening readmitted a series that ended six weeks before the window, which is the P17-07 defect returning',
    ).toBe(false);
  });
});
