import type { Env } from '../env';
import { sendBotDm } from './discord';
import { newId } from './ids';

// A leased delivery outbox for bot DMs.
//
// The problem this solves is that "did we already send this?" and "did it
// actually arrive?" are different questions, and a 15-minute cron with
// overlapping invocations needs both. The row's mere existence used to mean
// "sent", so a transient Discord failure looked permanently delivered. 0007
// split the outcome out into delivered_at/failed_at, which fixed that but
// introduced the mirror-image problem: a pending row is retryable, and two
// ticks racing on the same pending row would both send it.
//
// So each attempt takes a *lease*: the claimant writes its own token, reads
// it back, and only proceeds if what came back is its own. Two callers can
// both satisfy the UPDATE's WHERE clause and both see changes = 1 -- last
// write wins -- but only one of them can read its own token back afterwards.
// The lease expires on its own so a worker that dies mid-send doesn't strand
// the row forever.

export interface DmRecipient {
  id: string;
  notifications_enabled: number;
  dm_channel_id: string | null;
  timezone: string;
}

// How long one invocation owns an in-flight attempt. Comfortably longer than
// a DM round trip, comfortably shorter than the 15-minute cron interval, so a
// crashed invocation's rows are reclaimable by the following tick.
export const LEASE_MS = 5 * 60 * 1000;

// First retry lands on the next cron tick; each subsequent one doubles.
const BASE_BACKOFF_MS = 5 * 60 * 1000;
const MAX_BACKOFF_MS = 6 * 60 * 60 * 1000;

// A notification that hasn't got through after this many tries isn't going to.
// Spread across the doubling backoff above, this spans roughly a day and a
// half before the row is marked permanently failed.
const MAX_DELIVERY_ATTEMPTS = 8;

function backoffFor(attempt: number): number {
  return Math.min(BASE_BACKOFF_MS * 2 ** Math.max(0, attempt - 1), MAX_BACKOFF_MS);
}

interface OutboxRow {
  id: string;
  delivered_at: number | null;
  failed_at: number | null;
  attempt_count: number;
  claimed_until: number | null;
  next_attempt_at: number | null;
}

// The set of columns that uniquely identify one logical notification. Both
// tables' UNIQUE constraints are exactly these columns, which is what makes
// the INSERT below a safe claim: a concurrent inserter loses on the
// constraint rather than creating a duplicate.
export type OutboxKey = Record<string, string | number>;

// `table` and the key column names are compile-time constants from this
// codebase -- never request data -- so interpolating them is not an injection
// surface. Every *value* is still bound.
async function claim(
  env: Env,
  table: string,
  key: OutboxKey,
  token: string,
): Promise<{ id: string; attempt: number } | null> {
  const columns = Object.keys(key);
  const values = Object.values(key);
  const where = columns.map((col) => `${col} = ?`).join(' AND ');
  const now = Date.now();

  const existing = await env.DB.prepare(
    `SELECT id, delivered_at, failed_at, attempt_count, claimed_until, next_attempt_at
     FROM ${table} WHERE ${where}`,
  )
    .bind(...values)
    .first<OutboxRow>();

  if (!existing) {
    const id = newId();
    try {
      await env.DB.prepare(
        `INSERT INTO ${table} (id, ${columns.join(', ')}, sent_at, attempt_count, claim_token, claimed_until)
         VALUES (?, ${columns.map(() => '?').join(', ')}, ?, 1, ?, ?)`,
      )
        .bind(id, ...values, now, token, now + LEASE_MS)
        .run();
      return { id, attempt: 1 };
    } catch (err) {
      // A UNIQUE violation means a concurrent invocation inserted the same
      // claim between our SELECT and this INSERT -- that one owns the
      // attempt. Any other failure (D1 outage, schema drift, a bug) must not
      // be swallowed the same way.
      const message = (err as Error).message ?? '';
      if (message.includes('UNIQUE constraint failed')) return null;
      console.error(`outbox insert failed for ${table} ${JSON.stringify(key)}:`, err);
      throw err;
    }
  }

  if (existing.delivered_at != null || existing.failed_at != null) return null; // terminal
  if (existing.next_attempt_at != null && existing.next_attempt_at > now) return null; // backing off
  if (existing.claimed_until != null && existing.claimed_until > now) return null; // in flight elsewhere

  if (existing.attempt_count >= MAX_DELIVERY_ATTEMPTS) {
    console.warn(`outbox giving up on ${table} ${JSON.stringify(key)} after ${existing.attempt_count} attempts`);
    await env.DB.prepare(
      `UPDATE ${table} SET failed_at = ?, claim_token = NULL, claimed_until = NULL WHERE id = ?`,
    )
      .bind(now, existing.id)
      .run();
    return null;
  }

  const claimed = await env.DB.prepare(
    `UPDATE ${table}
     SET claim_token = ?, claimed_until = ?, sent_at = ?, attempt_count = attempt_count + 1, next_attempt_at = NULL
     WHERE id = ? AND delivered_at IS NULL AND failed_at IS NULL
       AND (claimed_until IS NULL OR claimed_until < ?)`,
  )
    .bind(token, now + LEASE_MS, now, existing.id, now)
    .run();
  if (claimed.meta.changes === 0) return null;

  // The UPDATE alone is not exclusive: two invocations can both pass that
  // WHERE clause and both be told they changed a row. Reading the token back
  // is what settles it -- whoever's token survived owns the attempt, and the
  // other one leaves without sending.
  const owner = await env.DB.prepare(`SELECT claim_token, attempt_count FROM ${table} WHERE id = ?`)
    .bind(existing.id)
    .first<{ claim_token: string | null; attempt_count: number }>();
  if (!owner || owner.claim_token !== token) return null;

  return { id: existing.id, attempt: owner.attempt_count };
}

