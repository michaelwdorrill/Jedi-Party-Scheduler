import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/router';
import { signJwt } from '../src/lib/jwt';
import { createSession } from '../src/lib/sessions';
import { createEventWithInvites } from '../src/lib/eventWrites';
import { seedGuild, seedMembership, seedUser, setup, membershipRule, stubFetch, type FetchStub } from './helpers';
import type { Env } from '../src/env';

let fetchStub: FetchStub | null = null;
afterEach(() => {
  fetchStub?.restore();
  fetchStub = null;
});

const app = buildApp();

async function authFor(env: Env, userId: string): Promise<Record<string, string>> {
  const { id: sessionId } = await createSession(env, userId);
  return { Authorization: `Bearer ${await signJwt(userId, sessionId, env.JWT_SIGNING_KEY)}` };
}

function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// specs/0014 stage 1's headline fix, and GET /:eventId's own gap the fix
// depended on: events.start_at/end_at are NULL for every recurring event by
// design (the real schedule lives in event_recurrence_rules), and this route
// used to echo that NULL straight through regardless of ?occurrence= --
// which is what silently kept the frontend's RSVP buttons (gated on
// `event.startAt && event.endAt`) from ever rendering for a recurring event.
// Found by hand on the sandbox, not by a test, because nothing here asserted
// on startAt/endAt for a recurring GET before this file.
describe('GET /events/:eventId resolves a recurring event to a real occurrence', () => {
  async function seedWeeklyEvent(env: Env, organizerId = 'organizer'): Promise<string> {
    return createEventWithInvites(env, 'guild-1', organizerId, {
      title: 'Weekly game night',
      description: null,
      game: null,
      eventType: 'single',
      timezone: 'America/New_York',
      isRecurring: true,
      recurrence: {
        freq: 'WEEKLY',
        interval: 1,
        byWeekday: [new Date().getUTCDay() === 0 ? 6 : new Date().getUTCDay() - 1], // today, in 0=Mon..6=Sun
        byMonthDay: null,
        startDate: new Date().toISOString().slice(0, 10),
        startTime: '19:00',
        durationMinutes: 120,
        endType: 'never',
        endDate: null,
        endCount: null,
      },
      invites: { userIds: [], groupIds: [] },
    });
  }

  it('defaults to the next upcoming occurrence, with a real time -- not the null base row', async () => {
    const { db, env } = setup();
    await seedGuild(db);
    await seedUser(db, 'organizer');
    await seedMembership(db, 'organizer', 'guild-1');
    fetchStub = stubFetch([membershipRule(200)]);
    const eventId = await seedWeeklyEvent(env);

    const res = await app.request(`/events/${eventId}`, { method: 'GET', headers: await authFor(env, 'organizer') }, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      isRecurring: boolean;
      occurrenceDate: string;
      startAt: number | null;
      endAt: number | null;
      myRsvpStatus: string | null;
    };

    expect(body.isRecurring).toBe(true);
    expect(body.occurrenceDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // The bug: these were always null for a recurring event, whatever
    // ?occurrence= said, because the route echoed events.start_at/end_at
    // straight through instead of resolving the requested occurrence.
    expect(body.startAt).not.toBeNull();
    expect(body.endAt).not.toBeNull();
    expect(body.endAt!).toBeGreaterThan(body.startAt!);
    // Decision 1: the organizer is implicitly attending without an explicit
    // event_attendance row.
    expect(body.myRsvpStatus).toBe('accepted');
  });

  it('resolves a specific ?occurrence= to that occurrence\'s own time, distinct from the default', async () => {
    const { db, env } = setup();
    await seedGuild(db);
    await seedUser(db, 'organizer');
    await seedMembership(db, 'organizer', 'guild-1');
    fetchStub = stubFetch([membershipRule(200)]);
    const eventId = await seedWeeklyEvent(env);

    const defaultRes = await app.request(`/events/${eventId}`, { method: 'GET', headers: await authFor(env, 'organizer') }, env);
    const defaultBody = (await defaultRes.json()) as { occurrenceDate: string; startAt: number; endAt: number };

    const nextWeek = addDays(defaultBody.occurrenceDate, 7);
    const explicitRes = await app.request(
      `/events/${eventId}?occurrence=${nextWeek}`,
      { method: 'GET', headers: await authFor(env, 'organizer') },
      env,
    );
    expect(explicitRes.status).toBe(200);
    const explicitBody = (await explicitRes.json()) as { occurrenceDate: string; startAt: number; endAt: number };

    expect(explicitBody.occurrenceDate).toBe(nextWeek);
    expect(explicitBody.startAt).not.toBeNull();
    // Exactly a week later -- same weekday and time, different calendar day.
    expect(explicitBody.startAt - defaultBody.startAt).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it('a decline on one occurrence leaves the next one untouched -- the regression this spec exists to prevent', async () => {
    const { db, env } = setup();
    await seedGuild(db);
    await seedUser(db, 'organizer');
    await seedMembership(db, 'organizer', 'guild-1');
    fetchStub = stubFetch([membershipRule(200)]);
    const eventId = await seedWeeklyEvent(env);
    const headers = await authFor(env, 'organizer');

    const firstRes = await app.request(`/events/${eventId}`, { method: 'GET', headers }, env);
    const first = (await firstRes.json()) as { occurrenceDate: string };
    const secondDate = addDays(first.occurrenceDate, 7);

    await app.request(
      `/events/${eventId}/rsvp`,
      { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'declined', occurrenceDate: first.occurrenceDate }) },
      env,
    );

    const firstAfter = await app.request(`/events/${eventId}?occurrence=${first.occurrenceDate}`, { method: 'GET', headers }, env);
    const secondAfter = await app.request(`/events/${eventId}?occurrence=${secondDate}`, { method: 'GET', headers }, env);

    expect(((await firstAfter.json()) as { myRsvpStatus: string | null }).myRsvpStatus).toBe('declined');
    // Decision 1's fallback still applies to the untouched occurrence: no row
    // there means implicitly attending, exactly as if nothing had happened.
    expect(((await secondAfter.json()) as { myRsvpStatus: string | null }).myRsvpStatus).toBe('accepted');
  });

  it('shows the organizer as accepted in the invited list too, not just myRsvpStatus', async () => {
    const { db, env } = setup();
    await seedGuild(db);
    await seedUser(db, 'organizer');
    await seedMembership(db, 'organizer', 'guild-1');
    fetchStub = stubFetch([membershipRule(200)]);
    const eventId = await seedWeeklyEvent(env);

    const res = await app.request(`/events/${eventId}`, { method: 'GET', headers: await authFor(env, 'organizer') }, env);
    const body = (await res.json()) as { invites: { userId: string; rsvpStatus: string | null }[] };
    expect(body.invites).toContainEqual(expect.objectContaining({ userId: 'organizer', rsvpStatus: 'accepted' }));
  });
});
