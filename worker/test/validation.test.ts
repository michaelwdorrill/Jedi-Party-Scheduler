import { afterEach, describe, expect, it } from 'vitest';
import { createEventWithInvites, type EventWriteInput } from '../src/lib/eventWrites';
import { assertRecurrenceInput, LIMITS, ValidationError } from '../src/lib/validate';
import { expandOccurrences } from '../src/lib/recurrence';
import {
  DAY_MS,
  ids,
  seedEvent,
  seedGuild,
  seedMembership,
  seedUser,
  setup,
  stubFetch,
  type FetchStub,
} from './helpers';

let fetchStub: FetchStub | null = null;
afterEach(() => {
  fetchStub?.restore();
  fetchStub = null;
});

async function seedOrganizer() {
  const ctx = setup();
  await seedGuild(ctx.db);
  await seedUser(ctx.db, 'organizer');
  await seedMembership(ctx.db, 'organizer', 'guild-1');
  fetchStub = stubFetch([]);
  return ctx;
}

const validSingle: EventWriteInput = {
  title: 'Game night',
  description: null,
  game: null,
  eventType: 'single',
  timezone: 'America/New_York',
  invites: { userIds: [], groupIds: [] },
  isRecurring: false,
  startAt: Date.now() + DAY_MS,
  endAt: Date.now() + DAY_MS + 3600_000,
};

function create(env: Parameters<typeof createEventWithInvites>[0], input: Partial<EventWriteInput>) {
  return createEventWithInvites(env, 'guild-1', 'organizer', { ...validSingle, ...input } as EventWriteInput);
}

