// IDEAS item 34: a group's roster is a list of people, and sharing a server
// with those people is not a reason to be handed it.
//
// Before v0.4.3 both group-listing routes joined on *guild* membership alone,
// with no `group_members` predicate on the caller -- so every member of a
// server received every group in it, and every one of those groups' full
// member lists. Not a leak through a crack: it was what the query asked for.
//
// The whole suite passed after the fix went in, which is the reason this file
// exists. Nothing pinned the old behaviour, so nothing would have noticed it
// coming back.
//
// specs/0011 / IDEAS item 36 (Sept 2026): a group no longer belongs to one
// guild, and the second gate this file used to pin -- "still hides a group
// from a member who has left the server" -- was a deliberate call to drop,
// not an oversight to preserve. Decided: group membership alone is enough.
// The boundary that guild check used to protect now lives at the event
// level (a group with no common server can't be used to create a new one;
// see eventWrites.test.ts / stage3-ish coverage for that half), not at the
// roster's own visibility.
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/router';
import { signJwt } from '../src/lib/jwt';
import { createSession } from '../src/lib/sessions';
import { seedGuild, seedMembership, seedUser, setup, stubFetch, type FetchStub } from './helpers';
import type { Env } from '../src/env';
import type { ShimDatabase } from './d1shim';

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

async function seedGroup(db: ShimDatabase, id: string, ownerId: string, memberIds: string[]) {
  await db
    .prepare(
      `INSERT INTO groups (id, name, game, idle_reminder_days, created_by, created_at)
       VALUES (?, ?, NULL, 2, ?, ?)`,
    )
    .bind(id, `Group ${id}`, ownerId, Date.now())
    .run();
  for (const memberId of memberIds) {
    await db
      .prepare(`INSERT INTO group_members (group_id, user_id, added_at) VALUES (?, ?, ?)`)
      .bind(id, memberId, Date.now())
      .run();
  }
}

async function myGroups(env: Env, userId: string): Promise<{ id: string }[]> {
  const headers = await authHeaders(env, userId);
  const res = await app.request('https://worker.test/me/groups', { headers }, env);
  expect(res.status).toBe(200);
  return res.json();
}

describe('a group is visible to its members, not to everyone in its server', () => {
  it('lists a group for someone in it and not for someone merely in the same server', async () => {
    const { db, env } = setup();
    await seedGuild(db);
    for (const id of ['owner', 'member', 'bystander']) {
      await seedUser(db, id);
      await seedMembership(db, id, 'guild-1');
    }
    await seedGroup(db, 'g1', 'owner', ['owner', 'member']);

    expect((await myGroups(env, 'owner')).map((g) => g.id)).toEqual(['g1']);
    expect((await myGroups(env, 'member')).map((g) => g.id)).toEqual(['g1']);
    // The bystander is a full, current member of guild-1. That used to be
    // enough to receive g1 and everyone in it.
    expect(await myGroups(env, 'bystander')).toEqual([]);
  });

  it('does not hand the roster to a bystander who knows the group id', async () => {
    const { db, env } = setup();
    await seedGuild(db);
    for (const id of ['owner', 'bystander']) {
      await seedUser(db, id);
      await seedMembership(db, id, 'guild-1');
    }
    await seedGroup(db, 'g1', 'owner', ['owner']);

    fetchStub = stubFetch([]);
    const res = await app.request(
      'https://worker.test/groups/g1',
      { headers: await authHeaders(env, 'bystander') },
      env,
    );
    // 404 rather than 403: a bystander should not learn the group exists.
    expect(res.status).toBe(404);
  });

  // Decided (Michael, Sept 2026): membership of the group alone is enough.
  // A departed member keeps seeing their own group -- the roster is just a
  // list of people, and there is no second server-membership gate on it any
  // more. The real boundary now lives at the event level (a group with an
  // unreachable member can't be used to create a new event), not here.
  it('still lists a group for a member with no active server membership at all', async () => {
    const { db, env } = setup();
    await seedGuild(db);
    await seedUser(db, 'owner');
    await seedMembership(db, 'owner', 'guild-1');
    await seedUser(db, 'departed');
    await seedMembership(db, 'departed', 'guild-1', { isMember: 0 });
    await seedGroup(db, 'g1', 'owner', ['owner', 'departed']);

    expect((await myGroups(env, 'departed')).map((g) => g.id)).toEqual(['g1']);
  });

  it('has no per-guild group listing at all', async () => {
    // GET /guilds/:guildId/groups was the other half of the same leak and is
    // gone, rather than restricted -- there is no caller for it now that the
    // event form's invitee picker reads /me/groups.
    const { db, env } = setup();
    await seedGuild(db);
    await seedUser(db, 'owner');
    await seedMembership(db, 'owner', 'guild-1');
    await seedGroup(db, 'g1', 'owner', ['owner']);

    fetchStub = stubFetch([]);
    const res = await app.request(
      'https://worker.test/guilds/guild-1/groups',
      { headers: await authHeaders(env, 'owner') },
      env,
    );
    expect(res.status).toBe(404);
  });
});
