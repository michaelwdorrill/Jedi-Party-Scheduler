import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildApp } from '../src/router';
import { signJwt } from '../src/lib/jwt';
import { createSession } from '../src/lib/sessions';
import { DAY_MS, HOUR_MS, seedAttendance, seedEvent, seedGuild, seedInvite, seedMembership, seedUser, setup } from './helpers';
import type { Env } from '../src/env';
import type { ShimDatabase } from './d1shim';

// IDEAS item 5 (second half) / docs/specs/0007: the server noticeboard.
//
// This is the only endpoint in the app that returns event details to someone
// who was not invited, so most of what is asserted here is what it must NOT
// return.

const app = buildApp();

async function call(env: Env, path: string, auth?: string): Promise<Response> {
  return app.request(
    `https://worker.test${path}`,
    auth ? { headers: { Authorization: `Bearer ${auth}` } } : {},
    env,
  );
}

async function authFor(env: Env, userId: string): Promise<string> {
  const { id: sessionId } = await createSession(env, userId);
  return signJwt(userId, sessionId, env.JWT_SIGNING_KEY);
}

interface NoticeboardItem {
  occurrenceId: string;
  eventId: string;
  title: string;
  startAt: number;
  attendees: { userId: string; rsvpStatus: string | null }[];
}

const RANGE = `from=${Date.now()}&to=${Date.now() + 30 * DAY_MS}`;

async function seedServer(db: ShimDatabase): Promise<void> {
  await seedGuild(db, 'guild-1');
  for (const id of ['organizer', 'invitee', 'bystander', 'outsider']) await seedUser(db, id);
  for (const id of ['organizer', 'invitee', 'bystander']) await seedMembership(db, id, 'guild-1');
}

async function fetchBoard(env: Env, userId: string): Promise<NoticeboardItem[]> {
  const res = await call(env, `/guilds/guild-1/noticeboard?${RANGE}`, await authFor(env, userId));
  expect(res.status).toBe(200);
  return res.json<NoticeboardItem[]>();
}

