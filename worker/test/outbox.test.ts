import { afterEach, describe, expect, it } from 'vitest';
import { deliverThroughOutbox, reapExhaustedDeliveries, LEASE_MS, type DmRecipient } from '../src/lib/outbox';
import { DISCORD_FETCH_TIMEOUT_MS, sendBotDm } from '../src/lib/discord';
import {
  DM_CHANNEL_RULE,
  dmSendRule,
  seedEvent,
  seedGuild,
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

const recipient: DmRecipient = {
  id: 'u1',
  notifications_enabled: 1,
  dm_channel_id: 'dm-channel-1',
  timezone: 'America/New_York',
};

async function seedOutboxFixture() {
  const ctx = setup();
  await seedGuild(ctx.db);
  await seedUser(ctx.db, 'u1');
  await seedEvent(ctx.db, { id: 'e1', organizerId: 'u1' });
  return ctx;
}

const KEY = {
  user_id: 'u1',
  event_id: 'e1',
  notification_type: 'invite',
  occurrence_date: '',
};

async function logRow(db: Awaited<ReturnType<typeof seedOutboxFixture>>['db']) {
  return db
    .prepare(
      `SELECT id, sent_at, delivered_at, failed_at, attempt_count, claim_token, claimed_until, next_attempt_at
       FROM notification_log WHERE user_id = ? AND event_id = ?`,
    )
    .bind('u1', 'e1')
    .first<{
      id: string;
      sent_at: number;
      delivered_at: number | null;
      failed_at: number | null;
      attempt_count: number;
      claim_token: string | null;
      claimed_until: number | null;
      next_attempt_at: number | null;
    }>();
}

function countSends(stub: FetchStub): number {
  return stub.calls.filter((u) => u.includes('/messages')).length;
}

describe('deliverThroughOutbox', () => {
  it('sends once and records delivery', async () => {
    const { db, env } = await seedOutboxFixture();
    fetchStub = stubFetch([DM_CHANNEL_RULE, dmSendRule(200)]);

    expect(await deliverThroughOutbox(env, 'notification_log', KEY, recipient, 'hi')).toBe(true);

    const row = await logRow(db);
    expect(row?.delivered_at).not.toBeNull();
    expect(row?.attempt_count).toBe(1);
    // The lease is released on a terminal outcome.
    expect(row?.claim_token).toBeNull();
    expect(countSends(fetchStub)).toBe(1);
  });

  it('never re-sends a delivered notification', async () => {
    const { env } = await seedOutboxFixture();
    fetchStub = stubFetch([DM_CHANNEL_RULE, dmSendRule(200)]);

    await deliverThroughOutbox(env, 'notification_log', KEY, recipient, 'hi');
    await deliverThroughOutbox(env, 'notification_log', KEY, recipient, 'hi');
    await deliverThroughOutbox(env, 'notification_log', KEY, recipient, 'hi');

    expect(countSends(fetchStub)).toBe(1);
  });

  it('does nothing for a recipient who has turned notifications off', async () => {
    const { env } = await seedOutboxFixture();
    fetchStub = stubFetch([]);

    expect(
      await deliverThroughOutbox(env, 'notification_log', KEY, { ...recipient, notifications_enabled: 0 }, 'hi'),
    ).toBe(false);
    expect(fetchStub.calls).toHaveLength(0);
  });

  // R7 from the review reproductions. Under the previous compare-and-set both
  // callers saw changes = 1 and both sent the DM.
  it('lets only one of two concurrent claimants send', async () => {
    const { env } = await seedOutboxFixture();
    fetchStub = stubFetch([DM_CHANNEL_RULE, dmSendRule(200)]);

    const [a, b] = await Promise.all([
      deliverThroughOutbox(env, 'notification_log', KEY, recipient, 'hi'),
      deliverThroughOutbox(env, 'notification_log', KEY, recipient, 'hi'),
    ]);

    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect(countSends(fetchStub)).toBe(1);
  });

  it('lets only one of many concurrent claimants send', async () => {
    const { env } = await seedOutboxFixture();
    fetchStub = stubFetch([DM_CHANNEL_RULE, dmSendRule(200)]);

    const results = await Promise.all(
      Array.from({ length: 8 }, () => deliverThroughOutbox(env, 'notification_log', KEY, recipient, 'hi')),
    );

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(countSends(fetchStub)).toBe(1);
  });

  it('leaves a 5xx pending with a future retry time, not delivered', async () => {
    const { db, env } = await seedOutboxFixture();
    fetchStub = stubFetch([DM_CHANNEL_RULE, dmSendRule(500)]);

    expect(await deliverThroughOutbox(env, 'notification_log', KEY, recipient, 'hi')).toBe(false);

    const row = await logRow(db);
    expect(row?.delivered_at).toBeNull();
    expect(row?.failed_at).toBeNull();
    expect(row!.next_attempt_at!).toBeGreaterThan(Date.now());
    expect(row?.claim_token).toBeNull(); // lease released so it can be reclaimed
  });

  it('honours the backoff instead of retrying on the very next tick', async () => {
    const { env } = await seedOutboxFixture();
    fetchStub = stubFetch([DM_CHANNEL_RULE, dmSendRule(500)]);

    await deliverThroughOutbox(env, 'notification_log', KEY, recipient, 'hi');
    await deliverThroughOutbox(env, 'notification_log', KEY, recipient, 'hi');

    expect(countSends(fetchStub)).toBe(1);
  });

  // R9 from the review reproductions: an unbounded fetch could still be
  // in-flight when the lease expires, letting a second invocation reclaim
  // and re-send. The fix is bounding both Discord fetches well under the
  // lease -- this is the invariant that makes that fix actually hold.
  it('keeps the Discord fetch timeout comfortably shorter than the outbox lease', () => {
    expect(DISCORD_FETCH_TIMEOUT_MS * 2).toBeLessThan(LEASE_MS);
  });

  it('treats a network failure (not just an HTTP error) as retryable, not a thrown exception', async () => {
    const { db, env } = await seedOutboxFixture();
    fetchStub = stubFetch([DM_CHANNEL_RULE, { match: '/messages', status: 0, networkError: true }]);

    await expect(deliverThroughOutbox(env, 'notification_log', KEY, recipient, 'hi')).resolves.toBe(false);

    const row = await logRow(db);
    expect(row?.delivered_at).toBeNull();
    expect(row?.failed_at).toBeNull();
    expect(row!.next_attempt_at!).toBeGreaterThan(Date.now());
  });

  it('sendBotDm itself never throws for a network failure -- it reports status 0', async () => {
    fetchStub = stubFetch([{ match: '/users/@me/channels', status: 0, networkError: true }]);
    const { result } = await sendBotDm('bot-token', 'u1', 'hi', null);
    expect(result).toEqual({ ok: false, status: 0 });
  });

  it('retries once the backoff has elapsed', async () => {
    const { db, env } = await seedOutboxFixture();
    fetchStub = stubFetch([DM_CHANNEL_RULE, dmSendRule(500)]);
    await deliverThroughOutbox(env, 'notification_log', KEY, recipient, 'hi');

    await db.prepare(`UPDATE notification_log SET next_attempt_at = ? WHERE user_id = ?`)
      .bind(Date.now() - 1000, 'u1')
      .run();
    await deliverThroughOutbox(env, 'notification_log', KEY, recipient, 'hi');

    expect(countSends(fetchStub)).toBe(2);
    expect((await logRow(db))?.attempt_count).toBe(2);
  });

  it('treats a Discord rate limit as retryable and respects retry_after as a floor', async () => {
    const { db, env } = await seedOutboxFixture();
    const hugeRetryAfterSeconds = 60 * 60 * 24; // far longer than the base backoff
    fetchStub = stubFetch([
      DM_CHANNEL_RULE,
      { match: '/messages', status: 429, body: { retry_after: hugeRetryAfterSeconds } },
    ]);

    await deliverThroughOutbox(env, 'notification_log', KEY, recipient, 'hi');

    const row = await logRow(db);
    expect(row?.delivered_at).toBeNull();
    expect(row!.next_attempt_at!).toBeGreaterThan(Date.now() + hugeRetryAfterSeconds * 1000 - 60_000);
  });

  it('marks a permanent 4xx failed and never retries it', async () => {
    const { db, env } = await seedOutboxFixture();
    fetchStub = stubFetch([DM_CHANNEL_RULE, dmSendRule(403)]);

    await deliverThroughOutbox(env, 'notification_log', KEY, recipient, 'hi');
    await deliverThroughOutbox(env, 'notification_log', KEY, recipient, 'hi');

    expect((await logRow(db))?.failed_at).not.toBeNull();
    expect((await logRow(db))?.delivered_at).toBeNull();
    expect(countSends(fetchStub)).toBe(1);
  });

  it('gives up after a bounded number of attempts', async () => {
    const { db, env } = await seedOutboxFixture();
    fetchStub = stubFetch([DM_CHANNEL_RULE, dmSendRule(503)]);

    // Each round clears the backoff so the retry is eligible immediately.
    for (let i = 0; i < 12; i++) {
      await deliverThroughOutbox(env, 'notification_log', KEY, recipient, 'hi');
      await db.prepare(`UPDATE notification_log SET next_attempt_at = NULL WHERE user_id = ?`).bind('u1').run();
    }

    // Attempts stop on their own -- the claim excludes a row that has used up
    // its budget -- but marking it terminal is the reaper's job now, so that
    // the delivery path never pays to read a row it isn't going to claim.
    expect(countSends(fetchStub)).toBeLessThanOrEqual(8);
    expect((await logRow(db))?.failed_at).toBeNull();

    await reapExhaustedDeliveries(env);

    const row = await logRow(db);
    expect(row?.failed_at).not.toBeNull();
    expect(row?.delivered_at).toBeNull();
    expect(countSends(fetchStub)).toBeLessThanOrEqual(8);
  });

  it('the reaper leaves rows that still have attempts left alone', async () => {
    const { db, env } = await seedOutboxFixture();
    fetchStub = stubFetch([DM_CHANNEL_RULE, dmSendRule(503)]);

    await deliverThroughOutbox(env, 'notification_log', KEY, recipient, 'hi');
    await reapExhaustedDeliveries(env);

    // One failed attempt out of eight is a row that should still be retried,
    // not one to give up on.
    const row = await logRow(db);
    expect(row?.failed_at).toBeNull();
    expect(row?.delivered_at).toBeNull();
  });

  it('does not let an unexpired lease be stolen', async () => {
    const { db, env } = await seedOutboxFixture();
    fetchStub = stubFetch([DM_CHANNEL_RULE, dmSendRule(500)]);
    await deliverThroughOutbox(env, 'notification_log', KEY, recipient, 'hi');

    // Model a worker that claimed the row and then died: lease held, no
    // backoff recorded.
    await db.prepare(
      `UPDATE notification_log SET claim_token = 'someone-else', claimed_until = ?, next_attempt_at = NULL
       WHERE user_id = ?`,
    )
      .bind(Date.now() + 60_000, 'u1')
      .run();

    await deliverThroughOutbox(env, 'notification_log', KEY, recipient, 'hi');
    expect(countSends(fetchStub)).toBe(1);
  });

  it('reclaims a row whose lease expired', async () => {
    const { db, env } = await seedOutboxFixture();
    fetchStub = stubFetch([DM_CHANNEL_RULE, dmSendRule(500)]);
    await deliverThroughOutbox(env, 'notification_log', KEY, recipient, 'hi');

    await db.prepare(
      `UPDATE notification_log SET claim_token = 'dead-worker', claimed_until = ?, next_attempt_at = NULL
       WHERE user_id = ?`,
    )
      .bind(Date.now() - 1000, 'u1')
      .run();

    await deliverThroughOutbox(env, 'notification_log', KEY, recipient, 'hi');
    expect(countSends(fetchStub)).toBe(2);
  });

  it('treats a failure to open the DM channel as retryable', async () => {
    const { db, env } = await seedOutboxFixture();
    fetchStub = stubFetch([{ match: '/users/@me/channels', status: 500 }]);

    await deliverThroughOutbox(
      env,
      'notification_log',
      KEY,
      { ...recipient, dm_channel_id: null },
      'hi',
    );

    const row = await logRow(db);
    expect(row?.failed_at).toBeNull();
    expect(row!.next_attempt_at!).toBeGreaterThan(Date.now());
  });

  it('caches a newly opened DM channel on the user', async () => {
    const { db, env } = await seedOutboxFixture();
    fetchStub = stubFetch([DM_CHANNEL_RULE, dmSendRule(200)]);

    await deliverThroughOutbox(env, 'notification_log', KEY, { ...recipient, dm_channel_id: null }, 'hi');

    const user = await db.prepare(`SELECT dm_channel_id FROM users WHERE id = ?`).bind('u1').first<{ dm_channel_id: string }>();
    expect(user?.dm_channel_id).toBe('dm-channel-1');
  });
});

describe('group nudges through the outbox', () => {
  async function seedGroupFixture() {
    const ctx = setup();
    await seedGuild(ctx.db);
    await seedUser(ctx.db, 'u1');
    await ctx.db.prepare(
      `INSERT INTO groups (id, guild_id, name, idle_reminder_days, created_by, created_at) VALUES (?, ?, ?, 2, ?, ?)`,
    )
      .bind('grp-1', 'guild-1', 'Group', 'u1', Date.now())
      .run();
    return ctx;
  }

  const nudgeKey = { group_id: 'grp-1', user_id: 'u1', last_event_at: 1_000 };

  it('does not resend a delivered nudge', async () => {
    const { env } = await seedGroupFixture();
    fetchStub = stubFetch([DM_CHANNEL_RULE, dmSendRule(200)]);

    await deliverThroughOutbox(env, 'group_nudge_log', nudgeKey, recipient, 'nudge');
    await deliverThroughOutbox(env, 'group_nudge_log', nudgeKey, recipient, 'nudge');

    expect(countSends(fetchStub)).toBe(1);
  });

  // The whole point of moving nudges into the outbox: a rate-limited nudge
  // used to be recorded as done and silently dropped.
  it('keeps a rate-limited nudge pending for a later retry', async () => {
    const { db, env } = await seedGroupFixture();
    fetchStub = stubFetch([DM_CHANNEL_RULE, dmSendRule(429)]);

    await deliverThroughOutbox(env, 'group_nudge_log', nudgeKey, recipient, 'nudge');

    const row = await db
      .prepare(`SELECT delivered_at, failed_at, next_attempt_at FROM group_nudge_log WHERE group_id = ?`)
      .bind('grp-1')
      .first<{ delivered_at: number | null; failed_at: number | null; next_attempt_at: number | null }>();
    expect(row?.delivered_at).toBeNull();
    expect(row?.failed_at).toBeNull();
    expect(row!.next_attempt_at!).toBeGreaterThan(Date.now());
  });

  it('treats a new idle episode as a separate nudge', async () => {
    const { env } = await seedGroupFixture();
    fetchStub = stubFetch([DM_CHANNEL_RULE, dmSendRule(200)]);

    await deliverThroughOutbox(env, 'group_nudge_log', nudgeKey, recipient, 'nudge');
    await deliverThroughOutbox(
      env,
      'group_nudge_log',
      { ...nudgeKey, last_event_at: 2_000 },
      recipient,
      'nudge',
    );

    expect(countSends(fetchStub)).toBe(2);
  });
});
