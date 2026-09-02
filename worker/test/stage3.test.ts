import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/router';
import { runReminderSweep } from '../src/cron/reminders';
import { recordRsvp } from '../src/lib/attendance';
import { updateEvent, type EventWriteInput } from '../src/lib/eventWrites';
import { cancelCustomId } from '../src/lib/interactions';
import {
  countRows,
  DM_CHANNEL_RULE,
  dmSendRule,
  HOUR_MS,
  loadEventRow,
  membershipRule,
  seedAttendance,
  seedEvent,
  seedGuild,
  seedInvite,
  seedMembership,
  seedUser,
  setup,
  stubFetch,
  type FetchStub,
} from './helpers';
import type { Env } from '../src/env';
import type { ShimDatabase } from './d1shim';

let fetchStub: FetchStub | null = null;
afterEach(() => {
  fetchStub?.restore();
  fetchStub = null;
});

const app = buildApp();

let publicKeyHex = '';
let privateKey: KeyObject;
beforeAll(() => {
  const pair = generateKeyPairSync('ed25519');
  privateKey = pair.privateKey;
  publicKeyHex = Buffer.from(pair.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32)).toString('hex');
});

function signed(body: unknown): { body: string; headers: Record<string, string> } {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const raw = JSON.stringify(body);
  const signature = sign(null, Buffer.from(timestamp + raw, 'utf8'), privateKey).toString('hex');
  return {
    body: raw,
    headers: { 'X-Signature-Ed25519': signature, 'X-Signature-Timestamp': timestamp, 'Content-Type': 'application/json' },
  };
}

function envWithKey(env: Env): Env {
  return { ...env, DISCORD_PUBLIC_KEY: publicKeyHex };
}

async function pressCancel(env: Env, eventId: string, userId: string, content = 'reminder text'): Promise<Response> {
  const { body, headers } = signed({
    type: 3,
    data: { custom_id: cancelCustomId(eventId) },
    user: { id: userId },
    message: { content },
  });
  return app.request('https://worker.test/discord/interactions', { method: 'POST', body, headers }, envWithKey(env));
}

// ---------------------------------------------------------------------------
// Multi-winner fan-out (specs/0014 stage 3)
// ---------------------------------------------------------------------------

async function seedMultiWinnerPoll(
  db: ShimDatabase,
  eventId: string,
  invitees: string[],
): Promise<void> {
  await seedGuild(db);
  await seedUser(db, 'organizer');
  await seedMembership(db, 'organizer', 'guild-1');
  await seedEvent(db, {
    id: eventId,
    organizerId: 'organizer',
    title: 'Which nights?',
    eventType: 'poll',
    startAt: null,
    endAt: null,
  });
  await db.prepare(`UPDATE events SET poll_resolution_mode = 'multi_winner' WHERE id = ?`).bind(eventId).run();
  for (const id of invitees) {
    await seedUser(db, id);
    await seedMembership(db, id, 'guild-1');
    await seedInvite(db, eventId, id);
  }
}