// Sends one DM through the outbox, at most once. Returns true if the message
// reached Discord on this call.
export async function deliverThroughOutbox(
  env: Env,
  table: 'notification_log' | 'group_nudge_log',
  key: OutboxKey,
  recipient: DmRecipient,
  content: string,
): Promise<boolean> {
  if (!recipient.notifications_enabled) return false;

  const token = newId();
  const held = await claim(env, table, key, token);
  if (!held) return false;

  const { result, channelId } = await sendBotDm(
    env.DISCORD_BOT_TOKEN,
    recipient.id,
    content,
    recipient.dm_channel_id,
  );
  if (channelId && channelId !== recipient.dm_channel_id) {
    await env.DB.prepare(`UPDATE users SET dm_channel_id = ? WHERE id = ?`).bind(channelId, recipient.id).run();
  }

  // Every terminal write is guarded on claim_token so a lease that expired
  // mid-send (and was reclaimed by another invocation) can't have its result
  // overwritten by the invocation that lost it.
  if (result.ok) {
    // Discord has genuinely accepted the message at this point -- that part
    // can't be undone. What this checks is narrower: whether *this*
    // invocation still owned the row when it went to record that. With the
    // fetch timeout above now comfortably inside the lease, losing this race
    // shouldn't happen in practice, but the check costs nothing and means
    // the return value never claims ownership it didn't actually have --
    // a losing invocation logs the anomaly instead of silently reporting
    // success as if its bookkeeping were authoritative.
    const write = await env.DB.prepare(
      `UPDATE ${table} SET delivered_at = ?, claim_token = NULL, claimed_until = NULL, next_attempt_at = NULL
       WHERE id = ? AND claim_token = ?`,
    )
      .bind(Date.now(), held.id, token)
      .run();
    if (write.meta.changes === 0) {
      console.warn(`outbox lease lost after a successful send for ${table} ${JSON.stringify(key)} -- delivered, but this invocation's claim had already expired`);
    }
    return true;
  }

  const retryable = result.status === 429 || result.status >= 500 || result.status === 0;
  if (retryable) {
    // Discord's own Retry-After is a floor, not the whole answer: honouring
    // just that would have every rate-limited notification pile back in
    // together a second later.
    const delay = Math.max(result.retryAfterMs ?? 0, backoffFor(held.attempt));
    await env.DB.prepare(
      `UPDATE ${table} SET next_attempt_at = ?, claim_token = NULL, claimed_until = NULL
       WHERE id = ? AND claim_token = ?`,
    )
      .bind(Date.now() + delay, held.id, token)
      .run();
    return false;
  }

  // A permanent 4xx (the recipient blocked DMs, the cached channel is gone,
  // the bot was removed) won't succeed by retrying it verbatim -- mark it
  // terminal so it stops being picked up, without pretending it was delivered.
  await env.DB.prepare(
    `UPDATE ${table} SET failed_at = ?, claim_token = NULL, claimed_until = NULL WHERE id = ? AND claim_token = ?`,
  )
    .bind(Date.now(), held.id, token)
    .run();
  return false;
}
