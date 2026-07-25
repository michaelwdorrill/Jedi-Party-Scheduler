import { Hono } from 'hono';
import type { AppEnv } from '../lib/authMiddleware';

export const groupRoutes = new Hono<AppEnv>();

interface GroupRow {
  id: string;
  guild_id: string;
  name: string;
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

groupRoutes.get('/:groupId', async (c) => {
  const groupId = c.req.param('groupId');
  const group = await c.env.DB.prepare(`SELECT * FROM groups WHERE id = ?`).bind(groupId).first<GroupRow>();
  if (!group) return c.text('Not found', 404);

  return c.json({
    id: group.id,
    guildId: group.guild_id,
    name: group.name,
    createdBy: group.created_by,
    members: await loadGroupMembers(c.env.DB, groupId),
  });
});

groupRoutes.patch('/:groupId', async (c) => {
  const userId = c.get('userId');
  const groupId = c.req.param('groupId');
  const group = await c.env.DB.prepare(`SELECT * FROM groups WHERE id = ?`).bind(groupId).first<GroupRow>();
  if (!group) return c.text('Not found', 404);
  if (group.created_by !== userId) return c.text('Forbidden', 403);

  const body = await c.req.json<{ name?: string; member_user_ids?: string[] }>();
  if (body.name?.trim()) {
    await c.env.DB.prepare(`UPDATE groups SET name = ? WHERE id = ?`).bind(body.name.trim(), groupId).run();
  }
  if (body.member_user_ids) {
    await c.env.DB.prepare(`DELETE FROM group_members WHERE group_id = ?`).bind(groupId).run();
    const now = Date.now();
    for (const memberId of body.member_user_ids) {
      await c.env.DB.prepare(
        `INSERT INTO group_members (group_id, user_id, added_at) VALUES (?, ?, ?)`,
      )
        .bind(groupId, memberId, now)
        .run();
    }
  }
  return c.json({ ok: true });
});

groupRoutes.delete('/:groupId', async (c) => {
  const userId = c.get('userId');
  const groupId = c.req.param('groupId');
  const group = await c.env.DB.prepare(`SELECT * FROM groups WHERE id = ?`).bind(groupId).first<GroupRow>();
  if (!group) return c.text('Not found', 404);
  if (group.created_by !== userId) return c.text('Forbidden', 403);

  await c.env.DB.prepare(`DELETE FROM groups WHERE id = ?`).bind(groupId).run();
  return c.json({ ok: true });
});

groupRoutes.post('/:groupId/members', async (c) => {
  const userId = c.get('userId');
  const groupId = c.req.param('groupId');
  const group = await c.env.DB.prepare(`SELECT * FROM groups WHERE id = ?`).bind(groupId).first<GroupRow>();
  if (!group) return c.text('Not found', 404);
  if (group.created_by !== userId) return c.text('Forbidden', 403);

  const body = await c.req.json<{ userId: string }>();
  await c.env.DB.prepare(
    `INSERT OR IGNORE INTO group_members (group_id, user_id, added_at) VALUES (?, ?, ?)`,
  )
    .bind(groupId, body.userId, Date.now())
    .run();
  return c.json({ ok: true });
});

groupRoutes.delete('/:groupId/members/:userId', async (c) => {
  const requesterId = c.get('userId');
  const groupId = c.req.param('groupId');
  const targetUserId = c.req.param('userId');
  const group = await c.env.DB.prepare(`SELECT * FROM groups WHERE id = ?`).bind(groupId).first<GroupRow>();
  if (!group) return c.text('Not found', 404);
  if (group.created_by !== requesterId) return c.text('Forbidden', 403);

  await c.env.DB.prepare(`DELETE FROM group_members WHERE group_id = ? AND user_id = ?`)
    .bind(groupId, targetUserId)
    .run();
  return c.json({ ok: true });
});
