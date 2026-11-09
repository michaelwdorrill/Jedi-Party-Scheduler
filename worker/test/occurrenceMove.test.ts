import { afterEach, describe, expect, it } from 'vitest';
import { DateTime } from 'luxon';
import { buildApp } from '../src/router';
import { signJwt } from '../src/lib/jwt';
import { createSession } from '../src/lib/sessions';
import { LIMITS } from '../src/lib/validate';
import { seedAttendance, seedEvent, seedGuild, seedInvite, seedMembership, seedUser, setup, stubFetch, type FetchStub } from './helpers';
import type { Env } from '../src/env';
import type { ShimDatabase } from './d1shim';

// IDEAS 94. The organizer moves one occurrence of their own series.
//
// Before this route the organizer could cancel a date but not move one, while
// an invitee could get one moved by a change request the organizer accepted.
// Found on the first browser walkthrough: release-testing step 2.12 asked for
// the move and there was no control to do it with.
//
// The route shares its write with the change-request accept path
// (writeOccurrenceMove), so these tests are about what the ROUTE adds around
// that write: who may call it, which dates it accepts, and what it refuses.
// What the write itself does is pinned by the accept path's own tests, which
// still pass through the shared function unchanged.

let fetchStub: FetchStub | null = null;
afterEach(() => {
  fetchStub?.restore();
  fetchStub = null;
});

const app = buildApp();
const ZONE = 'America/New_York'; // seedEvent's timezone

// Mondays from 7 January 2030, 7pm-9pm New York time. Far enough ahead that the
// fixture does not age into the past, and a weekly rule so that a date the
// series does not produce (a Tuesday) is a meaningful thing to try to move.
const MONDAY = '2030-01-14';
const NEXT_MONDAY = '2030-01-21';
const TUESDAY = '2030-01-15';

async function seedSeries(db: ShimDatabase, { status = 'active' }: { status?: string } = {}) {
  await seedGuild(db, 'guild-1');
  await seedUser(db, 'organizer');
  await seedMembership(db, 'organizer', 'guild-1');
  await seedEvent(db, { id: 'ev1', organizerId: 'organizer', isRecurring: 1, startAt: null, endAt: null, status });
  await db
    .prepare(
      `INSERT INTO event_recurrence_rules
         (event_id, freq, interval, by_weekday, by_month_day, start_date, start_time,
          duration_minutes, end_type, end_date, end_count)
       VALUES ('ev1', 'WEEKLY', 1, '0', NULL, '2030-01-07', '19:00', 120, 'never', NULL, NULL)`,
    )
    .run();
}

async function authAs(env: Env, userId: string): Promise<Record<string, string>> {
  const { id: sessionId } = await createSession(env, userId);
  return { Authorization: `Bearer ${await signJwt(userId, sessionId, env.JWT_SIGNING_KEY)}` };
}

function at(date: string, time: string): number {
  return DateTime.fromISO(`${date}T${time}`, { zone: ZONE }).toMillis();
}

async function move(env: Env, headers: Record<string, string>, date: string, startAt: unknown, endAt: unknown) {
  return app.request(
    `https://worker.test/events/ev1/occurrences/${date}/move`,
    { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ startAt, endAt }) },
    env,
  );
}

async function occurrenceAsTheAppSeesIt(env: Env, headers: Record<string, string>, date: string) {
  const res = await app.request(`https://worker.test/events/ev1?occurrence=${date}`, { headers }, env);
  expect(res.status, 'fixture: the event detail did not load').toBe(200);
  return res.json<{ startAt: number | null; endAt: number | null; occurrenceDate: string }>();
}

async function overrideFor(db: ShimDatabase, date: string) {
  return db
    .prepare(
      `SELECT is_cancelled, override_start_at, override_end_at FROM event_occurrence_overrides
       WHERE event_id = 'ev1' AND occurrence_date = ?`,
    )
    .bind(date)
    .first<{ is_cancelled: number; override_start_at: number | null; override_end_at: number | null }>();
}

