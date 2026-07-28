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
// So each attempt takes a *lease*, taken by the single upsert in claim()
// below. Because the whole claim is one statement, exclusion comes from the
// database serialising it rather than from a read-back check: the loser's
// WHERE clause no longer matches, so it returns nothing and leaves without
// sending. The lease expires on its own so a worker that dies mid-send
// doesn't strand the row forever.

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
export const MAX_DELIVERY_ATTEMPTS = 8;

function backoffFor(attempt: number): number {
  return Math.min(BASE_BACKOFF_MS * 2 ** Math.max(0, attempt - 1), MAX_BACKOFF_MS);
}

// The set of columns that uniquely identify one logical notification. Both
// tables' UNIQUE constraints are exactly these columns, which is what lets
// claim() below be a single upsert: a concurrent claimant collides on the
// constraint and takes the DO UPDATE branch rather than creating a duplicate.
export type OutboxKey = Record<string, string | number>;

export type OutboxTable = 'notification_log' | 'group_nudge_log';

// Takes the lease in one statement.
//
// This used to be three or four: SELECT the row, INSERT or UPDATE it, then
// SELECT again to check whose token survived. That was correct but it cost
// two D1 queries for *every candidate considered*, including the great
// majority that are already delivered and get rejected. At an event's
// 300-invitee maximum that was ~600 queries in a cron tick whose Free-plan
// allowance is fifty -- and the delivery budget could not prevent it, because
// the spend happened before the budget was consulted.
//
// The upsert collapses all of it. The ON CONFLICT branch's WHERE clause is
// exactly the old sequence of rejection checks -- terminal, backing off,
// leased elsewhere, out of attempts -- so a row that fails any of them is
// simply not updated and RETURNING yields nothing. Winning the race and
// learning that you won are now the same operation, which also removes the
// read-back window the old version needed to paper over.
//
// `table` and the key column names are compile-time constants from this
// codebase -- never request data -- so interpolating them is not an injection
// surface. Every *value* is still bound.
async function claim(
  env: Env,
  table: OutboxTable,
  key: OutboxKey,
  token: string,
): Promise<{ id: string; attempt: number } | null> {
  const columns = Object.keys(key);
  const values = Object.values(key);
  const now = Date.now();

  const { results } = await env.DB.prepare(
    `INSERT INTO ${table} (id, ${columns.join(', ')}, sent_at, attempt_count, claim_token, claimed_until)
     VALUES (?, ${columns.map(() => '?').join(', ')}, ?, 1, ?, ?)
     ON CONFLICT(${columns.join(', ')}) DO UPDATE SET
       claim_token = excluded.claim_token,
       claimed_until = excluded.claimed_until,
       sent_at = excluded.sent_at,
       attempt_count = ${table}.attempt_count + 1,
       next_attempt_at = NULL
     WHERE ${table}.delivered_at IS NULL
       AND ${table}.failed_at IS NULL
       AND ${table}.attempt_count < ?
       AND (${table}.claimed_until IS NULL OR ${table}.claimed_until < ?)
       AND (${table}.next_attempt_at IS NULL OR ${table}.next_attempt_at <= ?)
     RETURNING id, attempt_count`,
  )
    .bind(newId(), ...values, now, token, now + LEASE_MS, MAX_DELIVERY_ATTEMPTS, now, now)
    .all<{ id: string; attempt_count: number }>();

  const row = results[0];
  return row ? { id: row.id, attempt: row.attempt_count } : null;
}

// Rows that have used up MAX_DELIVERY_ATTEMPTS stop being claimable (the
// WHERE above excludes them) but nothing in the delivery path marks them
// terminal any more, since that path no longer reads a row it isn't going to
// claim. One sweep per tick settles them instead -- two statements for the
// whole backlog rather than one per exhausted row per tick.
export async function reapExhaustedDeliveries(env: Env): Promise<void> {
  const now = Date.now();
  for (const table of ['notification_log', 'group_nudge_log'] as const) {
    const res = await env.DB.prepare(
      `UPDATE ${table} SET failed_at = ?, claim_token = NULL, claimed_until = NULL
       WHERE delivered_at IS NULL AND failed_at IS NULL AND attempt_count >= ?
         AND (claimed_until IS NULL OR claimed_until < ?)`,
    )
      .bind(now, MAX_DELIVERY_ATTEMPTS, now)
      .run();
    if (res.meta.changes > 0) {
      console.warn(`outbox gave up on ${res.meta.changes} ${table} row(s) after ${MAX_DELIVERY_ATTEMPTS} attempts`);
    }
  }
}

// Structural, so this module doesn't depend on the cron's budget type -- the
// outbox doesn't care where the allowance comes from, only whether there is
// one left.
export interface DeliveryBudget {
  tryDelivery(cachedChannel?: boolean): boolean;
  readonly exhausted: boolean;
}

// Sends one DM through the outbox, at most once. Returns true if the message
// reached Discord on this call.
export async function deliverThroughOutbox(
  env: Env,
  table: OutboxTable,
  key: OutboxKey,
  recipient: DmRecipient,
  content: string,
  budget?: DeliveryBudget,
): Promise<boolean> {
  if (!recipient.notifications_enabled) return false;

  // Free, and checked first: an exhausted tick must not spend a query
  // claiming something it has already established it cannot send. The old
  // ordering charged the budget only after the claim, which meant every
  // remaining candidate still cost a statement or two apiece after the tick
  // had run out -- the exact overspend the budget exists to prevent.
  if (budget?.exhausted) return false;

  const token = newId();
  const held = await claim(env, table, key, token);
  if (!held) return false;

  // The charge itself still happens after the claim: `exhausted` above is the
  // cheapest-case test, and a recipient with no cached DM channel costs more
  // than that. Rejection here is rare and is not the loop's stop condition --
  // callers watch `exhausted` for that.
  if (budget && !budget.tryDelivery(recipient.dm_channel_id != null)) {
    // Hand the row back exactly as it was found: releasing the lease lets the
    // next tick claim it, and refunding the attempt keeps a deferral from
    // counting against MAX_DELIVERY_ATTEMPTS -- nothing was tried.
    await env.DB.prepare(
      `UPDATE ${table} SET claimed_until = NULL, claim_token = NULL, attempt_count = attempt_count - 1
       WHERE id = ? AND claim_token = ?`,
    )
      .bind(held.id, token)
      .run();
    return false;
  }

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
