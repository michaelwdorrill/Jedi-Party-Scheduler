// specs/0011 / IDEAS item 36: when a group used to invite people to an event
// no longer shares that event's venue server (someone left it, or left every
// server they had in common with the rest), the event still happens as
// scheduled -- but the people still invited to it are told once.
import { afterEach, describe, expect, it } from 'vitest';
import { runReminderSweep } from '../src/cron/reminders';
import {
  countRows,
  DM_CHANNEL_RULE,
  dmSendRule,
  membershipRule,
  seedEvent,
  seedGuild,
  seedMembership,
  seedUser,
  setup,
  stubFetch,
  type FetchStub,
} from './helpers';
import type { ShimDatabase } from './d1shim';

let fetchStub: FetchStub | null = null;
afterEach(() => {
  fetchStub?.restore();
  fetchStub = null;
});

async function seedGroupInvite(db: ShimDatabase, eventId: string, groupId: string, userId: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO event_invites (id, event_id, user_id, invited_via, source_group_id, rsvp_status, invited_at)
       VALUES (?, ?, ?, 'group', ?, 'pending', ?)`,
    )
    .bind(`inv-${eventId}-${userId}`, eventId, userId, groupId, Date.now())
    .run();
}

describe('a drifted group-sourced venue notifies the event, not the calendar', () => {
  it('notifies everyone still invited once the group no longer shares the venue guild', async () => {
    const { db, env } = setup();
    await seedGuild(db, 'guild-1');
    await seedGuild(db, 'guild-2');
    await seedUser(db, 'organizer');
    await seedMembership(db, 'organizer', 'guild-1');
    await seedUser(db, 'alice');
    await seedMembership(db, 'alice', 'guild-1');
    // Bob has left guild-1 (the event's venue) but is still in guild-2, so
    // the group's roster (organizer, alice, bob) no longer shares guild-1.
    await seedUser(db, 'bob');
    await seedMembership(db, 'bob', 'guild-2');

    await db
      .prepare(`INSERT INTO groups (id, name, created_by, created_at) VALUES ('grp', 'Crew', 'organizer', ?)`)
      .bind(Date.now())
      .run();
    for (const id of ['organizer', 'alice', 'bob']) {
      await db.prepare(`INSERT INTO group_members (group_id, user_id, added_at) VALUES ('grp', ?, ?)`).bind(id, Date.now()).run();
    }

    const start = Date.now() + 24 * 60 * 60 * 1000;
    await seedEvent(db, { id: 'e1', guildId: 'guild-1', organizerId: 'organizer', startAt: start, endAt: start + 3600_000 });
    await seedGroupInvite(db, 'e1', 'grp', 'alice');

    fetchStub = stubFetch([DM_CHANNEL_RULE, dmSendRule(200), membershipRule(200)]);
    // Several ticks: other sweeps share the same tick budget, so delivery to
    // both the organizer and alice is not guaranteed to land in one tick.
    for (let i = 0; i < 5; i++) await runReminderSweep(env);

    expect(
      await countRows(db, 'notification_log', `event_id = 'e1' AND notification_type = 'group_venue_drift'`),
    ).toBe(2); // organizer + alice

    // One-shot: a further tick must not repeat it for either recipient.
    await runReminderSweep(env);
    expect(
      await countRows(db, 'notification_log', `event_id = 'e1' AND notification_type = 'group_venue_drift'`),
    ).toBe(2);
  });

  it('does not notify when the group still shares the venue guild', async () => {
    const { db, env } = setup();
    await seedGuild(db, 'guild-1');
    await seedUser(db, 'organizer');
    await seedMembership(db, 'organizer', 'guild-1');
    await seedUser(db, 'alice');
    await seedMembership(db, 'alice', 'guild-1');

    await db
      .prepare(`INSERT INTO groups (id, name, created_by, created_at) VALUES ('grp', 'Crew', 'organizer', ?)`)
      .bind(Date.now())
      .run();
    for (const id of ['organizer', 'alice']) {
      await db.prepare(`INSERT INTO group_members (group_id, user_id, added_at) VALUES ('grp', ?, ?)`).bind(id, Date.now()).run();
    }

    const start = Date.now() + 24 * 60 * 60 * 1000;
    await seedEvent(db, { id: 'e1', guildId: 'guild-1', organizerId: 'organizer', startAt: start, endAt: start + 3600_000 });
    await seedGroupInvite(db, 'e1', 'grp', 'alice');

    fetchStub = stubFetch([]);
    await runReminderSweep(env);

    expect(await countRows(db, 'notification_log', `event_id = 'e1' AND notification_type = 'group_venue_drift'`)).toBe(0);
  });

  it('does not notify about a past event', async () => {
    const { db, env } = setup();
    await seedGuild(db, 'guild-1');
    await seedGuild(db, 'guild-2');
    await seedUser(db, 'organizer');
    await seedMembership(db, 'organizer', 'guild-1');
    await seedUser(db, 'bob');
    await seedMembership(db, 'bob', 'guild-2');

    await db
      .prepare(`INSERT INTO groups (id, name, created_by, created_at) VALUES ('grp', 'Crew', 'organizer', ?)`)
      .bind(Date.now())
      .run();
    for (const id of ['organizer', 'bob']) {
      await db.prepare(`INSERT INTO group_members (group_id, user_id, added_at) VALUES ('grp', ?, ?)`).bind(id, Date.now()).run();
    }

    const start = Date.now() - 24 * 60 * 60 * 1000;
    await seedEvent(db, { id: 'e1', guildId: 'guild-1', organizerId: 'organizer', startAt: start, endAt: start + 3600_000 });
    await seedGroupInvite(db, 'e1', 'grp', 'bob');

    fetchStub = stubFetch([]);
    await runReminderSweep(env);

    expect(await countRows(db, 'notification_log', `event_id = 'e1' AND notification_type = 'group_venue_drift'`)).toBe(0);
  });
});
