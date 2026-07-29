import { afterEach, describe, expect, it } from 'vitest';
import { computeBusyBlocksForUsers } from '../src/lib/freeBusy';
import { createEventWithInvites, type EventWriteInput } from '../src/lib/eventWrites';
import { FreeBusyTooLargeError, LIMITS } from '../src/lib/validate';
import { MEMBERSHIP_FRESHNESS_MS } from '../src/lib/db';
import { D1_FREE_PLAN_QUERY_BUDGET, type ShimDatabase } from './d1shim';
import {
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

async function seedOrganizer(db: ShimDatabase) {
  await seedGuild(db);
  await seedUser(db, 'organizer');
  await seedMembership(db, 'organizer', 'guild-1');
}

async function seedPollEvent(
  db: ShimDatabase,
  eventId: string,
  {
    optionsPerEvent,
    guildId = 'guild-1',
  }: { optionsPerEvent: number; guildId?: string },
): Promise<{ optionIds: string[] }> {
  const now = Date.now();
  await db.prepare(
    `INSERT INTO events (id, guild_id, organizer_id, title, event_type, timezone, status,
       poll_mode, poll_resolution_mode, is_recurring, created_at, updated_at)
     VALUES (?, ?, 'organizer', 'Multi-winner poll', 'poll', 'UTC', 'active', 'options', 'multi_winner', 0, ?, ?)`,
  )
    .bind(eventId, guildId, now, now)
    .run();

  const optionIds: string[] = [];
  const base = Date.now() + 7 * 24 * HOUR_MS;
  for (let i = 0; i < optionsPerEvent; i++) {
    const optionId = `${eventId}-opt${i}`;
    optionIds.push(optionId);
    await db.prepare(
      `INSERT INTO event_poll_options (id, event_id, start_at, end_at, display_order, confirmed_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
      .bind(optionId, eventId, base + i * HOUR_MS, base + i * HOUR_MS + HOUR_MS, i, now)
      .run();
  }
  return { optionIds };
}

// computeBusyBlocksForUsers only considers events a requested user organizes
// or is invited to -- a vote on an event the user was never invited to would
// be a different bug (F-05, cross-guild/object authorization), not this one.
async function seedInvitees(db: ShimDatabase, eventId: string, userIds: readonly string[]): Promise<void> {
  for (const userId of userIds) {
    await db.prepare(
      `INSERT INTO event_invites (id, event_id, user_id, invited_via, rsvp_status, invited_at)
       VALUES (?, ?, ?, 'individual', 'accepted', ?)`,
    )
      .bind(`inv-${eventId}-${userId}`, eventId, userId, Date.now())
      .run();
  }
}

// F-04-A from the Pass 7 review: confirmed multi-winner poll votes never
// entered the shared free/busy occurrence budget, and the loader read every
// voter for a confirmed option rather than just the requested users, so a
// configured-valid poll topology could load 255,000 rows and still bypass
// the 20,000-occurrence ceiling entirely.
describe('free/busy multi-winner poll blocks are budgeted and requester-scoped (F-04-A)', () => {
  it('refuses a poll topology that would exceed the shared occurrence ceiling', async () => {
    const { db, env } = setup();
    await seedOrganizer(db);

    const requestedUsers = ids('reqd', 25);
    for (const id of requestedUsers) {
      await seedUser(db, id);
      await seedMembership(db, id, 'guild-1');
    }

    // 17 polls x 50 confirmed options x 25 requested users = 21,250, over the
    // 20,000 ceiling -- the exact topology from the review's R1 reproduction.
    // Only the requested users vote "yes" so the SQL-side row volume this
    // test seeds also reflects the fix (the review's concern was the loader
    // reading every one of a poll's up-to-300 voters, not just these 25).
    for (const pollId of ids('poll', 17)) {
      const { optionIds } = await seedPollEvent(db, pollId, { optionsPerEvent: 50 });
      await seedInvitees(db, pollId, requestedUsers);
      for (const optionId of optionIds) {
        for (const userId of requestedUsers) {
          await db.prepare(
            `INSERT INTO event_poll_votes (option_id, user_id, vote, voted_at) VALUES (?, ?, 'yes', ?)`,
          )
            .bind(optionId, userId, Date.now())
            .run();
        }
      }
    }

    const from = Date.now();
    const to = from + 30 * 24 * HOUR_MS;
    await expect(computeBusyBlocksForUsers(env, requestedUsers, from, to)).rejects.toThrow(FreeBusyTooLargeError);
  });

  it('does not load votes from users outside the request or outside the requested range', async () => {
    const { db, env } = setup();
    await seedOrganizer(db);

    const requestedUsers = ids('reqd', 2);
    for (const id of requestedUsers) {
      await seedUser(db, id);
      await seedMembership(db, id, 'guild-1');
    }
    // A guild-mate who voted yes but was never in the free/busy request.
    await seedUser(db, 'bystander');
    await seedMembership(db, 'bystander', 'guild-1');

    const { optionIds } = await seedPollEvent(db, 'poll-1', { optionsPerEvent: 1 });
    await seedInvitees(db, 'poll-1', [...requestedUsers, 'bystander']);
    const [optionId] = optionIds;
    for (const userId of [...requestedUsers, 'bystander']) {
      await db.prepare(
        `INSERT INTO event_poll_votes (option_id, user_id, vote, voted_at) VALUES (?, ?, 'yes', ?)`,
      )
        .bind(optionId, userId, Date.now())
        .run();
    }

    // A confirmed option far outside the requested range -- its votes must
    // not be loaded or attributed to anyone.
    const outOfRangeOptionId = 'poll-1-late';
    await db.prepare(
      `INSERT INTO event_poll_options (id, event_id, start_at, end_at, display_order, confirmed_at)
       VALUES (?, 'poll-1', ?, ?, 99, ?)`,
    )
      .bind(outOfRangeOptionId, Date.now() + 365 * 24 * HOUR_MS, Date.now() + 365 * 24 * HOUR_MS + HOUR_MS, Date.now())
      .run();
    await db.prepare(
      `INSERT INTO event_poll_votes (option_id, user_id, vote, voted_at) VALUES (?, ?, 'yes', ?)`,
    )
      .bind(outOfRangeOptionId, requestedUsers[0], Date.now())
      .run();

    const from = Date.now();
    const to = from + 30 * 24 * HOUR_MS;
    const result = await computeBusyBlocksForUsers(env, requestedUsers, from, to);

    expect(result.get(requestedUsers[0])).toHaveLength(1);
    expect(result.get(requestedUsers[1])).toHaveLength(1);
    expect(result.has('bystander')).toBe(false);
  });
});

// F-04-B from the Pass 7 review: direct and group-derived invitees each went
// through their own membership-revalidation pass and each wrote back its
// stale-row results one statement at a time, so a single valid create could
// spend up to twice MAX_LIVE_REVALIDATIONS_PER_REQUEST worth of individual
// D1 writes -- pushing a configured-valid combination (max direct + max
// group invitees, both with stale rows, plus a max-size poll) to 82 D1
// statements against the Free plan's 50. The fix merges both sources into
// one revalidation pass (sharing the request-wide stale-row cap) and writes
// its results back in set-based chunks instead of per-row.
describe('combined direct/group invitee resolution fits the Free-plan budget (F-04-B)', () => {
  it('creates a max poll with max resolved invitees split across direct + group, some stale in both', async () => {
    const { db, env } = setup();
    await seedOrganizer(db);

    // MAX_RESOLVED_INVITEES now equals MAX_INVITEES (both 25 under the
    // private-profile limits -- see PRIVATE_FREE_PROFILE in validate.ts), so
    // "max direct invitees" and "max resolved invitees" are no longer two
    // independent dimensions: 25 direct invitees alone already fills the
    // resolved cap. What's still worth exercising in combination is direct
    // and group-derived invitees *sharing* that one cap, with stale rows in
    // both sources sharing the one combined revalidation pass (see
    // resolveInviteeUserIds) -- MAX_LIVE_REVALIDATIONS_PER_REQUEST (20) is a
    // request-wide budget, not per source.
    const directCount = 10;
    const groupOnlyCount = LIMITS.MAX_RESOLVED_INVITEES - directCount; // 15
    const direct = ids('direct', directCount);
    for (const [i, id] of direct.entries()) {
      await seedUser(db, id);
      await seedMembership(db, id, 'guild-1', {
        verifiedAgoMs: i < 5 ? MEMBERSHIP_FRESHNESS_MS + HOUR_MS : 0,
      });
    }

    // Group-derived invitees distinct from the direct set, so the resolved
    // total lands exactly at MAX_RESOLVED_INVITEES.
    const group = ids('group-member', groupOnlyCount);
    for (const [i, id] of group.entries()) {
      await seedUser(db, id);
      await seedMembership(db, id, 'guild-1', {
        verifiedAgoMs: i < 5 ? MEMBERSHIP_FRESHNESS_MS + HOUR_MS : 0,
      });
    }
    await db.prepare(
      `INSERT INTO groups (id, guild_id, name, created_by, created_at) VALUES ('g1', 'guild-1', 'Everyone', 'organizer', ?)`,
    )
      .bind(Date.now())
      .run();
    for (const id of group) {
      await db.prepare(`INSERT INTO group_members (group_id, user_id, added_at) VALUES ('g1', ?, ?)`)
        .bind(id, Date.now())
        .run();
    }

    fetchStub = stubFetch([membershipRule(200)]);

    const options = Array.from({ length: LIMITS.MAX_POLL_OPTIONS }, (_, i) => ({
      startAt: Date.now() + 7 * 24 * HOUR_MS + i * HOUR_MS,
      endAt: Date.now() + 7 * 24 * HOUR_MS + (i + 1) * HOUR_MS,
    }));

    db.resetQueryCount();
    await createEventWithInvites(env, 'guild-1', 'organizer', {
      title: 'Max combination',
      timezone: 'UTC',
      eventType: 'poll',
      pollMode: 'options',
      pollResolutionMode: 'multi_winner',
      pollStrategy: 'threshold',
      pollThresholdCount: 3,
      pollDeadlineAt: Date.now() + 24 * HOUR_MS,
      pollOptions: options,
      invites: { userIds: direct, groupIds: ['g1'] },
    } as unknown as EventWriteInput);

    expect(db.queryCount).toBeLessThan(D1_FREE_PLAN_QUERY_BUDGET);
  });
});
