import { Hono } from 'hono';
import type { AppEnv } from '../lib/authMiddleware';
import type { Env } from '../env';
import { chunkRows } from '../lib/d1';
import { assertValidRoster, commonServerSet } from '../lib/groups';
import { ownerDepartureStatements } from '../lib/groups';
import { newId } from '../lib/ids';
import { assertOptionalString, assertSafeInt, assertString, assertStringArray, LIMITS, readJsonBody, ValidationError } from '../lib/validate';

export const groupRoutes = new Hono<AppEnv>();

interface GroupRow {
  id: string;
  name: string;
  game: string | null;
  idle_reminder_days: number;
  created_by: string;
}

async function loadGroupMembers(db: D1Database, groupId: string) {
  const { results } = await db
    .prepare(
      `SELECT u.id, u.username, u.global_name, u.avatar_hash
       FROM group_members gm JOIN users u ON u.id = gm.user_id
       WHERE gm.group_id = ?`,
    )
    .bind(groupId)
    .all<{ id: string; username: string; global_name: string | null; avatar_hash: string | null }>();
  return results.map((m) => ({
    id: m.id,
    username: m.username,
    globalName: m.global_name,
    avatarHash: m.avatar_hash,
  }));
}

// A group's roster is a list of people, so being in the same server as those
// people is not a reason to be handed it (IDEAS item 34). Every read and
// every write below requires membership of the group itself, and nothing
// else -- specs/0011, decided: membership of the group alone is enough.
// There is no longer a second "and still shares a server" gate the way there
// was when a group belonged to one guild (`group.guild_id`); the boundary
// that check used to protect now lives at the event level instead (a group
// with an unreachable member can't be used on a new event, and an existing
// event whose group has drifted apart says so -- see routes/events.ts and
// the group-drift cron sweep).
async function isGroupMember(env: Env, groupId: string, userId: string): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT 1 AS ok FROM group_members WHERE group_id = ? AND user_id = ?`,
  )
    .bind(groupId, userId)
    .first<{ ok: number }>();
  return !!row;
}

async function loadGroup(env: Env, groupId: string, userId: string): Promise<GroupRow | null> {
  const group = await env.DB.prepare(`SELECT * FROM groups WHERE id = ?`).bind(groupId).first<GroupRow>();
  if (!group || !(await isGroupMember(env, group.id, userId))) return null;
  return group;
}

groupRoutes.get('/:groupId', async (c) => {
  const userId = c.get('userId');
  const group = await loadGroup(c.env, c.req.param('groupId'), userId);
  if (!group) return c.text('Not found', 404);

  const members = await loadGroupMembers(c.env.DB, group.id);
  return c.json({
    id: group.id,
    name: group.name,
    game: group.game,
    idleReminderDays: group.idle_reminder_days,
    createdBy: group.created_by,
    members,
    commonServers: await commonServerSet(c.env, members.map((m) => m.id)),
  });
});

// specs/0011: group creation is no longer scoped to a server -- it moved
// here from POST /guilds/:guildId/groups, which is gone. Anyone can propose
// a roster; the only requirement is that the roster (with the creator
// included) shares a common server, checked the same way every other
// roster-changing route checks it.
groupRoutes.post('/', async (c) => {
  const userId = c.get('userId');
  const body = await readJsonBody<{ name: string; game?: string | null; idle_reminder_days?: number; member_user_ids: string[] }>(c);
  const name = assertString(body.name, 'name', LIMITS.GROUP_NAME);
  const game = assertOptionalString(body.game, 'game', LIMITS.GAME);
  const idleReminderDays = body.idle_reminder_days === undefined ? 2 : assertSafeInt(body.idle_reminder_days, 'idle_reminder_days');
  if (idleReminderDays < 1 || idleReminderDays > 3650) throw new ValidationError('idle_reminder_days out of range');
  const memberIds = assertStringArray(body.member_user_ids ?? [], 'member_user_ids', LIMITS.MAX_GROUP_MEMBERS, 64);

  // The creator is always a member of their own group (migration 0017).
  // Deduped here rather than relying on INSERT OR IGNORE alone, so the
  // roster actually validated and counted against MAX_GROUP_MEMBERS is the
  // one that gets written.
  const rosterIds = memberIds.includes(userId) ? memberIds : [userId, ...memberIds];
  await assertValidRoster(c.env, rosterIds);

  const groupCount = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM groups WHERE created_by = ?`)
    .bind(userId)
    .first<{ n: number }>();
  if ((groupCount?.n ?? 0) >= LIMITS.MAX_GROUPS_PER_OWNER) {
    throw new ValidationError("You've reached your limit of groups");
  }

  const groupId = newId();
  const now = Date.now();
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO groups (id, name, game, idle_reminder_days, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(groupId, name, game, idleReminderDays, userId, now),
    ...chunkRows(rosterIds, 3).map((chunk) =>
      c.env.DB.prepare(
        `INSERT OR IGNORE INTO group_members (group_id, user_id, added_at)
         VALUES ${chunk.map(() => '(?, ?, ?)').join(', ')}`,
      ).bind(...chunk.flatMap((memberId) => [groupId, memberId, now])),
    ),
  ]);

  return c.json({ id: groupId }, 201);
});

