import { Hono } from 'hono';
import type { AppEnv } from '../lib/authMiddleware';
import type { Env } from '../env';
import { chunkRows } from '../lib/d1';
import { filterActiveGuildMembers, requireActiveGuildMember } from '../lib/db';
import { ownerDepartureStatements } from '../lib/groups';
import { assertOptionalString, assertSafeInt, assertString, assertStringArray, LIMITS, readJsonBody, ValidationError } from '../lib/validate';

export const groupRoutes = new Hono<AppEnv>();

interface GroupRow {
  id: string;
  guild_id: string;
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

// Validates every target ID is a current active member of the group's guild
// and rejects the whole request atomically if any isn't -- a caller
// shouldn't be able to graft a user from another guild onto this roster.
async function assertValidGroupMemberTargets(env: Env, guildId: string, memberIds: string[]) {
  const active = await filterActiveGuildMembers(env, guildId, memberIds);
  const invalid = memberIds.filter((id) => !active.has(id));
  if (invalid.length > 0) {
    throw new ValidationError('One or more members are not current members of this server');
  }
}

groupRoutes.get('/:groupId', async (c) => {
  const userId = c.get('userId');
  const groupId = c.req.param('groupId');
  const group = await c.env.DB.prepare(`SELECT * FROM groups WHERE id = ?`).bind(groupId).first<GroupRow>();
  // A group UUID alone must not be enough to read the roster -- the caller
  // has to be a current active member of the group's own guild, not just
  // logged in as *someone*.
  if (!group || !(await requireActiveGuildMember(c.env, userId, group.guild_id))) {
    return c.text('Not found', 404);
  }

  return c.json({
    id: group.id,
    guildId: group.guild_id,
    name: group.name,
    game: group.game,
    idleReminderDays: group.idle_reminder_days,
    createdBy: group.created_by,
    members: await loadGroupMembers(c.env.DB, groupId),
  });
});

groupRoutes.patch('/:groupId', async (c) => {
  const userId = c.get('userId');
  const groupId = c.req.param('groupId');
  const group = await c.env.DB.prepare(`SELECT * FROM groups WHERE id = ?`).bind(groupId).first<GroupRow>();
  if (!group || !(await requireActiveGuildMember(c.env, userId, group.guild_id))) {
    return c.text('Not found', 404);
  }
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
    await assertValidGroupMemberTargets(c.env, group.guild_id, memberIds);
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
    values.push(groupId);
    statements.push(c.env.DB.prepare(`UPDATE groups SET ${setClauses.join(', ')} WHERE id = ?`).bind(...values));
  }
  if (memberIds !== undefined) {
    const now = Date.now();
    // The owner stays on their own roster whatever the submitted list says.
    // The edit form sends the complete desired membership, so an owner who
    // simply doesn't tick themselves would otherwise silently leave -- which
    // is a different intent from the explicit "remove me" that
    // DELETE /:groupId/members/:userId expresses, and the only one of the two
    // that should hand the group to someone else.
    if (!memberIds.includes(userId)) memberIds = [userId, ...memberIds];
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
  const group = await c.env.DB.prepare(`SELECT * FROM groups WHERE id = ?`).bind(groupId).first<GroupRow>();
  if (!group || !(await requireActiveGuildMember(c.env, userId, group.guild_id))) {
    return c.text('Not found', 404);
  }
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
  const group = await c.env.DB.prepare(`SELECT * FROM groups WHERE id = ?`).bind(groupId).first<GroupRow>();
  if (!group || !(await requireActiveGuildMember(c.env, userId, group.guild_id))) {
    return c.text('Not found', 404);
  }
  if (group.created_by !== userId) return c.text('Forbidden', 403);

  const body = await readJsonBody<{ userId: string }>(c);
  const targetId = assertString(body.userId, 'userId', 64);
  await assertValidGroupMemberTargets(c.env, group.guild_id, [targetId]);

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
  const group = await c.env.DB.prepare(`SELECT * FROM groups WHERE id = ?`).bind(groupId).first<GroupRow>();
  if (!group || !(await requireActiveGuildMember(c.env, requesterId, group.guild_id))) {
    return c.text('Not found', 404);
  }
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
