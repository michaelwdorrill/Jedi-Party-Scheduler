import { afterEach, describe, expect, it } from 'vitest';
import { chunkIds, chunkRows, D1_MAX_BIND_PARAMS } from '../src/lib/d1';
import { loadMyRsvpForEvents, loadOverridesForEvents, loadPrimaryGroupForEvents } from '../src/lib/events';
import { expandPersonalOccurrences } from '../src/lib/personalEvents';
import { createEventWithInvites, updateEvent } from '../src/lib/eventWrites';
import { LIMITS } from '../src/lib/validate';
import { TooManyParametersError } from './d1shim';
import {
  DAY_MS,
  ids,
  loadEventRow,
  seedEvent,
  seedGuild,
  seedInvite,
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

// The harness itself has to be able to fail the way D1 fails, or none of the
// assertions below prove anything. This is that check.
describe('the test harness enforces D1 limits', () => {
  it('rejects a statement bound with more than 100 parameters', async () => {
    const { db } = setup();
    const tooMany = ids('x', D1_MAX_BIND_PARAMS + 1);
    expect(() =>
      db.prepare(`SELECT 1 WHERE 'a' IN (${tooMany.map(() => '?').join(',')})`).bind(...tooMany),
    ).toThrow(TooManyParametersError);
  });

  it('accepts exactly 100', async () => {
    const { db } = setup();
    const exact = ids('x', D1_MAX_BIND_PARAMS);
    expect(() =>
      db.prepare(`SELECT 1 WHERE 'a' IN (${exact.map(() => '?').join(',')})`).bind(...exact),
    ).not.toThrow();
  });
});

describe('chunkIds', () => {
  it('leaves room for the caller\'s fixed parameters', () => {
    for (const chunk of chunkIds(ids('x', 500), 20)) {
      expect(chunk.length + 20).toBeLessThanOrEqual(D1_MAX_BIND_PARAMS);
    }
  });

  it('returns no chunks for an empty list, so callers need no emptiness check', () => {
    expect(chunkIds([])).toEqual([]);
  });

  it('preserves every id exactly once', () => {
    const input = ids('x', 301);
    expect(chunkIds(input).flat()).toEqual(input);
  });
});

describe('chunkRows', () => {
  it('keeps multi-row inserts inside the parameter budget', () => {
    for (const chunk of chunkRows(ids('x', 300), 6)) {
      expect(chunk.length * 6).toBeLessThanOrEqual(D1_MAX_BIND_PARAMS);
    }
  });

  it('folds many rows into few statements', () => {
    // 300 invitees used to mean 300 statements in one batch.
    expect(chunkRows(ids('x', 300), 6).length).toBeLessThan(30);
  });
});

// R5 and R6 from the review reproductions: a member's calendar, and the whole
// recurring cron sweep, broke once the visible event count passed 100.
describe('calendar helpers at and beyond the parameter ceiling', () => {
  async function seedManyEvents(count: number) {
    const ctx = setup();
    await seedGuild(ctx.db);
    await seedUser(ctx.db, 'u1');
    await seedMembership(ctx.db, 'u1', 'guild-1');
    const eventIds = ids('e', count);
    for (const id of eventIds) {
      await seedEvent(ctx.db, { id, organizerId: 'u1' });
      await seedInvite(ctx.db, id, 'u1');
    }
    return { ...ctx, eventIds };
  }

  it.each([99, 100, 101, 300])('loadOverridesForEvents handles %i events', async (count) => {
    const { env, eventIds } = await seedManyEvents(count);
    await expect(loadOverridesForEvents(env, eventIds)).resolves.toBeInstanceOf(Map);
  });

  it.each([99, 100, 101, 300])('loadMyRsvpForEvents handles %i events', async (count) => {
    const { env, eventIds } = await seedManyEvents(count);
    const map = await loadMyRsvpForEvents(env, eventIds, 'u1');
    expect(map.size).toBe(count);
  });

  it.each([101, 300])('loadPrimaryGroupForEvents handles %i events', async (count) => {
    const { env, eventIds } = await seedManyEvents(count);
    await expect(loadPrimaryGroupForEvents(env, eventIds)).resolves.toBeInstanceOf(Map);
  });

  it('expands a full personal-event allowance without exceeding limits', async () => {
    const { db, env } = setup();
    await seedUser(db, 'u1');
    const now = Date.now();
    for (const id of ids('pe', 500)) {
      await db.prepare(
        `INSERT INTO personal_events (id, user_id, title, timezone, start_at, end_at, status, availability,
           is_recurring, created_at, updated_at)
         VALUES (?, ?, 'Busy', 'America/New_York', ?, ?, 'active', 'busy', 0, ?, ?)`,
      )
        .bind(id, 'u1', now + DAY_MS, now + DAY_MS + 3600_000, now, now)
        .run();
    }

    const occurrences = await expandPersonalOccurrences(env, 'u1', now, now + 2 * DAY_MS);
    expect(occurrences).toHaveLength(500);
  });
});

describe('invite writes at the configured maxima', () => {
  async function seedGuildWithMembers(count: number) {
    const ctx = setup();
    await seedGuild(ctx.db);
    await seedUser(ctx.db, 'organizer');
    await seedMembership(ctx.db, 'organizer', 'guild-1');
    const userIds = ids('u', count);
    for (const id of userIds) {
      await seedUser(ctx.db, id);
      await seedMembership(ctx.db, id, 'guild-1');
    }
    return { ...ctx, userIds };
  }

  const baseInput = {
    title: 'Game night',
    description: null,
    game: null,
    eventType: 'single' as const,
    timezone: 'America/New_York',
    isRecurring: false,
    startAt: Date.now() + DAY_MS,
    endAt: Date.now() + DAY_MS + 3600_000,
  };

  // Invites one short of the cap, because the organizer's own row (idea 26)
  // is the last one and the cap is on rows written, not on names submitted.
  // That is the correct reading of MAX_RESOLVED_INVITEES' own rationale -- a
  // guild's whole population is about 25, and the organizer is one of it, so
  // 25 *other* people implies a 26-person guild outside the supported profile.
  it('writes the full MAX_RESOLVED_INVITEES maximum, organizer included', async () => {
    const { db, env, userIds } = await seedGuildWithMembers(LIMITS.MAX_INVITEES - 1);
    fetchStub = stubFetch([]);

    const eventId = await createEventWithInvites(env, 'guild-1', 'organizer', {
      ...baseInput,
      invites: { userIds, groupIds: [] },
    });

    const row = await db.prepare(`SELECT COUNT(*) AS n FROM event_invites WHERE event_id = ?`)
      .bind(eventId)
      .first<{ n: number }>();
    expect(row?.n).toBe(LIMITS.MAX_RESOLVED_INVITEES);
  });

  it('counts the organizer against the resolved cap rather than silently exceeding it', async () => {
    const { env, userIds } = await seedGuildWithMembers(LIMITS.MAX_RESOLVED_INVITEES);
    fetchStub = stubFetch([]);

    await expect(
      createEventWithInvites(env, 'guild-1', 'organizer', {
        ...baseInput,
        invites: { userIds, groupIds: [] },
      }),
    ).rejects.toThrow(/too large/);
  });

  // The replacement path used to build `NOT IN (...every invitee...)`, which
  // at the configured maxima is several times the ceiling. It's now a
  // read-then-diff, so what gets chunked is the removal list. Reaching those
  // sizes means going through groups, which is also how a real organizer
  // would: nobody hand-picks two hundred people.
  it('replaces a full-group invite list without a NOT IN blowup', async () => {
    // One short of MAX_GROUP_MEMBERS so that each group plus the organizer's
    // own row lands exactly on MAX_RESOLVED_INVITEES rather than one over it.
    const groupSize = LIMITS.MAX_GROUP_MEMBERS - 1;
    const { db, env, userIds } = await seedGuildWithMembers(groupSize * 2);
    fetchStub = stubFetch([]);

    const now = Date.now();
    for (const [groupId, members] of [
      ['grp-a', userIds.slice(0, groupSize)],
      ['grp-b', userIds.slice(groupSize, groupSize * 2)],
    ] as const) {
      await db.prepare(
        `INSERT INTO groups (id, guild_id, name, idle_reminder_days, created_by, created_at) VALUES (?, ?, ?, 2, ?, ?)`,
      )
        .bind(groupId, 'guild-1', groupId, 'organizer', now)
        .run();
      for (const memberId of members) {
        await db.prepare(`INSERT INTO group_members (group_id, user_id, added_at) VALUES (?, ?, ?)`)
          .bind(groupId, memberId, now)
          .run();
      }
    }

    const eventId = await createEventWithInvites(env, 'guild-1', 'organizer', {
      ...baseInput,
      invites: { userIds: [], groupIds: ['grp-a'] },
    });
    expect(
      (await db.prepare(`SELECT COUNT(*) AS n FROM event_invites WHERE event_id = ?`).bind(eventId).first<{ n: number }>())?.n,
    ).toBe(groupSize + 1);

    await updateEvent(env, eventId, 'guild-1', { invites: { userIds: [], groupIds: ['grp-b'] } }, await loadEventRow(db, eventId));

    const remaining = await db.prepare(`SELECT user_id FROM event_invites WHERE event_id = ?`)
      .bind(eventId)
      .all<{ user_id: string }>();
    // True replacement: group A's members are gone, group B's are in -- and
    // the organizer survives it, which is the half idea 26 added. Without
    // that, saving an edit would delete their row and restore the 403.
    expect(remaining.results).toHaveLength(groupSize + 1);
    expect(remaining.results.some((r) => r.user_id === 'u-0')).toBe(false);
    expect(remaining.results.some((r) => r.user_id === `u-${groupSize + 5}`)).toBe(true);
    expect(remaining.results.some((r) => r.user_id === 'organizer')).toBe(true);
  });

  it('preserves an existing invitee\'s RSVP through a replacement', async () => {
    const { db, env, userIds } = await seedGuildWithMembers(5);
    fetchStub = stubFetch([]);

    const eventId = await createEventWithInvites(env, 'guild-1', 'organizer', {
      ...baseInput,
      invites: { userIds: userIds.slice(0, 3), groupIds: [] },
    });
    await db.prepare(`UPDATE event_invites SET rsvp_status = 'accepted' WHERE event_id = ? AND user_id = ?`)
      .bind(eventId, 'u-0')
      .run();

    await updateEvent(
      env,
      eventId,
      'guild-1',
      { invites: { userIds: ['u-0', 'u-3'], groupIds: [] } },
      await loadEventRow(db, eventId),
    );

    const kept = await db.prepare(`SELECT rsvp_status FROM event_invites WHERE event_id = ? AND user_id = ?`)
      .bind(eventId, 'u-0')
      .first<{ rsvp_status: string }>();
    expect(kept?.rsvp_status).toBe('accepted');
  });
});