// specs/0011: live narrowing for the group create/edit picker. Given a
// candidate roster (which may not include every already-selected member's
// final form -- the frontend calls this on every change), returns the
// common-server set that roster would have. The frontend uses this to grey
// out candidates that would empty the intersection; this route is also the
// only source of truth an editor has for "would this roster actually be
// valid", since the real check (assertValidRoster) only runs on save.
groupRoutes.post('/common-servers', async (c) => {
  const body = await readJsonBody<{ member_user_ids: string[] }>(c);
  const memberIds = assertStringArray(body.member_user_ids ?? [], 'member_user_ids', LIMITS.MAX_GROUP_MEMBERS, 64);
  return c.json({ servers: await commonServerSet(c.env, memberIds) });
});

groupRoutes.patch('/:groupId', async (c) => {
  const userId = c.get('userId');
  const group = await loadGroup(c.env, c.req.param('groupId'), userId);
  if (!group) return c.text('Not found', 404);
  if (group.created_by !== userId) return c.text('Forbidden', 403);

  const body = await readJsonBody<{
    name?: string;
    game?: string | null;
    idle_reminder_days?: number;
    member_user_ids?: string[];
  }>(c);

  // Validate and resolve every field before queuing any mutation -- an
  // invalid member target must not leave the name/settings changed while
  // the roster half of the same request fails.
  const name = body.name !== undefined ? assertString(body.name, 'name', LIMITS.GROUP_NAME) : undefined;
  const game = body.game !== undefined ? assertOptionalString(body.game, 'game', LIMITS.GAME) : undefined;
  let days: number | undefined;
  if (body.idle_reminder_days !== undefined) {
    days = assertSafeInt(body.idle_reminder_days, 'idle_reminder_days');
    if (days < 1 || days > 3650) throw new ValidationError('idle_reminder_days out of range');
  }
  let memberIds: string[] | undefined;
  if (body.member_user_ids) {
    memberIds = assertStringArray(body.member_user_ids, 'member_user_ids', LIMITS.MAX_GROUP_MEMBERS, 64);
    // The owner stays on their own roster whatever the submitted list says.
    // The edit form sends the complete desired membership, so an owner who
    // simply doesn't tick themselves would otherwise silently leave -- which
    // is a different intent from the explicit "remove me" that
    // DELETE /:groupId/members/:userId expresses, and the only one of the two
    // that should hand the group to someone else.
    if (!memberIds.includes(userId)) memberIds = [userId, ...memberIds];
    await assertValidRoster(c.env, memberIds);
  }

  const statements: D1PreparedStatement[] = [];
  const setClauses: string[] = [];
  const values: unknown[] = [];
  if (name !== undefined) {
    setClauses.push('name = ?');
    values.push(name);
  }
  if (game !== undefined) {
    setClauses.push('game = ?');
    values.push(game);
  }
  if (days !== undefined) {
    setClauses.push('idle_reminder_days = ?');
    values.push(days);
  }
  if (setClauses.length > 0) {
    values.push(c.req.param('groupId'));
    statements.push(c.env.DB.prepare(`UPDATE groups SET ${setClauses.join(', ')} WHERE id = ?`).bind(...values));
  }
  if (memberIds !== undefined) {
    const now = Date.now();
    const groupId = c.req.param('groupId');
    statements.push(c.env.DB.prepare(`DELETE FROM group_members WHERE group_id = ?`).bind(groupId));
    // Multi-row inserts: a roster may hold MAX_GROUP_MEMBERS people, and one
    // statement each would put that many queries in a single batch.
    for (const chunk of chunkRows(memberIds, 3)) {
      statements.push(
        c.env.DB.prepare(
          `INSERT INTO group_members (group_id, user_id, added_at)
           VALUES ${chunk.map(() => '(?, ?, ?)').join(', ')}`,
        ).bind(...chunk.flatMap((memberId) => [groupId, memberId, now])),
      );
    }
  }
  // One batch for the whole request -- a failure partway through leaves
  // nothing applied, rather than scalar fields changed with a stale roster
  // (or vice versa).
  if (statements.length > 0) await c.env.DB.batch(statements);
  return c.json({ ok: true });
});

