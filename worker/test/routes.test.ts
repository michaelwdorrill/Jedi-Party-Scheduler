import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/router';
import { signJwt } from '../src/lib/jwt';
import { createSession, revokeSession } from '../src/lib/sessions';
import { LIMITS, MAX_BODY_BYTES } from '../src/lib/validate';
import {
  DAY_MS,
  HOUR_MS,
  ids,
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
import { MEMBERSHIP_GRACE_MS } from '../src/lib/db';
import type { Env } from '../src/env';

let fetchStub: FetchStub | null = null;
afterEach(() => {
  fetchStub?.restore();
  fetchStub = null;
});

const app = buildApp();

async function authFor(env: Env, userId: string): Promise<{ headers: Record<string, string>; sessionId: string }> {
  const { id: sessionId } = await createSession(env, userId);
  const token = await signJwt(userId, sessionId, env.JWT_SIGNING_KEY);
  return { headers: { Authorization: `Bearer ${token}` }, sessionId };
}

async function call(env: Env, path: string, init: RequestInit = {}): Promise<Response> {
  return app.request(`https://worker.test${path}`, init, env);
}

async function seedSignedInUser({ verifiedAgoMs = 0 } = {}) {
  const ctx = setup();
  await seedGuild(ctx.db);
  await seedUser(ctx.db, 'u1');
  await seedMembership(ctx.db, 'u1', 'guild-1', { verifiedAgoMs });
  const auth = await authFor(ctx.env, 'u1');
  return { ...ctx, ...auth };
}

const range = `from=${Date.now()}&to=${Date.now() + 30 * DAY_MS}`;

describe('authentication', () => {
  it('rejects a request with no token', async () => {
    const { env } = await seedSignedInUser();
    expect((await call(env, '/me')).status).toBe(401);
  });

  it.each([
    ['garbage', 'not-a-jwt'],
    ['wrong shape', 'a.b'],
    ['bad signature', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1MSJ9.wrong'],
    ['empty', ''],
  ])('rejects a malformed token (%s) with 401, not 500', async (_label, token) => {
    const { env } = await seedSignedInUser();
    const res = await call(env, '/me', { headers: { Authorization: `Bearer ${token}` } });
    expect(res.status).toBe(401);
  });

  it('accepts a valid token backed by a live session', async () => {
    const { env, headers } = await seedSignedInUser();
    expect((await call(env, '/me', { headers })).status).toBe(200);
  });

  // The whole point of server-side sessions: revocation takes effect
  // immediately, without waiting out the access token's lifetime.
  it('rejects a valid token whose session has been revoked', async () => {
    const { env, headers, sessionId } = await seedSignedInUser();
    await revokeSession(env, sessionId);
    expect((await call(env, '/me', { headers })).status).toBe(401);
  });

  it('rejects a valid token whose session has expired', async () => {
    const { db, env, headers, sessionId } = await seedSignedInUser();
    await db.prepare(`UPDATE sessions SET expires_at = ? WHERE id = ?`).bind(Date.now() - 1000, sessionId).run();
    expect((await call(env, '/me', { headers })).status).toBe(401);
  });
});

describe('guild membership responses', () => {
  it('allows a current member', async () => {
    const { env, headers } = await seedSignedInUser();
    fetchStub = stubFetch([]);
    expect((await call(env, `/guilds/guild-1/events?${range}`, { headers })).status).toBe(200);
  });

  it('returns 403 for a guild the caller is not in', async () => {
    const { db, env, headers } = await seedSignedInUser();
    await seedGuild(db, 'other-guild');
    fetchStub = stubFetch([]);
    expect((await call(env, `/guilds/other-guild/events?${range}`, { headers })).status).toBe(403);
  });

  it('returns 403 once Discord confirms the caller has left', async () => {
    const { env, headers } = await seedSignedInUser({ verifiedAgoMs: 2 * HOUR_MS });
    fetchStub = stubFetch([membershipRule(404)]);
    expect((await call(env, `/guilds/guild-1/events?${range}`, { headers })).status).toBe(403);
  });

  // The distinction that matters: an unreachable Discord is not a permissions
  // decision, and answering 403 would tell the user they'd lost access to
  // their own server.
  it('returns a retryable 503 -- not 403 -- when membership cannot be verified', async () => {
    const { env, headers } = await seedSignedInUser({ verifiedAgoMs: MEMBERSHIP_GRACE_MS + HOUR_MS });
    fetchStub = stubFetch([membershipRule(500)]);

    const res = await call(env, `/guilds/guild-1/events?${range}`, { headers });
    expect(res.status).toBe(503);
    expect(res.headers.get('Retry-After')).toBe('300');
  });

  it('still serves the request inside the grace window', async () => {
    const { env, headers } = await seedSignedInUser({ verifiedAgoMs: 2 * HOUR_MS });
    fetchStub = stubFetch([membershipRule(500)]);
    expect((await call(env, `/guilds/guild-1/events?${range}`, { headers })).status).toBe(200);
  });
});

describe('request validation at the route boundary', () => {
  it('rejects an oversized body by its declared length with 413', async () => {
    const { env, headers } = await seedSignedInUser();
    const res = await call(env, '/me', {
      method: 'PATCH',
      headers: { ...headers, 'Content-Length': String(MAX_BODY_BYTES + 1) },
      body: JSON.stringify({ timezone: 'UTC' }),
    });
    expect(res.status).toBe(413);
  });

  // Content-Length is attacker-controlled and absent for chunked transfer, so
  // the streaming reader is the real backstop.
  it('rejects an oversized body that under-declares its length', async () => {
    const { env, headers } = await seedSignedInUser();
    const res = await call(env, '/me', {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ timezone: 'UTC', padding: 'x'.repeat(MAX_BODY_BYTES) }),
    });
    expect(res.status).toBe(413);
  });

  it('turns a validation failure into a 400 with a usable message', async () => {
    const { env, headers } = await seedSignedInUser();
    const res = await call(env, '/me', {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ timezone: 'Mars/Olympus_Mons' }),
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('timezone');
  });

  it('rejects a non-boolean settings toggle', async () => {
    const { env, headers } = await seedSignedInUser();
    const res = await call(env, '/me', {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ notificationsEnabled: 'yes' }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects a malformed occurrence date in the path', async () => {
    const { db, env, headers } = await seedSignedInUser();
    await seedEvent(db, { id: 'e1', organizerId: 'u1', isRecurring: 1 });
    fetchStub = stubFetch([]);

    const res = await call(env, '/events/e1/occurrences/not-a-date/cancel', { method: 'POST', headers });
    expect(res.status).toBe(400);
  });

  it('accepts a well-formed occurrence date', async () => {
    const { db, env, headers } = await seedSignedInUser();
    await seedEvent(db, { id: 'e1', organizerId: 'u1', isRecurring: 1 });
    fetchStub = stubFetch([]);

    const res = await call(env, '/events/e1/occurrences/2026-03-14/cancel', { method: 'POST', headers });
    expect(res.status).toBe(200);
  });

  it('rejects a from/to range wider than the configured maximum', async () => {
    const { env, headers } = await seedSignedInUser();
    fetchStub = stubFetch([]);
    const wide = `from=0&to=${Date.now() + 10 * 365 * DAY_MS}`;
    expect((await call(env, `/guilds/guild-1/events?${wide}`, { headers })).status).toBe(400);
  });

  it('sets Referrer-Policy on every response', async () => {
    const { env, headers } = await seedSignedInUser();
    const res = await call(env, '/me', { headers });
    expect(res.headers.get('Referrer-Policy')).toBe('no-referrer');
  });
});

describe('object visibility', () => {
  it('hides an event from a signed-in user who is neither organizer nor invitee', async () => {
    const { db, env } = await seedSignedInUser();
    await seedUser(db, 'stranger');
    await seedMembership(db, 'stranger', 'guild-1');
    await seedEvent(db, { id: 'private', organizerId: 'u1' });
    const stranger = await authFor(env, 'stranger');
    fetchStub = stubFetch([]);

    expect((await call(env, '/events/private', { headers: stranger.headers })).status).toBe(404);
  });

  it('shows an event to someone invited to it', async () => {
    const { db, env } = await seedSignedInUser();
    await seedUser(db, 'guest');
    await seedMembership(db, 'guest', 'guild-1');
    await seedEvent(db, { id: 'shared', organizerId: 'u1' });
    await seedInvite(db, 'shared', 'guest');
    const guest = await authFor(env, 'guest');
    fetchStub = stubFetch([]);

    expect((await call(env, '/events/shared', { headers: guest.headers })).status).toBe(200);
  });

  it('refuses to let a non-organizer edit an event', async () => {
    const { db, env } = await seedSignedInUser();
    await seedUser(db, 'guest');
    await seedMembership(db, 'guest', 'guild-1');
    await seedEvent(db, { id: 'shared', organizerId: 'u1' });
    await seedInvite(db, 'shared', 'guest');
    const guest = await authFor(env, 'guest');
    fetchStub = stubFetch([]);

    const res = await call(env, '/events/shared', {
      method: 'PATCH',
      headers: guest.headers,
      body: JSON.stringify({ title: 'Hijacked' }),
    });
    expect(res.status).toBe(404);
  });
});

describe('scheduling assistant', () => {
  // Free/busy cost is a product (users x events x occurrences), so its
  // maximum is deliberately much smaller than other list limits.
  it('accepts the full configured user maximum', async () => {
    const { db, env, headers } = await seedSignedInUser();
    const userIds = ids('friend', LIMITS.MAX_FREE_BUSY_USERS);
    for (const id of userIds) {
      await seedUser(db, id);
      await seedMembership(db, id, 'guild-1');
    }
    fetchStub = stubFetch([]);

    const res = await call(env, `/guilds/guild-1/free-busy?${range}&user_ids=${userIds.join(',')}`, { headers });
    expect(res.status).toBe(200);
    expect((await res.json()) as unknown[]).toHaveLength(LIMITS.MAX_FREE_BUSY_USERS);
  });

  it('rejects more than the configured maximum', async () => {
    const { env, headers } = await seedSignedInUser();
    fetchStub = stubFetch([]);

    const res = await call(
      env,
      `/guilds/guild-1/free-busy?${range}&user_ids=${ids('friend', LIMITS.MAX_FREE_BUSY_USERS + 1).join(',')}`,
      { headers },
    );
    expect(res.status).toBe(400);
  });

  // Free/busy has its own, far shorter range cap than the calendar: a year
  // of 25 people's recurring series is where the unbounded occurrence
  // expansion came from.
  it('rejects a range longer than the free/busy window even though the calendar would allow it', async () => {
    const { env, headers } = await seedSignedInUser();
    fetchStub = stubFetch([]);
    const from = Date.now();
    const to = from + LIMITS.MAX_FREE_BUSY_RANGE_MS + DAY_MS;

    const res = await call(env, `/guilds/guild-1/free-busy?from=${from}&to=${to}&user_ids=friend-0`, { headers });
    expect(res.status).toBe(400);
  });
});

// A personal-event PATCH that touches the schedule has to leave a coherent
// one behind. Per-field validation can't see this: every individual field in
// `{isRecurring: true}` is valid, but the combination asks for a recurring
// event with no rule, which the write path resolved by producing a
// non-recurring event with no start or end time -- exactly the shape POST
// refuses to create.
describe('personal event schedule coherence', () => {
  async function createOneOff(env: Env, headers: Record<string, string>): Promise<string> {
    const res = await call(env, '/personal-events', {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Dentist',
        timezone: 'America/New_York',
        startAt: Date.now() + HOUR_MS,
        endAt: Date.now() + 2 * HOUR_MS,
      }),
    });
    expect(res.status).toBe(201);
    return (await res.json<{ id: string }>()).id;
  }

  async function patch(env: Env, headers: Record<string, string>, id: string, body: unknown): Promise<Response> {
    return call(env, `/personal-events/${id}`, {
      method: 'PATCH',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('rejects switching to recurring without a rule', async () => {
    const { env, headers } = await seedSignedInUser();
    const id = await createOneOff(env, headers);
    expect((await patch(env, headers, id, { isRecurring: true })).status).toBe(400);
  });

  it('rejects switching to non-recurring without a complete time range', async () => {
    const { env, headers } = await seedSignedInUser();
    const id = await createOneOff(env, headers);
    expect((await patch(env, headers, id, { isRecurring: false })).status).toBe(400);
    expect((await patch(env, headers, id, { isRecurring: false, startAt: Date.now() })).status).toBe(400);
  });

  it('leaves the stored event untouched when a schedule edit is rejected', async () => {
    const { db, env, headers } = await seedSignedInUser();
    const id = await createOneOff(env, headers);
    await patch(env, headers, id, { isRecurring: true });

    const row = await db
      .prepare(`SELECT is_recurring, start_at, end_at FROM personal_events WHERE id = ?`)
      .bind(id)
      .first<{ is_recurring: number; start_at: number | null; end_at: number | null }>();
    expect(row?.is_recurring).toBe(0);
    expect(row?.start_at).not.toBeNull();
    expect(row?.end_at).not.toBeNull();
  });

  it('still allows a partial edit that does not touch the schedule', async () => {
    const { db, env, headers } = await seedSignedInUser();
    const id = await createOneOff(env, headers);
    expect((await patch(env, headers, id, { title: 'Renamed' })).status).toBe(200);

    const row = await db
      .prepare(`SELECT title, start_at FROM personal_events WHERE id = ?`)
      .bind(id)
      .first<{ title: string; start_at: number | null }>();
    expect(row?.title).toBe('Renamed');
    expect(row?.start_at).not.toBeNull();
  });
});
