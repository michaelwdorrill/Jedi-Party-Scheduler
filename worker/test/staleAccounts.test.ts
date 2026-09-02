import { afterEach, describe, expect, it, vi } from 'vitest';
import { runReminderSweep } from '../src/cron/reminders';
import {
  countRows,
  DAY_MS,
  DM_CHANNEL_RULE,
  dmSendRule,
  seedEvent,
  seedGuild,
  seedInvite,
  seedMembership,
  seedUser,
  setup,
  stubFetch,
  type FetchStub,
} from './helpers';
import type { ShimDatabase } from './d1shim';

// IDEAS item 10 / docs/specs/0016: warn, then purge, an account that has gone
// stale. "Stale" is measured from last_login_at (or created_at, absent one).

let fetchStub: FetchStub | null = null;
afterEach(() => {
  fetchStub?.restore();
  fetchStub = null;
  vi.useRealTimers();
});

async function ageAccount(db: ShimDatabase, userId: string, ageMs: number, everLoggedIn = true): Promise<void> {
  const referenceAt = Date.now() - ageMs;
  await db
    .prepare(`UPDATE users SET last_login_at = ?, created_at = ? WHERE id = ?`)
    .bind(everLoggedIn ? referenceAt : null, referenceAt, userId)
    .run();
}

async function warningRows(
  db: ShimDatabase,
  userId: string,
): Promise<{ warning_type: string; delivered_at: number | null }[]> {
  const { results } = await db
    .prepare(`SELECT warning_type, delivered_at FROM account_purge_warnings WHERE user_id = ? ORDER BY warning_type`)
    .bind(userId)
    .all<{ warning_type: string; delivered_at: number | null }>();
  return results;
}

async function userExists(db: ShimDatabase, userId: string): Promise<boolean> {
  return (await countRows(db, 'users', 'id = ?', userId)) > 0;
}

describe('a recently-active account gets no warning and no purge', () => {
  it('leaves a fresh login untouched', async () => {
    const { db, env } = setup();
    await seedGuild(db);
    await seedUser(db, 'fresh');
    await seedMembership(db, 'fresh', 'guild-1');
    fetchStub = stubFetch([]);

    await runReminderSweep(env);

    expect(await warningRows(db, 'fresh')).toEqual([]);
    expect(await userExists(db, 'fresh')).toBe(true);
  });
});

describe('the two warnings fire at their thresholds and only once each', () => {
  it('sends the 2-week warning at 351 days and does not resend it on a later tick', async () => {
    const { db, env } = setup();
    await seedGuild(db);
    await seedUser(db, 'stale2wk');
    await seedMembership(db, 'stale2wk', 'guild-1');
    await ageAccount(db, 'stale2wk', 351 * DAY_MS);
    fetchStub = stubFetch([DM_CHANNEL_RULE, dmSendRule(200)]);

    await runReminderSweep(env);
    let rows = await warningRows(db, 'stale2wk');
    expect(rows).toEqual([{ warning_type: 'stale_2wk', delivered_at: expect.any(Number) }]);

    // Idempotent: a second tick must not send it again.
    const callsBefore = fetchStub.calls.length;
    await runReminderSweep(env);
    expect(fetchStub.calls.length).toBe(callsBefore);
    rows = await warningRows(db, 'stale2wk');
    expect(rows).toHaveLength(1);
  });

  it('sends the 1-week warning at 358 days, and both once the account is fully stale', async () => {
    const { db, env } = setup();
    await seedGuild(db);
    await seedUser(db, 'stale1wk');
    await seedMembership(db, 'stale1wk', 'guild-1');
    await ageAccount(db, 'stale1wk', 358 * DAY_MS);
    fetchStub = stubFetch([DM_CHANNEL_RULE, dmSendRule(200)]);

    await runReminderSweep(env);
    const rows = await warningRows(db, 'stale1wk');
    expect(rows).toEqual([{ warning_type: 'stale_1wk', delivered_at: expect.any(Number) }]);
    // The 2-week rung is in the past for this account (age already past it on
    // its very first scan) and is never sent retroactively -- only whichever
    // rung applies to the account's current age.
    expect(rows.some((r) => r.warning_type === 'stale_2wk')).toBe(false);
  });

  it('ignores notifications_enabled -- this is not a gameplay notification', async () => {
    const { db, env } = setup();
    await seedGuild(db);
    await seedUser(db, 'optedout');
    await seedMembership(db, 'optedout', 'guild-1');
    await ageAccount(db, 'optedout', 351 * DAY_MS);
    await db.prepare(`UPDATE users SET notifications_enabled = 0 WHERE id = 'optedout'`).run();
    fetchStub = stubFetch([DM_CHANNEL_RULE, dmSendRule(200)]);

    await runReminderSweep(env);

    expect(await warningRows(db, 'optedout')).toHaveLength(1);
  });

  it('measures a never-logged-in account from created_at', async () => {
    const { db, env } = setup();
    await seedGuild(db);
    await seedUser(db, 'neverlogged');
    await seedMembership(db, 'neverlogged', 'guild-1');
    await ageAccount(db, 'neverlogged', 351 * DAY_MS, /* everLoggedIn */ false);
    fetchStub = stubFetch([DM_CHANNEL_RULE, dmSendRule(200)]);

    await runReminderSweep(env);

    expect(await warningRows(db, 'neverlogged')).toHaveLength(1);
  });
});