describe('the server noticeboard', () => {
  it('shows a member an event they were never invited to', async () => {
    const { db, env } = setup();
    await seedServer(db);
    await seedEvent(db, {
      id: 'evt-1',
      organizerId: 'organizer',
      title: 'Friday Game',
      startAt: Date.now() + 2 * DAY_MS,
      endAt: Date.now() + 2 * DAY_MS + 3 * HOUR_MS,
    });
    await seedInvite(db, 'evt-1', 'invitee');

    // The whole point of the feature: 'bystander' holds no invite at all.
    const board = await fetchBoard(env, 'bystander');
    expect(board.map((o) => o.title)).toEqual(['Friday Game']);
  });

  it('refuses someone who is not a member of the server', async () => {
    const { db, env } = setup();
    await seedServer(db);
    await seedEvent(db, { id: 'evt-1', organizerId: 'organizer', startAt: Date.now() + DAY_MS, endAt: Date.now() + DAY_MS + HOUR_MS });

    const res = await call(env, `/guilds/guild-1/noticeboard?${RANGE}`, await authFor(env, 'outsider'));
    expect(res.status).toBe(403);
  });

  it('never shows an event the organiser marked private', async () => {
    const { db, env } = setup();
    await seedServer(db);
    await seedEvent(db, { id: 'evt-1', organizerId: 'organizer', title: 'Secret', startAt: Date.now() + DAY_MS, endAt: Date.now() + DAY_MS + HOUR_MS });
    await db.prepare(`UPDATE events SET is_private = 1 WHERE id = 'evt-1'`).run();

    expect(await fetchBoard(env, 'bystander')).toEqual([]);
  });

  // Decision 2 of the spec, and the promise that makes the whole feature
  // defensible: events created under the previous Privacy Policy do not change
  // visibility retroactively. The mechanism is migration 0038's backfill.
  it('keeps every pre-existing event private, by migration', () => {
    const sql = readFileSync(join(__dirname, '..', 'migrations', '0038_server_noticeboard.sql'), 'utf8');
    // Without this statement, ADD COLUMN's DEFAULT 0 would make every event
    // that already existed publicly visible the moment this deployed.
    expect(sql).toMatch(/UPDATE\s+events\s+SET\s+is_private\s*=\s*1/i);
    expect(sql).toMatch(/is_private INTEGER NOT NULL DEFAULT 0/);
  });

  it('never returns descriptions', async () => {
    const { db, env } = setup();
    await seedServer(db);
    await seedEvent(db, { id: 'evt-1', organizerId: 'organizer', startAt: Date.now() + DAY_MS, endAt: Date.now() + DAY_MS + HOUR_MS });
    await db
      .prepare(`UPDATE events SET description = 'the party plans to rob the vault' WHERE id = 'evt-1'`)
      .run();

    const raw = await call(env, `/guilds/guild-1/noticeboard?${RANGE}`, await authFor(env, 'bystander'));
    // Asserted against the serialised response, not the parsed object: a
    // description leaking under any key at all should fail this.
    expect(await raw.text()).not.toContain('rob the vault');
  });

  // Blocker 4 of the spec. Personal blocks are private by design and live in a
  // different table, so this asserts the separation holds rather than that a
  // filter works.
  it('never shows personal time blocks', async () => {
    const { db, env } = setup();
    await seedServer(db);
    const now = Date.now();
    await db
      .prepare(
        `INSERT INTO personal_events (id, user_id, title, description, timezone, start_at, end_at,
           status, availability, is_recurring, created_at, updated_at)
         VALUES ('pe-1', 'organizer', 'Dentist', NULL, 'UTC', ?, ?, 'active', 'busy', 0, ?, ?)`,
      )
      .bind(now + DAY_MS, now + DAY_MS + HOUR_MS, now, now)
      .run();

    const raw = await call(env, `/guilds/guild-1/noticeboard?${RANGE}`, await authFor(env, 'bystander'));
    expect(await raw.text()).not.toContain('Dentist');
  });

  it('shows who is invited and what they answered', async () => {
    const { db, env } = setup();
    await seedServer(db);
    await seedEvent(db, { id: 'evt-1', organizerId: 'organizer', startAt: Date.now() + DAY_MS, endAt: Date.now() + DAY_MS + HOUR_MS });
    await seedInvite(db, 'evt-1', 'invitee');
    await seedAttendance(db, 'evt-1', 'invitee', 'accepted');

    const [item] = await fetchBoard(env, 'bystander');
    const invitee = item.attendees.find((a) => a.userId === 'invitee');
    expect(invitee?.rsvpStatus).toBe('accepted');
    // Decision 4: an invitee cannot hide from the list, so there is no filter
    // here to test -- what matters is that the organiser is present even
    // without an invite row of their own.
    expect(item.attendees.some((a) => a.userId === 'organizer')).toBe(true);
  });

  it('does not advertise a poll that has not resolved', async () => {
    const { db, env } = setup();
    await seedServer(db);
    await seedEvent(db, {
      id: 'evt-poll',
      organizerId: 'organizer',
      title: 'Which night?',
      eventType: 'poll',
      startAt: null,
      endAt: null,
    });
    await db
      .prepare(`UPDATE events SET poll_deadline_at = ? WHERE id = 'evt-poll'`)
      .bind(Date.now() + 3 * DAY_MS)
      .run();

    // A maybe is not a commitment; a noticeboard that lists them advertises
    // sessions that may never happen.
    expect(await fetchBoard(env, 'bystander')).toEqual([]);
  });

  // Every other test here seeds the events table directly, which means they all
  // exercise the column DEFAULT rather than the route that real events come
  // through. A create path that dropped isPrivate on the floor would leave all
  // of them green, so this one drives the actual HTTP endpoint the form posts
  // to and then reads the board back.
  it('puts an event created through the real endpoint on the board', async () => {
    const { db, env } = setup();
    await seedServer(db);

    const res = await app.request(
      'https://worker.test/guilds/guild-1/events',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${await authFor(env, 'organizer')}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          title: 'Made the normal way',
          description: 'BANTHAFODDER',
          eventType: 'single',
          timezone: 'America/New_York',
          startAt: Date.now() + 2 * DAY_MS,
          endAt: Date.now() + 2 * DAY_MS + 4 * HOUR_MS,
          invites: { userIds: [], groupIds: [] },
          isPrivate: false,
        }),
      },
      env,
    );
    expect(res.status).toBe(201);

    const board = await fetchBoard(env, 'bystander');
    expect(board.map((i) => i.title)).toEqual(['Made the normal way']);
    // The description must not have travelled with it, checked against the raw
    // body rather than the parsed shape.
    const raw = await (
      await call(env, `/guilds/guild-1/noticeboard?${RANGE}`, await authFor(env, 'bystander'))
    ).text();
    expect(raw).not.toContain('BANTHAFODDER');
  });

  it('keeps an event off the board when the organiser ticked the box, through the real endpoint', async () => {
    const { db, env } = setup();
    await seedServer(db);

    const res = await app.request(
      'https://worker.test/guilds/guild-1/events',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${await authFor(env, 'organizer')}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          title: 'Kept quiet',
          eventType: 'single',
          timezone: 'America/New_York',
          startAt: Date.now() + 2 * DAY_MS,
          endAt: Date.now() + 2 * DAY_MS + 4 * HOUR_MS,
          invites: { userIds: [], groupIds: [] },
          isPrivate: true,
        }),
      },
      env,
    );
    expect(res.status).toBe(201);

    expect(await fetchBoard(env, 'bystander')).toEqual([]);
  });

  it('does advertise a poll once it has resolved', async () => {
    const { db, env } = setup();
    await seedServer(db);
    await seedEvent(db, {
      id: 'evt-poll-done',
      organizerId: 'organizer',
      title: 'Which night? (decided)',
      eventType: 'poll',
      startAt: Date.now() + 3 * DAY_MS,
      endAt: Date.now() + 3 * DAY_MS + 2 * HOUR_MS,
    });
    await db.prepare(`UPDATE events SET status = 'resolved' WHERE id = 'evt-poll-done'`).run();

    // The other half of the rule above, and the half that was broken: a
    // resolved poll has a real time and is an ordinary event from here on, so
    // it belongs on the board. Its status is 'resolved' rather than 'active',
    // which is exactly what the old `status = 'active'` filter threw away.
    const board = await fetchBoard(env, 'bystander');
    expect(board.map((i) => i.eventId)).toEqual(['evt-poll-done']);
  });

  it('expands a recurring series, with per-occurrence answers', async () => {
    const { db, env } = setup();
    await seedServer(db);
    await seedEvent(db, { id: 'evt-r', organizerId: 'organizer', title: 'Weekly', startAt: null, endAt: null, isRecurring: 1 });
    const startDate = new Date(Date.now() + DAY_MS).toISOString().slice(0, 10);
    await db
      .prepare(
        `INSERT INTO event_recurrence_rules (event_id, freq, interval, by_weekday, by_month_day,
           start_date, start_time, duration_minutes, end_type, end_date, end_count)
         VALUES ('evt-r', 'WEEKLY', 1, NULL, NULL, ?, '19:30', 120, 'never', NULL, NULL)`,
      )
      .bind(startDate)
      .run();
    await seedInvite(db, 'evt-r', 'invitee');

    const board = await fetchBoard(env, 'bystander');
    expect(board.length).toBeGreaterThan(2);
    // specs/0014: an answer belongs to one night, not to the series.
    const first = board[0];
    await seedAttendance(db, 'evt-r', 'invitee', 'declined', first.occurrenceId.split('::')[1]);

    const after = await fetchBoard(env, 'bystander');
    expect(after[0].attendees.find((a) => a.userId === 'invitee')?.rsvpStatus).toBe('declined');
    expect(after[1].attendees.find((a) => a.userId === 'invitee')?.rsvpStatus).toBeNull();
  });

  it('refuses a range wider than it will answer accurately', async () => {
    const { db, env } = setup();
    await seedServer(db);
    const res = await call(
      env,
      `/guilds/guild-1/noticeboard?from=${Date.now()}&to=${Date.now() + 200 * DAY_MS}`,
      await authFor(env, 'bystander'),
    );
    expect(res.status).toBe(400);
  });

  it('leaves a cancelled event off the board', async () => {
    const { db, env } = setup();
    await seedServer(db);
    await seedEvent(db, {
      id: 'evt-1',
      organizerId: 'organizer',
      status: 'cancelled',
      startAt: Date.now() + DAY_MS,
      endAt: Date.now() + DAY_MS + HOUR_MS,
    });
    expect(await fetchBoard(env, 'bystander')).toEqual([]);
  });
});
