import type { Env } from '../env';

export interface UserRow {
  id: string;
  username: string;
  global_name: string | null;
  avatar_hash: string | null;
  timezone: string;
  notifications_enabled: number;
}

export interface GuildRow {
  id: string;
  name: string;
}

export function mapUser(row: UserRow) {
  return {
    id: row.id,
    username: row.username,
    globalName: row.global_name,
    avatarHash: row.avatar_hash,
    timezone: row.timezone,
    notificationsEnabled: !!row.notifications_enabled,
  };
}

export function mapFriend(row: UserRow) {
  return {
    id: row.id,
    username: row.username,
    globalName: row.global_name,
    avatarHash: row.avatar_hash,
  };
}

export function mapGuild(row: GuildRow) {
  return { id: row.id, name: row.name };
}

export async function isGuildMember(env: Env, userId: string, guildId: string): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT 1 FROM user_guild_membership WHERE user_id = ? AND guild_id = ? AND is_member = 1`,
  )
    .bind(userId, guildId)
    .first();
  return !!row;
}

export async function listUserGuilds(env: Env, userId: string) {
  const { results } = await env.DB.prepare(
    `SELECT g.id, g.name FROM guilds g
     JOIN user_guild_membership m ON m.guild_id = g.id
     WHERE m.user_id = ? AND m.is_member = 1 AND g.is_active = 1
     ORDER BY g.name`,
  )
    .bind(userId)
    .all<GuildRow>();
  return results.map(mapGuild);
}

// "Friends" = other users who have also logged into this app and share the
// given guild with the requesting user.
export async function listFriends(env: Env, userId: string, guildId: string) {
  const { results } = await env.DB.prepare(
    `SELECT u.id, u.username, u.global_name, u.avatar_hash, u.timezone, u.notifications_enabled
     FROM users u
     JOIN user_guild_membership m ON m.user_id = u.id
     WHERE m.guild_id = ? AND m.is_member = 1 AND u.id != ?
     ORDER BY u.username`,
  )
    .bind(guildId, userId)
    .all<UserRow>();
  return results.map(mapFriend);
}

export function isOwner(env: Env, userId: string): boolean {
  return userId === env.OWNER_DISCORD_ID;
}

export interface UpsertUserInput {
  id: string;
  username: string;
  globalName: string | null;
  avatarHash: string | null;
  discordRefreshToken: string;
  discordTokenExpiresAt: number;
}

export async function upsertUser(env: Env, input: UpsertUserInput): Promise<void> {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO users (id, username, global_name, avatar_hash, timezone, notifications_enabled,
       discord_refresh_token, discord_token_expires_at, created_at, updated_at, last_login_at)
     VALUES (?, ?, ?, ?, 'America/New_York', 1, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       username = excluded.username,
       global_name = excluded.global_name,
       avatar_hash = excluded.avatar_hash,
       discord_refresh_token = excluded.discord_refresh_token,
       discord_token_expires_at = excluded.discord_token_expires_at,
       updated_at = excluded.updated_at,
       last_login_at = excluded.last_login_at`,
  )
    .bind(
      input.id,
      input.username,
      input.globalName,
      input.avatarHash,
      input.discordRefreshToken,
      input.discordTokenExpiresAt,
      now,
      now,
      now,
    )
    .run();
}

// Intersects the caller's live Discord guild list against our allow-list and
// updates the membership cache: allow-listed guilds they're currently in are
// marked is_member=1, previously-cached memberships they're no longer in
// (left the server, or it dropped off the allow-list) are marked is_member=0.
export async function syncGuildMembership(
  env: Env,
  userId: string,
  discordGuildIds: string[],
): Promise<void> {
  const now = Date.now();

  const currentlyMemberOf: string[] = [];
  if (discordGuildIds.length > 0) {
    const placeholders = discordGuildIds.map(() => '?').join(',');
    const { results } = await env.DB.prepare(
      `SELECT id FROM guilds WHERE is_active = 1 AND id IN (${placeholders})`,
    )
      .bind(...discordGuildIds)
      .all<{ id: string }>();
    currentlyMemberOf.push(...results.map((r) => r.id));
  }

  for (const guildId of currentlyMemberOf) {
    await env.DB.prepare(
      `INSERT INTO user_guild_membership (user_id, guild_id, is_member, verified_at)
       VALUES (?, ?, 1, ?)
       ON CONFLICT(user_id, guild_id) DO UPDATE SET is_member = 1, verified_at = excluded.verified_at`,
    )
      .bind(userId, guildId, now)
      .run();
  }

  if (currentlyMemberOf.length > 0) {
    const placeholders = currentlyMemberOf.map(() => '?').join(',');
    await env.DB.prepare(
      `UPDATE user_guild_membership SET is_member = 0, verified_at = ?
       WHERE user_id = ? AND is_member = 1 AND guild_id NOT IN (${placeholders})`,
    )
      .bind(now, userId, ...currentlyMemberOf)
      .run();
  } else {
    await env.DB.prepare(
      `UPDATE user_guild_membership SET is_member = 0, verified_at = ? WHERE user_id = ? AND is_member = 1`,
    )
      .bind(now, userId)
      .run();
  }
}
