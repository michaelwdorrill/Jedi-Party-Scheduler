import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import {
  endFollowingStart,
  seedTimeRangeDraft,
  timeRangeDraftComplete,
  timeRangeDraftOrdered,
  timeRangeDraftToMillis,
} from '../src/lib/timeRange';

// The conversion both "propose a new time" forms share (IDEAS 94). The case
// that matters is the timezone: a typed 9pm means 9pm in the EVENT's zone, not
// the browser's, or an organizer abroad moves a session by their own offset.
const NY = 'America/New_York';

describe('timeRange', () => {
  it('seeds from the session it is moving, in the event zone', () => {
    const startAt = DateTime.fromISO('2030-01-14T19:00', { zone: NY }).toMillis();
    const endAt = DateTime.fromISO('2030-01-14T21:00', { zone: NY }).toMillis();
    expect(seedTimeRangeDraft(startAt, endAt, NY)).toEqual({
      date: '2030-01-14',
      startTime: '19:00',
      endDate: '2030-01-14',
      endTime: '21:00',
    });
  });

  it('keeps the original fallbacks: now when there is no start, an hour later when there is no end', () => {
    const now = DateTime.fromISO('2030-03-02T10:15', { zone: NY }).toMillis();
    expect(seedTimeRangeDraft(null, null, NY, now)).toEqual({
      date: '2030-03-02',
      startTime: '10:15',
      endDate: '2030-03-02',
      endTime: '11:15',
    });
  });

  it('round-trips a seeded draft back to the same instants', () => {
    const startAt = DateTime.fromISO('2030-01-14T23:30', { zone: NY }).toMillis();
    const endAt = DateTime.fromISO('2030-01-15T01:30', { zone: NY }).toMillis();
    expect(timeRangeDraftToMillis(seedTimeRangeDraft(startAt, endAt, NY), NY)).toEqual({ startAt, endAt });
  });

  it('reads typed times in the event zone, whatever zone the browser is in', () => {
    const typed = { date: '2030-01-15', startTime: '21:00', endDate: '2030-01-15', endTime: '23:00' };
    expect(timeRangeDraftToMillis(typed, NY).startAt).toBe(Date.UTC(2030, 0, 16, 2, 0));
    expect(timeRangeDraftToMillis(typed, 'Europe/London').startAt).toBe(Date.UTC(2030, 0, 15, 21, 0));
  });

  it('tells a backwards range from an incomplete one', () => {
    const backwards = { date: '2030-01-15', startTime: '21:00', endDate: '2030-01-15', endTime: '20:00' };
    const halfTyped = { date: '2030-01-15', startTime: '', endDate: '2030-01-15', endTime: '20:00' };
    expect(timeRangeDraftOrdered(backwards, NY)).toBe(false);
    expect(timeRangeDraftComplete(backwards, NY)).toBe(true);
    // isValidRange leaves incomplete input alone by design, so "ordered" alone
    // would let a half-typed time through; "complete" is what catches it.
    expect(timeRangeDraftOrdered(halfTyped, NY)).toBe(true);
    expect(timeRangeDraftComplete(halfTyped, NY)).toBe(false);
  });
});

describe('endFollowingStart', () => {
  const evening = { date: '2030-01-14', startTime: '19:00', endDate: '2030-01-14', endTime: '23:00' };

  it('moves the end by the same amount when the start DATE changes', () => {
    expect(endFollowingStart(evening, { date: '2030-01-16', startTime: '19:00' }, NY)).toEqual({
      endDate: '2030-01-16',
      endTime: '23:00',
    });
  });

  it('moves the end by the same amount when the start TIME changes, across midnight if it must', () => {
    expect(endFollowingStart(evening, { date: '2030-01-14', startTime: '21:30' }, NY)).toEqual({
      endDate: '2030-01-15',
      endTime: '01:30',
    });
  });

  it('keeps a multi-day length', () => {
    const weekend = { date: '2030-01-18', startTime: '18:00', endDate: '2030-01-20', endTime: '12:00' };
    expect(endFollowingStart(weekend, { date: '2030-01-25', startTime: '18:00' }, NY)).toEqual({
      endDate: '2030-01-27',
      endTime: '12:00',
    });
  });

  it('keeps elapsed time across a DST change, as a calendar does', () => {
    // US clocks go forward at 2am on 10 March 2030. A 4-hour session moved
    // onto the night it happens still lasts 4 hours: 10pm to 3am, not 2am.
    const fourHours = { date: '2030-03-02', startTime: '22:00', endDate: '2030-03-03', endTime: '02:00' };
    expect(endFollowingStart(fourHours, { date: '2030-03-09', startTime: '22:00' }, NY)).toEqual({
      endDate: '2030-03-10',
      endTime: '03:00',
    });
  });

  it('leaves a half-typed end alone, apart from the old date nudge', () => {
    const noEndTime = { date: '2030-01-14', startTime: '19:00', endDate: '2030-01-14', endTime: '' };
    expect(endFollowingStart(noEndTime, { date: '2030-01-14', startTime: '20:00' }, NY)).toEqual({
      endDate: '2030-01-14',
      endTime: '',
    });
    expect(endFollowingStart(noEndTime, { date: '2030-01-16', startTime: '19:00' }, NY).endDate).toBe('2030-01-16');
  });

  it('does not invent a length for a backwards range', () => {
    const backwards = { date: '2030-01-14', startTime: '21:00', endDate: '2030-01-14', endTime: '20:00' };
    expect(endFollowingStart(backwards, { date: '2030-01-14', startTime: '22:00' }, NY)).toEqual({
      endDate: '2030-01-14',
      endTime: '20:00',
    });
  });
});