describe('multi-winner fan-out', () => {
  it('creates a standalone event per confirmed option, carrying the invite list and provenance', async () => {
    const { db, env } = setup();
    await seedMultiWinnerPoll(db, 'poll-1', ['alice', 'bob']);
    const start = Date.now() + 5 * 24 * HOUR_MS;
    await db
      .prepare(
        `INSERT INTO event_poll_options (id, event_id, start_at, end_at, display_order, confirmed_at)
         VALUES ('opt-1', 'poll-1', ?, ?, 0, ?)`,
      )
      .bind(start, start + 3 * HOUR_MS, Date.now())
      .run();

    fetchStub = stubFetch([DM_CHANNEL_RULE, dmSendRule(200), membershipRule(200)]);
    await runReminderSweep(env);

    const fanned = await db
      .prepare(`SELECT * FROM events WHERE created_from_option_id = 'opt-1'`)
      .first<{
        id: string;
        title: string;
        event_type: string;
        start_at: number;
        end_at: number;
        status: string;
        created_from_poll_id: string;
        organizer_id: string;
      }>();
    expect(fanned).toBeTruthy();
    expect(fanned!.title).toBe('Which nights?');
    expect(fanned!.event_type).toBe('single');
    expect(fanned!.status).toBe('active');
    expect(fanned!.start_at).toBe(start);
    expect(fanned!.end_at).toBe(start + 3 * HOUR_MS);
    expect(fanned!.created_from_poll_id).toBe('poll-1');
    expect(fanned!.organizer_id).toBe('organizer');

    const invited = await db
      .prepare(`SELECT user_id FROM event_invites WHERE event_id = ? ORDER BY user_id`)
      .bind(fanned!.id)
      .all<{ user_id: string }>();
    expect(invited.results.map((r) => r.user_id)).toEqual(['alice', 'bob']);
  });

  it('is idempotent across repeated sweeps -- one event per option, not one per tick', async () => {
    const { db, env } = setup();
    await seedMultiWinnerPoll(db, 'poll-1', ['alice']);
    const start = Date.now() + 5 * 24 * HOUR_MS;
    await db
      .prepare(
        `INSERT INTO event_poll_options (id, event_id, start_at, end_at, display_order, confirmed_at)
         VALUES ('opt-1', 'poll-1', ?, ?, 0, ?)`,
      )
      .bind(start, start + 3 * HOUR_MS, Date.now())
      .run();

    fetchStub = stubFetch([DM_CHANNEL_RULE, dmSendRule(200), membershipRule(200)]);
    await runReminderSweep(env);
    await runReminderSweep(env);
    await runReminderSweep(env);

    expect(await countRows(db, 'events', `created_from_option_id = 'opt-1'`)).toBe(1);
  });

  it('fans out each confirmed option separately when a poll confirms more than one', async () => {
    const { db, env } = setup();
    await seedMultiWinnerPoll(db, 'poll-1', ['alice']);
    const start = Date.now() + 5 * 24 * HOUR_MS;
    for (const [id, offset] of [['opt-1', 0], ['opt-2', 1]] as [string, number][]) {
      await db
        .prepare(
          `INSERT INTO event_poll_options (id, event_id, start_at, end_at, display_order, confirmed_at)
           VALUES (?, 'poll-1', ?, ?, ?, ?)`,
        )
        .bind(id, start + offset * 24 * HOUR_MS, start + offset * 24 * HOUR_MS + HOUR_MS, offset, Date.now())
        .run();
    }

    fetchStub = stubFetch([DM_CHANNEL_RULE, dmSendRule(200), membershipRule(200)]);
    await runReminderSweep(env);

    expect(await countRows(db, 'events', `created_from_poll_id = 'poll-1'`)).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// The minimum-attendees cascade (decision 4)
// ---------------------------------------------------------------------------

async function seedMinimumEvent(
  db: ShimDatabase,
  eventId: string,
  { autoCancel, invitees = ['alice', 'bob'] }: { autoCancel: boolean; invitees?: string[] },
): Promise<void> {
  await seedGuild(db);
  await seedUser(db, 'organizer');
  await seedMembership(db, 'organizer', 'guild-1');
  await seedEvent(db, { id: eventId, organizerId: 'organizer', title: 'Game night' });
  await db
    .prepare(`UPDATE events SET minimum_attendees = 2, auto_cancel_below_minimum = ? WHERE id = ?`)
    .bind(autoCancel ? 1 : 0, eventId)
    .run();
  for (const id of invitees) {
    await seedUser(db, id);
    await seedMembership(db, id, 'guild-1');
    await seedInvite(db, eventId, id);
    await seedAttendance(db, eventId, id, 'accepted', '');
  }
}

describe('the minimum-attendees cascade', () => {
  it('auto-cancels synchronously the moment a decline drops attendance below the minimum', async () => {
    const { db, env } = setup();
    await seedMinimumEvent(db, 'e1', { autoCancel: true });

    // Confirmed: organizer + alice + bob = 3, well above the minimum of 2.
    // Alice declining leaves organizer + bob = 2, still at the minimum, not
    // below it -- the event must still be active.
    await recordRsvp(env, 'alice', 'e1', '', 'declined');
    expect((await loadEventRow(db, 'e1')).status).toBe('active');

    // Bob declining too leaves only the organizer: 1, below the minimum of
    // 2. This is the write that has to flip the event synchronously, per
    // decision 4 -- no sweep needed for the state itself to be correct.
    await recordRsvp(env, 'bob', 'e1', '', 'declined');
    expect((await loadEventRow(db, 'e1')).status).toBe('cancelled');
  });

  it('sends the cancelled-event notice to whoever is still confirmed, once', async () => {
    const { db, env } = setup();
    await seedMinimumEvent(db, 'e1', { autoCancel: true });
    await recordRsvp(env, 'alice', 'e1', '', 'declined');
    await recordRsvp(env, 'bob', 'e1', '', 'declined');
    expect((await loadEventRow(db, 'e1')).status).toBe('cancelled');

    fetchStub = stubFetch([DM_CHANNEL_RULE, dmSendRule(200), membershipRule(200)]);
    await runReminderSweep(env);

    // The organizer is the only one still "confirmed" (decision 1: implicitly
    // attending unless they declined) -- alice and bob explicitly declined,
    // so they don't get told their own decline cancelled the thing they'd
    // already said they weren't coming to.
    expect(
      await countRows(
        db,
        'notification_log',
        `event_id = 'e1' AND notification_type = 'event_cancelled_below_minimum' AND user_id = 'organizer'`,
      ),
    ).toBe(1);
    expect(
      await countRows(db, 'notification_log', `event_id = 'e1' AND notification_type = 'event_cancelled_below_minimum'`),
    ).toBe(1);

    // One-shot: a second tick must not repeat it.
    await runReminderSweep(env);
    expect(
      await countRows(db, 'notification_log', `event_id = 'e1' AND notification_type = 'event_cancelled_below_minimum'`),
    ).toBe(1);
  });

  it('prompts the organizer instead of auto-cancelling when auto-cancel is off, and only once', async () => {
    const { db, env } = setup();
    await seedMinimumEvent(db, 'e1', { autoCancel: false });
    await recordRsvp(env, 'alice', 'e1', '', 'declined');
    await recordRsvp(env, 'bob', 'e1', '', 'declined');

    // Not auto-cancelled: the synchronous half of the cascade only ever
    // cancels when the organizer opted into that.
    expect((await loadEventRow(db, 'e1')).status).toBe('active');

    fetchStub = stubFetch([DM_CHANNEL_RULE, dmSendRule(200), membershipRule(200)]);
    await runReminderSweep(env);

    expect(
      await countRows(
        db,
        'notification_log',
        `event_id = 'e1' AND notification_type = 'organizer_cancel_prompt' AND user_id = 'organizer'`,
      ),
    ).toBe(1);

    // Still active, and the prompt does not repeat on a later tick even
    // though attendance is still below the minimum.
    await runReminderSweep(env);
    expect((await loadEventRow(db, 'e1')).status).toBe('active');
    expect(
      await countRows(db, 'notification_log', `event_id = 'e1' AND notification_type = 'organizer_cancel_prompt'`),
    ).toBe(1);
  });

  it("does not prompt once attendance has recovered back to the minimum", async () => {
    const { db, env } = setup();
    await seedMinimumEvent(db, 'e1', { autoCancel: false });
    await recordRsvp(env, 'alice', 'e1', '', 'declined');
    await recordRsvp(env, 'bob', 'e1', '', 'declined');

    fetchStub = stubFetch([DM_CHANNEL_RULE, dmSendRule(200), membershipRule(200)]);
    await recordRsvp(env, 'alice', 'e1', '', 'accepted');

    await runReminderSweep(env);
    expect(
      await countRows(db, 'notification_log', `event_id = 'e1' AND notification_type = 'organizer_cancel_prompt'`),
    ).toBe(0);
  });
});

describe("the organizer's cancel button", () => {
  it('cancels the event and rewrites the DM with no components left to press again', async () => {
    const { db, env } = setup();
    await seedMinimumEvent(db, 'e1', { autoCancel: false });
    await recordRsvp(env, 'alice', 'e1', '', 'declined');
    await recordRsvp(env, 'bob', 'e1', '', 'declined');

    const res = await pressCancel(env, 'e1', 'organizer', '"Game night" has dropped below its minimum. Cancel it?');
    expect(res.status).toBe(200);
    const json = (await res.json()) as { type: number; data: { content: string; components: unknown[] } };
    expect(json.type).toBe(7);
    expect(json.data.content).toContain('cancelled');
    expect(json.data.components).toEqual([]);

    expect((await loadEventRow(db, 'e1')).status).toBe('cancelled');
  });

  it('refuses a press from anyone other than the organizer, and leaves the event active', async () => {
    const { db, env } = setup();
    await seedMinimumEvent(db, 'e1', { autoCancel: false });

    const res = await pressCancel(env, 'e1', 'alice');
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { flags?: number; content: string } };
    expect(json.data.content).toContain('organizer');

    expect((await loadEventRow(db, 'e1')).status).toBe('active');
  });
});

// ---------------------------------------------------------------------------
// recordRsvp refuses a write once the event is no longer active
// ---------------------------------------------------------------------------

describe('recordRsvp on an event that is no longer active', () => {
  it('rejects the write rather than recording an answer for a session that no longer exists', async () => {
    const { db, env } = setup();
    await seedGuild(db);
    await seedUser(db, 'organizer');
    await seedUser(db, 'alice');
    await seedMembership(db, 'organizer', 'guild-1');
    await seedMembership(db, 'alice', 'guild-1');
    await seedEvent(db, { id: 'e1', organizerId: 'organizer', status: 'cancelled' });
    await seedInvite(db, 'e1', 'alice');

    const outcome = await recordRsvp(env, 'alice', 'e1', '', 'accepted');
    expect(outcome).toBe('event_not_active');
    expect(await countRows(db, 'event_attendance', `event_id = 'e1' AND user_id = 'alice'`)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Decision 3: a schedule edit clears attendance only if the local date moves
// ---------------------------------------------------------------------------

describe('decision 3: attendance survives a schedule edit unless the local date moves', () => {
  async function seedAnsweredEvent(db: ShimDatabase, startAt: number, timezone = 'America/New_York'): Promise<void> {
    await seedGuild(db);
    await seedUser(db, 'organizer');
    await seedUser(db, 'alice');
    await seedMembership(db, 'organizer', 'guild-1');
    await seedMembership(db, 'alice', 'guild-1');
    await seedEvent(db, { id: 'e1', organizerId: 'organizer', startAt, endAt: startAt + HOUR_MS });
    await db.prepare(`UPDATE events SET timezone = ? WHERE id = 'e1'`).bind(timezone).run();
    await seedInvite(db, 'e1', 'alice');
    await seedAttendance(db, 'e1', 'alice', 'accepted', '');
  }

  it('keeps attendance when only the time-of-day moves within the same local day', async () => {
    const { db, env } = setup();
    // 6pm Eastern on a given day.
    const start = Date.parse('2026-09-10T22:00:00.000Z');
    await seedAnsweredEvent(db, start, 'America/New_York');

    // Move to 8pm the same evening -- still 2026-09-10 in America/New_York.
    await updateEvent(
      env,
      'e1',
      'guild-1',
      { isRecurring: false, startAt: start + 2 * HOUR_MS, endAt: start + 3 * HOUR_MS } as Partial<EventWriteInput>,
      await loadEventRow(db, 'e1'),
    );

    expect(await countRows(db, 'event_attendance', `event_id = 'e1' AND user_id = 'alice'`)).toBe(1);
  });

  it('clears attendance when the edit moves the event to a different local day', async () => {
    const { db, env } = setup();
    const start = Date.parse('2026-09-10T22:00:00.000Z');
    await seedAnsweredEvent(db, start, 'America/New_York');

    // A day later.
    await updateEvent(
      env,
      'e1',
      'guild-1',
      { isRecurring: false, startAt: start + 24 * HOUR_MS, endAt: start + 25 * HOUR_MS } as Partial<EventWriteInput>,
      await loadEventRow(db, 'e1'),
    );

    expect(await countRows(db, 'event_attendance', `event_id = 'e1' AND user_id = 'alice'`)).toBe(0);
  });

  it('clears attendance when only the timezone changes but the displayed date does too', async () => {
    const { db, env } = setup();
    // 11pm Eastern on 2026-09-10.
    const start = Date.parse('2026-09-11T03:00:00.000Z');
    await seedAnsweredEvent(db, start, 'America/New_York');

    // Same UTC instant, but the organizer fixes the timezone to one where
    // this instant reads as the *next* calendar day -- decision 3's own
    // test ("if we move it to a different day, you'll be asked again") is
    // about what the invitee sees, not the underlying instant.
    await updateEvent(
      env,
      'e1',
      'guild-1',
      { isRecurring: false, startAt: start, endAt: start + HOUR_MS, timezone: 'Pacific/Auckland' } as Partial<EventWriteInput>,
      await loadEventRow(db, 'e1'),
    );

    expect(await countRows(db, 'event_attendance', `event_id = 'e1' AND user_id = 'alice'`)).toBe(0);
  });
});
