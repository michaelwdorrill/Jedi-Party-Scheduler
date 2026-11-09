import { afterEach, describe, expect, it } from 'vitest';
import { createEventWithInvites } from '../src/lib/eventWrites';
import { runReminderSweep } from '../src/cron/reminders';
import { recordPollSelection } from '../src/lib/polls';
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

// IDEAS 97, found on the first browser walkthrough: on a multi-winner poll,
// "Can't make it" on a confirmed day left it confirmed -- and once the day had
// become its own event, the answer reached nothing at all, so the real session
// went on counting the person who had just said they could not come.
//
// Michael's call was that a day drops back when it falls below the poll's
// threshold. Two halves, because a confirmed day lives in two shapes:
//
//   - before the reminder sweep fans it out, nobody has been told, so it simply
//     un-confirms and can confirm again;
//   - after, it is a real event people were invited to, so it is called off
//     there -- by the event inheriting the threshold as its minimum, which is
//     the existing minimum-attendees cascade, notice to everyone still coming
//     included.

let fetchStub: FetchStub | null = null;
afterEach(() => {
  fetchStub?.restore();
  fetchStub = null;
});

const CANCEL_NOTICE = 'attendance dropped below the minimum';

async function seedPoll(
  db: ShimDatabase,
  env: Env,
  { threshold, invitees, windowed = false }: { threshold: number; invitees: string[]; windowed?: boolean },
): Promise<{ pollId: string; optionId: string }> {
  await seedGuild(db);
  for (const user of ['organizer', ...invitees]) {
    await seedUser(db, user);
    await seedMembership(db, user, 'guild-1');
  }
  fetchStub = stubFetch([DM_CHANNEL_RULE, dmSendRule(200), membershipRule(200, { roles: [] })]);
  const base = Date.now();
  const slot = { startAt: base + 9 * DAY_MS, endAt: base + 9 * DAY_MS + 4 * HOUR_MS };
  const pollId = await createEventWithInvites(env, 'guild-1', 'organizer', {
    title: 'Which nights?',
    description: null,
    game: null,
    eventType: 'poll',
    timezone: 'America/New_York',
    isRecurring: false,
    pollStrategy: 'threshold',
    pollThresholdCount: threshold,
    pollDeadlineAt: base + 3 * DAY_MS,
    pollResolutionMode: 'multi_winner',
    pollOptions: [slot],
    ...(windowed ? { windowBlockMinutes: 120 } : {}),
    invites: { userIds: invitees, groupIds: [] },
  } as never);
  const option = await db
    .prepare(`SELECT id FROM event_poll_options WHERE event_id = ?`)
    .bind(pollId)
    .first<{ id: string }>();
  return { pollId, optionId: option!.id };
}

async function authed(env: Env, userId: string): Promise<string> {
  const { id } = await createSession(env, userId);
  return signJwt(userId, id, env.JWT_SIGNING_KEY);
}

async function vote(env: Env, pollId: string, optionId: string, userId: string, answer: 'yes' | 'no' | 'maybe') {
  const res = await buildApp().request(
    `https://worker.test/events/${pollId}/poll/vote`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${await authed(env, userId)}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ optionId, vote: answer }),
    },
    env,
  );
  return { status: res.status, text: await res.text() };
}

async function isConfirmed(db: ShimDatabase, optionId: string): Promise<boolean> {
  const row = await db
    .prepare(`SELECT confirmed_at FROM event_poll_options WHERE id = ?`)
    .bind(optionId)
    .first<{ confirmed_at: number | null }>();
  return row!.confirmed_at != null;
}

async function session(db: ShimDatabase, optionId: string) {
  return db
    .prepare(
      `SELECT id, status, minimum_attendees, auto_cancel_below_minimum FROM events WHERE created_from_option_id = ?`,
    )
    .bind(optionId)
    .first<{ id: string; status: string; minimum_attendees: number | null; auto_cancel_below_minimum: number }>();
}

async function sweep(env: Env, ticks = 4): Promise<void> {
  for (let i = 0; i < ticks; i++) await runReminderSweep(env);
}