groupRoutes.delete('/:groupId', async (c) => {
  const userId = c.get('userId');
  const groupId = c.req.param('groupId');
  const group = await loadGroup(c.env, groupId, userId);
  if (!group) return c.text('Not found', 404);
  if (group.created_by !== userId) return c.text('Forbidden', 403);

  // event_invites.source_group_id references this group with no cascade/
  // set-null delete action, so a group that was ever used to invite people
  // to an event would otherwise block its own deletion with a FK violation
  // (the same class of bug fixed for account deletion's sessions FK). Clear
  // the historical reference first, in the same batch -- this never touches
  // the event or its invitees, just detaches which group originally sourced
  // the invite.
  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE event_invites SET source_group_id = NULL WHERE source_group_id = ?`).bind(groupId),
    c.env.DB.prepare(`DELETE FROM group_members WHERE group_id = ?`).bind(groupId),
    c.env.DB.prepare(`DELETE FROM group_nudge_log WHERE group_id = ?`).bind(groupId),
    c.env.DB.prepare(`DELETE FROM group_activity_nudges WHERE group_id = ?`).bind(groupId),
    c.env.DB.prepare(`DELETE FROM groups WHERE id = ?`).bind(groupId),
  ]);
  return c.json({ ok: true });
});

groupRoutes.post('/:groupId/members', async (c) => {
  const userId = c.get('userId');
  const groupId = c.req.param('groupId');
  const group = await loadGroup(c.env, groupId, userId);
  if (!group) return c.text('Not found', 404);
  if (group.created_by !== userId) return c.text('Forbidden', 403);

  const body = await readJsonBody<{ userId: string }>(c);
  const targetId = assertString(body.userId, 'userId', 64);

  const existing = await loadGroupMembers(c.env.DB, groupId);
  const proposedRoster = existing.map((m) => m.id).includes(targetId)
    ? existing.map((m) => m.id)
    : [...existing.map((m) => m.id), targetId];
  await assertValidRoster(c.env, proposedRoster);

  await c.env.DB.prepare(
    `INSERT OR IGNORE INTO group_members (group_id, user_id, added_at) VALUES (?, ?, ?)`,
  )
    .bind(groupId, targetId, Date.now())
    .run();
  return c.json({ ok: true });
});

groupRoutes.delete('/:groupId/members/:userId', async (c) => {
  const requesterId = c.get('userId');
  const groupId = c.req.param('groupId');
  const targetUserId = c.req.param('userId');
  const group = await loadGroup(c.env, groupId, requesterId);
  if (!group) return c.text('Not found', 404);
  if (group.created_by !== requesterId) return c.text('Forbidden', 403);

  // The owner removing themselves is the one case that changes who owns the
  // group rather than just who's in it. Ownership moves to whoever has turned
  // up to the most of this group's sessions (see lib/groups.ts), in the same
  // batch as the removal so there's no committed moment where the group's
  // owner isn't one of its members. If there's no one to hand it to, that
  // throws and the removal is refused.
  if (targetUserId === group.created_by) {
    const { statements, successorId } = await ownerDepartureStatements(c.env, group);
    await c.env.DB.batch(statements);
    return c.json({ ok: true, transferredTo: successorId });
  }

  await c.env.DB.prepare(`DELETE FROM group_members WHERE group_id = ? AND user_id = ?`)
    .bind(groupId, targetUserId)
    .run();
  return c.json({ ok: true });
});
