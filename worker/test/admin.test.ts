import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/router';
import { signJwt } from '../src/lib/jwt';
import { createSession } from '../src/lib/sessions';
import { seedGuild, seedMembership, seedUser, setup, stubFetch, type FetchStub } from './helpers';
import type { Env } from '../src/env';

let fetchStub: FetchStub | null = null;
afterEach(() => {
  fetchStub?.restore();
  fetchStub = null;
});

const app = buildApp();

async function authFor(env: Env, userId: string): Promise<Record<string, string>> {
  const { id: sessionId } = await createSession(env, userId);
  const token = await signJwt(userId, sessionId, env.JWT_SIGNING_KEY);
  return { Authorization: `Bearer ${token}` };
}

async function call(env: Env, path: string, init: RequestInit = {}): Promise<Response> {
  return app.request(`https://worker.test${path}`, init, env);
}

describe('GET /admin/users', () => {
  it('rejects a non-owner with 403', async () => {
    const { db, env } = setup();
    await seedUser(db, 'not-owner');
    const headers = await authFor(env, 'not-owner');
    const res = await call(env, '/admin/users', { headers });
    expect(res.status).toBe(403);
  });

  it('rejects an unauthenticated request with 401 before the owner check', async () => {
    const { env } = setup();
    const res = await call(env, '/admin/users');
    expect(res.status).toBe(401);
  });

  it('lets the owner list every user with their guild memberships and last login', async () => {
    const { db, env } = setup();
    // OWNER_DISCORD_ID is 'owner' in the test env (see helpers.ts:makeEnv).
    await seedUser(db, 'owner');
    await seedUser(db, 'alice');
    await seedUser(db, 'bob');
    await seedGuild(db, 'guild-1');
    await seedGuild(db, 'guild-2');
    await seedMembership(db, 'alice', 'guild-1');
    await seedMembership(db, 'alice', 'guild-2');
    await seedMembership(db, 'bob', 'guild-1');
    // A membership row that's since lapsed. It must still be *reported* --
    // hiding it made "departed" indistinguishable from "never a member"
    // (idea 15) -- but tagged isMember: false rather than as current.
    await seedMembership(db, 'bob', 'guild-2', { isMember: 0 });

    const headers = await authFor(env, 'owner');
    const res = await call(env, '/admin/users', { headers });
    expect(res.status).toBe(200);
    const body = await res.json<{
      users: {
        id: string;
        guilds: { id: string; name: string; isMember: boolean }[];
        lastLoginAt: number | null;
      }[];
      nextCursor: string | null;
    }>();

    expect(body.users.map((u) => u.id).sort()).toEqual(['alice', 'bob', 'owner']);

    const alice = body.users.find((u) => u.id === 'alice')!;
    expect(alice.guilds.map((g) => g.id).sort()).toEqual(['guild-1', 'guild-2']);
    expect(alice.guilds.every((g) => g.isMember)).toBe(true);
    expect(alice.lastLoginAt).not.toBeNull();

    // Bob's departed guild-2 row comes back, flagged -- that's the whole
    // point. Someone showing no *current* servers still shows the history.
    const bob = body.users.find((u) => u.id === 'bob')!;
    expect(bob.guilds.map((g) => g.id).sort()).toEqual(['guild-1', 'guild-2']);
    expect(bob.guilds.find((g) => g.id === 'guild-1')!.isMember).toBe(true);
    expect(bob.guilds.find((g) => g.id === 'guild-2')!.isMember).toBe(false);
  });

  it('reports a login attempt that was turned away separately from a real login', async () => {
    const { db, env } = setup();
    await seedUser(db, 'owner');
    // seedUser stamps both, as a successful login would. An attempt that was
    // rejected for sharing no allow-listed server leaves last_login_at alone,
    // which is what makes the two tellable apart on this page (idea 15).
    await seedUser(db, 'bounced');
    await db
      .prepare(`UPDATE users SET last_login_at = NULL, last_login_attempt_at = ? WHERE id = 'bounced'`)
      .bind(Date.now())
      .run();

    const headers = await authFor(env, 'owner');
    const res = await call(env, '/admin/users', { headers });
    const body = await res.json<{
      users: { id: string; lastLoginAt: number | null; lastLoginAttemptAt: number | null }[];
    }>();

    const bounced = body.users.find((u) => u.id === 'bounced')!;
    expect(bounced.lastLoginAt).toBeNull();
    expect(bounced.lastLoginAttemptAt).not.toBeNull();

    const owner = body.users.find((u) => u.id === 'owner')!;
    expect(owner.lastLoginAt).not.toBeNull();
  });

  it('pages with a keyset cursor rather than returning everything at once', async () => {
    const { db, env } = setup();
    await seedUser(db, 'owner');
    for (let i = 0; i < 5; i++) await seedUser(db, `user-${i}`);
    const headers = await authFor(env, 'owner');

    const first = await call(env, '/admin/users?limit=2', { headers });
    const firstBody = await first.json<{ users: { id: string }[]; nextCursor: string | null }>();
    expect(firstBody.users).toHaveLength(2);
    expect(firstBody.nextCursor).not.toBeNull();

    const second = await call(env, `/admin/users?limit=2&after=${firstBody.nextCursor}`, { headers });
    const secondBody = await second.json<{ users: { id: string }[]; nextCursor: string | null }>();
    expect(secondBody.users).toHaveLength(2);
    expect(secondBody.users.map((u) => u.id)).not.toEqual(firstBody.users.map((u) => u.id));
  });

  it('does not read any event data -- only users and guild membership', async () => {
    // Documents the boundary from ARCHITECTURE.md's privacy model: no admin
    // endpoint reads other people's event data. This isn't a runtime
    // assertion so much as a marker that the response shape below is the
    // whole contract -- adding event fields to it later should fail review,
    // not this test, but the shape is pinned here to make the omission
    // explicit.
    const { db, env } = setup();
    await seedUser(db, 'owner');
    const headers = await authFor(env, 'owner');
    const res = await call(env, '/admin/users', { headers });
    const body = await res.json<{ users: Record<string, unknown>[] }>();
    const keys = Object.keys(body.users[0]).sort();
    expect(keys).toEqual([
      'globalName',
      'guilds',
      'id',
      'lastLoginAt',
      'lastLoginAttemptAt',
      'notificationsEnabled',
      'username',
    ]);
  });
});