describe('a confirmed multi-winner day that drops below its threshold (IDEAS 97)', () => {
  it('un-confirms, and can confirm again, before it has become its own event', async () => {
    const { db, env } = setup();
    const { pollId, optionId } = await seedPoll(db, env, { threshold: 2, invitees: ['invitee'] });

    await vote(env, pollId, optionId, 'organizer', 'yes');
    await vote(env, pollId, optionId, 'invitee', 'yes');
    expect(await isConfirmed(db, optionId)).toBe(true);

    expect((await vote(env, pollId, optionId, 'invitee', 'no')).status).toBe(200);
    expect(await isConfirmed(db, optionId), 'one yes against a threshold of two is not confirmed').toBe(false);

    await vote(env, pollId, optionId, 'invitee', 'yes');
    expect(await isConfirmed(db, optionId)).toBe(true);
  });

  it('gives the day its threshold as a minimum, and counts the people who said yes', async () => {
    const { db, env } = setup();
    const { pollId, optionId } = await seedPoll(db, env, { threshold: 2, invitees: ['invitee', 'other'] });
    await vote(env, pollId, optionId, 'organizer', 'yes');
    await vote(env, pollId, optionId, 'invitee', 'yes');
    await vote(env, pollId, optionId, 'other', 'no');
    await sweep(env);

    const day = await session(db, optionId);
    expect(day).toMatchObject({ status: 'active', minimum_attendees: 2, auto_cancel_below_minimum: 1 });
    const { results } = await db
      .prepare(`SELECT user_id, rsvp_status FROM event_attendance WHERE event_id = ? ORDER BY user_id`)
      .bind(day!.id)
      .all<{ user_id: string; rsvp_status: string }>();
    // Every answer carried over (P24-02): the yes-voters as accepted, and the
    // no-voter as declined rather than left as "no answer" -- so they are not
    // reminded about a night they said they could not make.
    expect(results).toEqual([
      { user_id: 'invitee', rsvp_status: 'accepted' },
      { user_id: 'organizer', rsvp_status: 'accepted' },
      { user_id: 'other', rsvp_status: 'declined' },
    ]);
  });

  // Pass 24 review, P24-02. An organizer with no attendance row counts as going
  // by default, so when only yes-votes were carried, an organizer who voted
  // "Can't make it" before fan-out was shown "yes" on the poll row, listed as
  // confirmed, and counted toward the minimum: the day then survived a dropout
  // that takes the poll's own count below its threshold.
  it("carries the organizer's Can't make it into the day, so it is neither shown as yes nor counted", async () => {
    const { db, env } = setup();
    const { pollId, optionId } = await seedPoll(db, env, { threshold: 2, invitees: ['a', 'b'] });
    await vote(env, pollId, optionId, 'organizer', 'no');
    await vote(env, pollId, optionId, 'a', 'yes');
    await vote(env, pollId, optionId, 'b', 'yes');
    await sweep(env);
    const day = await session(db, optionId);
    expect(day!.status).toBe('active');

    const res = await buildApp().request(
      `https://worker.test/events/${pollId}`,
      { headers: { Authorization: `Bearer ${await authed(env, 'organizer')}` } },
      env,
    );
    const body = (await res.json()) as { pollOptions: { myVote: string | null; confirmedUsers: { userId: string }[] }[] };
    const option = body.pollOptions[0];
    expect(option.myVote, 'the poll row shows the answer the organizer gave').toBe('no');
    expect(option.confirmedUsers.map((u) => u.userId).sort()).toEqual(['a', 'b']);

    // One dropout takes the day to one yes against a threshold of two.
    await vote(env, pollId, optionId, 'a', 'no');
    expect((await session(db, optionId))!.status).toBe('cancelled');
  });

  it("calls the day off when a Can't make it on the poll takes it below, and tells whoever is still coming", async () => {
    const { db, env } = setup();
    const { pollId, optionId } = await seedPoll(db, env, { threshold: 2, invitees: ['invitee'] });
    await vote(env, pollId, optionId, 'organizer', 'yes');
    await vote(env, pollId, optionId, 'invitee', 'yes');
    await sweep(env);
    const day = await session(db, optionId);

    // The walkthrough's case: the organizer, then the poll row's button.
    expect((await vote(env, pollId, optionId, 'organizer', 'no')).status).toBe(200);

    expect((await session(db, optionId))!.status, 'the answer reached the day it was about').toBe('cancelled');
    const answer = await db
      .prepare(`SELECT rsvp_status FROM event_attendance WHERE event_id = ? AND user_id = 'organizer'`)
      .bind(day!.id)
      .first<{ rsvp_status: string }>();
    expect(answer!.rsvp_status).toBe('declined');

    fetchStub!.calls.length = 0;
    fetchStub!.bodies.length = 0;
    await sweep(env);
    // Sends (POST .../messages) and edits (PATCH .../messages/<id>) counted
    // apart: since the 10 Nov walkthrough the day's invite DM is also edited to
    // the cancellation text and loses its buttons, which is a second call
    // carrying the same words but not a second notice.
    const calls = fetchStub!.calls.map((url, i) => ({ url, body: fetchStub!.bodies[i] }));
    expect(calls.filter((c) => /\/messages$/.test(c.url) && c.body?.includes(CANCEL_NOTICE)).length).toBe(1);
    expect(calls.filter((c) => /\/messages\/[^/]+$/.test(c.url) && c.body?.includes(CANCEL_NOTICE)).length).toBeGreaterThan(0);
    const { results: told } = await db
      .prepare(`SELECT user_id FROM notification_log WHERE event_id = ? AND notification_type = 'event_cancelled_below_minimum'`)
      .bind(day!.id)
      .all<{ user_id: string }>();
    // The one who said no is not told about their own decision.
    expect(told.map((row) => row.user_id)).toEqual(['invitee']);
  });

  it('refuses a later answer on a day that was called off, rather than recording it as if it counted', async () => {
    const { db, env } = setup();
    const { pollId, optionId } = await seedPoll(db, env, { threshold: 2, invitees: ['invitee'] });
    await vote(env, pollId, optionId, 'organizer', 'yes');
    await vote(env, pollId, optionId, 'invitee', 'yes');
    await sweep(env);
    await vote(env, pollId, optionId, 'invitee', 'no');

    const late = await vote(env, pollId, optionId, 'invitee', 'yes');
    expect(late.status).toBe(400);
    expect(late.text).toContain('called off');
  });

  it('keeps a day that is still at its threshold after someone drops out', async () => {
    const { db, env } = setup();
    const { pollId, optionId } = await seedPoll(db, env, { threshold: 2, invitees: ['invitee', 'other'] });
    for (const user of ['organizer', 'invitee', 'other']) await vote(env, pollId, optionId, user, 'yes');
    await sweep(env);

    await vote(env, pollId, optionId, 'other', 'no');
    expect((await session(db, optionId))!.status).toBe('active');
    expect(await isConfirmed(db, optionId)).toBe(true);
  });

  it("shows the day's own answers on the poll row once it has an event", async () => {
    const { db, env } = setup();
    const { pollId, optionId } = await seedPoll(db, env, { threshold: 1, invitees: ['invitee'] });
    await vote(env, pollId, optionId, 'organizer', 'yes');
    await vote(env, pollId, optionId, 'invitee', 'yes');
    await sweep(env);
    const day = await session(db, optionId);
    // Answered on the day's own event, not the poll -- the case where the
    // poll's record of the vote and the day's answer disagree, which is the
    // one where it matters which the row reads.
    const rsvp = await buildApp().request(
      `https://worker.test/events/${day!.id}/rsvp`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${await authed(env, 'invitee')}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'declined' }),
      },
      env,
    );
    expect(rsvp.status).toBe(200);

    const res = await buildApp().request(
      `https://worker.test/events/${pollId}`,
      { headers: { Authorization: `Bearer ${await authed(env, 'invitee')}` } },
      env,
    );
    const body = (await res.json()) as {
      pollOptions: { sessionEventId: string | null; sessionStatus: string | null; myVote: string | null; confirmedUsers: { userId: string }[] }[];
    };
    const row = body.pollOptions[0];
    expect(row.sessionEventId).toBe(day!.id);
    expect(row.sessionStatus).toBe('active');
    expect(row.myVote).toBe('no');
    expect(row.confirmedUsers.map((u) => u.userId)).toEqual(['organizer']);
  });

  it('leaves a windowed day as it was: no inherited minimum', async () => {
    // Invariant guard, not a revert check: windowed answers are ranges, and
    // how a withdrawn range should un-confirm a day is recorded under IDEAS 97
    // rather than guessed at here.
    const { db, env } = setup();
    const { optionId } = await seedPoll(db, env, { threshold: 1, invitees: ['invitee'], windowed: true });
    await db.prepare(`UPDATE event_poll_options SET confirmed_at = ? WHERE id = ?`).bind(Date.now(), optionId).run();
    await sweep(env);
    const day = await session(db, optionId);
    expect(day).toMatchObject({ minimum_attendees: null, auto_cancel_below_minimum: 0 });
  });
});

