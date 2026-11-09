import { describe, expect, it } from 'vitest';
import { DateTime } from 'luxon';
import { dayRange } from '../src/lib/calendarDays';
import { pollRowVotingClosed } from '../src/lib/pollRow';
import { autoCancelLine, calledOffLine, people, peopleCan, peopleSay, unlessLeavesFewer } from '../src/lib/plural';

// Found on the 10 November 2026 walkthrough and taken into 1.0 by Michael.

const ZONE = 'America/New_York';
const at = (iso: string) => DateTime.fromISO(iso, { zone: ZONE }).toMillis();
const days = (r: { first: DateTime; last: DateTime }) => [r.first.toISODate(), r.last.toISODate()];

describe('which days an event is drawn on (R94: a midnight end showed on the next day)', () => {
  it('keeps a session ending at exactly midnight on its own day', () => {
    expect(days(dayRange(at('2026-11-15T20:00'), at('2026-11-16T00:00'), ZONE))).toEqual(['2026-11-15', '2026-11-15']);
  });
  it('still spans two days when it runs past midnight', () => {
    expect(days(dayRange(at('2026-11-15T21:30'), at('2026-11-16T01:30'), ZONE))).toEqual(['2026-11-15', '2026-11-16']);
  });
  it('ends a multi-day block on the last day it occupies', () => {
    expect(days(dayRange(at('2026-11-20T00:00'), at('2026-11-22T00:00'), ZONE))).toEqual(['2026-11-20', '2026-11-21']);
  });
  it('puts a zero-length or open-ended item on its start day', () => {
    expect(days(dayRange(at('2026-11-15T20:00'), at('2026-11-15T20:00'), ZONE))).toEqual(['2026-11-15', '2026-11-15']);
    expect(days(dayRange(at('2026-11-15T20:00'), null, ZONE))).toEqual(['2026-11-15', '2026-11-15']);
  });
});

describe("a poll row's voting buttons (P24-04: a cancelled poll still offered them)", () => {
  const unconfirmed = { confirmedAt: null, sessionEventId: null };
  const ownEvent = { confirmedAt: 1, sessionEventId: 'day-1' };
  it('closes a day that never became its own event once the poll is not active', () => {
    expect(pollRowVotingClosed(unconfirmed, 'cancelled', false)).toBe(true);
    expect(pollRowVotingClosed({ confirmedAt: 1, sessionEventId: null }, 'cancelled', false)).toBe(true);
  });
  it('keeps a day that is its own event answerable, since that answers the event', () => {
    expect(pollRowVotingClosed(ownEvent, 'cancelled', true)).toBe(false);
  });
  // INVARIANT GUARD: the rule that was already there.
  it('still closes an unconfirmed day after the deadline, and leaves an open one open', () => {
    expect(pollRowVotingClosed(unconfirmed, 'active', true)).toBe(true);
    expect(pollRowVotingClosed(unconfirmed, 'active', false)).toBe(false);
  });
});

describe("'1 people' (IDEAS 100)", () => {
  it('counts', () => {
    expect(people(1)).toBe('1 person');
    expect(people(2)).toBe('2 people');
    expect(peopleSay(1)).toBe('1 person says');
    expect(peopleSay(3)).toBe('3 people say');
    expect(peopleCan(1)).toBe('1 person can');
    expect(peopleCan(2)).toBe('2 people can');
  });
  it('says "nobody" rather than "fewer than 1"', () => {
    expect(autoCancelLine(1)).toBe('Called off automatically if nobody is in.');
    expect(autoCancelLine(2)).toBe('Called off automatically if fewer than 2 people are in.');
    expect(calledOffLine(1)).toBe('Nobody was still in, so this day was called off.');
    expect(calledOffLine(3)).toBe('Fewer than 3 people were still in, so this day was called off.');
    expect(calledOffLine(null)).toBe('Too few people were still in, so this day was called off.');
    expect(unlessLeavesFewer(1)).toBe('if that leaves nobody in');
    expect(unlessLeavesFewer(2)).toBe('if that leaves fewer than 2 in');
  });
});
