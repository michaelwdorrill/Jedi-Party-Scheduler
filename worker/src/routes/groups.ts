import { Hono } from 'hono';
import type { AppEnv } from '../lib/authMiddleware';
import type { Env } from '../env';
import { filterActiveGuildMembers, requireActiveGuildMember } from '../lib/db';
import { assertOptionalString, assertSafeInt, assertString, assertStringArray, LIMITS, ValidationError } from '../lib/validate';

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

  const body = await c.req.json<{
    name?: string;
    game?: string | null;
    idle_reminder_days?: number;
    member_user_ids?: string[];
  }>();
  if (body.name !== undefined) {
    const name = assertString(body.name, 'name', LIMITS.GROUP_NAME);
    await c.env.DB.prepare(`UPDATE groups SET name = ? WHERE id = ?`).bind(name, groupId).run();
  }
  if (body.game !== undefined) {
    const game = assertOptionalString(body.game, 'game', LIMITS.GAME);
    await c.env.DB.prepare(`UPDATE groups SET game = ? WHERE id = ?`).bind(game, groupId).run();
  }
  if (body.idle_reminder_days !== undefined) {
    const days = assertSafeInt(body.idle_reminder_days, 'idle_reminder_days');
    if (days < 1 || days > 3650) throw new ValidationError('idle_reminder_days out of range');
    await c.env.DB.prepare(`UPDATE groups SET idle_reminder_days = ? WHERE id = ?`).bind(days, groupId).run();
  }
  if (body.member_user_ids) {
    const memberIds = assertStringArray(body.member_user_ids, 'member_user_ids', LIMITS.MAX_GROUP_MEMBERS, 64);
    await assertValidGroupMemberTargets(c.env, group.guild_id, memberIds);

    const now = Date.now();
    // Batched so a failure partway through can't leave the roster with only
    // some of the new members and none of the old ones.
    await c.env.DB.batch([
      c.env.DB.prepare(`DELETE FROM group_members WHERE group_id = ?`).bind(groupId),
      ...memberIds.map((memberId) =>
        c.env.DB.prepare(`INSERT INTO group_members (group_id, user_id, added_at) VALUES (?, ?, ?)`).bind(
          groupId,
          memberId,
          now,
        ),
      ),
    ]);
  }
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

  await c.env.DB.prepare(`DELETE FROM groups WHERE id = ?`).bind(groupId).run();
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

  const body = await c.req.json<{ userId: string }>();
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

  await c.env.DB.prepare(`DELETE FROM group_members WHERE group_id = ? AND user_id = ?`)
    .bind(groupId, targetUserId)
    .run();
  return c.json({ ok: true });
});
