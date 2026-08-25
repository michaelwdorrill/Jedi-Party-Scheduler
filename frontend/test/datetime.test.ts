import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import { buildMonthGrid, formatDuration, hasEnded, isValidRange, startsInPast } from '../src/lib/datetime';

describe('buildMonthGrid', () => {
  it('starts on a Sunday and ends on a Saturday for a month starting on a Sunday', () => {
    // June 2025: the 1st is a Sunday.
    const days = buildMonthGrid(DateTime.fromISO('2025-06-15'));
    expect(days[0].weekday % 7).toBe(0);
    expect(days[days.length - 1].weekday % 7).toBe(6);
    expect(days.length % 7).toBe(0);
  });

  it('starts on a Sunday and ends on a Saturday for a month starting on a Monday', () => {
    // September 2025: the 1st is a Monday.
    const days = buildMonthGrid(DateTime.fromISO('2025-09-10'));
    expect(days[0].weekday % 7).toBe(0);
    expect(days[days.length - 1].weekday % 7).toBe(6);
    expect(days.length % 7).toBe(0);
  });

  it('starts on a Sunday and ends on a Saturday for a month ending on a Saturday', () => {
    // May 2025: the 31st is a Saturday.
    const days = buildMonthGrid(DateTime.fromISO('2025-05-15'));
    expect(days[0].weekday % 7).toBe(0);
    expect(days[days.length - 1].weekday % 7).toBe(6);
    expect(days.length % 7).toBe(0);
  });

  it('includes every day of the month itself', () => {
    const monthStart = DateTime.fromISO('2025-09-10');
    const days = buildMonthGrid(monthStart);
    const inMonth = days.filter((d) => d.hasSame(monthStart, 'month'));
    expect(inMonth).toHaveLength(30);
  });
});

describe('isValidRange', () => {
  const zone = 'America/New_York';

  it('rejects an end time before the start time on the same day', () => {
    expect(isValidRange('2025-06-10', '17:00', '2025-06-10', '13:00', zone)).toBe(false);
  });

  it('rejects equal instants', () => {
    expect(isValidRange('2025-06-10', '13:00', '2025-06-10', '13:00', zone)).toBe(false);
  });

  it('accepts an overnight range ending after midnight the next day', () => {
    expect(isValidRange('2025-06-10', '19:30', '2025-06-11', '01:00', zone)).toBe(true);
  });

  it('accepts a range spanning the spring-forward DST boundary', () => {
    // Clocks in America/New_York jump from 2:00 AM to 3:00 AM on 2025-03-09.
    expect(isValidRange('2025-03-08', '22:00', '2025-03-09', '01:00', zone)).toBe(true);
  });

  it('does not throw on incomplete input', () => {
    expect(isValidRange('', '', '', '', zone)).toBe(true);
  });
});

// Idea 27. The distinction that matters is *ended* vs *started*: a session
// running right now is the most current thing on the calendar, and fading it
// would say the opposite.
describe('hasEnded', () => {
  const now = DateTime.fromISO('2026-08-24T20:00:00Z').toMillis();
  const hour = 60 * 60 * 1000;

  it('is true once the end has gone by', () => {
    expect(hasEnded({ startAt: now - 3 * hour, endAt: now - hour }, now)).toBe(true);
  });

  it('is false for an event that has started but not finished', () => {
    expect(hasEnded({ startAt: now - hour, endAt: now + hour }, now)).toBe(false);
  });

  it('is false for an event still to come', () => {
    expect(hasEnded({ startAt: now + hour, endAt: now + 2 * hour }, now)).toBe(false);
  });

  it('falls back to the start when there is no end', () => {
    expect(hasEnded({ startAt: now - hour, endAt: null }, now)).toBe(true);
    expect(hasEnded({ startAt: now + hour, endAt: null }, now)).toBe(false);
  });

  // An unresolved poll has neither, and is emphatically not over.
  it('is false when there is no time at all', () => {
    expect(hasEnded({ startAt: null, endAt: null }, now)).toBe(false);
  });
});

// Idea 28. This drives a warning, never a block -- see the note on the
// function -- so the only thing worth pinning down is that it reads the
// organiser's own zone rather than the browser's.
describe('startsInPast', () => {
  const now = DateTime.fromISO('2026-08-24T20:00:00Z').toMillis();

  it('is true for a start already behind us', () => {
    expect(startsInPast('2026-08-24', '15:00', 'UTC', now)).toBe(true);
  });

  it('is false for a start still ahead', () => {
    expect(startsInPast('2026-08-24', '21:00', 'UTC', now)).toBe(false);
  });

  // The same wall-clock time is past in one zone and future in another, which
  // is the whole reason this is a warning and not a block: "8pm tonight" has
  // already gone in London at 20:00 UTC and is still four hours off in New
  // York, so a hard stop would reject one organiser's perfectly ordinary entry.
  it('judges the wall-clock time in the given zone, not UTC', () => {
    expect(startsInPast('2026-08-24', '20:00', 'Europe/London', now)).toBe(true); // 19:00Z
    expect(startsInPast('2026-08-24', '20:00', 'America/New_York', now)).toBe(false); // 00:00Z next day
  });

  it('stays quiet on incomplete input rather than warning about a half-typed date', () => {
    expect(startsInPast('', '19:00', 'UTC', now)).toBe(false);
    expect(startsInPast('2026-08-24', '', 'UTC', now)).toBe(false);
  });
});

// specs/0013's minimum session length, which the API carries in minutes.
// "150 minutes" is not how anyone describes an evening.
describe('formatDuration', () => {
  it('says hours once there are any', () => {
    expect(formatDuration(150)).toBe('2.5 hours');
    expect(formatDuration(180)).toBe('3 hours');
  });

  it('says minutes below an hour', () => {
    expect(formatDuration(30)).toBe('30 minutes');
    expect(formatDuration(45)).toBe('45 minutes');
  });

  it('is singular at exactly one hour', () => {
    expect(formatDuration(60)).toBe('1 hour');
  });
});
