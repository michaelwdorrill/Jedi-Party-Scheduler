import { afterEach, describe, expect, it, vi } from 'vitest';
import { runReminderSweep } from '../src/cron/reminders';
import { handleInteraction } from '../src/lib/interactions';
import {
  countRows,
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

// Pass 14 review (September 2026). Two independent reviewers; reviewer A
// withheld sign-off on one P1, reviewer B judged every Pass-13 fix closed and
// found five adjacent defects. Four findings were reported by both.
//
// One describe() per finding, finding id in the title.

let fetchStub: FetchStub | null = null;
afterEach(() => {
  fetchStub?.restore();
  fetchStub = null;
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// P14-01
// ---------------------------------------------------------------------------

// The third of three outgoing paths to carry a user id forward instead of
// deriving recipients live. P12-01 fixed recipient selection, P13-03 fixed
// message editing, and this one -- the change-request decision notice -- keys
// on ecr.requester_id with only guild-membership joins, while selecting the
// event's CURRENT title and the organizer's CURRENT decision note.
//
// So removing a requester, renaming the event and then declining their request
// sends them a first DM containing both new values.
describe('a removed requester gets no decision notice (P14-01)', () => {
  async function seedFiledRequest(db: Awaited<ReturnType<typeof setup>>['db']): Promise<void> {
    await seedGuild(db);
    await seedUser(db, 'organizer');
    await seedUser(db, 'asker');
    await seedMembership(db, 'organizer', 'guild-1');
    await seedMembership(db, 'asker', 'guild-1');
    await db.prepare(`UPDATE users SET dm_channel_id = 'dm-asker' WHERE id = 'asker'`).run();

    const start = Date.now() + 5 * DAY_MS;
    await seedEvent(db, {
      id: 'ev-1',
      organizerId: 'organizer',
      title: 'Ordinary Tuesday Game',
      startAt: start,
      endAt: start + 2 * HOUR_MS,
    });
    await seedInvite(db, 'ev-1', 'asker');
    await seedUser(db, 'newcomer');
    await seedMembership(db, 'newcomer', 'guild-1');

    await db
      .prepare(
        `INSERT INTO event_change_requests
           (id, event_id, requester_id, kind, target_user_id, occurrence_date, status, event_revision, message, created_at)
         VALUES ('cr-1', 'ev-1', 'asker', 'add_invitee', 'newcomer', '', 'pending', 0, 'can my friend come?', ?)`,
      )
      .bind(Date.now())
      .run();
  }

  it('withholds the new title and decision note once access is gone', async () => {
    const { db, env } = setup('paid');
    await seedFiledRequest(db);

    // The organizer removes them, through the same two statements the real
    // invite-removal route runs.
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM event_invites WHERE event_id = 'ev-1' AND user_id = 'asker'`),
      env.DB.prepare(`DELETE FROM event_attendance WHERE event_id = 'ev-1' AND user_id = 'asker'`),
    ]);

    // ...then renames the event and declines with a private note. Both values
    // are created after the removal.
    await db.prepare(`UPDATE events SET title = 'Raid on the Vault -- secret' WHERE id = 'ev-1'`).run();
    await db
      .prepare(
        `UPDATE event_change_requests SET status = 'declined', decision_note = 'no, we moved it off-site', decided_at = ? WHERE id = 'cr-1'`,
      )
      .bind(Date.now())
      .run();

    fetchStub = stubFetch([DM_CHANNEL_RULE, dmSendRule(200), membershipRule(200)]);
    await runReminderSweep(env);

    // Scoped to the removed requester's own DM channel. The organizer also
    // gets notices about their own event and those legitimately carry the
    // title, so asserting over every outgoing body would fail for the wrong
    // reason.
    const toRemoved = fetchStub.calls
      .map((url, i) => ({ url, body: fetchStub!.bodies[i] ?? '' }))
      .filter((c) => c.url.includes('dm-asker'));
    const sentToRemoved = toRemoved.map((c) => c.body).join(' ');

    expect(sentToRemoved, 'the new private title reached a removed requester').not.toContain('Raid on the Vault');
    expect(sentToRemoved, 'the organizer private note reached a removed requester').not.toContain('off-site');
    expect(
      await countRows(db, 'change_request_log', `user_id = 'asker' AND notification_type = 'change_request_decision'`),
    ).toBe(0);
  });

  it('still tells a requester who is still on the event', async () => {
    const { db, env } = setup('paid');
    await seedFiledRequest(db);

    await db.prepare(`UPDATE events SET title = 'Raid on the Vault -- secret' WHERE id = 'ev-1'`).run();
    await db
      .prepare(
        `UPDATE event_change_requests SET status = 'declined', decision_note = 'no, we moved it off-site', decided_at = ? WHERE id = 'cr-1'`,
      )
      .bind(Date.now())
      .run();

    fetchStub = stubFetch([DM_CHANNEL_RULE, dmSendRule(200), membershipRule(200)]);
    await runReminderSweep(env);

    expect(
      await countRows(db, 'change_request_log', `user_id = 'asker' AND notification_type = 'change_request_decision'`),
      'a current invitee stopped being told the outcome of their own request',
    ).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// P14-02
// ---------------------------------------------------------------------------

// The website's loadOwnedActiveEvent requires the organizer to still be a
// current active member of the event's guild -- its comment says
// "leaving/removal revokes control too, not just visibility". Both interaction
// cancel handlers checked organizer identity and event state and stopped
// there, so an authentic press of a control still sitting in an old DM
// cancelled a session the website would have refused with a 404.
//
// A signature proves who pressed the button. It does not prove they may still
// act.
describe('Discord cancel controls respect current guild membership (P14-02)', () => {
  function press(customId: string, userId: string) {
    return {
      type: 3,
      data: { custom_id: customId },
      member: { user: { id: userId } },
      message: { id: 'msg-1', components: [] },
    } as never;
  }

  async function seedOrganizerWhoLeft(db: Awaited<ReturnType<typeof setup>>['db']) {
    await seedGuild(db);
    await seedUser(db, 'organizer');
    await seedMembership(db, 'organizer', 'guild-1');
    const start = Date.now() + 3 * DAY_MS;
    await seedEvent(db, { id: 'ev-1', organizerId: 'organizer', startAt: start, endAt: start + 2 * HOUR_MS });
    await seedEvent(db, { id: 'ev-rec', organizerId: 'organizer', isRecurring: 1, startAt: null, endAt: null });
    // They leave the server. The website refuses every organizer mutation
    // from this point; the retained Discord controls did not.
    await db
      .prepare(`UPDATE user_guild_membership SET is_member = 0 WHERE user_id = 'organizer' AND guild_id = 'guild-1'`)
      .run();
  }

  it('refuses a whole-event cancel from an organizer who has left', async () => {
    const { db, env } = setup('paid');
    await seedOrganizerWhoLeft(db);

    const res = await handleInteraction(env, press('uo:v2:cancel:ev-1', 'organizer'));

    expect(await countRows(db, 'events', `id = 'ev-1' AND status = 'cancelled'`), 'the session was cancelled by someone no longer in the server').toBe(0);
    expect(JSON.stringify(res)).toContain('no longer in that server');
  });

  it('refuses an occurrence cancel from an organizer who has left', async () => {
    const { db, env } = setup('paid');
    await seedOrganizerWhoLeft(db);

    await handleInteraction(env, press('uo:v2:cancelocc:ev-rec:2026-09-20', 'organizer'));

    expect(
      await countRows(db, 'event_occurrence_overrides', `event_id = 'ev-rec' AND is_cancelled = 1`),
      'an occurrence was cancelled by someone no longer in the server',
    ).toBe(0);
  });

  it('still lets a current organizer cancel', async () => {
    const { db, env } = setup('paid');
    await seedGuild(db);
    await seedUser(db, 'organizer');
    await seedMembership(db, 'organizer', 'guild-1');
    const start = Date.now() + 3 * DAY_MS;
    await seedEvent(db, { id: 'ev-1', organizerId: 'organizer', startAt: start, endAt: start + 2 * HOUR_MS });

    await handleInteraction(env, press('uo:v2:cancel:ev-1', 'organizer'));

    expect(await countRows(db, 'events', `id = 'ev-1' AND status = 'cancelled'`)).toBe(1);
  });
});
