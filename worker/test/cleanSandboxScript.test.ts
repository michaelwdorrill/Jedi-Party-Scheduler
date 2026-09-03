import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { seedEvent, seedGuild, seedMembership, seedUser, setup } from './helpers';

// scripts/clean-sandbox.sql. Found while a real `npm run clean:sandbox` run
// against the sandbox database failed with a bare "FOREIGN KEY constraint
// failed" -- item 38's exact failure shape, from a column that didn't exist
// when item 38 was fixed.
//
// migration 0027 (specs/0014 stage 3) added
// events.created_from_poll_id/created_from_option_id, neither with ON DELETE
// CASCADE. created_from_option_id REFERENCES event_poll_options(id), and the
// script deleted event_poll_options before events -- so a still-live
// fanned-out event pointing at a poll's option blocked the poll's own
// options (and therefore the poll itself) from being deleted.
describe('clean-sandbox.sql', () => {
  it('clears a fanned-out event without a foreign-key error', async () => {
    const { db } = setup();
    await seedGuild(db);
    await seedUser(db, 'organizer');
    await seedMembership(db, 'organizer', 'guild-1');

    // The poll a multi-winner option fanned out from -- cancelled and old
    // enough that sweepPurgeTerminalHistory would eventually purge it too
    // (see cron/reminders.ts, which has the identical ordering issue).
    await seedEvent(db, { id: 'poll1', organizerId: 'organizer', eventType: 'poll', status: 'cancelled' });
    await db
      .prepare(`INSERT INTO event_poll_options (id, event_id, start_at, end_at, display_order) VALUES ('opt1', 'poll1', ?, ?, 0)`)
      .bind(Date.now(), Date.now() + 3600_000)
      .run();

    // The fanned-out child: a normal, still-active event that just happens
    // to remember where it came from.
    await seedEvent(db, { id: 'fanned1', organizerId: 'organizer', status: 'active' });
    await db
      .prepare(`UPDATE events SET created_from_poll_id = 'poll1', created_from_option_id = 'opt1' WHERE id = 'fanned1'`)
      .run();

    const sql = readFileSync(join(__dirname, '..', 'scripts', 'clean-sandbox.sql'), 'utf8');
    expect(() => db.raw.exec(sql)).not.toThrow();

    expect((await db.prepare(`SELECT COUNT(*) AS n FROM events`).first<{ n: number }>())?.n).toBe(0);
  });
});
