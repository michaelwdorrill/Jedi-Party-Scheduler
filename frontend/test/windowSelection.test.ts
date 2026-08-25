import { describe, expect, it } from 'vitest';
import { moveWindowEnd, moveWindowStart } from '../src/lib/windowSelection';

// A 12-hour window, 2.5-hour minimum, all in minutes from the window's start.
const TOTAL = 12 * 60;
const BLOCK = 150;

describe('moveWindowStart', () => {
  it('pushes the end along instead of refusing to move', () => {
    // Michael's case verbatim: start 6:00, end 8:30 (a 2.5-hour selection
    // with no slack), drag the start to 6:30. The old version clamped and
    // the handle stopped dead; now the end follows to 9:00.
    const six = 0;
    const eightThirty = 150;
    expect(moveWindowStart(30, { startMin: six, endMin: eightThirty }, TOTAL, BLOCK)).toEqual({
      startMin: 30,
      endMin: 180,
    });
  });

  it('leaves an end that already has slack where it is', () => {
    // 6:00-10:00 is 4 hours, so moving the start to 6:30 still clears the
    // minimum with an hour to spare -- nothing to push.
    expect(moveWindowStart(30, { startMin: 0, endMin: 240 }, TOTAL, BLOCK)).toEqual({
      startMin: 30,
      endMin: 240,
    });
  });

  it('stops once the pushed end reaches the end of the window', () => {
    // The one case where the dragged handle still stops: the selection has
    // genuinely run out of window, rather than stopping halfway through it.
    const result = moveWindowStart(TOTAL, { startMin: 0, endMin: 150 }, TOTAL, BLOCK);
    expect(result).toEqual({ startMin: TOTAL - BLOCK, endMin: TOTAL });
  });

  it('never goes past the start of the window', () => {
    expect(moveWindowStart(-90, { startMin: 60, endMin: 300 }, TOTAL, BLOCK)).toEqual({
      startMin: 0,
      endMin: 300,
    });
  });
});

describe('moveWindowEnd', () => {
  it('pulls the start along, the same way round', () => {
    // The end handle had exactly the same dead zone, and a rule that applies
    // to one handle and not the other is harder to learn than either.
    expect(moveWindowEnd(180, { startMin: 60, endMin: 300 }, TOTAL, BLOCK)).toEqual({
      startMin: 30,
      endMin: 180,
    });
  });

  it('leaves a start that already has slack where it is', () => {
    expect(moveWindowEnd(240, { startMin: 0, endMin: 300 }, TOTAL, BLOCK)).toEqual({
      startMin: 0,
      endMin: 240,
    });
  });

  it('stops once the pulled start reaches the start of the window', () => {
    expect(moveWindowEnd(0, { startMin: 60, endMin: 300 }, TOTAL, BLOCK)).toEqual({
      startMin: 0,
      endMin: BLOCK,
    });
  });

  it('never goes past the end of the window', () => {
    expect(moveWindowEnd(TOTAL + 120, { startMin: 60, endMin: 300 }, TOTAL, BLOCK)).toEqual({
      startMin: 60,
      endMin: TOTAL,
    });
  });
});

describe('both handles, on a window barely longer than the minimum', () => {
  // A 3-hour window with a 2.5-hour minimum: 30 minutes of slack in total,
  // which is where an off-by-one in the push would show up first.
  const tight = 180;
  it('keeps every result inside the window and at least the minimum long', () => {
    for (let next = -60; next <= tight + 60; next += 15) {
      for (const current of [
        { startMin: 0, endMin: 150 },
        { startMin: 30, endMin: 180 },
        { startMin: 15, endMin: 165 },
      ]) {
        for (const result of [
          moveWindowStart(next, current, tight, BLOCK),
          moveWindowEnd(next, current, tight, BLOCK),
        ]) {
          expect(result.startMin).toBeGreaterThanOrEqual(0);
          expect(result.endMin).toBeLessThanOrEqual(tight);
          expect(result.endMin - result.startMin).toBeGreaterThanOrEqual(BLOCK);
        }
      }
    }
  });
});
