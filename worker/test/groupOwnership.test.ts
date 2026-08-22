import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/router';
import { signJwt } from '../src/lib/jwt';
import { createSession } from '../src/lib/sessions';
import { findSuccessorOwner } from '../src/lib/groups';
import {
  countRows,
  membershipRule,
  seedEvent,
  seedGuild,
  seedMembership,
  seedUser,
  setup,
  stubFetch,
  type FetchStub,
} from './helpers';
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

async function seedPeople(db: ShimDatabase, ids: string[]) {
  await seedGuild(db);
  for (const id of ids) {
    await seedUser(db, id);
    await seedMembership(db, id, 'guild-1');
  }
}

async function seedGroup(db: ShimDatabase, id: string, createdBy: string, memberIds: string[]) {
  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO groups (id, guild_id, name, created_by, created_at, idle_reminder_days)
       VALUES (?, 'guild-1', ?, ?, ?, 2)`,
    )
    .bind(id, `Group ${id}`, createdBy, now)
    .run();
  let offset = 0;
  for (const memberId of memberIds) {
    // Staggered added_at so the earliest-joined tiebreak is actually testable.
    await db
      .prepare(`INSERT INTO group_members (group_id, user_id, added_at) VALUES (?, ?, ?)`)
      .bind(id, memberId, now + offset++)
      .run();
  }
}

async function seedAttendance(db: ShimDatabase, eventId: string, groupId: string, userId: string, status: string) {
  await db
    .prepare(
      `INSERT INTO event_invites (id, event_id, user_id, invited_via, source_group_id, rsvp_status, invited_at)
       VALUES (?, ?, ?, 'group', ?, ?, ?)`,
    )
    .bind(`inv-${eventId}-${userId}`, eventId, userId, groupId, status, Date.now())
    .run();
}

describe('a group creator is a member of their own group', () => {
  it('seeds the creator on create, without double-counting one who ticked themselves', async () => {
    const { db, env } = setup();
    await seedPeople(db, ['owner', 'alice']);
    fetchStub = stubFetch([membershipRule(200)]);
    const headers = await authHeaders(env, 'owner');

    const res = await app.request(
      'https://worker.test/guilds/guild-1/groups',
      {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Raiders', member_user_ids: ['alice'] }),
      },
      env,
    );
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };

    expect(await countRows(db, 'group_members', 'group_id = ?', id)).toBe(2);
    expect(await countRows(db, 'group_members', 'group_id = ? AND user_id = ?', id, 'owner')).toBe(1);

    // Ticking yourself in the picker must not produce a duplicate row.
    const res2 = await app.request(
      'https://worker.test/guilds/guild-1/groups',
      {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Second', member_user_ids: ['owner', 'alice'] }),
      },
      env,
    );
    const { id: id2 } = (await res2.json()) as { id: string };
    expect(await countRows(db, 'group_members', 'group_id = ?', id2)).toBe(2);
  });

  it('keeps the owner on the roster when an edit submits a list without them', async () => {
    const { db, env } = setup();
    await seedPeople(db, ['owner', 'alice']);
    await seedGroup(db, 'g1', 'owner', ['owner', 'alice']);
    fetchStub = stubFetch([membershipRule(200)]);
    const headers = await authHeaders(env, 'owner');

    // The edit form submits the complete desired roster; an owner who simply
    // didn't tick themselves must not silently leave their own group.
    const res = await app.request(
      'https://worker.test/groups/g1',
      {
        method: 'PATCH',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ member_user_ids: ['alice'] }),
      },
      env,
    );
    expect(res.status).toBe(200);
    expect(await countRows(db, 'group_members', 'group_id = ? AND user_id = ?', 'g1', 'owner')).toBe(1);
  });
});

describe('ownership transfer when the owner leaves', () => {
  it('hands the group to the member who attended the most of its events', async () => {
    const { db, env } = setup();
    await seedPeople(db, ['owner', 'alice', 'bob']);
    await seedGroup(db, 'g1', 'owner', ['owner', 'alice', 'bob']);
    await seedEvent(db, { id: 'e1', organizerId: 'owner' });
    await seedEvent(db, { id: 'e2', organizerId: 'owner' });
    // bob accepted two, alice one -- bob should inherit despite alice having
    // joined the group first.
    await seedAttendance(db, 'e1', 'g1', 'alice', 'accepted');
    await seedAttendance(db, 'e1', 'g1', 'bob', 'accepted');
    await seedAttendance(db, 'e2', 'g1', 'bob', 'accepted');
    await seedAttendance(db, 'e2', 'g1', 'alice', 'declined');

    expect(await findSuccessorOwner(env, 'g1', 'owner')).toBe('bob');

    fetchStub = stubFetch([membershipRule(200)]);
    const headers = await authHeaders(env, 'owner');
    const res = await app.request(
      'https://worker.test/groups/g1/members/owner',
      { method: 'DELETE', headers },
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ transferredTo: 'bob' });

    const group = await db.prepare(`SELECT created_by FROM groups WHERE id = 'g1'`).first<{ created_by: string }>();
    expect(group?.created_by).toBe('bob');
    expect(await countRows(db, 'group_members', 'group_id = ? AND user_id = ?', 'g1', 'owner')).toBe(0);
  });

  it('breaks a tie on attendance by earliest joined', async () => {
    const { db, env } = setup();
    await seedPeople(db, ['owner', 'alice', 'bob']);
    // alice added before bob; neither has attended anything.
    await seedGroup(db, 'g1', 'owner', ['owner', 'alice', 'bob']);
    expect(await findSuccessorOwner(env, 'g1', 'owner')).toBe('alice');
  });

  it('refuses to leave a group with nobody to hand it to', async () => {
    const { db, env } = setup();
    await seedPeople(db, ['owner']);
    await seedGroup(db, 'g1', 'owner', ['owner']);
    expect(await findSuccessorOwner(env, 'g1', 'owner')).toBeNull();

    fetchStub = stubFetch([membershipRule(200)]);
    const headers = await authHeaders(env, 'owner');
    const res = await app.request(
      'https://worker.test/groups/g1/members/owner',
      { method: 'DELETE', headers },
      env,
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/no one to hand it to/i);

    // Nothing changed: still owned by them, still a member.
    const group = await db.prepare(`SELECT created_by FROM groups WHERE id = 'g1'`).first<{ created_by: string }>();
    expect(group?.created_by).toBe('owner');
    expect(await countRows(db, 'group_members', 'group_id = ?', 'g1')).toBe(1);
  });

  it('removing someone who is not the owner leaves ownership alone', async () => {
    const { db, env } = setup();
    await seedPeople(db, ['owner', 'alice']);
    await seedGroup(db, 'g1', 'owner', ['owner', 'alice']);
    fetchStub = stubFetch([membershipRule(200)]);
    const headers = await authHeaders(env, 'owner');

    const res = await app.request(
      'https://worker.test/groups/g1/members/alice',
      { method: 'DELETE', headers },
      env,
    );
    expect(res.status).toBe(200);
    const group = await db.prepare(`SELECT created_by FROM groups WHERE id = 'g1'`).first<{ created_by: string }>();
    expect(group?.created_by).toBe('owner');
  });
});

describe('group permissions stay owner-only for administration', () => {
  it('a non-owner member cannot add members, rename or delete', async () => {
    const { db, env } = setup();
    await seedPeople(db, ['owner', 'alice', 'carol']);
    await seedGroup(db, 'g1', 'owner', ['owner', 'alice']);
    fetchStub = stubFetch([membershipRule(200)]);
    const headers = await authHeaders(env, 'alice');
    const json = { ...headers, 'Content-Type': 'application/json' };

    const add = await app.request(
      'https://worker.test/groups/g1/members',
      { method: 'POST', headers: json, body: JSON.stringify({ userId: 'carol' }) },
      env,
    );
    expect(add.status).toBe(403);

    const rename = await app.request(
      'https://worker.test/groups/g1',
      { method: 'PATCH', headers: json, body: JSON.stringify({ name: 'Hijacked' }) },
      env,
    );
    expect(rename.status).toBe(403);

    const del = await app.request('https://worker.test/groups/g1', { method: 'DELETE', headers }, env);
    expect(del.status).toBe(403);
  });
});
