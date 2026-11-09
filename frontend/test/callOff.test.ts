import { describe, expect, it } from 'vitest';
import { cancelEventMessage, rsvpCallsOffEvent, voteCallsOffDay } from '../src/lib/callOff';
import type { EventDetail, EventInvite, PollOption } from '../src/types';

// IDEAS 97: which presses call a day off for everyone, so the page can say so
// before it happens. These must agree with the server's cascade (recordRsvp),
// which counts accepted invitees plus the organizer unless they declined, and
// runs on a decline only.

const person = (userId: string) => ({ userId, username: userId, globalName: null });

function day(overrides: Partial<PollOption> = {}): PollOption {
  return {
    id: 'opt',
    startAt: 0,
    endAt: 1,
    displayOrder: 0,
    confirmedAt: 1,
    confirmedUsers: [person('me'), person('alt')],
    voters: [],
    tally: { yes: 2, no: 0, maybe: 0 },
    myVote: 'yes',
    sessionEventId: 'day-event',
    sessionStatus: 'active',
    ...overrides,
  };
}

function invite(userId: string, rsvpStatus: EventInvite['rsvpStatus']): EventInvite {
  return { userId, username: userId, globalName: null, invitedVia: 'individual', sourceGroupId: null, rsvpStatus };
}

function dayEvent(invites: EventInvite[], overrides: Partial<EventDetail> = {}): EventDetail {
  return {
    eventType: 'single',
    status: 'active',
    isRecurring: false,
    organizerId: 'org',
    minimumAttendees: 2,
    autoCancelBelowMinimum: true,
    minimumAttendeesDeadlineAt: null,
    minimumAttendeesDeadlineHoursBefore: null,
    invites,
    ...overrides,
  } as EventDetail;
}

describe('voteCallsOffDay', () => {
  it("is true for the Can't make it that takes a day below its threshold", () => {
    expect(voteCallsOffDay(day(), 2, 'no')).toBe(true);
  });

  it('is false while the day would still be at its threshold', () => {
    expect(voteCallsOffDay(day({ confirmedUsers: [person('me'), person('a'), person('b')] }), 2, 'no')).toBe(false);
  });

  it('is false for a maybe, which takes you out of the count but decides nothing', () => {
    expect(voteCallsOffDay(day(), 2, 'maybe')).toBe(false);
  });

  it('is false for someone who was not counted in the first place', () => {
    expect(voteCallsOffDay(day({ myVote: 'maybe' }), 2, 'no')).toBe(false);
  });

  it('is false before the day has its own event -- nobody has been told, and it can confirm again', () => {
    expect(voteCallsOffDay(day({ sessionEventId: null, sessionStatus: null }), 2, 'no')).toBe(false);
  });
});

describe('rsvpCallsOffEvent', () => {
  it('counts the organizer unless they declined, as the server does', () => {
    // Organizer implicitly in, plus one accepted invitee: two, at a minimum
    // of two. Either of them declining calls it off.
    const event = dayEvent([invite('org', null), invite('alt', 'accepted')]);
    expect(rsvpCallsOffEvent(event, 'alt', 'declined')).toBe(true);
    expect(rsvpCallsOffEvent(event, 'org', 'declined')).toBe(true);
  });

  it('is false with someone to spare, and false for an answer that is not a decline', () => {
    const event = dayEvent([invite('org', null), invite('alt', 'accepted'), invite('third', 'accepted')]);
    expect(rsvpCallsOffEvent(event, 'alt', 'declined')).toBe(false);
    expect(rsvpCallsOffEvent(dayEvent([invite('org', null), invite('alt', 'accepted')]), 'alt', 'tentative')).toBe(false);
  });

  it('is false where the server would not cancel: auto-cancel off, or a deadline set', () => {
    const invites = [invite('org', null), invite('alt', 'accepted')];
    expect(rsvpCallsOffEvent(dayEvent(invites, { autoCancelBelowMinimum: false }), 'alt', 'declined')).toBe(false);
    expect(rsvpCallsOffEvent(dayEvent(invites, { minimumAttendeesDeadlineAt: 5 }), 'alt', 'declined')).toBe(false);
  });
});

describe('cancelEventMessage (IDEAS 99)', () => {
  const NY = 'America/New_York';
  const poll = (options: PollOption[]) =>
    ({ eventType: 'poll', pollResolutionMode: 'multi_winner', pollOptions: options }) as unknown as EventDetail;
  // Tue 10 Nov 2026, 7pm New York.
  const tue = Date.UTC(2026, 10, 11, 0, 0);

  it('names the days that stay on when a multi-winner poll is cancelled', () => {
    const msg = cancelEventMessage(poll([day({ startAt: tue })]), NY);
    expect(msg).toContain('The day already confirmed as its own event (Tue 10 Nov) will still happen');
    expect(msg).toContain('cancel it from its own page');
  });

  it('leaves out a day that is confirmed but not yet its own event, and one already called off', () => {
    const notYet = day({ startAt: tue, sessionEventId: null, sessionStatus: null });
    const calledOff = day({ startAt: tue, sessionStatus: 'cancelled' });
    expect(cancelEventMessage(poll([notYet, calledOff]), NY)).toBe('Cancel this event for everyone?');
  });

  it('keeps the plain question for every other kind of event', () => {
    expect(cancelEventMessage({ eventType: 'single', pollOptions: null } as unknown as EventDetail, NY)).toBe(
      'Cancel this event for everyone?',
    );
  });
});