describe('a fully stale account is purged', () => {
  it('deletes an account with nothing scheduled', async () => {
    const { db, env } = setup();
    await seedGuild(db);
    await seedUser(db, 'gone');
    await seedMembership(db, 'gone', 'guild-1');
    await ageAccount(db, 'gone', 366 * DAY_MS);
    fetchStub = stubFetch([]);

    await runReminderSweep(env);

    expect(await userExists(db, 'gone')).toBe(false);
  });

  it('does not purge an account organising a future active event', async () => {
    const { db, env } = setup();
    await seedGuild(db);
    await seedUser(db, 'organizer');
    await seedMembership(db, 'organizer', 'guild-1');
    await ageAccount(db, 'organizer', 366 * DAY_MS);
    await seedEvent(db, { id: 'future', organizerId: 'organizer', startAt: Date.now() + DAY_MS, endAt: Date.now() + DAY_MS + 3600_000 });
    fetchStub = stubFetch([]);

    await runReminderSweep(env);

    expect(await userExists(db, 'organizer')).toBe(true);
  });

  it('does not purge an account with a non-declined invite to a future active event', async () => {
    const { db, env } = setup();
    await seedGuild(db);
    await seedUser(db, 'organizer');
    await seedUser(db, 'invitee');
    await seedMembership(db, 'organizer', 'guild-1');
    await seedMembership(db, 'invitee', 'guild-1');
    await ageAccount(db, 'invitee', 366 * DAY_MS);
    await seedEvent(db, { id: 'future', organizerId: 'organizer', startAt: Date.now() + DAY_MS, endAt: Date.now() + DAY_MS + 3600_000 });
    await seedInvite(db, 'future', 'invitee');
    fetchStub = stubFetch([]);

    await runReminderSweep(env);

    expect(await userExists(db, 'invitee')).toBe(true);
  });

  it('does purge an account that only declined its invite to a future event', async () => {
    const { db, env } = setup();
    await seedGuild(db);
    await seedUser(db, 'organizer');
    await seedUser(db, 'decliner');
    await seedMembership(db, 'organizer', 'guild-1');
    await seedMembership(db, 'decliner', 'guild-1');
    await ageAccount(db, 'decliner', 366 * DAY_MS);
    await seedEvent(db, { id: 'future', organizerId: 'organizer', startAt: Date.now() + DAY_MS, endAt: Date.now() + DAY_MS + 3600_000 });
    await seedInvite(db, 'future', 'decliner');
    await db.prepare(`UPDATE event_invites SET rsvp_status = 'declined' WHERE event_id = 'future' AND user_id = 'decliner'`).run();
    fetchStub = stubFetch([]);

    await runReminderSweep(env);

    expect(await userExists(db, 'decliner')).toBe(false);
  });

  it('purges an account whose only stake is a past event', async () => {
    const { db, env } = setup();
    await seedGuild(db);
    await seedUser(db, 'organizer');
    await seedMembership(db, 'organizer', 'guild-1');
    await ageAccount(db, 'organizer', 366 * DAY_MS);
    await seedEvent(db, { id: 'past', organizerId: 'organizer', startAt: Date.now() - 30 * DAY_MS, endAt: Date.now() - 29 * DAY_MS });
    fetchStub = stubFetch([]);

    await runReminderSweep(env);

    expect(await userExists(db, 'organizer')).toBe(false);
  });

  it('caps purges at one per tick and catches the rest on the next one', async () => {
    const { db, env } = setup();
    await seedGuild(db);
    await seedUser(db, 'gone-a');
    await seedUser(db, 'gone-b');
    await seedMembership(db, 'gone-a', 'guild-1');
    await seedMembership(db, 'gone-b', 'guild-1');
    await ageAccount(db, 'gone-a', 366 * DAY_MS);
    await ageAccount(db, 'gone-b', 366 * DAY_MS);
    fetchStub = stubFetch([]);

    await runReminderSweep(env);
    const remainingAfterFirst = (await userExists(db, 'gone-a')) !== (await userExists(db, 'gone-b'));
    expect(remainingAfterFirst).toBe(true); // exactly one purged, not zero and not both

    await runReminderSweep(env);
    expect(await userExists(db, 'gone-a')).toBe(false);
    expect(await userExists(db, 'gone-b')).toBe(false);
  });
});
