import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import { buildMonthGrid, isValidRange } from '../src/lib/datetime';

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
