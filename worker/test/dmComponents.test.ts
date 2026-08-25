import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runReminderSweep } from '../src/cron/reminders';
import { parseCustomId } from '../src/lib/interactions';
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
import type { ShimDatabase } from './d1shim';

let fetchStub: FetchStub | null = null;
afterEach(() => {
  fetchStub?.restore();
  fetchStub = null;
});

// The DM bodies the sweep actually sent, parsed. Asserting on these rather
// than on the builders in isolation is the point: the builders were never the
// risky part, and a control that is built correctly and then not attached is
// exactly the bug this file exists to catch.
function sentMessages(stub: FetchStub): { content: string; components?: unknown[] }[] {
  return stub.calls
    .map((url, i) => ({ url, body: stub.bodies[i] }))
    .filter((c) => c.url.includes('/messages') && c.body)
    .map((c) => JSON.parse(c.body!) as { content: string; components?: unknown[] });
}

interface Button {
  type: number;
  style: number;
  label: string;
  custom_id?: string;
  url?: string;
}
interface Select {
  type: number;
  custom_id: string;
  min_values: number;
  max_values: number;
  options: { label: string; value: string }[];
}
function firstRow<T>(message: { components?: unknown[] }): T[] {
  const row = message.components?.[0] as { components: T[] } | undefined;
  return row?.components ?? [];
}

async function seedInvitee(db: ShimDatabase): Promise<void> {
  await seedGuild(db);
  await seedUser(db, 'organizer');
  await seedUser(db, 'invitee');
  await seedMembership(db, 'organizer', 'guild-1');
  await seedMembership(db, 'invitee', 'guild-1');
}

describe('the controls a DM carries', () => {
  it('puts the three RSVP buttons on an invite to a fixed-time event', async () => {
    const { db, env } = setup();
    await seedInvitee(db);
    await seedEvent(db, { id: 'e1', organizerId: 'organizer', title: 'Game night' });
    await seedInvite(db, 'e1', 'invitee');
    fetchStub = stubFetch([DM_CHANNEL_RULE, dmSendRule(200)]);

    await runReminderSweep(env);

    const [dm] = sentMessages(fetchStub);
    const buttons = firstRow<Button>(dm);
    expect(buttons.map((b) => b.label)).toEqual(["I'm in", 'Maybe', "Can't make it"]);
    // Each one has to carry an id the receiving half can actually read back.
    expect(buttons.map((b) => parseCustomId(b.custom_id))).toEqual([
      { kind: 'rsvp', status: 'accepted', eventId: 'e1' },
      { kind: 'rsvp', status: 'tentative', eventId: 'e1' },
      { kind: 'rsvp', status: 'declined', eventId: 'e1' },
    ]);
  });

  it('puts a select of the candidates on an invite to a poll', async () => {
    const { db, env } = setup();
    await seedInvitee(db);
    await seedEvent(db, {
      id: 'p1',
      organizerId: 'organizer',
      title: 'Which night?',
      eventType: 'poll',
      startAt: null,
      endAt: null,
    });
    await seedInvite(db, 'p1', 'invitee');
    for (const [i, id] of ['o1', 'o2'].entries()) {
      await db
        .prepare(`INSERT INTO event_poll_options (id, event_id, start_at, end_at, display_order) VALUES (?, 'p1', ?, ?, ?)`)
        .bind(id, Date.now() + (i + 1) * DAY_MS, Date.now() + (i + 1) * DAY_MS + 3 * HOUR_MS, i)
        .run();
    }
    fetchStub = stubFetch([DM_CHANNEL_RULE, dmSendRule(200)]);

    await runReminderSweep(env);

    const [dm] = sentMessages(fetchStub);
    const [select] = firstRow<Select>(dm);
    expect(parseCustomId(select.custom_id)).toEqual({ kind: 'vote', eventId: 'p1' });
    expect(select.options.map((o) => o.value)).toEqual(['o1', 'o2']);
    // min_values 0 so "actually, none of these" is expressible at all.
    expect(select.min_values).toBe(0);
    expect(select.max_values).toBe(2);
    // The DM says what the select cannot, rather than letting a picked/not
    // picked control imply a yes/no the app does not record.
    expect(dm.content).toContain('left blank, not refused');
  });

  it('gives a window poll a link instead of a control that would mangle it', async () => {
    const { db, env } = setup();
    await seedInvitee(db);
    await seedEvent(db, {
      id: 'w1',
      organizerId: 'organizer',
      title: 'Find us 3 hours',
      eventType: 'poll',
      startAt: null,
      endAt: null,
    });
    await db.prepare(`UPDATE events SET window_block_minutes = 180 WHERE id = 'w1'`).run();
    await seedInvite(db, 'w1', 'invitee');
    fetchStub = stubFetch([DM_CHANNEL_RULE, dmSendRule(200)]);

    await runReminderSweep(env);

    const [dm] = sentMessages(fetchStub);
    const [button] = firstRow<Button>(dm);
    // Style 5 is a link button: no custom_id, because nothing comes back.
    expect(button.style).toBe(5);
    expect(button.custom_id).toBeUndefined();
    expect(button.url).toContain('/#/events/w1');
  });

  it('puts the buttons on a reminder too, where someone realises they cannot make it', async () => {
    const { db, env } = setup();
    await seedInvitee(db);
    await seedEvent(db, {
      id: 'e2',
      organizerId: 'organizer',
      title: 'Tomorrow night',
      startAt: Date.now() + 20 * HOUR_MS,
      endAt: Date.now() + 23 * HOUR_MS,
    });
    await seedInvite(db, 'e2', 'invitee');
    fetchStub = stubFetch([DM_CHANNEL_RULE, dmSendRule(200)]);

    await runReminderSweep(env);

    const reminder = sentMessages(fetchStub).find((m) => m.content.includes('coming up'));
    expect(reminder).toBeDefined();
    expect(firstRow<Button>(reminder!).map((b) => b.label)).toEqual(["I'm in", 'Maybe', "Can't make it"]);
  });

  it('leaves a cancelled poll with no controls, because there is nothing left to answer', async () => {
    const { db, env } = setup();
    await seedInvitee(db);
    await seedEvent(db, {
      id: 'p2',
      organizerId: 'organizer',
      title: 'Never happened',
      eventType: 'poll',
      status: 'cancelled',
      startAt: null,
      endAt: null,
    });
    await seedInvite(db, 'p2', 'invitee');
    fetchStub = stubFetch([DM_CHANNEL_RULE, dmSendRule(200)]);

    await runReminderSweep(env);

    const dm = sentMessages(fetchStub).find((m) => m.content.includes('was cancelled'));
    expect(dm).toBeDefined();
    expect(dm!.components).toBeUndefined();
  });
});