// IDEAS item 58: deactivating a server (DELETE /admin/guilds/:id) only makes
// the app forget it -- this is the separate, deliberate action that makes the
// bot actually leave.
describe('POST /admin/guilds/:id/leave', () => {
  it('rejects a non-owner with 403', async () => {
    const { db, env } = setup();
    await seedUser(db, 'not-owner');
    const headers = await authFor(env, 'not-owner');
    const res = await call(env, '/admin/guilds/some-guild/leave', { method: 'POST', headers });
    expect(res.status).toBe(403);
  });

  it('calls Discord to remove the bot from the guild', async () => {
    const { db, env } = setup();
    await seedUser(db, 'owner');
    await seedGuild(db, 'guild-1');
    // Discord's real response here is a bodyless 204; the stub can't
    // construct one (a Response with a null-body status can't carry a body
    // string), so this uses 200 -- leaveGuild only branches on res.ok.
    fetchStub = stubFetch([{ match: '/users/@me/guilds/guild-1', status: 200 }]);

    const headers = await authFor(env, 'owner');
    const res = await call(env, '/admin/guilds/guild-1/leave', { method: 'POST', headers });
    expect(res.status).toBe(200);
    expect(fetchStub.calls.some((u) => u.includes('/users/@me/guilds/guild-1'))).toBe(true);
  });

  it('treats a 404 from Discord (already not a member) as success', async () => {
    const { db, env } = setup();
    await seedUser(db, 'owner');
    fetchStub = stubFetch([{ match: '/users/@me/guilds/', status: 404 }]);

    const headers = await authFor(env, 'owner');
    const res = await call(env, '/admin/guilds/never-joined/leave', { method: 'POST', headers });
    expect(res.status).toBe(200);
  });

  it('surfaces a real Discord failure as a 500', async () => {
    const { db, env } = setup();
    await seedUser(db, 'owner');
    fetchStub = stubFetch([{ match: '/users/@me/guilds/', status: 401 }]);

    const headers = await authFor(env, 'owner');
    const res = await call(env, '/admin/guilds/guild-1/leave', { method: 'POST', headers });
    expect(res.status).toBe(500);
  });
});
