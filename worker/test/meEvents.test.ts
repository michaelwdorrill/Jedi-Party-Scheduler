import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/router';
import { signJwt } from '../src/lib/jwt';
import { createSession } from '../src/lib/sessions';
import {
  DAY_MS,
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
import type { Env } from '../src/env';

let fetchStub: FetchStub | null = null;
afterEach(() => {
  fetchStub?.restore();
  fetchStub = null;
});

const app = buildApp();

async function authHeaders(env: Env, userId: string): Promise<Record<string, string>> {
  const { id: sessionId } = await createSession(env, userId);
  const token = await signJwt(userId, sessionId, env.JWT_SIGNING_KEY);
  return { Authorization: `Bearer ${token}` };
}

interface Occurrence {
  eventId: string;
  title: string;
  guildId: string | null;
  guildName: string | null;
  isPersonal: boolean;
}

async function myEvents(env: Env, userId: string): Promise<Occurrence[]> {
  const headers = await authHeaders(env, userId);
  const from = Date.now() - DAY_MS;
  const to = Date.now() + 7 * DAY_MS;
  const res = await app.request(`https://worker.test/me/events?from=${from}&to=${to}`, { headers }, env);
  expect(res.status).toBe(200);
  return (await res.json()) as Occurrence[];
}

describe('GET /me/events spans every server the caller is in', () => {
  it('returns events from multiple guilds in one call, each labelled with its server', async () => {
    const { db, env } = setup();
    await seedGuild(db, 'guild-1');
    await seedGuild(db, 'guild-2');
    await seedUser(db, 'me');
    await seedUser(db, 'organizer');
    for (const g of ['guild-1', 'guild-2']) {
      await seedMembership(db, 'me', g);
      await seedMembership(db, 'organizer', g);
    }

    await seedEvent(db, { id: 'e1', guildId: 'guild-1', organizerId: 'organizer', title: 'Raid', startAt: Date.now() + HOUR_MS, endAt: Date.now() + 2 * HOUR_MS });
    await seedInvite(db, 'e1', 'me');
    await seedEvent(db, { id: 'e2', guildId: 'guild-2', organizerId: 'me', title: 'My session', startAt: Date.now() + 3 * HOUR_MS, endAt: Date.now() + 4 * HOUR_MS });

    const events = await myEvents(env, 'me');
    expect(events.map((e) => e.eventId).sort()).toEqual(['e1', 'e2']);
    expect(events.find((e) => e.eventId === 'e1')!.guildId).toBe('guild-1');
    expect(events.find((e) => e.eventId === 'e2')!.guildId).toBe('guild-2');
    // Labelled, so a calendar can show which server without a second lookup.
    expect(events.every((e) => e.guildName !== null)).toBe(true);
  });

  it('excludes events from a server the caller has left', async () => {
    const { db, env } = setup();
    await seedGuild(db, 'guild-1');
    await seedGuild(db, 'guild-2');
    await seedUser(db, 'me');
    await seedUser(db, 'organizer');
    await seedMembership(db, 'me', 'guild-1');
    // Departed guild-2. The invite row survives -- they aren't deleted on
    // leaving -- so only the membership check keeps this off the calendar.
    await seedMembership(db, 'me', 'guild-2', { isMember: 0 });
    await seedMembership(db, 'organizer', 'guild-1');
    await seedMembership(db, 'organizer', 'guild-2');

    await seedEvent(db, { id: 'stays', guildId: 'guild-1', organizerId: 'organizer', startAt: Date.now() + HOUR_MS, endAt: Date.now() + 2 * HOUR_MS });
    await seedInvite(db, 'stays', 'me');
    await seedEvent(db, { id: 'gone', guildId: 'guild-2', organizerId: 'organizer', startAt: Date.now() + HOUR_MS, endAt: Date.now() + 2 * HOUR_MS });
    await seedInvite(db, 'gone', 'me');

    const events = await myEvents(env, 'me');
    expect(events.map((e) => e.eventId)).toEqual(['stays']);
  });

  it('excludes a server whose membership has gone stale beyond the grace window', async () => {
    const { db, env } = setup();
    await seedGuild(db, 'guild-1');
    await seedUser(db, 'me');
    await seedUser(db, 'organizer');
    // Same freshness bound the cron's recipient queries use: a membership row
    // nothing has confirmed for over a day stops counting.
    await seedMembership(db, 'me', 'guild-1', { verifiedAgoMs: 25 * HOUR_MS });
    await seedMembership(db, 'organizer', 'guild-1');
    await seedEvent(db, { id: 'e1', guildId: 'guild-1', organizerId: 'organizer', startAt: Date.now() + HOUR_MS, endAt: Date.now() + 2 * HOUR_MS });
    await seedInvite(db, 'e1', 'me');

    expect(await myEvents(env, 'me')).toEqual([]);
  });

  it("never returns another person's events, even in a shared server", async () => {
    const { db, env } = setup();
    await seedGuild(db, 'guild-1');
    await seedUser(db, 'me');
    await seedUser(db, 'someone');
    await seedMembership(db, 'me', 'guild-1');
    await seedMembership(db, 'someone', 'guild-1');

    // Same guild, but 'me' is neither the organizer nor invited.
    await seedEvent(db, { id: 'not-mine', guildId: 'guild-1', organizerId: 'someone', startAt: Date.now() + HOUR_MS, endAt: Date.now() + 2 * HOUR_MS });
    await seedInvite(db, 'not-mine', 'someone');

    expect(await myEvents(env, 'me')).toEqual([]);
  });

  it('folds in the caller\'s own personal time, and nobody else\'s', async () => {
    const { db, env } = setup();
    await seedGuild(db, 'guild-1');
    await seedUser(db, 'me');
    await seedUser(db, 'other');
    await seedMembership(db, 'me', 'guild-1');
    await seedMembership(db, 'other', 'guild-1');

    const now = Date.now();
    for (const [id, owner] of [['p-mine', 'me'], ['p-theirs', 'other']]) {
      await db
        .prepare(
          `INSERT INTO personal_events (id, user_id, title, timezone, start_at, end_at, status, availability, is_recurring, created_at, updated_at)
           VALUES (?, ?, 'Busy', 'UTC', ?, ?, 'active', 'busy', 0, ?, ?)`,
        )
        .bind(id, owner, now + HOUR_MS, now + 2 * HOUR_MS, now, now)
        .run();
    }

    const events = await myEvents(env, 'me');
    expect(events.map((e) => e.eventId)).toEqual(['p-mine']);
    expect(events[0].isPersonal).toBe(true);
    // Personal time isn't guild-scoped, so it carries no server label.
    expect(events[0].guildId).toBeNull();
  });

  it('rejects a missing or oversized range the same way the guild route does', async () => {
    const { db, env } = setup();
    await seedGuild(db);
    await seedUser(db, 'me');
    await seedMembership(db, 'me', 'guild-1');
    const headers = await authHeaders(env, 'me');

    const missing = await app.request('https://worker.test/me/events', { headers }, env);
    expect(missing.status).toBe(400);

    const backwards = await app.request(
      `https://worker.test/me/events?from=${Date.now()}&to=${Date.now() - 1000}`,
      { headers },
      env,
    );
    expect(backwards.status).toBe(400);

    const huge = await app.request(
      `https://worker.test/me/events?from=0&to=${400 * DAY_MS}`,
      { headers },
      env,
    );
    expect(huge.status).toBe(400);
  });
});

describe('the per-guild calendar still behaves as it did', () => {
  it('scopes to one guild while /me/events spans both', async () => {
    const { db, env } = setup();
    await seedGuild(db, 'guild-1');
    await seedGuild(db, 'guild-2');
    await seedUser(db, 'me');
    await seedMembership(db, 'me', 'guild-1');
    await seedMembership(db, 'me', 'guild-2');
    await seedEvent(db, { id: 'e1', guildId: 'guild-1', organizerId: 'me', startAt: Date.now() + HOUR_MS, endAt: Date.now() + 2 * HOUR_MS });
    await seedEvent(db, { id: 'e2', guildId: 'guild-2', organizerId: 'me', startAt: Date.now() + HOUR_MS, endAt: Date.now() + 2 * HOUR_MS });

    fetchStub = stubFetch([membershipRule(200)]);
    const headers = await authHeaders(env, 'me');
    const from = Date.now() - DAY_MS;
    const to = Date.now() + 7 * DAY_MS;

    const scoped = await app.request(
      `https://worker.test/guilds/guild-1/events?from=${from}&to=${to}`,
      { headers },
      env,
    );
    const scopedBody = (await scoped.json()) as Occurrence[];
    expect(scopedBody.map((e) => e.eventId)).toEqual(['e1']);

    expect((await myEvents(env, 'me')).map((e) => e.eventId).sort()).toEqual(['e1', 'e2']);
  });
});
