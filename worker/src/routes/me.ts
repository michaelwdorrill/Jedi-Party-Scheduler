import { Hono } from 'hono';
import type { AppEnv } from '../lib/authMiddleware';
import { deleteUserCompletely, isGuildMember, listFriends, mapUser, type UserRow } from '../lib/db';

export const meRoutes = new Hono<AppEnv>();

const PROFILE_COLUMNS = `id, username, global_name, avatar_hash, timezone, notifications_enabled, free_busy_visible`;

meRoutes.get('/', async (c) => {
  const userId = c.get('userId');
  const row = await c.env.DB.prepare(`SELECT ${PROFILE_COLUMNS} FROM users WHERE id = ?`)
    .bind(userId)
    .first<UserRow>();
  if (!row) return c.text('User not found', 404);
  return c.json(mapUser(row));
});

meRoutes.patch('/', async (c) => {
  const userId = c.get('userId');
  const body = await c.req.json<{
    timezone?: string;
    notificationsEnabled?: boolean;
    freeBusyVisible?: boolean;
  }>();

  await c.env.DB.prepare(
    `UPDATE users SET
       timezone = COALESCE(?, timezone),
       notifications_enabled = COALESCE(?, notifications_enabled),
       free_busy_visible = COALESCE(?, free_busy_visible),
       updated_at = ?
     WHERE id = ?`,
  )
    .bind(
      body.timezone ?? null,
      body.notificationsEnabled === undefined ? null : body.notificationsEnabled ? 1 : 0,
      body.freeBusyVisible === undefined ? null : body.freeBusyVisible ? 1 : 0,
      Date.now(),
      userId,
    )
    .run();

  const row = await c.env.DB.prepare(`SELECT ${PROFILE_COLUMNS} FROM users WHERE id = ?`)
    .bind(userId)
    .first<UserRow>();
  return c.json(mapUser(row!));
});

// Right to erasure. Irreversible and immediate -- no soft-delete, no grace
// period, nothing retained for analytics.
meRoutes.delete('/', async (c) => {
  const userId = c.get('userId');
  await deleteUserCompletely(c.env, userId);
  return c.json({ ok: true });
});

// Everything this app holds about the caller, in one JSON payload (GDPR
// right of access / data portability).
meRoutes.get('/export', async (c) => {
  const userId = c.get('userId');
  const tables: Record<string, string> = {
    profile: `SELECT ${PROFILE_COLUMNS}, created_at, updated_at, last_login_at FROM users WHERE id = ?`,
    serverMemberships: `SELECT guild_id, nickname, is_member, verified_at FROM user_guild_membership WHERE user_id = ?`,
    personalEvents: `SELECT * FROM personal_events WHERE user_id = ?`,
    organisedEvents: `SELECT * FROM events WHERE organizer_id = ?`,
    invitations: `SELECT * FROM event_invites WHERE user_id = ?`,
    pollVotes: `SELECT * FROM event_poll_votes WHERE user_id = ?`,
    windowAvailability: `SELECT * FROM event_window_availability WHERE user_id = ?`,
    groupsCreated: `SELECT * FROM groups WHERE created_by = ?`,
    groupMemberships: `SELECT * FROM group_members WHERE user_id = ?`,
    notificationsSent: `SELECT * FROM notification_log WHERE user_id = ?`,
  };

  const out: Record<string, unknown> = { exportedAt: new Date().toISOString() };
  for (const [key, sql] of Object.entries(tables)) {
    const { results } = await c.env.DB.prepare(sql).bind(userId).all();
    out[key] = results;
  }
  return c.json(out);
});

meRoutes.get('/friends', async (c) => {
  const userId = c.get('userId');
  const guildId = c.req.query('guild_id');
  if (!guildId) return c.text('guild_id is required', 400);
  if (!(await isGuildMember(c.env, userId, guildId))) return c.text('Forbidden', 403);

  return c.json(await listFriends(c.env, userId, guildId));
});
