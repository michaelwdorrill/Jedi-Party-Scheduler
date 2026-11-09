import { afterEach, describe, expect, it } from 'vitest';
import { runReminderSweep } from '../src/cron/reminders';
import {
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
import type { ShimDatabase } from './d1shim';

// Walkthrough 5.16 (10 Nov 2026), raised for 1.0 by Michael: a called-off
// day's invite DM still offered I'm in / Maybe / Can't make it. Only poll DMs
// were edited when they settled; a one-off event's invite was never touched on
// cancellation. A press was refused ("not active", 4.12) -- safe, but the
// message went on asking a question about an event that no longer existed.

let fetchStub: FetchStub | null = null;
afterEach(() => {
  fetchStub?.restore();
  fetchStub = null;
});

function edits(stub: FetchStub): { url: string; body: Record<string, unknown> }[] {
  return stub.calls
    .map((url, i) => ({ url, body: stub.bodies[i] }))
    .filter((c) => /\/messages\/[^/]+$/.test(c.url) && c.body)
    .map((c) => ({ url: c.url, body: JSON.parse(c.body!) as Record<string, unknown> }));
}

async function seedCancelledWithInviteDm(db: ShimDatabase, rsvp: 'pending' | 'accepted') {
  await seedGuild(db);
  for (const id of ['organizer', 'guest']) {
    await seedUser(db, id);
    await seedMembership(db, id, 'guild-1');
  }
  await db.prepare(`UPDATE users SET dm_channel_id = 'dm-guest' WHERE id = 'guest'`).run();
  await seedEvent(db, { id: 'e1', organizerId: 'organizer', title: 'Friday thing', status: 'cancelled' });
  await seedInvite(db, 'e1', 'guest');
  if (rsvp === 'accepted') {
    await db
      .prepare(`INSERT INTO event_attendance (id, event_id, occurrence_date, user_id, rsvp_status, responded_at) VALUES ('a1', 'e1', '', 'guest', 'accepted', ?)`)
      .bind(Date.now())
      .run();
  }
  await db
    .prepare(
      `INSERT INTO notification_log (id, user_id, event_id, notification_type, occurrence_date,
         sent_at, delivered_at, attempt_count, content, message_id)
       VALUES ('nl-inv', 'guest', 'e1', 'invite', '', ?, ?, 1, 'You have been invited', 'msg-inv')`,
    )
    .bind(Date.now() - HOUR_MS, Date.now() - HOUR_MS)
    .run();
}

describe("a cancelled event's invite DM", () => {
  // The walkthrough's case: nobody was still coming, so no cancellation notice
  // was owed -- and so nothing ever went back to the invite.
  it('loses its answer buttons and says the event was cancelled, even when nobody was coming', async () => {
    const { db, env } = setup();
    await seedCancelledWithInviteDm(db, 'pending');
    fetchStub = stubFetch([DM_CHANNEL_RULE, { match: '/messages/msg-inv', status: 200, body: {} }, dmSendRule(200), membershipRule(200)]);

    await runReminderSweep(env);

    const [edit] = edits(fetchStub);
    expect(edit, 'the invite DM was edited').toBeDefined();
    expect(edit.url).toContain('/channels/dm-guest/messages/msg-inv');
    expect(edit.body.components).toEqual([]);
    expect(String(edit.body.content)).toContain('"Friday thing" has been cancelled');
  });

  it('is edited once, after the cancellation notice, for someone who was coming', async () => {
    const { db, env } = setup();
    await seedCancelledWithInviteDm(db, 'accepted');
    fetchStub = stubFetch([DM_CHANNEL_RULE, { match: '/messages/msg-inv', status: 200, body: {} }, dmSendRule(200), membershipRule(200)]);

    await runReminderSweep(env);
    await runReminderSweep(env);

    const notice = await db
      .prepare(`SELECT COUNT(*) AS n FROM notification_log WHERE event_id = 'e1' AND user_id = 'guest' AND notification_type = 'event_cancelled'`)
      .first<{ n: number }>();
    expect(notice!.n, 'the cancellation notice still goes out').toBe(1);
    expect(edits(fetchStub)).toHaveLength(1);
  });

  // INVARIANT GUARD, not a reproduction: this passes without the
  // event_type check too, because on an ordinary tick the poll's own sweep runs
  // first and edits the invite with the poll's words. The check is for the tick
  // where that sweep is deferred for budget and this path would otherwise win
  // the one edit an invite gets -- a race this suite can't stage without
  // faking the budget. Kept so the ordinary outcome is pinned.
  it("leaves a cancelled poll's invite to the poll's own wording", async () => {
    const { db, env } = setup();
    await seedCancelledWithInviteDm(db, 'pending');
    await db.prepare(`UPDATE events SET event_type = 'poll', start_at = NULL, end_at = NULL WHERE id = 'e1'`).run();
    fetchStub = stubFetch([DM_CHANNEL_RULE, { match: '/messages/msg-inv', status: 200, body: {} }, dmSendRule(200), membershipRule(200)]);

    await runReminderSweep(env);

    for (const edit of edits(fetchStub)) {
      expect(String(edit.body.content)).not.toContain('has been cancelled by the organizer');
    }
  });
});

// Found on the 10 Nov batch re-check (B9): the sandbox sent nothing at all for
// over an hour after this edit shipped. It charged the tick's budget once per
// recently cancelled one-off on EVERY tick, edited or not, and it runs before
// the new-invites sweep -- so with enough cancellations in the three-day window
// (sixteen did it here) invites never went out. An event whose invites are all
// edited must cost nothing on later ticks.
describe('editing cancelled invites does not starve the rest of the tick', () => {
  it('still sends a new invite with 25 recently cancelled one-offs already edited', async () => {
    const { db, env } = setup();
    await seedGuild(db);
    for (const id of ['organizer', 'guest']) {
      await seedUser(db, id);
      await seedMembership(db, id, 'guild-1');
    }
    await db.prepare(`UPDATE users SET dm_channel_id = 'dm-guest' WHERE id = 'guest'`).run();
    for (let i = 0; i < 25; i++) {
      await seedEvent(db, { id: `c${i}`, organizerId: 'organizer', title: `cancelled ${i}`, status: 'cancelled' });
      await seedInvite(db, `c${i}`, 'guest');
      await db
        .prepare(
          `INSERT INTO notification_log (id, user_id, event_id, notification_type, occurrence_date, sent_at, delivered_at,
             attempt_count, content, message_id, message_edited_at)
           VALUES (?, 'guest', ?, 'invite', '', ?, ?, 1, 'x', ?, ?)`,
        )
        .bind(`nl-${i}`, `c${i}`, Date.now() - HOUR_MS, Date.now() - HOUR_MS, `msg-${i}`, Date.now())
        .run();
    }
    await seedEvent(db, { id: 'fresh', organizerId: 'organizer', title: 'fresh', startAt: Date.now() + 48 * HOUR_MS, endAt: Date.now() + 50 * HOUR_MS });
    await seedInvite(db, 'fresh', 'guest');
    fetchStub = stubFetch([DM_CHANNEL_RULE, { match: '/messages/msg-', status: 200, body: {} }, dmSendRule(200), membershipRule(200)]);

    for (let tick = 0; tick < 3; tick++) await runReminderSweep(env);

    const sent = await db
      .prepare(`SELECT COUNT(*) AS n FROM notification_log WHERE event_id = 'fresh' AND notification_type = 'invite'`)
      .first<{ n: number }>();
    expect(sent!.n, 'the new invite went out within three ticks').toBe(1);
  });
});

// The same re-check, the half bd0d957 left: an event whose edit IS still due
// was charged ahead of new invites, so a pile of unedited cancellations (the
// one that built up before that fix deployed) held invites back for an hour on
// the sandbox. A stale button is survivable; a missing invite is not -- so the
// edits now run after new invites, and a fresh invite goes out on the first
// tick whatever is waiting to be edited.
describe('cancelled invite edits wait behind new invites', () => {
  it('sends a new invite on the first tick with 25 cancelled one-offs still to edit, and edits them all later', async () => {
    const { db, env } = setup();
    await seedGuild(db);
    for (const id of ['organizer', 'guest']) {
      await seedUser(db, id);
      await seedMembership(db, id, 'guild-1');
    }
    await db.prepare(`UPDATE users SET dm_channel_id = 'dm-guest' WHERE id = 'guest'`).run();
    for (let i = 0; i < 25; i++) {
      await seedEvent(db, { id: `c${i}`, organizerId: 'organizer', title: `cancelled ${i}`, status: 'cancelled' });
      await seedInvite(db, `c${i}`, 'guest');
      await db
        .prepare(
          `INSERT INTO notification_log (id, user_id, event_id, notification_type, occurrence_date, sent_at, delivered_at,
             attempt_count, content, message_id)
           VALUES (?, 'guest', ?, 'invite', '', ?, ?, 1, 'x', ?)`,
        )
        .bind(`nl-${i}`, `c${i}`, Date.now() - HOUR_MS, Date.now() - HOUR_MS, `msg-${i}`)
        .run();
      // The organizer's own cancellation notice is already out: notices are
      // meant to go before invites, and this measures the edits alone.
      await db
        .prepare(
          `INSERT INTO notification_log (id, user_id, event_id, notification_type, occurrence_date, sent_at, delivered_at, attempt_count, content)
           VALUES (?, 'organizer', ?, 'event_cancelled', '', ?, ?, 1, 'x')`,
        )
        .bind(`nc-${i}`, `c${i}`, Date.now() - HOUR_MS, Date.now() - HOUR_MS)
        .run();
    }
    await seedEvent(db, { id: 'fresh', organizerId: 'organizer', title: 'fresh', startAt: Date.now() + 48 * HOUR_MS, endAt: Date.now() + 50 * HOUR_MS });
    await seedInvite(db, 'fresh', 'guest');
    fetchStub = stubFetch([DM_CHANNEL_RULE, { match: '/messages/msg-', status: 200, body: {} }, dmSendRule(200), membershipRule(200)]);

    await runReminderSweep(env);
    const sent = await db
      .prepare(`SELECT COUNT(*) AS n FROM notification_log WHERE event_id = 'fresh' AND notification_type = 'invite' AND delivered_at IS NOT NULL`)
      .first<{ n: number }>();
    expect(sent!.n, 'the new invite went out on the first tick').toBe(1);

    for (let tick = 0; tick < 10; tick++) await runReminderSweep(env);
    const left = await db
      .prepare(`SELECT COUNT(*) AS n FROM notification_log WHERE notification_type = 'invite' AND event_id LIKE 'c%' AND message_edited_at IS NULL`)
      .first<{ n: number }>();
    expect(left!.n, 'every cancelled invite was edited eventually').toBe(0);
  });
});
