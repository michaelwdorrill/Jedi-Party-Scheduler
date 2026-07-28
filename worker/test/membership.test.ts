import { afterEach, describe, expect, it } from 'vitest';
import {
  checkGuildAccess,
  filterActiveGuildMembers,
  isGuildMember,
  MembershipUnavailableError,
  MEMBERSHIP_FRESHNESS_MS,
  MEMBERSHIP_GRACE_MS,
  revalidateStaleMemberships,
  syncGuildMembership,
} from '../src/lib/db';
import {
  DAY_MS,
  HOUR_MS,
  ids,
  membershipRule,
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

async function membershipRow(db: Awaited<ReturnType<typeof setup>>['db'], userId: string, guildId: string) {
  return db
    .prepare(`SELECT is_member, verified_at FROM user_guild_membership WHERE user_id = ? AND guild_id = ?`)
    .bind(userId, guildId)
    .first<{ is_member: number; verified_at: number }>();
}

describe('checkGuildAccess', () => {
  it('trusts a fresh cache without calling Discord at all', async () => {
    const { db, env } = setup();
    await seedGuild(db);
    await seedUser(db, 'u1');
    await seedMembership(db, 'u1', 'guild-1', { verifiedAgoMs: MEMBERSHIP_FRESHNESS_MS / 2 });
    fetchStub = stubFetch([]); // any Discord call would throw "Unstubbed fetch"

    expect(await checkGuildAccess(env, 'u1', 'guild-1')).toBe('member');
    expect(fetchStub.calls).toHaveLength(0);
  });

  it('denies a deactivated guild without calling Discord', async () => {
    const { db, env } = setup();
    await seedGuild(db, 'guild-1', 0);
    await seedUser(db, 'u1');
    await seedMembership(db, 'u1', 'guild-1', { verifiedAgoMs: 2 * DAY_MS });
    fetchStub = stubFetch([]);

    expect(await checkGuildAccess(env, 'u1', 'guild-1')).toBe('denied');
    expect(fetchStub.calls).toHaveLength(0);
  });

  it('revalidates a stale row and denies a departed member, updating the cache', async () => {
    const { db, env } = setup();
    await seedGuild(db);
    await seedUser(db, 'u1');
    await seedMembership(db, 'u1', 'guild-1', { verifiedAgoMs: 2 * HOUR_MS });
    fetchStub = stubFetch([membershipRule(404)]);

    expect(await checkGuildAccess(env, 'u1', 'guild-1')).toBe('denied');
    expect(fetchStub.calls).toHaveLength(1);
    expect((await membershipRow(db, 'u1', 'guild-1'))?.is_member).toBe(0);
  });

  it('refreshes verified_at when Discord confirms membership', async () => {
    const { db, env } = setup();
    await seedGuild(db);
    await seedUser(db, 'u1');
    await seedMembership(db, 'u1', 'guild-1', { verifiedAgoMs: 2 * HOUR_MS });
    fetchStub = stubFetch([membershipRule(200)]);

    expect(await checkGuildAccess(env, 'u1', 'guild-1')).toBe('member');
    const row = await membershipRow(db, 'u1', 'guild-1');
    expect(Date.now() - row!.verified_at).toBeLessThan(MEMBERSHIP_FRESHNESS_MS);
  });

  // R1 from the review reproductions: previously EVERY one of these
  // authorized, indefinitely. Now they authorize only inside the grace
  // window, and the window keeps counting from the last confirmed check
  // rather than resetting on each failed attempt.
  describe.each([
    ['invalid bot token (401)', membershipRule(401)],
    ['bot removed from guild (403)', membershipRule(403)],
    ['rate limited (429)', membershipRule(429)],
    ['Discord outage (500)', membershipRule(500)],
    ['network failure', { match: '/members/', status: 0, networkError: true }],
  ])('when Discord cannot confirm: %s', (_label, rule) => {
    it('still allows access inside the grace window', async () => {
      const { db, env } = setup();
      await seedGuild(db);
      await seedUser(db, 'u1');
      await seedMembership(db, 'u1', 'guild-1', { verifiedAgoMs: 2 * HOUR_MS });
      fetchStub = stubFetch([rule]);

      expect(await checkGuildAccess(env, 'u1', 'guild-1')).toBe('member');
    });

    it('does not refresh verified_at, so the grace window keeps counting down', async () => {
      const { db, env } = setup();
      await seedGuild(db);
      await seedUser(db, 'u1');
      const staleness = 2 * HOUR_MS;
      await seedMembership(db, 'u1', 'guild-1', { verifiedAgoMs: staleness });
      fetchStub = stubFetch([rule]);

      await checkGuildAccess(env, 'u1', 'guild-1');
      const row = await membershipRow(db, 'u1', 'guild-1');
      expect(Date.now() - row!.verified_at).toBeGreaterThanOrEqual(staleness - 1000);
    });

    it('refuses once the cached answer is older than the grace window', async () => {
      const { db, env } = setup();
      await seedGuild(db);
      await seedUser(db, 'u1');
      await seedMembership(db, 'u1', 'guild-1', { verifiedAgoMs: MEMBERSHIP_GRACE_MS + HOUR_MS });
      fetchStub = stubFetch([rule]);

      expect(await checkGuildAccess(env, 'u1', 'guild-1')).toBe('unverifiable');
    });
  });
});

describe('isGuildMember', () => {
  it('throws MembershipUnavailableError rather than reporting a denial it cannot justify', async () => {
    const { db, env } = setup();
    await seedGuild(db);
    await seedUser(db, 'u1');
    await seedMembership(db, 'u1', 'guild-1', { verifiedAgoMs: MEMBERSHIP_GRACE_MS + HOUR_MS });
    fetchStub = stubFetch([membershipRule(500)]);

    await expect(isGuildMember(env, 'u1', 'guild-1')).rejects.toBeInstanceOf(MembershipUnavailableError);
  });

  it('returns false, without throwing, for a settled denial', async () => {
    const { db, env } = setup();
    await seedGuild(db);
    await seedUser(db, 'u1');
    await seedMembership(db, 'u1', 'guild-1', { verifiedAgoMs: 2 * HOUR_MS });
    fetchStub = stubFetch([membershipRule(404)]);

    expect(await isGuildMember(env, 'u1', 'guild-1')).toBe(false);
  });
});

describe('filterActiveGuildMembers', () => {
  // R2 from the review reproductions: a former member whose row was never
  // re-read stayed selectable as an invite/group target forever.
  it('excludes an indefinitely stale former member', async () => {
    const { db, env } = setup();
    await seedGuild(db);
    await seedUser(db, 'former');
    await seedMembership(db, 'former', 'guild-1', { verifiedAgoMs: 30 * DAY_MS });
    fetchStub = stubFetch([membershipRule(404)]);

    const active = await filterActiveGuildMembers(env, 'guild-1', ['former']);
    expect(active.has('former')).toBe(false);
    expect((await membershipRow(db, 'former', 'guild-1'))?.is_member).toBe(0);
  });

  it('excludes a past-grace stale member when Discord cannot be reached', async () => {
    const { db, env } = setup();
    await seedGuild(db);
    await seedUser(db, 'stale');
    await seedMembership(db, 'stale', 'guild-1', { verifiedAgoMs: MEMBERSHIP_GRACE_MS + DAY_MS });
    fetchStub = stubFetch([membershipRule(500)]);

    expect((await filterActiveGuildMembers(env, 'guild-1', ['stale'])).has('stale')).toBe(false);
  });

  it('keeps a recently-confirmed member when Discord cannot be reached', async () => {
    const { db, env } = setup();
    await seedGuild(db);
    await seedUser(db, 'recent');
    await seedMembership(db, 'recent', 'guild-1', { verifiedAgoMs: 2 * HOUR_MS });
    fetchStub = stubFetch([membershipRule(500)]);

    expect((await filterActiveGuildMembers(env, 'guild-1', ['recent'])).has('recent')).toBe(true);
  });

  // The configured invite maximum is 100 users, which with the guild ID is
  // 101 bound parameters -- R4 from the review reproductions.
  it('handles a full 100-user target list without exceeding D1 parameter limits', async () => {
    const { db, env } = setup();
    await seedGuild(db);
    const userIds = ids('u', 100);
    for (const id of userIds) {
      await seedUser(db, id);
      await seedMembership(db, id, 'guild-1');
    }
    fetchStub = stubFetch([]);

    expect((await filterActiveGuildMembers(env, 'guild-1', userIds)).size).toBe(100);
  });

  it('handles a full 300-invitee resolved list', async () => {
    const { db, env } = setup();
    await seedGuild(db);
    const userIds = ids('u', 300);
    for (const id of userIds) {
      await seedUser(db, id);
      await seedMembership(db, id, 'guild-1');
    }
    fetchStub = stubFetch([]);

    expect((await filterActiveGuildMembers(env, 'guild-1', userIds)).size).toBe(300);
  });

  // The budget bounds outbound calls, but what it must NOT do is turn
  // "didn't get checked" into "confirmed member" -- every caller of this is
  // about to grant access or trigger a private DM. Refusing is retryable;
  // guessing is not correctable.
  it('refuses rather than guessing when more targets are stale than one request can verify', async () => {
    const { db, env } = setup();
    await seedGuild(db);
    const userIds = ids('u', 100);
    for (const id of userIds) {
      await seedUser(db, id);
      await seedMembership(db, id, 'guild-1', { verifiedAgoMs: 2 * HOUR_MS });
    }
    fetchStub = stubFetch([membershipRule(200)]);

    await expect(filterActiveGuildMembers(env, 'guild-1', userIds)).rejects.toBeInstanceOf(
      MembershipUnavailableError,
    );
    // And it refuses *before* spending the outbound budget it can't finish.
    expect(fetchStub.calls.length).toBe(0);
  });

  it('still live-checks a stale list small enough to verify in one request', async () => {
    const { db, env } = setup();
    await seedGuild(db);
    const userIds = ids('u', 5);
    for (const id of userIds) {
      await seedUser(db, id);
      await seedMembership(db, id, 'guild-1', { verifiedAgoMs: 2 * HOUR_MS });
    }
    fetchStub = stubFetch([membershipRule(200)]);

    expect((await filterActiveGuildMembers(env, 'guild-1', userIds)).size).toBe(5);
    expect(fetchStub.calls.length).toBe(5);
  });
});

describe('syncGuildMembership', () => {
  it('handles the 200 guilds Discord can return for one account', async () => {
    const { db, env } = setup();
    await seedUser(db, 'u1');
    const guildIds = ids('g', 200);
    for (const id of guildIds.slice(0, 3)) await seedGuild(db, id);

    await syncGuildMembership(env, 'u1', guildIds);

    const row = await db
      .prepare(`SELECT COUNT(*) AS n FROM user_guild_membership WHERE user_id = ? AND is_member = 1`)
      .bind('u1')
      .first<{ n: number }>();
    expect(row?.n).toBe(3);
  });

  it('clears memberships the user no longer has, without a NOT IN list', async () => {
    const { db, env } = setup();
    await seedUser(db, 'u1');
    await seedGuild(db, 'kept');
    await seedGuild(db, 'left');
    await seedMembership(db, 'u1', 'kept');
    await seedMembership(db, 'u1', 'left');

    await syncGuildMembership(env, 'u1', ['kept']);

    expect((await membershipRow(db, 'u1', 'kept'))?.is_member).toBe(1);
    expect((await membershipRow(db, 'u1', 'left'))?.is_member).toBe(0);
  });

  it('clears every membership when the user is in none of the allow-listed guilds', async () => {
    const { db, env } = setup();
    await seedUser(db, 'u1');
    await seedGuild(db, 'left');
    await seedMembership(db, 'u1', 'left');

    await syncGuildMembership(env, 'u1', []);

    expect((await membershipRow(db, 'u1', 'left'))?.is_member).toBe(0);
  });
});

describe('revalidateStaleMemberships', () => {
  it('refreshes stale rows in a bounded batch, oldest first', async () => {
    const { db, env } = setup();
    await seedGuild(db);
    for (const [i, id] of ids('u', 5).entries()) {
      await seedUser(db, id);
      await seedMembership(db, id, 'guild-1', { verifiedAgoMs: (i + 2) * HOUR_MS });
    }
    fetchStub = stubFetch([membershipRule(200)]);

    expect(await revalidateStaleMemberships(env, 3)).toBe(3);
    // The three oldest (u-4, u-3, u-2) should now be fresh.
    const fresh = await db
      .prepare(`SELECT COUNT(*) AS n FROM user_guild_membership WHERE verified_at >= ?`)
      .bind(Date.now() - HOUR_MS)
      .first<{ n: number }>();
    expect(fresh?.n).toBe(3);
  });

  it('marks departed members as gone', async () => {
    const { db, env } = setup();
    await seedGuild(db);
    await seedUser(db, 'gone');
    await seedMembership(db, 'gone', 'guild-1', { verifiedAgoMs: 3 * HOUR_MS });
    fetchStub = stubFetch([membershipRule(404)]);

    await revalidateStaleMemberships(env, 10);
    expect((await membershipRow(db, 'gone', 'guild-1'))?.is_member).toBe(0);
  });

  // A broken bot token fails identically for every row, so continuing would
  // burn one Discord round trip per membership for nothing.
  it('stops early when the bot token is rejected', async () => {
    const { db, env } = setup();
    await seedGuild(db);
    for (const id of ids('u', 10)) {
      await seedUser(db, id);
      await seedMembership(db, id, 'guild-1', { verifiedAgoMs: 3 * HOUR_MS });
    }
    fetchStub = stubFetch([membershipRule(401)]);

    await revalidateStaleMemberships(env, 10);
    expect(fetchStub.calls).toHaveLength(1);
  });

  it('leaves fresh rows alone', async () => {
    const { db, env } = setup();
    await seedGuild(db);
    await seedUser(db, 'fresh');
    await seedMembership(db, 'fresh', 'guild-1', { verifiedAgoMs: 60_000 });
    fetchStub = stubFetch([]);

    expect(await revalidateStaleMemberships(env, 10)).toBe(0);
  });
});
