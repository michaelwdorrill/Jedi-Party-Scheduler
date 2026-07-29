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
// "Which of these users still needs this notification?", expressed as SQL
// fragments a recipient query can splice in rather than as a second query.
//
// Asking separately is what the Pass 9 review measured as unbudgeted work:
// every recipient source that could not answer the question itself issued a
// follow-up `settledRecipients()` read, and those reads were never charged to
// the tick's budget. Twenty of them took a valid tick from a modelled 50 to a
// measured 69 D1 statements, past the Free plan's ceiling, while the budget
// still reported it had stopped safely. Folding the filter into the source
// query removes the statement rather than accounting for it, which is the
// better of the two fixes -- and it makes the query's LIMIT mean "rows worth
// acting on" instead of "rows, most of which may already be done".
//
// Splice `PENDING_NOTIFICATION_JOIN` after the recipient query's other joins
// and `PENDING_NOTIFICATION_WHERE` into its WHERE clause. Bind order follows
// SQL text order: the join's three parameters come at the point the join
// appears, the where's three at the point the predicate appears. The
// recipient table must be aliased `u`.
export const PENDING_NOTIFICATION_JOIN = `
  LEFT JOIN notification_log nl
    ON nl.user_id = u.id AND nl.event_id = ?
    AND nl.notification_type = ? AND nl.occurrence_date = ?`;

export const PENDING_NOTIFICATION_WHERE = `
  u.notifications_enabled = 1
  AND (
    nl.id IS NULL
    OR (nl.delivered_at IS NULL AND nl.failed_at IS NULL
        AND nl.attempt_count < ?
        AND (nl.claimed_until IS NULL OR nl.claimed_until < ?)
        AND (nl.next_attempt_at IS NULL OR nl.next_attempt_at <= ?))
  )`;

export function pendingNotificationJoinBinds(
  eventId: string,
  notificationType: string,
  occurrenceDate: string,
): unknown[] {
  return [eventId, notificationType, occurrenceDate];
}

export function pendingNotificationWhereBinds(now = Date.now()): unknown[] {
  return [MAX_DELIVERY_ATTEMPTS, now, now];
}

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
  // Reserves one delivery's full cost up front. False means this tick cannot
  // afford it, and the caller must not spend anything on it.
  reserveDelivery(cachedChannel: boolean): boolean;
  // Returns a reservation whose delivery never happened, less the single
  // statement the claim attempt itself cost.
  refundUnsentDelivery(cachedChannel: boolean): void;
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

  const cached = recipient.dm_channel_id != null;

  // Reserved *before* the claim, for this recipient's actual cost.
  //
  // The previous ordering asked `budget.exhausted` first and only charged
  // after claiming. `exhausted` is the cheapest-case test -- one subrequest,
  // two statements, the cost of a recipient whose DM channel is already
  // cached -- so with two statements left it reported "not exhausted" while
  // an uncached recipient actually needed three. The claim then ran (one real
  // statement), the charge was refused, and releasing the claim ran another.
  // The budget never moved, so a loop holding a list of uncached recipients
  // repeated that pair indefinitely: two unaccounted statements per recipient,
  // spent by the very mechanism meant to stop spending.
  //
  // Reserving first means a delivery this tick cannot afford costs nothing at
  // all.
  if (budget && !budget.reserveDelivery(cached)) return false;

  const token = newId();
  const held = await claim(env, table, key, token);
  if (!held) {
    // Nothing to send: already delivered, still backing off, or another
    // invocation won the claim. Give back what was reserved, less the one
    // statement the claim attempt actually cost.
    //
    // The refund is what makes reserve-before-claim safe. A tick re-scans far
    // more notifications than it sends, and charging full price for each
    // settled row it looks at would let a large delivered backlog exhaust the
    // allowance without a single DM going out.
    budget?.refundUnsentDelivery(cached);
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
