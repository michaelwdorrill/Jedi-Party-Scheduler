// scripts/seed-google-demo.sql, run against the real schema.
//
// The point of testing a fixture file is not that the SQL parses -- it is that
// the fixture still means what its header says it means. This one exists to
// make a manual verification decisive: two events that MUST reach Google and
// two that MUST NOT. If the "must not" pair ever silently starts syncing, the
// manual test it supports would pass while proving the opposite of what it
// claims, which is worse than having no fixture at all.
//
// So this runs the real sweep's own selection logic over the seeded data and
// asserts the verdict, rather than just counting rows.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTestDb, type ShimDatabase } from './d1shim';
import { desiredOccurrencesFor, SYNC_WINDOW_MS } from '../src/cron/googleSync';
import { runReminderSweep } from '../src/cron/reminders';
import { DM_CHANNEL_RULE, dmSendRule, makeEnv, membershipRule, stubFetch } from './helpers';

const SEED_SQL = readFileSync(join(__dirname, '..', 'scripts', 'seed-google-demo.sql'), 'utf8');

// The operator id the seed keys off, matching wrangler.toml's OWNER_DISCORD_ID
// the same way seed-poll-demo.sql does.
const OPERATOR = '346042183486537730';

// The seed is deliberately a no-op unless the operator is already an active
// member of an allow-listed guild -- every insert is guarded on exactly that,
// so finding neither is a clean no-op rather than the foreign-key error
// IDEAS item 38 was. The sandbox has that state because a real person logs in;
// a fresh test database has to be given it.
function seedOperatorMembership(db: ShimDatabase): void {
  const now = Date.now();
  db.raw.exec(`
    INSERT INTO guilds (id, name, is_active, added_at) VALUES ('guild-real', 'The Real Server', 1, ${now});
    INSERT INTO users (id, username, global_name, avatar_hash, timezone, notifications_enabled,
                       created_at, updated_at, accepted_policy_version, accepted_policy_at)
    VALUES ('${OPERATOR}', 'operator', NULL, NULL, 'America/New_York', 1, ${now}, ${now}, 3, ${now});
    INSERT INTO user_guild_membership (user_id, guild_id, is_member, verified_at)
    VALUES ('${OPERATOR}', 'guild-real', 1, ${now});
  `);
}

describe('seed-google-demo.sql', () => {
  it('applies to a schema built from the migrations, and is re-runnable', () => {
    const db = createTestDb();
    seedOperatorMembership(db);

    expect(() => db.raw.exec(SEED_SQL)).not.toThrow();
    // Re-running is what a fixture gets used for -- seed, look, change
    // something, seed again. Item 38's whole lesson was a seed whose first
    // run's success made the second impossible.
    expect(() => db.raw.exec(SEED_SQL)).not.toThrow();

    const events = db.raw.prepare(`SELECT COUNT(*) AS n FROM events WHERE id LIKE 'gdemo-%'`).get() as { n: number };
    expect(events.n).toBe(4);
  });

  it('is a clean no-op when the operator is not in any allow-listed guild', () => {
    // The guard every insert carries. Without it this would be a bare foreign
    // key error against a database that simply has not been logged into yet.
    const db = createTestDb();
    expect(() => db.raw.exec(SEED_SQL)).not.toThrow();
    const events = db.raw.prepare(`SELECT COUNT(*) AS n FROM events WHERE id LIKE 'gdemo-%'`).get() as { n: number };
    expect(events.n).toBe(0);
  });

  it('syncs exactly the two events it promises, and neither of the two it does not', async () => {
    const db = createTestDb();
    seedOperatorMembership(db);
    db.raw.exec(SEED_SQL);

    const env = makeEnv(db);
    const desired = await desiredOccurrencesFor(env, OPERATOR, Date.now());
    const syncedEventIds = new Set(desired.map((o) => o.eventId));

    // The two that must appear.
    expect(syncedEventIds.has('gdemo-fixed')).toBe(true);
    expect(syncedEventIds.has('gdemo-weekly')).toBe(true);

    // The two that must not, and these are the assertions the fixture exists
    // for: a declined session is a commitment explicitly refused, and an open
    // poll's candidate nights are maybes, not commitments.
    expect(syncedEventIds.has('gdemo-declined')).toBe(false);
    expect(syncedEventIds.has('gdemo-poll')).toBe(false);
  });

  it('expands the weekly series into one entry per occurrence across the window', async () => {
    const db = createTestDb();
    seedOperatorMembership(db);
    db.raw.exec(SEED_SQL);

    const desired = await desiredOccurrencesFor(makeEnv(db), OPERATOR, Date.now());
    const weekly = desired.filter((o) => o.eventId === 'gdemo-weekly');

    // Roughly 60 days of a weekly series, pushed per-occurrence rather than as
    // one RRULE (specs/0017). Asserted as a range rather than an exact count
    // because the first occurrence lands relative to whenever this runs.
    const expected = Math.floor(SYNC_WINDOW_MS / (7 * 24 * 60 * 60 * 1000));
    expect(weekly.length).toBeGreaterThanOrEqual(expected - 1);
    expect(weekly.length).toBeLessThanOrEqual(expected + 1);

    // Each occurrence keys distinctly, which is what stops the link table's
    // UNIQUE(user_id, event_id, occurrence_date) collapsing a series into one
    // entry that gets rewritten every tick.
    expect(new Set(weekly.map((o) => o.occurrenceDate)).size).toBe(weekly.length);
    expect(weekly.every((o) => o.occurrenceDate !== '')).toBe(true);
  });

  // The fixture invites a real person to two events, and sweepNewInvites DMs
  // any invite row with no settled notification_log entry. Without suppression
  // that is two real Discord messages per seed run -- one of them saying
  // "You've been invited to Session You Declined", with RSVP buttons, about an
  // event this seed has already marked declined. Happened on the first live
  // run of this fixture.
  it('does not DM the operator about the invites it plants', async () => {
    const db = createTestDb();
    seedOperatorMembership(db);
    db.raw.exec(SEED_SQL);

    const fetchStub = stubFetch([DM_CHANNEL_RULE, dmSendRule(200), membershipRule(200)]);
    try {
      await runReminderSweep(makeEnv(db));
      const dms = fetchStub.calls.filter((u) => u.includes('/messages'));
      expect(dms).toHaveLength(0);
    } finally {
      fetchStub.restore();
    }
  });

  it('carries the description trap that proves descriptions are never sent', () => {
    const db = createTestDb();
    seedOperatorMembership(db);
    db.raw.exec(SEED_SQL);

    // The fixture's own canary. If someone ever "helpfully" adds the
    // description to the Google payload, this string is what makes that
    // visible on screen rather than only in a spec.
    const row = db.raw
      .prepare(`SELECT description FROM events WHERE id = 'gdemo-fixed'`)
      .get() as { description: string };
    expect(row.description).toContain('MUST NOT REACH GOOGLE');
  });
});
