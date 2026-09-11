import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runReminderSweep } from '../src/cron/reminders';
import { MAX_DELIVERY_ATTEMPTS } from '../src/lib/outbox';
import type { ShimDatabase } from './d1shim';
import {
  DAY_MS,
  DM_CHANNEL_RULE,
  dmSendRule,
  HOUR_MS,
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

// Pass 17 review. The P1 is closed, and the one new finding is the fix for
// P16-08 eating itself: widening a candidate query to feed claim() without
// applying claim()'s own eligibility rules.

let fetchStub: FetchStub | null = null;
afterEach(() => {
  fetchStub?.restore();
  fetchStub = null;
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// P17-01
// ---------------------------------------------------------------------------

async function seedOrganizer(db: ShimDatabase): Promise<void> {
  await seedGuild(db, 'guild-1');
  await seedUser(db, 'organizer');
  await seedMembership(db, 'organizer', 'guild-1');
  await db.prepare(`UPDATE users SET dm_channel_id = 'dm-organizer' WHERE id = 'organizer'`).run();
}

// One answered event per notice, so no roster or invite cap is involved.
async function seedNotice(db: ShimDatabase, i: number, opts: { exhausted: boolean }): Promise<void> {
  const responder = `resp-${i}`;
  await seedUser(db, responder);
  await seedMembership(db, responder, 'guild-1');
  const start = Date.now() + 3 * DAY_MS;
  await seedEvent(db, { id: `ev-${i}`, organizerId: 'organizer', startAt: start, endAt: start + HOUR_MS });
  await seedInvite(db, `ev-${i}`, responder);
  // ONE timestamp, used by both rows below. The outbox's LEFT JOIN keys on
  // responded_at, so two separate Date.now() calls that happen to straddle a
  // millisecond boundary make the log row fail to join -- and the notice then
  // reads as brand new instead of exhausted. That is what made the first
  // version of this test count 1 claim sometimes and 2 others, which is a
  // fixture defect dressed as a flaky product.
  const respondedAt = Date.now();
  await db
    .prepare(
      `INSERT INTO event_attendance (id, event_id, user_id, occurrence_date, rsvp_status, responded_at)
       VALUES (?, ?, ?, '', 'accepted', ?)`,
    )
    .bind(`att-${i}`, `ev-${i}`, responder, respondedAt)
    .run();

  if (!opts.exhausted) return;
  // The state eight ordinary 503s leave behind: undelivered, NOT failed, out
  // of attempts, and past its last backoff. Nothing marks this table terminal,
  // so the row stays in exactly this shape forever.
  await db
    .prepare(
      `INSERT INTO organizer_rsvp_notice_log
         (id, organizer_id, event_id, occurrence_date, responder_id, responded_at, sent_at,
          delivered_at, failed_at, attempt_count, next_attempt_at, content)
       VALUES (?, 'organizer', ?, '', ?, ?, ?, NULL, NULL, ?, ?, 'an earlier notice')`,
    )
    .bind(`log-${i}`, `ev-${i}`, responder, respondedAt, respondedAt, MAX_DELIVERY_ATTEMPTS, Date.now() - HOUR_MS)
    .run();
}

describe('exhausted notices do not starve healthy ones (P17-01)', () => {
  // Measured as REFUSED CLAIMS rather than as a starved notice, deliberately.
  //
  // Two fixtures were tried first and neither reproduces reliably. Forty
  // exhausted rows on the Free plan does starve a later notice -- but forty
  // extra events give the sweep's other work enough to do that a Free tick
  // never reaches the organizer notices at all, so it starves for the wrong
  // reason. Filling GLOBAL_SCAN_LIMIT on the paid plan depends on which rows
  // win the page, and this query has no ORDER BY, so that is arbitrary: the
  // healthy row survived the cut on the unfixed tree and the test passed while
  // the defect was present.
  //
  // The claim attempt is the thing the finding is actually about, and it is
  // exact: every ineligible row selected costs one refused statement, every
  // tick, forever. Unfixed that is one per exhausted row; fixed it is zero.
  it('issues no claim at all for a row that has no attempts left', async () => {
    const { db, env } = setup('paid');
    await seedOrganizer(db);
    for (let i = 0; i < 40; i++) await seedNotice(db, i, { exhausted: true });
    await seedNotice(db, 999, { exhausted: false });

    let claimAttempts = 0;
    const counting = new Proxy(env.DB, {
      get(target, prop, receiver) {
        if (prop === 'prepare') {
          return (sql: string) => {
            if (sql.includes('organizer_rsvp_notice_log') && sql.includes('RETURNING id, attempt_count')) {
              claimAttempts += 1;
            }
            return Reflect.get(target, prop, receiver).call(target, sql);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });

    fetchStub = stubFetch([DM_CHANNEL_RULE, dmSendRule(200), membershipRule(200)]);
    await runReminderSweep({ ...env, DB: counting });

    // Exactly one: the healthy notice. The forty exhausted rows are refused by
    // claim() on the unfixed tree, at one statement each, and are not selected
    // at all once the candidate query applies the same rules claim() does.
    expect(
      claimAttempts,
      'a claim was attempted for rows that claim() can only refuse, at one statement each, every tick',
    ).toBe(1);

    const healthy = await db
      .prepare(`SELECT delivered_at FROM organizer_rsvp_notice_log WHERE event_id = 'ev-999'`)
      .first<{ delivered_at: number | null }>();
    expect(healthy?.delivered_at, 'the healthy notice was not delivered').not.toBeNull();
  });

  // The next three are invariant guards, not reproductions: all pass on the
  // unfixed tree, because claim() was already refusing these rows correctly --
  // the defect was the cost of asking, not a wrong answer. They are here
  // because the risk of this narrowing is over-narrowing, and these are the
  // three shapes that must keep working: an exhausted row is excluded rather
  // than rewritten, a row with attempts left is still retried (P16-08's own
  // property), and a live lease is still respected.
  it('leaves the exhausted rows alone rather than terminalising them', async () => {
    const { db, env } = setup();
    await seedOrganizer(db);
    await seedNotice(db, 0, { exhausted: true });

    fetchStub = stubFetch([DM_CHANNEL_RULE, dmSendRule(200), membershipRule(200)]);
    await runReminderSweep(env);

    const row = await db
      .prepare(`SELECT attempt_count, delivered_at, failed_at FROM organizer_rsvp_notice_log WHERE id = 'log-0'`)
      .first<{ attempt_count: number; delivered_at: number | null; failed_at: number | null }>();
    // Excluded from selection, not rewritten. Marking them terminal is a
    // separate decision with its own per-tick cost, and the obstruction is
    // what needed fixing.
    expect(row!.attempt_count).toBe(MAX_DELIVERY_ATTEMPTS);
    expect(row!.delivered_at).toBeNull();
    expect(row!.failed_at).toBeNull();
  });

  it('still retries a row that has attempts left', async () => {
    const { db, env } = setup('paid');
    await seedOrganizer(db);
    await seedNotice(db, 0, { exhausted: false });

    // One transient failure, then healthy: the P16-08 property, which this
    // narrowing must not undo.
    fetchStub = stubFetch([DM_CHANNEL_RULE, dmSendRule(503), membershipRule(200)]);
    await runReminderSweep(env);
    fetchStub.restore();
    await db
      .prepare(`UPDATE organizer_rsvp_notice_log SET next_attempt_at = ? WHERE event_id = 'ev-0'`)
      .bind(Date.now() - 60 * 1000)
      .run();

    fetchStub = stubFetch([DM_CHANNEL_RULE, dmSendRule(200), membershipRule(200)]);
    await runReminderSweep(env);

    const row = await db
      .prepare(`SELECT delivered_at FROM organizer_rsvp_notice_log WHERE event_id = 'ev-0'`)
      .first<{ delivered_at: number | null }>();
    expect(row!.delivered_at, 'P16-08 regressed: a row with attempts left stopped being retried').not.toBeNull();
  });

  it('does not select a row another invocation holds a live lease on', async () => {
    const { db, env } = setup('paid');
    await seedOrganizer(db);
    await seedNotice(db, 0, { exhausted: false });
    await db
      .prepare(
        `INSERT INTO organizer_rsvp_notice_log
           (id, organizer_id, event_id, occurrence_date, responder_id, responded_at, sent_at,
            delivered_at, failed_at, attempt_count, next_attempt_at, claimed_until, content)
         VALUES ('log-0', 'organizer', 'ev-0', '', 'resp-0', ?, ?, NULL, NULL, 1, ?, ?, 'in flight')`,
      )
      .bind(Date.now(), Date.now(), Date.now() - HOUR_MS, Date.now() + 10 * 60 * 1000)
      .run();

    fetchStub = stubFetch([DM_CHANNEL_RULE, dmSendRule(200), membershipRule(200)]);
    await runReminderSweep(env);

    const row = await db
      .prepare(`SELECT delivered_at FROM organizer_rsvp_notice_log WHERE id = 'log-0'`)
      .first<{ delivered_at: number | null }>();
    expect(row!.delivered_at, 'a row under a live lease was delivered twice').toBeNull();
  });
});

// ---------------------------------------------------------------------------
// P17-02
// ---------------------------------------------------------------------------

// Migration 0044 backfilled `applied_at = decided_at` for every accepted row.
// Two successive comments justified that, and both justifications were false:
// first that legacy accepted rows had always applied, then that stamping them
// was harmless because the column only feeds a notice gate. The Pass-17 review
// showed the second one plainly -- the notice is a message asserting the change
// was accepted, so a stamped-but-unapplied row makes the app claim a success
// that did not happen, to the person who asked for it.
//
// The backfill is gone. This guards against its return, because the reasoning
// for putting it back is superficially attractive every time: without it, an
// accepted-and-not-yet-announced request loses its DM.
describe('the migration does not manufacture completion evidence (P17-02)', () => {
  it('contains no backfill of applied_at', () => {
    // readFileSync + join, matching cleanSandboxScript.test.ts. `node:fs/promises`
    // and a URL argument pull in Node type declarations that collide with
    // @cloudflare/workers-types in the test tsconfig -- the tests pass and the
    // typecheck fails, which is the trap this pass has already hit twice.
    const sql = readFileSync(join(__dirname, '..', 'migrations', '0044_change_request_applied.sql'), 'utf8');
    expect(sql).toContain('ADD COLUMN applied_at');
    expect(
      /UPDATE\s+event_change_requests[\s\S]*applied_at\s*=/i.test(sql),
      'the backfill is back: every legacy accepted row is being stamped as applied again, which makes the ' +
        'decision notice assert a success nobody can verify',
    ).toBe(false);
  });

  it('stays silent about an accepted request with no completion record', async () => {
    const { db, env } = setup('paid');
    await seedGuild(db, 'guild-1');
    await seedUser(db, 'organizer');
    await seedUser(db, 'asker');
    await seedMembership(db, 'organizer', 'guild-1');
    await seedMembership(db, 'asker', 'guild-1');
    await db.prepare(`UPDATE users SET dm_channel_id = 'dm-asker' WHERE id = 'asker'`).run();

    const start = Date.now() + 5 * DAY_MS;
    await seedEvent(db, { id: 'ev-1', organizerId: 'organizer', startAt: start, endAt: start + 2 * HOUR_MS });
    await seedInvite(db, 'ev-1', 'asker');
    // The shape a pre-0044 accepted row has after the migration: decided, with
    // nothing recording whether the change landed.
    await db
      .prepare(
        `INSERT INTO event_change_requests
           (id, event_id, requester_id, kind, target_user_id, occurrence_date, status, event_revision,
            proposed_start_at, proposed_end_at, message, created_at, decided_at, decided_by, applied_at)
         VALUES ('cr-1', 'ev-1', 'asker', 'time_change', NULL, '', 'accepted', 0, ?, ?, NULL, ?, ?, 'organizer', NULL)`,
      )
      .bind(start + 3 * HOUR_MS, start + 5 * HOUR_MS, Date.now() - DAY_MS, Date.now() - DAY_MS)
      .run();

    fetchStub = stubFetch([DM_CHANNEL_RULE, dmSendRule(200), membershipRule(200)]);
    await runReminderSweep(env);

    const sent = await db
      .prepare(
        `SELECT COUNT(*) AS n FROM change_request_log
         WHERE user_id = 'asker' AND notification_type = 'change_request_decision'`,
      )
      .first<{ n: number }>();
    expect(
      sent!.n,
      'the requester was told their change was accepted, for a change with no record of ever being applied',
    ).toBe(0);
  });
});
