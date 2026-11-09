import { afterEach, describe, expect, it } from 'vitest';
import { createEventWithInvites } from '../src/lib/eventWrites';
import { runReminderSweep } from '../src/cron/reminders';
import { createSession } from '../src/lib/sessions';
import { signJwt } from '../src/lib/jwt';
import { buildApp } from '../src/router';
import type { Env } from '../src/env';
import type { ShimDatabase } from './d1shim';
import {
  DAY_MS,
  DM_CHANNEL_RULE,
  dmSendRule,
  HOUR_MS,
  membershipRule,
  seedGuild,
  seedMembership,
  seedUser,
  setup,
  stubFetch,
  type FetchStub,
} from './helpers';

// IDEAS 99, found when the 8 November walkthrough's setup had to be cleaned
// off production: cancelling a multi-winner poll told invitees it "didn't get
// enough interest on any day" when the organizer had cancelled it, or that
// voting had closed with days confirmed, when nobody had chosen to keep them.
//
// Michael's call: days that already became their own events stay on. These
// pin the three ways a multi-winner poll can end up cancelled to the notice
// each one now sends.

let fetchStub: FetchStub | null = null;
afterEach(() => {
  fetchStub?.restore();
  fetchStub = null;
});

const NOT_ENOUGH = "didn't get enough interest";
const BY_ORGANIZER = 'was cancelled by the organizer';
const CLOSED_BY_ORGANIZER = 'The organizer closed the poll';

async function seedPoll(db: ShimDatabase, env: Env): Promise<{ pollId: string; optionId: string }> {
  await seedGuild(db);
  for (const user of ['organizer', 'invitee']) {
    await seedUser(db, user);
    await seedMembership(db, user, 'guild-1');
  }
  fetchStub = stubFetch([DM_CHANNEL_RULE, dmSendRule(200), membershipRule(200, { roles: [] })]);
  const base = Date.now();
  const pollId = await createEventWithInvites(env, 'guild-1', 'organizer', {
    title: 'Which nights?',
    description: null,
    game: null,
    eventType: 'poll',
    timezone: 'America/New_York',
    isRecurring: false,
    pollStrategy: 'threshold',
    pollThresholdCount: 2,
    pollDeadlineAt: base + 3 * DAY_MS,
    pollResolutionMode: 'multi_winner',
    pollOptions: [{ startAt: base + 9 * DAY_MS, endAt: base + 9 * DAY_MS + 4 * HOUR_MS }],
    invites: { userIds: ['invitee'], groupIds: [] },
  } as never);
  const option = await db.prepare(`SELECT id FROM event_poll_options WHERE event_id = ?`).bind(pollId).first<{ id: string }>();
  return { pollId, optionId: option!.id };
}

async function as(env: Env, userId: string, path: string, method: string, body?: unknown): Promise<number> {
  const { id } = await createSession(env, userId);
  const token = await signJwt(userId, id, env.JWT_SIGNING_KEY);
  const res = await buildApp().request(
    `https://worker.test${path}`,
    {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    env,
  );
  return res.status;
}

async function sweep(env: Env): Promise<void> {
  for (let i = 0; i < 4; i++) await runReminderSweep(env);
}

function sent(stub: FetchStub): string[] {
  return stub.bodies.filter((b): b is string => !!b);
}

describe('the notice when a multi-winner poll ends cancelled (IDEAS 99)', () => {
  it('says the organizer closed it, and that a day which became its own event is still on', async () => {
    const { db, env } = setup();
    const { pollId, optionId } = await seedPoll(db, env);
    await as(env, 'organizer', `/events/${pollId}/poll/vote`, 'POST', { optionId, vote: 'yes' });
    await as(env, 'invitee', `/events/${pollId}/poll/vote`, 'POST', { optionId, vote: 'yes' });
    await sweep(env); // the day becomes its own event

    expect(await as(env, 'organizer', `/events/${pollId}`, 'DELETE')).toBe(200);
    fetchStub!.bodies.length = 0;
    fetchStub!.calls.length = 0;
    await sweep(env);

    const bodies = sent(fetchStub!);
    expect(bodies.some((b) => b.includes(CLOSED_BY_ORGANIZER) && b.includes('1 day(s) already confirmed are still happening'))).toBe(true);
    expect(bodies.some((b) => b.includes(NOT_ENOUGH))).toBe(false);
    const day = await db
      .prepare(`SELECT status FROM events WHERE created_from_option_id = ?`)
      .bind(optionId)
      .first<{ status: string }>();
    expect(day!.status, 'the day stays on, as decided').toBe('active');
  });

  it('says the organizer cancelled it when nothing was confirmed, not that nobody was interested', async () => {
    const { db, env } = setup();
    const { pollId } = await seedPoll(db, env);
    expect(await as(env, 'organizer', `/events/${pollId}`, 'DELETE')).toBe(200);
    fetchStub!.bodies.length = 0;
    fetchStub!.calls.length = 0;
    await sweep(env);

    const bodies = sent(fetchStub!);
    expect(bodies.some((b) => b.includes(BY_ORGANIZER))).toBe(true);
    expect(bodies.some((b) => b.includes(NOT_ENOUGH))).toBe(false);
  });

  it('keeps the original wording when the deadline closes a poll nobody confirmed', async () => {
    // Invariant guard: the deadline's own cancel must still read as the
    // deadline. Passes before and after the change.
    const { db, env } = setup();
    const { pollId } = await seedPoll(db, env);
    await db.prepare(`UPDATE events SET poll_deadline_at = ? WHERE id = ?`).bind(Date.now() - 60_000, pollId).run();
    fetchStub!.bodies.length = 0;
    fetchStub!.calls.length = 0;
    await sweep(env);

    const status = await db.prepare(`SELECT status FROM events WHERE id = ?`).bind(pollId).first<{ status: string }>();
    expect(status!.status).toBe('cancelled');
    const bodies = sent(fetchStub!);
    expect(bodies.some((b) => b.includes(NOT_ENOUGH))).toBe(true);
    expect(bodies.some((b) => b.includes(BY_ORGANIZER))).toBe(false);
  });
});