// Pass 24 review, P24-04, raised for 1.0 after the 10 Nov walkthrough (5.15)
// showed the site still offering the buttons the review assumed it hid: a
// cancelled multi-winner poll accepted votes on days that had not become their
// own event, saved them, and showed them as the person's answer, while they
// did nothing.
describe('a cancelled multi-winner poll takes no more answers (P24-04)', () => {
  it('refuses a vote on a day that never became its own event, and saves nothing', async () => {
    const { db, env } = setup();
    const { pollId, optionId } = await seedPoll(db, env, { threshold: 2, invitees: ['invitee'] });
    await db.prepare(`UPDATE events SET status = 'cancelled' WHERE id = ?`).bind(pollId).run();

    const res = await vote(env, pollId, optionId, 'invitee', 'yes');

    expect(res.status).toBe(400);
    expect(res.text).toMatch(/closed/i);
    const saved = await db.prepare(`SELECT COUNT(*) AS n FROM event_poll_votes WHERE option_id = ?`).bind(optionId).first<{ n: number }>();
    expect(saved!.n).toBe(0);
  });

  it("refuses the Discord night picker's answer too", async () => {
    const { db, env } = setup();
    const { pollId, optionId } = await seedPoll(db, env, { threshold: 2, invitees: ['invitee'] });
    await db.prepare(`UPDATE events SET status = 'cancelled' WHERE id = ?`).bind(pollId).run();

    expect((await recordPollSelection(env, 'invitee', pollId, [optionId])).status).toBe('closed');
  });

  // INVARIANT GUARD: a day that is its own event still answers from the poll's
  // row after the poll is cancelled -- item 99 keeps those days on.
  it('still answers a day that is its own event', async () => {
    const { db, env } = setup();
    const { pollId, optionId } = await seedPoll(db, env, { threshold: 2, invitees: ['invitee'] });
    await vote(env, pollId, optionId, 'organizer', 'yes');
    await vote(env, pollId, optionId, 'invitee', 'yes');
    await sweep(env);
    await db.prepare(`UPDATE events SET status = 'cancelled' WHERE id = ?`).bind(pollId).run();

    expect((await vote(env, pollId, optionId, 'invitee', 'no')).status).toBe(200);
    expect((await session(db, optionId))!.status).toBe('cancelled');
  });
});

