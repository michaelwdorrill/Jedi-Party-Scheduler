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
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/router';
import { signJwt } from '../src/lib/jwt';
import { createSession } from '../src/lib/sessions';
import { DAY_MS, seedGuild, seedMembership, seedUser, setup, stubFetch, type FetchStub } from './helpers';
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

async function seedGroup(db: ShimDatabase, id: string, guildId: string, ownerId: string, memberIds: string[]) {
  await db
    .prepare(
      `INSERT INTO groups (id, guild_id, name, game, idle_reminder_days, created_by, created_at)
       VALUES (?, ?, ?, NULL, 2, ?, ?)`,
    )
    .bind(id, guildId, `Group ${id}`, ownerId, Date.now())
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
    await seedGroup(db, 'g1', 'guild-1', 'owner', ['owner', 'member']);

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
    await seedGroup(db, 'g1', 'guild-1', 'owner', ['owner']);

    fetchStub = stubFetch([]);
    const res = await app.request(
      'https://worker.test/groups/g1',
      { headers: await authHeaders(env, 'bystander') },
      env,
    );
    // 404 rather than 403: a bystander should not learn the group exists.
    expect(res.status).toBe(404);
  });

  it('still hides a group from a member who has left the server', async () => {
    // The `group_members` predicate does not make the guild predicate
    // redundant -- roster rows survive someone leaving a server, so
    // membership of the group alone would keep the group on their list
    // forever. Both have to hold.
    const { db, env } = setup();
    await seedGuild(db);
    await seedUser(db, 'owner');
    await seedMembership(db, 'owner', 'guild-1');
    await seedUser(db, 'departed');
    await seedMembership(db, 'departed', 'guild-1', { isMember: 0 });
    await seedGroup(db, 'g1', 'guild-1', 'owner', ['owner', 'departed']);

    expect(await myGroups(env, 'departed')).toEqual([]);
  });

  it('hides a group whose membership row has gone stale past the grace window', async () => {
    const { db, env } = setup();
    await seedGuild(db);
    await seedUser(db, 'owner');
    await seedMembership(db, 'owner', 'guild-1', { verifiedAgoMs: 3 * DAY_MS });
    await seedGroup(db, 'g1', 'guild-1', 'owner', ['owner']);

    expect(await myGroups(env, 'owner')).toEqual([]);
  });

  it('has no per-guild group listing at all', async () => {
    // GET /guilds/:guildId/groups was the other half of the same leak and is
    // gone, rather than restricted -- there is no caller for it now that the
    // event form's invitee picker reads /me/groups.
    const { db, env } = setup();
    await seedGuild(db);
    await seedUser(db, 'owner');
    await seedMembership(db, 'owner', 'guild-1');
    await seedGroup(db, 'g1', 'guild-1', 'owner', ['owner']);

    fetchStub = stubFetch([]);
    const res = await app.request(
      'https://worker.test/guilds/guild-1/groups',
      { headers: await authHeaders(env, 'owner') },
      env,
    );
    expect(res.status).toBe(404);
  });
});