describe('components survive a failed delivery', () => {
  it('are stored on the row and replayed by the retry, not re-derived', async () => {
    const { db, env } = setup();
    await seedInvitee(db);
    await seedEvent(db, { id: 'e3', organizerId: 'organizer', title: 'Game night' });
    await seedInvite(db, 'e3', 'invitee');

    // First attempt fails the way Discord's 5xx does: retryable, so the row
    // keeps its content and now its components too.
    fetchStub = stubFetch([DM_CHANNEL_RULE, dmSendRule(500)]);
    await runReminderSweep(env);
    fetchStub.restore();

    const row = await db
      .prepare(`SELECT components, next_attempt_at FROM notification_log WHERE event_id = 'e3'`)
      .first<{ components: string | null; next_attempt_at: number | null }>();
    expect(row?.components).toContain('uo:v1:rsvp:accepted:e3');

    // Make the retry due, and let the source sweep no longer be the thing
    // that finds it -- which is the whole reason the columns exist.
    await db.prepare(`UPDATE notification_log SET next_attempt_at = ? WHERE event_id = 'e3'`).bind(Date.now() - 1000).run();
    fetchStub = stubFetch([DM_CHANNEL_RULE, dmSendRule(200)]);
    await runReminderSweep(env);

    const retried = sentMessages(fetchStub).find((m) => m.content.includes('Game night'));
    expect(retried).toBeDefined();
    expect(firstRow<Button>(retried!).map((b) => b.custom_id)).toContain('uo:v1:rsvp:accepted:e3');
  });
});

// The fixture, end to end: does scripts/seed-button-demo.sql actually cause a
// DM with controls to be addressed to the operator? Asserting it here is
// cheaper than discovering it fifteen minutes later by staring at Discord.
describe('scripts/seed-button-demo.sql', () => {
  const OPERATOR = '346042183486537730';

  it('produces a DM to the operator carrying controls, on the next tick', async () => {
    const { db, env } = setup();
    const now = Date.now();
    // The operator and a real guild they are in -- what the seed chain hangs
    // everything off.
    await db.prepare(`INSERT INTO guilds (id, name, is_active, added_at) VALUES ('real-guild', 'Real', 1, ?)`).bind(now).run();
    await seedUser(db, OPERATOR);
    await db
      .prepare(`INSERT INTO user_guild_membership (user_id, guild_id, is_member, verified_at) VALUES (?, 'real-guild', 1, ?)`)
      .bind(OPERATOR, now)
      .run();

    for (const file of ['seed-sandbox.sql', 'seed-poll-demo.sql', 'seed-button-demo.sql']) {
      db.raw.exec(readFileSync(join(__dirname, '..', 'scripts', file), 'utf8'));
    }

    fetchStub = stubFetch([DM_CHANNEL_RULE, dmSendRule(200), membershipRule(200)]);
    // Several ticks, not one, and that is the fixture's real behaviour rather
    // than a concession: a freshly re-run seed-sandbox.sql leaves a backlog of
    // notifications for synthetic users, and on the Free plan's allowance the
    // first tick spends itself on those before it reaches these. The outbox is
    // resumable by construction, so the rest follow on the next ticks -- which
    // on the real sandbox means the second DM can be fifteen minutes behind
    // the first.
    for (let tick = 0; tick < 4; tick++) await runReminderSweep(env);

    const messages = sentMessages(fetchStub);
    const withControls = messages.filter((m) => m.components && m.components.length > 0);
    expect(withControls.length).toBeGreaterThan(0);

    const fixed = messages.find((m) => m.content.includes('Button check (fixed time)'));
    expect(fixed).toBeDefined();
    expect(firstRow<Button>(fixed!).map((b) => b.label)).toEqual(["I'm in", 'Maybe', "Can't make it"]);

    const poll = messages.find((m) => m.content.includes('Button check (which nights?)'));
    expect(poll).toBeDefined();
    const [select] = firstRow<Select>(poll!);
    expect(parseCustomId(select.custom_id)).toEqual({ kind: 'vote', eventId: 'demo-btn-poll' });
    expect(select.options).toHaveLength(3);
  });
});
