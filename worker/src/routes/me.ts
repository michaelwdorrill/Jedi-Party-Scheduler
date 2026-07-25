import { Hono } from 'hono';
import type { AppEnv } from '../lib/authMiddleware';
import { isGuildMember, listFriends, mapUser, type UserRow } from '../lib/db';

export const meRoutes = new Hono<AppEnv>();

meRoutes.get('/', async (c) => {
  const userId = c.get('userId');
  const row = await c.env.DB.prepare(
    `SELECT id, username, global_name, avatar_hash, timezone, notifications_enabled
     FROM users WHERE id = ?`,
  )
    .bind(userId)
    .first<UserRow>();
  if (!row) return c.text('User not found', 404);
  return c.json(mapUser(row));
});

meRoutes.patch('/', async (c) => {
  const userId = c.get('userId');
  const body = await c.req.json<{ timezone?: string; notificationsEnabled?: boolean }>();

  await c.env.DB.prepare(
    `UPDATE users SET
       timezone = COALESCE(?, timezone),
       notifications_enabled = COALESCE(?, notifications_enabled),
       updated_at = ?
     WHERE id = ?`,
  )
    .bind(
      body.timezone ?? null,
      body.notificationsEnabled === undefined ? null : body.notificationsEnabled ? 1 : 0,
      Date.now(),
      userId,
    )
    .run();

  const row = await c.env.DB.prepare(
    `SELECT id, username, global_name, avatar_hash, timezone, notifications_enabled
     FROM users WHERE id = ?`,
  )
    .bind(userId)
    .first<UserRow>();
  return c.json(mapUser(row!));
});

meRoutes.get('/friends', async (c) => {
  const userId = c.get('userId');
  const guildId = c.req.query('guild_id');
  if (!guildId) return c.text('guild_id is required', 400);
  if (!(await isGuildMember(c.env, userId, guildId))) return c.text('Forbidden', 403);

  return c.json(await listFriends(c.env, userId, guildId));
});
