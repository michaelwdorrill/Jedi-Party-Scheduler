import { afterEach, describe, expect, it } from 'vitest';
import { runReminderSweep } from '../src/cron/reminders';
import { MEMBERSHIP_GRACE_MS } from '../src/lib/db';
import {
  DAY_MS,
  DM_CHANNEL_RULE,
  dmSendRule,
  HOUR_MS,
  ids,
  membershipRule,
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

function sends(stub: FetchStub): number {
  return stub.calls.filter((u) => u.includes('/messages')).length;
}

// The cron only ever reads the membership cache, so the freshness cutoff is
// the entire protection against DMing someone who left. Every recipient query
// has to honour it.
describe('cron recipient filtering', () => {
  async function seedInvitee({ verifiedAgoMs = 0, isMember = 1, guildActive = 1 } = {}) {
    const ctx = setup();
    await seedGuild(ctx.db, 'guild-1', guildActive);
    await seedUser(ctx.db, 'organizer');
    await seedUser(ctx.db, 'invitee');
    await seedMembership(ctx.db, 'organizer', 'guild-1', { verifiedAgoMs: 0 });
    await seedMembership(ctx.db, 'invitee', 'guild-1', { verifiedAgoMs, isMember });
    await seedEvent(ctx.db, { id: 'e1', organizerId: 'organizer', title: 'Secret game' });
    await seedInvite(ctx.db, 'e1', 'invitee');
    return ctx;
  }

  async function invitesSentTo(db: Awaited<ReturnType<typeof seedInvitee>>['db'], userId: string): Promise<number> {
    const row = await db
      .prepare(`SELECT COUNT(*) AS n FROM notification_log WHERE user_id = ? AND notification_type = 'invite'`)
      .bind(userId)
      .first<{ n: number }>();
    return row?.n ?? 0;
  }

  it('DMs a current member', async () => {
    const { db, env } = await seedInvitee();
    fetchStub = stubFetch([DM_CHANNEL_RULE, dmSendRule(200), membershipRule(200)]);

    await runReminderSweep(env);
    expect(await invitesSentTo(db, 'invitee')).toBe(1);
  });

  // R3 from the review reproductions. This sweep discloses a private event's
  // title and link, and was the one recipient query with no guild check.
  it('does not DM someone whose membership was revoked', async () => {
    const { db, env } = await seedInvitee({ isMember: 0 });
    fetchStub = stubFetch([DM_CHANNEL_RULE, dmSendRule(200), membershipRule(200)]);

    await runReminderSweep(env);
    expect(await invitesSentTo(db, 'invitee')).toBe(0);
  });

  it('does not DM someone whose membership is older than the grace window', async () => {
    const { db, env } = await seedInvitee({ verifiedAgoMs: MEMBERSHIP_GRACE_MS + DAY_MS });
    // Discord says they left, so the background revalidation sweep marks them
    // gone before the invite sweep runs.
    fetchStub = stubFetch([DM_CHANNEL_RULE, dmSendRule(200), membershipRule(404)]);

    await runReminderSweep(env);
    expect(await invitesSentTo(db, 'invitee')).toBe(0);
  });

  it('does not DM anyone in a deactivated guild', async () => {
    const { db, env } = await seedInvitee({ guildActive: 0 });
    fetchStub = stubFetch([DM_CHANNEL_RULE, dmSendRule(200), membershipRule(200)]);

    await runReminderSweep(env);
    expect(await invitesSentTo(db, 'invitee')).toBe(0);
    expect(await invitesSentTo(db, 'organizer')).toBe(0);
  });

  it('does not DM someone who turned notifications off', async () => {
    const { db, env } = await seedInvitee();
    await db.prepare(`UPDATE users SET notifications_enabled = 0 WHERE id = ?`).bind('invitee').run();
    fetchStub = stubFetch([DM_CHANNEL_RULE, dmSendRule(200), membershipRule(200)]);

    await runReminderSweep(env);
    expect(await invitesSentTo(db, 'invitee')).toBe(0);
  });
});

describe('invite retry', () => {
  async function seedPendingInvite() {
    const ctx = setup();
    await seedGuild(ctx.db);
    await seedUser(ctx.db, 'organizer');
    await seedUser(ctx.db, 'invitee');
    await seedMembership(ctx.db, 'organizer', 'guild-1');
    await seedMembership(ctx.db, 'invitee', 'guild-1');
    await seedEvent(ctx.db, { id: 'e1', organizerId: 'organizer', startAt: null, endAt: null });
    await seedInvite(ctx.db, 'e1', 'invitee');
    return ctx;
  }

  // R8 from the review reproductions: the sweep selected only rows with no
  // log entry, so the first transient failure was the last attempt anyone
  // would ever make.
  it('re-selects an invite whose first delivery attempt failed transiently', async () => {
    const { db, env } = await seedPendingInvite();
    fetchStub = stubFetch([DM_CHANNEL_RULE, dmSendRule(500), membershipRule(200)]);
    await runReminderSweep(env);

    const pending = await db
      .prepare(`SELECT delivered_at, failed_at FROM notification_log WHERE user_id = 'invitee'`)
      .first<{ delivered_at: number | null; failed_at: number | null }>();
    expect(pending?.delivered_at).toBeNull();
    expect(pending?.failed_at).toBeNull();

    // Clear the backoff, let Discord succeed, and sweep again.
    await db.prepare(`UPDATE notification_log SET next_attempt_at = NULL`).run();
    fetchStub.restore();
    fetchStub = stubFetch([DM_CHANNEL_RULE, dmSendRule(200), membershipRule(200)]);
    await runReminderSweep(env);

    const delivered = await db
      .prepare(`SELECT delivered_at FROM notification_log WHERE user_id = 'invitee'`)
      .first<{ delivered_at: number | null }>();
    expect(delivered?.delivered_at).not.toBeNull();
  });

  it('does not re-select an invite that was permanently rejected', async () => {
    const { db, env } = await seedPendingInvite();
    fetchStub = stubFetch([DM_CHANNEL_RULE, dmSendRule(403), membershipRule(200)]);

    await runReminderSweep(env);
    const before = sends(fetchStub);
    await runReminderSweep(env);

    expect(sends(fetchStub)).toBe(before);
    const row = await db
      .prepare(`SELECT failed_at FROM notification_log WHERE user_id = 'invitee'`)
      .first<{ failed_at: number | null }>();
    expect(row?.failed_at).not.toBeNull();
  });

  it('does not re-send a delivered invite on the next tick', async () => {
    const { env } = await seedPendingInvite();
    fetchStub = stubFetch([DM_CHANNEL_RULE, dmSendRule(200), membershipRule(200)]);

    await runReminderSweep(env);
    await runReminderSweep(env);
    await runReminderSweep(env);

    expect(sends(fetchStub)).toBe(1);
  });
});

describe('recurring sweep resilience', () => {
  // R6 from the review reproductions: the override preload ran once for every
  // recurring event in the database, outside the per-event try/catch, so past
  // ~100 events it failed before a single reminder was processed.
  // Runs on the Paid plan deliberately. What this test exists to catch is the
  // preload failure -- which showed up as *zero* events processed -- and that
  // needs a tick whose allowance can actually reach all 150. On the Free
  // plan's fifty queries per invocation no correct implementation can, and
  // asserting otherwise would just be asserting that the budget is broken.
  // The Free-plan behaviour (defer, then resume) is the test below.
  it('processes well past 100 recurring events', async () => {
    const { db, env } = setup('paid');
    await seedGuild(db);
    await seedUser(db, 'organizer');
    await seedMembership(db, 'organizer', 'guild-1');

    const startsIn30Min = new Date(Date.now() + 30 * 60_000);
    const startTime = `${String(startsIn30Min.getUTCHours()).padStart(2, '0')}:${String(startsIn30Min.getUTCMinutes()).padStart(2, '0')}`;

    for (const id of ids('rec', 150)) {
      await seedEvent(db, { id, organizerId: 'organizer', isRecurring: 1, startAt: null, endAt: null });
      await db.prepare(`UPDATE events SET timezone = 'UTC' WHERE id = ?`).bind(id).run();
      await db.prepare(
        `INSERT INTO event_recurrence_rules (event_id, freq, interval, start_date, start_time, duration_minutes, end_type)
         VALUES (?, 'DAILY', 1, ?, ?, 60, 'never')`,
      )
        .bind(id, startsIn30Min.toISOString().slice(0, 10), startTime)
        .run();
    }

    fetchStub = stubFetch([DM_CHANNEL_RULE, dmSendRule(200), membershipRule(200)]);
    await runReminderSweep(env);

    // Every event should have produced reminder rows -- not zero, which is
    // what a preload failure looked like.
    const row = await db
      .prepare(`SELECT COUNT(DISTINCT event_id) AS n FROM notification_log WHERE notification_type LIKE 'reminder%'`)
      .first<{ n: number }>();
    expect(row?.n).toBe(150);
  });

  // The Free plan cannot get through 150 recurring events in one invocation,
  // so the question is not whether it defers but whether deferral loses
  // anything. It must not: each tick has to make forward progress, and the
  // events it didn't reach have to still be reachable on the next one.
  it('works through a backlog across ticks on the Free plan', async () => {
    const { db, env } = setup();
    await seedGuild(db);
    await seedUser(db, 'organizer');
    await seedMembership(db, 'organizer', 'guild-1');

    const startsIn30Min = new Date(Date.now() + 30 * 60_000);
    const startTime = `${String(startsIn30Min.getUTCHours()).padStart(2, '0')}:${String(startsIn30Min.getUTCMinutes()).padStart(2, '0')}`;

    for (const id of ids('rec', 40)) {
      await seedEvent(db, { id, organizerId: 'organizer', isRecurring: 1, startAt: null, endAt: null });
      await db.prepare(`UPDATE events SET timezone = 'UTC' WHERE id = ?`).bind(id).run();
      await db.prepare(
        `INSERT INTO event_recurrence_rules (event_id, freq, interval, start_date, start_time, duration_minutes, end_type)
         VALUES (?, 'DAILY', 1, ?, ?, 60, 'never')`,
      )
        .bind(id, startsIn30Min.toISOString().slice(0, 10), startTime)
        .run();
    }

    fetchStub = stubFetch([DM_CHANNEL_RULE, dmSendRule(200), membershipRule(200)]);

    const covered = async (): Promise<number> => {
      const row = await db
        .prepare(`SELECT COUNT(DISTINCT event_id) AS n FROM notification_log WHERE notification_type LIKE 'reminder%'`)
        .first<{ n: number }>();
      return row?.n ?? 0;
    };

    let previous = 0;
    for (let tick = 0; tick < 20; tick++) {
      db.resetQueryCount();
      await runReminderSweep(env);
      // Every tick stays inside the platform ceiling...
      expect(db.queryCount).toBeLessThan(50);
      const now = await covered();
      // ...and never goes backwards.
      expect(now).toBeGreaterThanOrEqual(previous);
      previous = now;
    }

    // And the backlog is genuinely worked off, not just nibbled at.
    expect(previous).toBe(40);
  });

  it('keeps going when one event has an unusable recurrence rule', async () => {
    const { db, env } = setup();
    await seedGuild(db);
    await seedUser(db, 'organizer');
    await seedMembership(db, 'organizer', 'guild-1');

    const soon = new Date(Date.now() + 30 * 60_000);
    const startTime = `${String(soon.getUTCHours()).padStart(2, '0')}:${String(soon.getUTCMinutes()).padStart(2, '0')}`;

    // One recurring event flagged as recurring but with no rule at all.
    await seedEvent(db, { id: 'broken', organizerId: 'organizer', isRecurring: 1, startAt: null, endAt: null });
    await seedEvent(db, { id: 'good', organizerId: 'organizer', isRecurring: 1, startAt: null, endAt: null });
    await db.prepare(`UPDATE events SET timezone = 'UTC' WHERE id = 'good'`).run();
    await db.prepare(
      `INSERT INTO event_recurrence_rules (event_id, freq, interval, start_date, start_time, duration_minutes, end_type)
       VALUES ('good', 'DAILY', 1, ?, ?, 60, 'never')`,
    )
      .bind(soon.toISOString().slice(0, 10), startTime)
      .run();

    fetchStub = stubFetch([DM_CHANNEL_RULE, dmSendRule(200), membershipRule(200)]);
    await runReminderSweep(env);

    const row = await db
      .prepare(`SELECT COUNT(*) AS n FROM notification_log WHERE event_id = 'good'`)
      .first<{ n: number }>();
    expect(row!.n).toBeGreaterThan(0);
  });
});

describe('idle group nudges', () => {
  async function seedIdleGroup() {
    const ctx = setup();
    await seedGuild(ctx.db);
    await seedUser(ctx.db, 'organizer');
    await seedMembership(ctx.db, 'organizer', 'guild-1');
    const now = Date.now();
    await ctx.db.prepare(
      `INSERT INTO groups (id, guild_id, name, idle_reminder_days, created_by, created_at) VALUES ('grp', 'guild-1', 'Squad', 2, 'organizer', ?)`,
    )
      .bind(now)
      .run();
    await ctx.db.prepare(`INSERT INTO group_members (group_id, user_id, added_at) VALUES ('grp', 'organizer', ?)`)
      .bind(now)
      .run();
    // A finished event ten days ago and nothing since.
    await seedEvent(ctx.db, {
      id: 'past',
      organizerId: 'organizer',
      startAt: now - 10 * DAY_MS,
      endAt: now - 10 * DAY_MS + HOUR_MS,
    });
    await ctx.db.prepare(
      `INSERT INTO event_invites (id, event_id, user_id, invited_via, source_group_id, rsvp_status, invited_at)
       VALUES ('i1', 'past', 'organizer', 'group', 'grp', 'accepted', ?)`,
    )
      .bind(now)
      .run();
    return ctx;
  }

  it('nudges members of a group that has gone quiet', async () => {
    const { db, env } = await seedIdleGroup();
    fetchStub = stubFetch([DM_CHANNEL_RULE, dmSendRule(200), membershipRule(200)]);

    await runReminderSweep(env);

    const row = await db
      .prepare(`SELECT delivered_at FROM group_nudge_log WHERE group_id = 'grp' AND user_id = 'organizer'`)
      .first<{ delivered_at: number | null }>();
    expect(row?.delivered_at).not.toBeNull();
  });

  it('does not nudge the same member twice for one idle episode', async () => {
    const { env } = await seedIdleGroup();
    fetchStub = stubFetch([DM_CHANNEL_RULE, dmSendRule(200), membershipRule(200)]);

    await runReminderSweep(env);
    const after = sends(fetchStub);
    await runReminderSweep(env);

    expect(sends(fetchStub)).toBe(after);
  });

  // The old code recorded the group as nudged whether or not Discord accepted
  // the message, so a rate-limited nudge was lost for good.
  it('retries a nudge that Discord rejected transiently', async () => {
    const { db, env } = await seedIdleGroup();
    fetchStub = stubFetch([DM_CHANNEL_RULE, dmSendRule(500), membershipRule(200)]);
    await runReminderSweep(env);

    let row = await db
      .prepare(`SELECT delivered_at, failed_at FROM group_nudge_log WHERE group_id = 'grp'`)
      .first<{ delivered_at: number | null; failed_at: number | null }>();
    expect(row?.delivered_at).toBeNull();
    expect(row?.failed_at).toBeNull();

    await db.prepare(`UPDATE group_nudge_log SET next_attempt_at = NULL`).run();
    fetchStub.restore();
    fetchStub = stubFetch([DM_CHANNEL_RULE, dmSendRule(200), membershipRule(200)]);
    await runReminderSweep(env);

    row = await db
      .prepare(`SELECT delivered_at, failed_at FROM group_nudge_log WHERE group_id = 'grp'`)
      .first<{ delivered_at: number | null; failed_at: number | null }>();
    expect(row?.delivered_at).not.toBeNull();
  });
});
