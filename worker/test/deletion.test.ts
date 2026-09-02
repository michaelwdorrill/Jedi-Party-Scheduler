import { describe, expect, it } from 'vitest';
import { deleteUserCompletely } from '../src/lib/db';
import { createSession } from '../src/lib/sessions';
import { countRows, DAY_MS, seedEvent, seedGuild, seedInvite, seedMembership, seedUser, setup } from './helpers';

// Foreign keys are ON in the test harness (see d1shim.ts), matching D1's own
// default. That's what makes these tests capable of catching an ordering
// mistake -- the sessions-FK bug that shipped in an earlier pass was exactly
// this shape, and a runtime that couldn't fail on a dangling reference would
// have passed straight over it.
describe('deleteUserCompletely', () => {
  async function seedFullAccount() {
    const ctx = setup();
    const { db, env } = ctx;
    await seedGuild(db);
    await seedUser(db, 'target');
    await seedUser(db, 'bystander');
    await seedMembership(db, 'target', 'guild-1');
    await seedMembership(db, 'bystander', 'guild-1');

    const now = Date.now();

    // An event the target organises, with a poll, votes, availability,
    // invites, a recurrence rule, an override, and notifications.
    await seedEvent(db, { id: 'mine', organizerId: 'target', eventType: 'poll' });
    await db.prepare(`INSERT INTO event_poll_options (id, event_id, start_at, end_at, display_order) VALUES ('opt', 'mine', ?, ?, 0)`)
      .bind(now + DAY_MS, now + DAY_MS + 3600_000)
      .run();
    await db.prepare(`INSERT INTO event_poll_votes (option_id, user_id, vote, voted_at) VALUES ('opt', 'bystander', 'yes', ?)`)
      .bind(now)
      .run();
    await db.prepare(
      `INSERT INTO event_window_availability (option_id, event_id, user_id, avail_start_at, avail_end_at, submitted_at)
       VALUES ('opt', 'mine', 'bystander', ?, ?, ?)`,
    )
      .bind(now, now + 3600_000, now)
      .run();
    await seedInvite(db, 'mine', 'bystander');
    await db.prepare(
      `INSERT INTO event_recurrence_rules (event_id, freq, interval, start_date, start_time, duration_minutes, end_type)
       VALUES ('mine', 'DAILY', 1, '2026-01-01', '18:00', 60, 'never')`,
    ).run();
    await db.prepare(
      `INSERT INTO event_occurrence_overrides (id, event_id, occurrence_date, is_cancelled) VALUES ('ovr', 'mine', '2026-01-02', 1)`,
    ).run();
    await db.prepare(
      `INSERT INTO notification_log (id, user_id, event_id, notification_type, occurrence_date, sent_at)
       VALUES ('n1', 'bystander', 'mine', 'invite', '', ?)`,
    )
      .bind(now)
      .run();

    // A group the target created, referenced by an invite on someone else's
    // event -- the source_group_id foreign key that used to block deletion.
    await db.prepare(
      `INSERT INTO groups (id, guild_id, name, idle_reminder_days, created_by, created_at)
       VALUES ('grp', 'guild-1', 'Squad', 2, 'target', ?)`,
    )
      .bind(now)
      .run();
    await db.prepare(`INSERT INTO group_members (group_id, user_id, added_at) VALUES ('grp', 'bystander', ?)`)
      .bind(now)
      .run();
    await db.prepare(`INSERT INTO group_activity_nudges (group_id, last_event_at, notified_at) VALUES ('grp', ?, ?)`)
      .bind(now, now)
      .run();
    await db.prepare(
      `INSERT INTO group_nudge_log (id, group_id, user_id, last_event_at, sent_at) VALUES ('gn1', 'grp', 'bystander', ?, ?)`,
    )
      .bind(now, now)
      .run();

    // An event someone else organises, where the target is only a participant.
    await seedEvent(db, { id: 'theirs', organizerId: 'bystander' });
    await db.prepare(
      `INSERT INTO event_invites (id, event_id, user_id, invited_via, source_group_id, rsvp_status, invited_at)
       VALUES ('i-theirs', 'theirs', 'target', 'group', 'grp', 'accepted', ?)`,
    )
      .bind(now)
      .run();

    // Personal events and an active session.
    await db.prepare(
      `INSERT INTO personal_events (id, user_id, title, timezone, start_at, end_at, status, availability,
         is_recurring, created_at, updated_at)
       VALUES ('pe', 'target', 'Dentist', 'America/New_York', ?, ?, 'active', 'busy', 0, ?, ?)`,
    )
      .bind(now, now + 3600_000, now, now)
      .run();
    await db.prepare(
      `INSERT INTO personal_event_overrides (id, personal_event_id, occurrence_date, is_cancelled) VALUES ('peo', 'pe', '2026-01-02', 1)`,
    ).run();
    await createSession(env, 'target');

    // IDEAS item 10 / specs/0016: a stale-account warning, purely user-scoped
    // like personal_events rather than tied to anything the target owns.
    await db.prepare(
      `INSERT INTO account_purge_warnings (id, user_id, last_login_at, warning_type, sent_at)
       VALUES ('apw1', 'target', ?, 'stale_2wk', ?)`,
    )
      .bind(now, now)
      .run();

    return ctx;
  }

  it('erases the account without tripping a foreign key', async () => {
    const { db, env } = await seedFullAccount();
    await expect(deleteUserCompletely(env, 'target')).resolves.toBeUndefined();
    expect(await countRows(db, 'users', 'id = ?', 'target')).toBe(0);
  });

  it('removes every session, so the account cannot keep authenticating', async () => {
    const { db, env } = await seedFullAccount();
    await deleteUserCompletely(env, 'target');
    expect(await countRows(db, 'sessions', 'user_id = ?', 'target')).toBe(0);
  });

  it('removes the events the user organised and all their children', async () => {
    const { db, env } = await seedFullAccount();
    await deleteUserCompletely(env, 'target');

    expect(await countRows(db, 'events', "id = 'mine'")).toBe(0);
    expect(await countRows(db, 'event_poll_options', "event_id = 'mine'")).toBe(0);
    expect(await countRows(db, 'event_poll_votes', "option_id = 'opt'")).toBe(0);
    expect(await countRows(db, 'event_window_availability', "event_id = 'mine'")).toBe(0);
    expect(await countRows(db, 'event_invites', "event_id = 'mine'")).toBe(0);
    expect(await countRows(db, 'event_recurrence_rules', "event_id = 'mine'")).toBe(0);
    expect(await countRows(db, 'event_occurrence_overrides', "event_id = 'mine'")).toBe(0);
    expect(await countRows(db, 'notification_log', "event_id = 'mine'")).toBe(0);
  });

  it('removes the groups the user created, detaching historical invite references', async () => {
    const { db, env } = await seedFullAccount();
    await deleteUserCompletely(env, 'target');

    expect(await countRows(db, 'groups', "id = 'grp'")).toBe(0);
    expect(await countRows(db, 'group_members', "group_id = 'grp'")).toBe(0);
    expect(await countRows(db, 'group_activity_nudges', "group_id = 'grp'")).toBe(0);
    expect(await countRows(db, 'group_nudge_log', "group_id = 'grp'")).toBe(0);
  });

  it('leaves other people\'s events standing', async () => {
    const { db, env } = await seedFullAccount();
    await deleteUserCompletely(env, 'target');

    expect(await countRows(db, 'events', "id = 'theirs'")).toBe(1);
    expect(await countRows(db, 'users', "id = 'bystander'")).toBe(1);
    // The target's own invite to that event is gone; the event isn't.
    expect(await countRows(db, 'event_invites', "event_id = 'theirs' AND user_id = 'target'")).toBe(0);
  });

  it('removes the user\'s personal data', async () => {
    const { db, env } = await seedFullAccount();
    await deleteUserCompletely(env, 'target');

    expect(await countRows(db, 'personal_events', "user_id = 'target'")).toBe(0);
    expect(await countRows(db, 'personal_event_overrides', "personal_event_id = 'pe'")).toBe(0);
    expect(await countRows(db, 'account_purge_warnings', "user_id = 'target'")).toBe(0);
    expect(await countRows(db, 'user_guild_membership', "user_id = 'target'")).toBe(0);
  });

  // The erasure is a single D1 batch, which is one transaction: a failure
  // anywhere leaves the account entirely intact rather than half-erased.
  it('leaves nothing behind and nothing half-done when the final delete fails', async () => {
    const { db, env } = await seedFullAccount();
    // A second user's session row pointing at the target would be nonsense,
    // but an unexpected referencing row is exactly what a partial erasure
    // looks like -- force one to make the batch fail at the last statement.
    db.raw.exec(`CREATE TABLE stray (user_id TEXT NOT NULL REFERENCES users(id))`);
    db.raw.exec(`INSERT INTO stray (user_id) VALUES ('target')`);

    await expect(deleteUserCompletely(env, 'target')).rejects.toThrow();

    // Everything is still there: no partially-erased account.
    expect(await countRows(db, 'users', "id = 'target'")).toBe(1);
    expect(await countRows(db, 'events', "id = 'mine'")).toBe(1);
    expect(await countRows(db, 'groups', "id = 'grp'")).toBe(1);
    expect(await countRows(db, 'personal_events', "user_id = 'target'")).toBe(1);
    // ...but authorization was already cut off before the data work started.
    const session = await db
      .prepare(`SELECT revoked_at FROM sessions WHERE user_id = 'target'`)
      .first<{ revoked_at: number | null }>();
    expect(session?.revoked_at).not.toBeNull();
  });

  it('is idempotent: a repeat call on an already-erased account is a no-op', async () => {
    const { env } = await seedFullAccount();
    await deleteUserCompletely(env, 'target');
    await expect(deleteUserCompletely(env, 'target')).resolves.toBeUndefined();
  });
});
