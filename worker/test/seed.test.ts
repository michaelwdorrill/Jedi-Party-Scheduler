// scripts/seed-sandbox.sql, run against the real schema.
//
// The file has always claimed "safe to re-run". It wasn't, and the way it
// failed is worth pinning: the first run succeeds, and then the sandbox's own
// cron makes the second run impossible. `group_nudge_log` references both
// `groups` and `users` with no ON DELETE CASCADE, and the seed group sets
// `idle_reminder_days = 0` specifically so the idle sweep fires on the first
// tick -- so fifteen minutes after seeding, the seed can no longer delete its
// own group or users. It came back as a bare
// "FOREIGN KEY constraint failed: SQLITE_CONSTRAINT_FOREIGNKEY" with nothing
// naming the table.
//
// Real data accumulating on the same fixtures is the second half: a group of
// your own on the seed guild, or a seed user added to a group of yours,
// blocked the guild and user deletes respectively.
//
// These tests run the file twice with exactly that state in between.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTestDb } from './d1shim';

const SEED_SQL = readFileSync(join(__dirname, '..', 'scripts', 'seed-sandbox.sql'), 'utf8');

function seed(db: ReturnType<typeof createTestDb>) {
  db.raw.exec(SEED_SQL);
}

describe('seed-sandbox.sql', () => {
  it('applies to a schema built from the migrations', () => {
    const db = createTestDb();
    expect(() => seed(db)).not.toThrow();

    const groups = db.raw.prepare(`SELECT COUNT(*) AS n FROM groups WHERE id LIKE 'seed-%'`).get() as { n: number };
    expect(groups.n).toBe(1);
  });

  it('is re-runnable after the cron has written the nudge rows it is designed to trigger', () => {
    const db = createTestDb();
    seed(db);

    // What sweepIdleGroups writes on the first tick. Neither table cascades
    // from `groups`, which is what made the second run fail.
    db.raw.exec(`
      INSERT INTO group_activity_nudges (group_id, last_event_at, notified_at)
      VALUES ('seed-group-raid', 1, 1);
      INSERT INTO group_nudge_log (id, group_id, user_id, last_event_at, sent_at, attempt_count)
      VALUES ('nudge-1', 'seed-group-raid', 'seed-user-alice', 1, 1, 1);
    `);

    expect(() => seed(db)).not.toThrow();
  });

  it('is re-runnable once real data has been built on top of the fixtures', () => {
    const db = createTestDb();
    seed(db);

    // A real person, a group of their own on the seed guild containing a seed
    // user, and an event of theirs that invited people via the seed group.
    // Each of these blocked a different DELETE in the original file.
    db.raw.exec(`
      INSERT INTO users (id, username, timezone, notifications_enabled, created_at, updated_at)
      VALUES ('real-user', 'real', 'America/New_York', 1, 1, 1);
      INSERT INTO user_guild_membership (user_id, guild_id, is_member, verified_at)
      VALUES ('real-user', 'seed-guild', 1, 1);
      INSERT INTO groups (id, name, created_by, created_at, idle_reminder_days)
      VALUES ('real-group', 'My Crew', 'real-user', 1, 2);
      INSERT INTO group_members (group_id, user_id, added_at)
      VALUES ('real-group', 'real-user', 1), ('real-group', 'seed-user-alice', 1);
      INSERT INTO events (id, guild_id, organizer_id, title, event_type, timezone, start_at, end_at, status, is_recurring, created_at, updated_at)
      VALUES ('real-event', 'seed-guild', 'real-user', 'Mine', 'single', 'America/New_York', 1, 2, 'active', 0, 1, 1);
      INSERT INTO event_invites (id, event_id, user_id, invited_via, source_group_id, rsvp_status, invited_at)
      VALUES ('real-invite', 'real-event', 'seed-user-bob', 'group', 'seed-group-raid', 'pending', 1);
    `);

    expect(() => seed(db)).not.toThrow();

    // None of it collateral damage. The seed owns its own rows and nothing
    // else -- including the seed user someone added to a real group, who
    // stays on that roster.
    const survives = (sql: string) => (db.raw.prepare(sql).get() as { n: number }).n;
    expect(survives(`SELECT COUNT(*) AS n FROM users WHERE id = 'real-user'`)).toBe(1);
    expect(survives(`SELECT COUNT(*) AS n FROM groups WHERE id = 'real-group'`)).toBe(1);
    expect(survives(`SELECT COUNT(*) AS n FROM events WHERE id = 'real-event'`)).toBe(1);
    expect(survives(`SELECT COUNT(*) AS n FROM group_members WHERE group_id = 'real-group' AND user_id = 'seed-user-alice'`)).toBe(1);
    expect(survives(`SELECT COUNT(*) AS n FROM event_invites WHERE id = 'real-invite'`)).toBe(1);

    // The invite's source group was detached rather than deleted, the same
    // way routes/groups.ts detaches on a real group deletion.
    const detached = db.raw
      .prepare(`SELECT source_group_id AS g FROM event_invites WHERE id = 'real-invite'`)
      .get() as { g: string | null };
    expect(detached.g).toBeNull();
  });

  it('leaves the seed idempotent -- a third run changes no counts', () => {
    const db = createTestDb();
    seed(db);
    const counts = () =>
      ['users', 'groups', 'group_members', 'events', 'event_invites'].map(
        (t) => (db.raw.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n,
      );
    const after1 = counts();
    seed(db);
    seed(db);
    expect(counts()).toEqual(after1);
  });
});

// scripts/seed-poll-demo.sql -- the v0.4.5 demo data (ideas 39, 41, 42).
//
// Unlike seed-sandbox.sql it attaches to a *real* account, because a poll
// nobody is invited to appears on nobody's calendar. It therefore looks up
// the operator's id and whichever server they are actually in, and every
// insert is guarded so that finding neither is a clean no-op rather than a
// foreign-key error -- which is how the other seed failed when it was first
// run for real.
const DEMO_SQL = readFileSync(join(__dirname, '..', 'scripts', 'seed-poll-demo.sql'), 'utf8');
const OWNER = '346042183486537730';

function count(db: ReturnType<typeof createTestDb>, sql: string): number {
  return (db.raw.prepare(sql).get() as { n: number }).n;
}

describe('seed-poll-demo.sql', () => {
  it('is a clean no-op when the operator has never logged in', () => {
    const db = createTestDb();
    seed(db);
    expect(() => db.raw.exec(DEMO_SQL)).not.toThrow();
    expect(count(db, `SELECT COUNT(*) AS n FROM events WHERE id LIKE 'demo-%'`)).toBe(0);
  });

  it('builds the poll, its candidates, invites and busy time once they have', () => {
    const db = createTestDb();
    seed(db);
    const now = Date.now();
    db.raw.exec(`
      INSERT INTO guilds (id, name, is_active, added_at) VALUES ('real-guild', 'Sandbox Test Server', 1, ${now});
      INSERT INTO users (id, username, timezone, notifications_enabled, created_at, updated_at)
        VALUES ('${OWNER}', 'michael', 'America/New_York', 1, ${now}, ${now});
      INSERT INTO user_guild_membership (user_id, guild_id, is_member, verified_at)
        VALUES ('${OWNER}', 'real-guild', 1, ${now});
    `);

    expect(() => db.raw.exec(DEMO_SQL)).not.toThrow();

    expect(count(db, `SELECT COUNT(*) AS n FROM events WHERE id = 'demo-poll-nights'`)).toBe(1);
    expect(count(db, `SELECT COUNT(*) AS n FROM event_poll_options WHERE event_id = 'demo-poll-nights'`)).toBe(3);
    // The organiser holds a real invite row too (migration 0019).
    expect(count(db, `SELECT COUNT(*) AS n FROM event_invites WHERE event_id = 'demo-poll-nights'`)).toBe(4);
    expect(count(db, `SELECT COUNT(*) AS n FROM personal_events WHERE id LIKE 'demo-busy-%'`)).toBe(3);
    // The seed users must share the operator's real server or they cannot be
    // invited there and free/busy will not return them.
    expect(
      count(db, `SELECT COUNT(*) AS n FROM user_guild_membership WHERE guild_id = 'real-guild' AND user_id LIKE 'seed-user-%'`),
    ).toBe(3);
    // Everything lands in the guild the operator is actually in, not the
    // synthetic one -- otherwise none of it reaches their calendar.
    expect(count(db, `SELECT COUNT(*) AS n FROM events WHERE id LIKE 'demo-%' AND guild_id = 'real-guild'`)).toBe(3);

    // The v0.4.6 half: the same three candidates as windows, with submitted
    // availability behind each one. Both poll shapes have to be on screen at
    // once or specs/0013's claim that they are one object is unverifiable.
    const windowed = db.raw
      .prepare(`SELECT window_block_minutes AS m FROM events WHERE id = 'demo-poll-windows'`)
      .get() as { m: number | null };
    expect(windowed.m).toBe(150);
    expect(count(db, `SELECT COUNT(*) AS n FROM event_poll_options WHERE event_id = 'demo-poll-windows'`)).toBe(3);
    expect(count(db, `SELECT COUNT(*) AS n FROM event_window_availability WHERE event_id = 'demo-poll-windows'`)).toBe(8);
    // Every window is at least as long as the minimum it demands, or it is a
    // candidate nobody could ever win -- which the server refuses at write
    // time and a fixture has no excuse for either.
    const tooShort = db.raw
      .prepare(
        `SELECT COUNT(*) AS n FROM event_poll_options
          WHERE event_id = 'demo-poll-windows' AND (end_at - start_at) < 150 * 60000`,
      )
      .get() as { n: number };
    expect(tooShort.n).toBe(0);
  });

  it('is re-runnable, and the candidate times stay in the future', () => {
    const db = createTestDb();
    seed(db);
    const now = Date.now();
    db.raw.exec(`
      INSERT INTO guilds (id, name, is_active, added_at) VALUES ('real-guild', 'g', 1, ${now});
      INSERT INTO users (id, username, timezone, notifications_enabled, created_at, updated_at)
        VALUES ('${OWNER}', 'michael', 'America/New_York', 1, ${now}, ${now});
      INSERT INTO user_guild_membership (user_id, guild_id, is_member, verified_at)
        VALUES ('${OWNER}', 'real-guild', 1, ${now});
    `);
    db.raw.exec(DEMO_SQL);
    expect(() => db.raw.exec(DEMO_SQL)).not.toThrow();
    expect(count(db, `SELECT COUNT(*) AS n FROM event_poll_options WHERE event_id = 'demo-poll-nights'`)).toBe(3);

    const earliest = db.raw
      .prepare(`SELECT MIN(start_at) AS n FROM event_poll_options WHERE event_id = 'demo-poll-nights'`)
      .get() as { n: number };
    expect(earliest.n).toBeGreaterThan(now);
  });
});

// scripts/seed-button-demo.sql, tested the same way and for the same reason:
// a seed that fails does so against the real sandbox, minutes after you have
// switched context to look at Discord.
describe('seed-button-demo.sql', () => {
  const BUTTON_SQL = readFileSync(join(__dirname, '..', 'scripts', 'seed-button-demo.sql'), 'utf8');
  const POLL_DEMO_SQL = readFileSync(join(__dirname, '..', 'scripts', 'seed-poll-demo.sql'), 'utf8');
  // seed-sandbox.sql is what creates the seed users; seed-poll-demo.sql only
  // gives them membership of the operator's real guild. Running the chain in
  // the test is what proves the order documented in the file is the real one.
  const OPERATOR = '346042183486537730';

  // What seed-poll-demo.sql needs to find before it does anything: the
  // operator, and an active guild they are actually in.
  function seedOperator(db: ReturnType<typeof createTestDb>) {
    const now = Date.now();
    db.raw.exec(`INSERT INTO guilds (id, name, is_active, added_at) VALUES ('real-guild', 'Real', 1, ${now})`);
    db.raw.exec(
      `INSERT INTO users (id, username, global_name, avatar_hash, timezone, notifications_enabled,
         created_at, updated_at, last_login_at, last_login_attempt_at)
       VALUES ('${OPERATOR}', 'michael', NULL, NULL, 'America/New_York', 1, ${now}, ${now}, ${now}, ${now})`,
    );
    db.raw.exec(
      `INSERT INTO user_guild_membership (user_id, guild_id, is_member, verified_at)
       VALUES ('${OPERATOR}', 'real-guild', 1, ${now})`,
    );
  }

  it('applies to a schema built from the migrations, and is re-runnable', () => {
    const db = createTestDb();
    seedOperator(db);
    db.raw.exec(SEED_SQL);
    db.raw.exec(POLL_DEMO_SQL);

    expect(() => db.raw.exec(BUTTON_SQL)).not.toThrow();
    expect(() => db.raw.exec(BUTTON_SQL)).not.toThrow();

    const events = db.raw.prepare(`SELECT COUNT(*) AS n FROM events WHERE id LIKE 'demo-btn-%'`).get() as { n: number };
    expect(events.n).toBe(2);
  });

  it('invites the operator to events someone else organises, which is the whole point', () => {
    const db = createTestDb();
    seedOperator(db);
    db.raw.exec(SEED_SQL);
    db.raw.exec(POLL_DEMO_SQL);
    db.raw.exec(BUTTON_SQL);

    // If the operator were the organizer, sweepNewInvites would skip them and
    // no DM would ever arrive -- which is exactly why seed-poll-demo.sql does
    // not serve this purpose.
    const organizers = db.raw
      .prepare(`SELECT DISTINCT organizer_id AS o FROM events WHERE id LIKE 'demo-btn-%'`)
      .all() as { o: string }[];
    expect(organizers.map((r) => r.o)).toEqual(['seed-user-alice']);

    const invited = db.raw
      .prepare(`SELECT COUNT(*) AS n FROM event_invites WHERE event_id LIKE 'demo-btn-%' AND user_id = '${OPERATOR}'`)
      .get() as { n: number };
    expect(invited.n).toBe(2);
  });

  it('puts the poll deadline inside the window the deadline sweep scans', () => {
    const db = createTestDb();
    seedOperator(db);
    db.raw.exec(SEED_SQL);
    db.raw.exec(POLL_DEMO_SQL);
    db.raw.exec(BUTTON_SQL);

    const poll = db.raw
      .prepare(`SELECT poll_deadline_at AS d FROM events WHERE id = 'demo-btn-poll'`)
      .get() as { d: number };
    // sweepPollDeadlineReminders looks 24 hours ahead; a deadline outside it
    // is why seed-poll-demo.sql's week-out poll never nudges anyone.
    expect(poll.d).toBeGreaterThan(Date.now());
    expect(poll.d).toBeLessThan(Date.now() + 24 * 60 * 60 * 1000);
  });

  it('is a clean no-op when the operator is not in any active guild', () => {
    const db = createTestDb();
    // No operator, no guild: nothing to hang the fixtures off.
    expect(() => db.raw.exec(BUTTON_SQL)).not.toThrow();
    const events = db.raw.prepare(`SELECT COUNT(*) AS n FROM events WHERE id LIKE 'demo-btn-%'`).get() as { n: number };
    expect(events.n).toBe(0);
  });
});

// scripts/seed-resolve-demo.sql, tested like the others -- and with one extra
// assertion the others do not need: the threshold has to be reachable by a
// single vote, or the fixture cannot demonstrate the thing it exists for.
describe('seed-resolve-demo.sql', () => {
  const RESOLVE_SQL = readFileSync(join(__dirname, '..', 'scripts', 'seed-resolve-demo.sql'), 'utf8');
  const POLL_DEMO_SQL = readFileSync(join(__dirname, '..', 'scripts', 'seed-poll-demo.sql'), 'utf8');
  const OPERATOR = '346042183486537730';

  function seedOperator(db: ReturnType<typeof createTestDb>) {
    const now = Date.now();
    db.raw.exec(`INSERT INTO guilds (id, name, is_active, added_at) VALUES ('real-guild', 'Real', 1, ${now})`);
    db.raw.exec(
      `INSERT INTO users (id, username, global_name, avatar_hash, timezone, notifications_enabled,
         created_at, updated_at, last_login_at, last_login_attempt_at)
       VALUES ('${OPERATOR}', 'michael', NULL, NULL, 'America/New_York', 1, ${now}, ${now}, ${now}, ${now})`,
    );
    db.raw.exec(
      `INSERT INTO user_guild_membership (user_id, guild_id, is_member, verified_at)
       VALUES ('${OPERATOR}', 'real-guild', 1, ${now})`,
    );
  }

  it('applies to a migration-built schema and is re-runnable', () => {
    const db = createTestDb();
    seedOperator(db);
    db.raw.exec(SEED_SQL);
    db.raw.exec(POLL_DEMO_SQL);

    expect(() => db.raw.exec(RESOLVE_SQL)).not.toThrow();
    expect(() => db.raw.exec(RESOLVE_SQL)).not.toThrow();

    const opts = db.raw
      .prepare(`SELECT COUNT(*) AS n FROM event_poll_options WHERE event_id = 'demo-resolve'`)
      .get() as { n: number };
    expect(opts.n).toBe(2);
  });

  it('can be resolved by one vote, which is the whole point of it', () => {
    const db = createTestDb();
    seedOperator(db);
    db.raw.exec(SEED_SQL);
    db.raw.exec(POLL_DEMO_SQL);
    db.raw.exec(RESOLVE_SQL);

    const poll = db.raw
      .prepare(`SELECT poll_strategy, poll_threshold_count, organizer_id FROM events WHERE id = 'demo-resolve'`)
      .get() as { poll_strategy: string; poll_threshold_count: number; organizer_id: string };
    expect(poll.poll_strategy).toBe('threshold');
    expect(poll.poll_threshold_count).toBe(1);
    // Organised by someone else, or sweepNewInvites would skip the operator's
    // row and no DM with a dropdown would ever arrive to press.
    expect(poll.organizer_id).toBe('seed-user-alice');

    const invited = db.raw
      .prepare(`SELECT COUNT(*) AS n FROM event_invites WHERE event_id = 'demo-resolve' AND user_id = '${OPERATOR}'`)
      .get() as { n: number };
    expect(invited.n).toBe(1);
  });

  it('is a clean no-op with no operator in an active guild', () => {
    const db = createTestDb();
    expect(() => db.raw.exec(RESOLVE_SQL)).not.toThrow();
    const events = db.raw.prepare(`SELECT COUNT(*) AS n FROM events WHERE id = 'demo-resolve'`).get() as { n: number };
    expect(events.n).toBe(0);
  });
});

// scripts/clean-sandbox.sql. Tested against a database holding every fixture
// at once, because the failure mode is a foreign key nobody thought about --
// which is precisely how item 38 presented: a bare "FOREIGN KEY constraint
// failed" naming no table, fifteen minutes after the cron had written the
// rows that caused it.
describe('clean-sandbox.sql', () => {
  const CLEAN_SQL = readFileSync(join(__dirname, '..', 'scripts', 'clean-sandbox.sql'), 'utf8');
  const OPERATOR = '346042183486537730';

  function fullSandbox() {
    const db = createTestDb();
    const now = Date.now();
    db.raw.exec(`INSERT INTO guilds (id, name, is_active, added_at) VALUES ('real-guild', 'Real', 1, ${now})`);
    db.raw.exec(
      `INSERT INTO users (id, username, global_name, avatar_hash, timezone, notifications_enabled,
         created_at, updated_at, last_login_at, last_login_attempt_at)
       VALUES ('${OPERATOR}', 'michael', NULL, NULL, 'America/New_York', 1, ${now}, ${now}, ${now}, ${now})`,
    );
    db.raw.exec(
      `INSERT INTO user_guild_membership (user_id, guild_id, is_member, verified_at)
       VALUES ('${OPERATOR}', 'real-guild', 1, ${now})`,
    );
    // Every fixture, so the cleaner meets each shape it will meet for real.
    for (const file of ['seed-sandbox.sql', 'seed-poll-demo.sql', 'seed-button-demo.sql', 'seed-resolve-demo.sql']) {
      db.raw.exec(readFileSync(join(__dirname, '..', 'scripts', file), 'utf8'));
    }
    return db;
  }

  function count(db: ReturnType<typeof createTestDb>, table: string): number {
    return (db.raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  }

  it('empties the schedule without tripping a foreign key', () => {
    const db = fullSandbox();
    expect(count(db, 'events')).toBeGreaterThan(0);
    expect(count(db, 'groups')).toBeGreaterThan(0);

    expect(() => db.raw.exec(CLEAN_SQL)).not.toThrow();

    for (const table of [
      'events',
      'event_invites',
      'event_poll_options',
      'event_poll_votes',
      'event_window_availability',
      'personal_events',
      'groups',
      'group_members',
      'notification_log',
      'group_nudge_log',
    ]) {
      expect({ table, rows: count(db, table) }).toEqual({ table, rows: 0 });
    }
  });

  it('leaves the account, its servers and its session alone', () => {
    const db = fullSandbox();
    db.raw.exec(
      `INSERT INTO sessions (id, user_id, created_at, last_used_at, expires_at, revoked_at, policy_version)
       VALUES ('s1', '${OPERATOR}', ${Date.now()}, ${Date.now()}, ${Date.now() + 86400000}, NULL, 1)`,
    );

    db.raw.exec(CLEAN_SQL);

    // Staying logged in is the difference between a cleanup and a reset.
    expect(count(db, 'sessions')).toBe(1);
    expect(count(db, 'users')).toBeGreaterThan(0);
    expect(count(db, 'guilds')).toBeGreaterThan(0);
    expect(count(db, 'user_guild_membership')).toBeGreaterThan(0);
  });

  it('is re-runnable, and runs on an already-empty database', () => {
    const db = fullSandbox();
    db.raw.exec(CLEAN_SQL);
    expect(() => db.raw.exec(CLEAN_SQL)).not.toThrow();
  });

  it('leaves the fixtures re-seedable afterwards', () => {
    const db = fullSandbox();
    db.raw.exec(CLEAN_SQL);

    // The seed users survive, so the demos can be rebuilt without starting
    // from seed-sandbox.sql again -- except that one recreates its own group,
    // which the cleaner removed, so it goes first.
    expect(() => {
      db.raw.exec(readFileSync(join(__dirname, '..', 'scripts', 'seed-sandbox.sql'), 'utf8'));
      db.raw.exec(readFileSync(join(__dirname, '..', 'scripts', 'seed-poll-demo.sql'), 'utf8'));
      db.raw.exec(readFileSync(join(__dirname, '..', 'scripts', 'seed-button-demo.sql'), 'utf8'));
    }).not.toThrow();
    expect(count(db, 'events')).toBeGreaterThan(0);
  });
});