// Michael, 10 Nov walkthrough: from a day that became its own event there was
// no way back to the poll it came from.
describe("a poll day's own event links back to its poll", () => {
  async function eventAs(env: Env, eventId: string, userId: string) {
    const res = await buildApp().request(
      `https://worker.test/events/${eventId}`,
      { headers: { Authorization: `Bearer ${await authed(env, userId)}` } },
      env,
    );
    return (await res.json()) as { createdFromPoll: { id: string; title: string } | null };
  }

  it('names the poll for someone who can open it', async () => {
    const { db, env } = setup();
    const { pollId, optionId } = await seedPoll(db, env, { threshold: 2, invitees: ['invitee'] });
    await vote(env, pollId, optionId, 'organizer', 'yes');
    await vote(env, pollId, optionId, 'invitee', 'yes');
    await sweep(env);
    const day = await session(db, optionId);

    expect((await eventAs(env, day!.id, 'invitee')).createdFromPoll).toEqual({ id: pollId, title: 'Which nights?' });
    expect((await eventAs(env, pollId, 'invitee')).createdFromPoll).toBeNull();
  });

  it('gives no link to someone invited to the day but not to the poll', async () => {
    const { db, env } = setup();
    const { pollId, optionId } = await seedPoll(db, env, { threshold: 2, invitees: ['invitee'] });
    await vote(env, pollId, optionId, 'organizer', 'yes');
    await vote(env, pollId, optionId, 'invitee', 'yes');
    await sweep(env);
    const day = await session(db, optionId);
    await seedUser(db, 'late');
    await seedMembership(db, 'late', 'guild-1');
    await db
      .prepare(`INSERT INTO event_invites (id, event_id, user_id, invited_via, rsvp_status, invited_at) VALUES ('inv-late', ?, 'late', 'individual', 'pending', ?)`)
      .bind(day!.id, Date.now())
      .run();

    expect((await eventAs(env, day!.id, 'late')).createdFromPoll).toBeNull();
  });
});