describe('event create validation', () => {
  it('accepts a well-formed single event', async () => {
    const { env } = await seedOrganizer();
    await expect(create(env, {})).resolves.toBeTypeOf('string');
  });

  // Typed as boolean, previously never checked -- and it decides whether
  // start_at/end_at or a recurrence rule get written.
  it.each([['yes'], [1], [{}], [null]])('rejects a non-boolean isRecurring (%s)', async (value) => {
    const { env } = await seedOrganizer();
    await expect(create(env, { isRecurring: value as never })).rejects.toBeInstanceOf(ValidationError);
  });

  it('rejects a non-recurring event with no times', async () => {
    const { env } = await seedOrganizer();
    await expect(create(env, { startAt: undefined, endAt: undefined })).rejects.toBeInstanceOf(ValidationError);
  });

  it('rejects a recurring event with no recurrence rule', async () => {
    const { env } = await seedOrganizer();
    await expect(
      create(env, { isRecurring: true, recurrence: undefined, startAt: undefined, endAt: undefined }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('rejects an end time before the start time', async () => {
    const { env } = await seedOrganizer();
    await expect(create(env, { endAt: validSingle.startAt! - 1000 })).rejects.toBeInstanceOf(ValidationError);
  });

  it('rejects an implausibly long event', async () => {
    const { env } = await seedOrganizer();
    await expect(
      create(env, { endAt: validSingle.startAt! + LIMITS.MAX_EVENT_DURATION_MS + 1 }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('rejects an invalid timezone', async () => {
    const { env } = await seedOrganizer();
    await expect(create(env, { timezone: 'Mars/Olympus_Mons' })).rejects.toBeInstanceOf(ValidationError);
  });

  it('rejects an over-long title', async () => {
    const { env } = await seedOrganizer();
    await expect(create(env, { title: 'x'.repeat(LIMITS.TITLE + 1) })).rejects.toBeInstanceOf(ValidationError);
  });

  it('rejects an unknown eventType', async () => {
    const { env } = await seedOrganizer();
    await expect(create(env, { eventType: 'sneaky' as never })).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('poll shape validation', () => {
  const poll: Partial<EventWriteInput> = {
    eventType: 'poll',
    isRecurring: undefined,
    startAt: undefined,
    endAt: undefined,
    pollDeadlineAt: Date.now() + DAY_MS,
    pollStrategy: 'most_votes',
    pollOptions: [{ startAt: Date.now() + 2 * DAY_MS, endAt: Date.now() + 2 * DAY_MS + 3600_000 }],
  };

  it('accepts a well-formed options poll', async () => {
    const { env } = await seedOrganizer();
    await expect(create(env, poll)).resolves.toBeTypeOf('string');
  });

  // A poll with no deadline is never resolved and never cleaned up -- the
  // deadline sweep just re-examines it on every tick, forever.
  it('rejects a poll with no deadline', async () => {
    const { env } = await seedOrganizer();
    await expect(create(env, { ...poll, pollDeadlineAt: undefined })).rejects.toBeInstanceOf(ValidationError);
  });

  it('rejects a poll with no options', async () => {
    const { env } = await seedOrganizer();
    await expect(create(env, { ...poll, pollOptions: [] })).rejects.toBeInstanceOf(ValidationError);
  });

  it('rejects a threshold poll with no threshold', async () => {
    const { env } = await seedOrganizer();
    await expect(
      create(env, { ...poll, pollStrategy: 'threshold', pollThresholdCount: undefined }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  // A threshold of zero resolves the poll the instant it exists; one larger
  // than any possible invite list can never be reached.
  it.each([0, -1, LIMITS.MAX_RESOLVED_INVITEES + 1])(
    'rejects a meaningless threshold of %i',
    async (threshold) => {
      const { env } = await seedOrganizer();
      await expect(
        create(env, { ...poll, pollStrategy: 'threshold', pollThresholdCount: threshold }),
      ).rejects.toBeInstanceOf(ValidationError);
    },
  );

  it('rejects a window poll missing its window bounds', async () => {
    const { env } = await seedOrganizer();
    await expect(
      create(env, { ...poll, pollMode: 'window', pollOptions: undefined, windowStartAt: undefined }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('rejects a window longer than the configured span', async () => {
    const { env } = await seedOrganizer();
    const start = Date.now();
    await expect(
      create(env, {
        ...poll,
        pollMode: 'window',
        pollOptions: undefined,
        windowStartAt: start,
        windowEndAt: start + LIMITS.MAX_WINDOW_SPAN_MS + DAY_MS,
        windowBlockMinutes: 60,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('rejects more poll options than the configured maximum', async () => {
    const { env } = await seedOrganizer();
    const many = Array.from({ length: LIMITS.MAX_POLL_OPTIONS + 1 }, (_, i) => ({
      startAt: Date.now() + (i + 2) * DAY_MS,
      endAt: Date.now() + (i + 2) * DAY_MS + 3600_000,
    }));
    await expect(create(env, { ...poll, pollOptions: many })).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('recurrence validation', () => {
  const base = {
    freq: 'WEEKLY' as const,
    interval: 1,
    byWeekday: [1, 3],
    byMonthDay: null,
    startDate: '2026-01-05',
    startTime: '19:00',
    durationMinutes: 120,
    endType: 'never' as const,
    endDate: null,
    endCount: null,
  };

  it('normalises byWeekday: dedupes, sorts, and keeps it inside 0-6', () => {
    const out = assertRecurrenceInput({ ...base, byWeekday: [3, 1, 3, 1, 5] });
    expect(out.byWeekday).toEqual([1, 3, 5]);
  });

  // The CPU-amplification path: thousands of duplicate weekdays multiply the
  // expander's inner loop by that count.
  it('rejects more than seven unique weekdays', () => {
    expect(() => assertRecurrenceInput({ ...base, byWeekday: [0, 1, 2, 3, 4, 5, 6, 7] })).toThrow(ValidationError);
  });

  it.each([[-1], [7], [1.5], ['1']])('rejects an out-of-domain weekday (%s)', (day) => {
    expect(() => assertRecurrenceInput({ ...base, byWeekday: [day] })).toThrow(ValidationError);
  });

  it.each([['2026-13-01'], ['2026-02-30'], ['not-a-date'], ['2026-1-5']])(
    'rejects an invalid start date (%s)',
    (startDate) => {
      expect(() => assertRecurrenceInput({ ...base, startDate })).toThrow(ValidationError);
    },
  );

  it.each([['25:00'], ['19:60'], ['7pm'], ['19:00:00']])('rejects an invalid start time (%s)', (startTime) => {
    expect(() => assertRecurrenceInput({ ...base, startTime })).toThrow(ValidationError);
  });

  it('rejects an out-of-range interval', () => {
    expect(() => assertRecurrenceInput({ ...base, interval: LIMITS.MAX_RECURRENCE_INTERVAL + 1 })).toThrow(ValidationError);
    expect(() => assertRecurrenceInput({ ...base, interval: 0 })).toThrow(ValidationError);
  });

  it('rejects an out-of-range occurrence count', () => {
    expect(() =>
      assertRecurrenceInput({ ...base, endType: 'after_count', endCount: LIMITS.MAX_RECURRENCE_COUNT + 1 }),
    ).toThrow(ValidationError);
  });

  it('rejects byWeekday on a non-weekly rule', () => {
    expect(() => assertRecurrenceInput({ ...base, freq: 'MONTHLY', byWeekday: [1] })).toThrow(ValidationError);
  });

  // Defence in depth: even a row that predates validation must not be able to
  // make the expander do unbounded work.
  it('caps the expander even when the stored rule has duplicate weekdays', () => {
    const from = Date.parse('2026-01-01T00:00:00Z');
    const occurrences = expandOccurrences(
      {
        freq: 'WEEKLY',
        interval: 1,
        byWeekday: new Array(500).fill('1').join(','),
        byMonthDay: null,
        startDate: '2026-01-05',
        startTime: '19:00',
        durationMinutes: 60,
        endType: 'never',
        endDate: null,
        endCount: null,
      },
      'UTC',
      from,
      from + 30 * DAY_MS,
      [],
    );
    // One Monday a week for a month, not 500 duplicates of each.
    expect(occurrences.length).toBeLessThanOrEqual(6);
  });
});

describe('aggregate quotas', () => {
  it('refuses a new event once the guild is full', async () => {
    const { db, env } = await seedOrganizer();
    for (const id of ids('e', LIMITS.MAX_ACTIVE_EVENTS_PER_GUILD)) {
      await seedEvent(db, { id, organizerId: 'organizer' });
    }
    await expect(create(env, {})).rejects.toBeInstanceOf(ValidationError);
  });

  it('refuses a new event once one organizer is at their own limit', async () => {
    const { db, env } = await seedOrganizer();
    for (const id of ids('e', LIMITS.MAX_EVENTS_PER_ORGANIZER_PER_GUILD)) {
      await seedEvent(db, { id, organizerId: 'organizer' });
    }
    await expect(create(env, {})).rejects.toBeInstanceOf(ValidationError);
  });

  it('does not count cancelled events against the quota', async () => {
    const { db, env } = await seedOrganizer();
    for (const id of ids('e', LIMITS.MAX_EVENTS_PER_ORGANIZER_PER_GUILD)) {
      await seedEvent(db, { id, organizerId: 'organizer', status: 'cancelled' });
    }
    await expect(create(env, {})).resolves.toBeTypeOf('string');
  });

  it('caps recurring events separately, since every one is expanded on every calendar load', async () => {
    const { db, env } = await seedOrganizer();
    for (const id of ids('r', LIMITS.MAX_RECURRING_EVENTS_PER_GUILD)) {
      await seedEvent(db, { id, organizerId: 'organizer', isRecurring: 1 });
    }

    // A one-off still goes through...
    await expect(create(env, {})).resolves.toBeTypeOf('string');
    // ...but another recurring one does not.
    await expect(
      create(env, {
        isRecurring: true,
        startAt: undefined,
        endAt: undefined,
        recurrence: {
          freq: 'WEEKLY',
          interval: 1,
          byWeekday: [1],
          byMonthDay: null,
          startDate: '2026-01-05',
          startTime: '19:00',
          durationMinutes: 60,
          endType: 'never',
          endDate: null,
          endCount: null,
        },
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});