describe('the organizer moves one occurrence (IDEAS 94)', () => {
  it('moves that date -- even onto another day -- and leaves the rest of the series alone', async () => {
    const { db, env } = setup();
    await seedSeries(db);
    const headers = await authAs(env, 'organizer');
    fetchStub = stubFetch([]);

    // Monday's session moves to Tuesday evening: a different DAY, which is the
    // case the read path once lost (P14-14) and so the one worth proving.
    const startAt = at(TUESDAY, '21:00');
    const endAt = at(TUESDAY, '23:00');
    const res = await move(env, headers, MONDAY, startAt, endAt);
    expect(res.status).toBe(200);

    const moved = await occurrenceAsTheAppSeesIt(env, headers, MONDAY);
    expect(moved.startAt).toBe(startAt);
    expect(moved.endAt).toBe(endAt);

    const untouched = await occurrenceAsTheAppSeesIt(env, headers, NEXT_MONDAY);
    expect(untouched.startAt, 'a move of one date changed another').toBe(at(NEXT_MONDAY, '19:00'));
  });

  it('refuses anyone but the organizer, and writes nothing', async () => {
    const { db, env } = setup();
    await seedSeries(db);
    await seedUser(db, 'invitee');
    await seedMembership(db, 'invitee', 'guild-1');
    await seedInvite(db, 'ev1', 'invitee');
    fetchStub = stubFetch([]);

    const res = await move(env, await authAs(env, 'invitee'), MONDAY, at(MONDAY, '20:00'), at(MONDAY, '22:00'));
    // 404 rather than 403, as every other organizer-only route answers: an
    // invitee knows the event exists, but the route does not say so to anyone.
    expect(res.status).toBe(404);
    expect(await overrideFor(db, MONDAY)).toBeNull();
  });

  it('refuses a one-off event, and says to edit it instead', async () => {
    const { db, env } = setup();
    await seedGuild(db, 'guild-1');
    await seedUser(db, 'organizer');
    await seedMembership(db, 'organizer', 'guild-1');
    await seedEvent(db, { id: 'ev1', organizerId: 'organizer' });
    fetchStub = stubFetch([]);

    const res = await move(env, await authAs(env, 'organizer'), MONDAY, at(MONDAY, '20:00'), at(MONDAY, '22:00'));
    expect(res.status).toBe(400);
    // The message is the point: without the explicit check this is still a
    // 400 -- a one-off has no rule, so the date check refuses it -- but one
    // that says "not one of this event's dates" about an event with exactly
    // one date, which is true and useless.
    expect(await res.text()).toMatch(/edit the event/i);
  });

  it('refuses a date the series does not produce, and writes nothing', async () => {
    const { db, env } = setup();
    await seedSeries(db);
    fetchStub = stubFetch([]);

    const res = await move(env, await authAs(env, 'organizer'), TUESDAY, at(TUESDAY, '20:00'), at(TUESDAY, '22:00'));
    expect(res.status).toBe(400);
    // The expander would ignore this row on read (P14-13), so the harm is not
    // a phantom session -- it is a row that counts against the per-event cap
    // forever while doing nothing, and a 200 for a move that moved nothing.
    expect(await overrideFor(db, TUESDAY), 'an override was stored for a date that is not a session').toBeNull();
  });

  it('refuses a cancelled series', async () => {
    const { db, env } = setup();
    await seedSeries(db, { status: 'cancelled' });
    fetchStub = stubFetch([]);

    const res = await move(env, await authAs(env, 'organizer'), MONDAY, at(MONDAY, '20:00'), at(MONDAY, '22:00'));
    expect(res.status).toBe(409);
    expect(await overrideFor(db, MONDAY)).toBeNull();
  });

  it('refuses an end that is not after the start', async () => {
    const { db, env } = setup();
    await seedSeries(db);
    fetchStub = stubFetch([]);
    const headers = await authAs(env, 'organizer');

    const backwards = await move(env, headers, MONDAY, at(MONDAY, '22:00'), at(MONDAY, '20:00'));
    expect(backwards.status).toBe(400);
    const empty = await move(env, headers, MONDAY, at(MONDAY, '20:00'), at(MONDAY, '20:00'));
    expect(empty.status).toBe(400);
    expect(await overrideFor(db, MONDAY)).toBeNull();
  });

  it('refuses a span longer than any event may last', async () => {
    const { db, env } = setup();
    await seedSeries(db);
    fetchStub = stubFetch([]);

    const startAt = at(MONDAY, '20:00');
    const res = await move(env, await authAs(env, 'organizer'), MONDAY, startAt, startAt + LIMITS.MAX_EVENT_DURATION_MS + 1);
    expect(res.status).toBe(400);
    expect(await overrideFor(db, MONDAY)).toBeNull();
  });

  it('refuses non-numeric times and a malformed date', async () => {
    const { db, env } = setup();
    await seedSeries(db);
    fetchStub = stubFetch([]);
    const headers = await authAs(env, 'organizer');

    expect((await move(env, headers, MONDAY, '8pm', '10pm')).status).toBe(400);
    expect((await move(env, headers, 'next-monday', at(MONDAY, '20:00'), at(MONDAY, '22:00'))).status).toBe(400);
  });

  it('refuses a new date at the per-event cap, but still lets an already-changed date move', async () => {
    const { db, env } = setup();
    await seedSeries(db);
    fetchStub = stubFetch([]);
    const headers = await authAs(env, 'organizer');

    // Fill the cap with cancellations on other Mondays, keeping MONDAY free and
    // NEXT_MONDAY among the changed ones.
    let day = DateTime.fromISO(NEXT_MONDAY, { zone: ZONE });
    for (let i = 0; i < LIMITS.MAX_OVERRIDES_PER_EVENT; i++) {
      await db
        .prepare(`INSERT INTO event_occurrence_overrides (id, event_id, occurrence_date, is_cancelled) VALUES (?, 'ev1', ?, 1)`)
        .bind(`cap-${i}`, day.toISODate())
        .run();
      day = day.plus({ weeks: 1 });
    }

    const fresh = await move(env, headers, MONDAY, at(MONDAY, '20:00'), at(MONDAY, '22:00'));
    expect(fresh.status).toBe(400);
    expect(await fresh.text()).toMatch(/limit/);
    expect(await overrideFor(db, MONDAY)).toBeNull();

    // Admission admits an existing key at capacity -- the OVERRIDE_ADMISSION_SQL
    // property that keeps people at the cap able to change what is already there.
    const existing = await move(env, headers, NEXT_MONDAY, at(NEXT_MONDAY, '20:00'), at(NEXT_MONDAY, '22:00'));
    expect(existing.status).toBe(200);
  });

  // INVARIANT GUARDS, not reproductions: each passes with or without anything
  // in the route, because it pins a property of the SHARED write. They are here
  // so that a later change to writeOccurrenceMove that alters either has to
  // argue with a named test from the organizer's side too, not only the
  // accept path's.

  it('keeps the answers people already gave for that date', async () => {
    const { db, env } = setup();
    await seedSeries(db);
    await seedUser(db, 'invitee');
    await seedMembership(db, 'invitee', 'guild-1');
    await seedInvite(db, 'ev1', 'invitee');
    await seedAttendance(db, 'ev1', 'invitee', 'accepted', MONDAY);
    fetchStub = stubFetch([]);

    expect((await move(env, await authAs(env, 'organizer'), MONDAY, at(MONDAY, '20:30'), at(MONDAY, '22:30'))).status).toBe(200);

    const answer = await db
      .prepare(`SELECT rsvp_status FROM event_attendance WHERE event_id = 'ev1' AND occurrence_date = ? AND user_id = 'invitee'`)
      .bind(MONDAY)
      .first<{ rsvp_status: string }>();
    expect(answer?.rsvp_status, 'moving a date discarded the answers given for it').toBe('accepted');
  });

  it('brings back a date the organizer had cancelled, at the new time', async () => {
    const { db, env } = setup();
    await seedSeries(db);
    fetchStub = stubFetch([]);
    const headers = await authAs(env, 'organizer');

    const cancel = await app.request(`https://worker.test/events/ev1/occurrences/${MONDAY}/cancel`, { method: 'POST', headers }, env);
    expect(cancel.status, 'fixture: the cancel did not take').toBe(200);

    expect((await move(env, headers, MONDAY, at(MONDAY, '21:00'), at(MONDAY, '23:00'))).status).toBe(200);

    expect(await overrideFor(db, MONDAY)).toEqual({
      is_cancelled: 0,
      override_start_at: at(MONDAY, '21:00'),
      override_end_at: at(MONDAY, '23:00'),
    });
    expect((await occurrenceAsTheAppSeesIt(env, headers, MONDAY)).startAt).toBe(at(MONDAY, '21:00'));
  });
});
