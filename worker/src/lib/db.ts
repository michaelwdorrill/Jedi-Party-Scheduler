import type { Env } from '../env';
import { revokeAllSessionsForUser } from './sessions';

export interface UserRow {
  id: string;
  username: string;
  global_name: string | null;
  avatar_hash: string | null;
  timezone: string;
  notifications_enabled: number;
  free_busy_visible?: number;
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
    freeBusyVisible: row.free_busy_visible === undefined ? true : !!row.free_busy_visible,
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

// Requires BOTH that the cache says the user is currently a member AND that
// the guild itself hasn't been deactivated -- deactivating a guild is
// supposed to immediately block every route derived from it, not just stop
// it from appearing in listings.
export async function isGuildMember(env: Env, userId: string, guildId: string): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT 1 FROM user_guild_membership m
     JOIN guilds g ON g.id = m.guild_id
     WHERE m.user_id = ? AND m.guild_id = ? AND m.is_member = 1 AND g.is_active = 1`,
  )
    .bind(userId, guildId)
    .first();
  return !!row;
}

// Same check, phrased for call sites that resolve a guildId from some other
// object (an event, a group, a poll) rather than from the URL directly, and
// want a uniform 404 for "not found" vs "not yours" rather than leaking which
// one it is.
export async function requireActiveGuildMember(env: Env, userId: string, guildId: string): Promise<boolean> {
  return isGuildMember(env, userId, guildId);
}

// Given a set of candidate user IDs, returns only the ones who are currently
// active members of the given (active) guild. Used to validate group-member
// and event-invite targets so a request can't graft a user from one guild
// onto another guild's roster/invite list just by knowing their ID.
export async function filterActiveGuildMembers(env: Env, guildId: string, userIds: string[]): Promise<Set<string>> {
  if (userIds.length === 0) return new Set();
  const placeholders = userIds.map(() => '?').join(',');
  const { results } = await env.DB.prepare(
    `SELECT m.user_id FROM user_guild_membership m
     JOIN guilds g ON g.id = m.guild_id
     WHERE m.guild_id = ? AND m.is_member = 1 AND g.is_active = 1 AND m.user_id IN (${placeholders})`,
  )
    .bind(guildId, ...userIds)
    .all<{ user_id: string }>();
  return new Set(results.map((r) => r.user_id));
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
}

export async function upsertUser(env: Env, input: UpsertUserInput): Promise<void> {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO users (id, username, global_name, avatar_hash, timezone, notifications_enabled,
       created_at, updated_at, last_login_at)
     VALUES (?, ?, ?, ?, 'America/New_York', 1, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       username = excluded.username,
       global_name = excluded.global_name,
       avatar_hash = excluded.avatar_hash,
       updated_at = excluded.updated_at,
       last_login_at = excluded.last_login_at`,
  )
    .bind(input.id, input.username, input.globalName, input.avatarHash, now, now, now)
    .run();
}

// Full erasure of a user's data, exposed as DELETE /me. Discord's Developer
// Terms require an easily accessible way for users to have their API Data
// deleted, and GDPR/CCPA give a right to erasure -- this is that path, done
// in-app rather than by emailing the operator.
//
// Events this user organised are removed outright (they own that content, and
// the invitees' copies are meaningless without it). Where the user was merely
// a participant, only their own rows go: the event survives for everyone else.
export async function deleteUserCompletely(env: Env, userId: string): Promise<void> {
  // Revoke every session first, before touching any other data. If something
  // below fails partway through, the account is still immediately and fully
  // locked out rather than left accessible with partially-deleted data.
  await revokeAllSessionsForUser(env, userId);

  const { results: organised } = await env.DB.prepare(
    `SELECT id FROM events WHERE organizer_id = ?`,
  )
    .bind(userId)
    .all<{ id: string }>();

  for (const event of organised) {
    // Explicit child deletes rather than relying on ON DELETE CASCADE, since
    // D1 only enforces cascades when foreign_keys pragma is on and we'd rather
    // not depend on that for a correctness-critical erasure path.
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM event_poll_votes WHERE option_id IN (SELECT id FROM event_poll_options WHERE event_id = ?)`).bind(event.id),
      env.DB.prepare(`DELETE FROM event_poll_options WHERE event_id = ?`).bind(event.id),
      env.DB.prepare(`DELETE FROM event_window_availability WHERE event_id = ?`).bind(event.id),
      env.DB.prepare(`DELETE FROM event_invites WHERE event_id = ?`).bind(event.id),
      env.DB.prepare(`DELETE FROM event_recurrence_rules WHERE event_id = ?`).bind(event.id),
      env.DB.prepare(`DELETE FROM event_occurrence_overrides WHERE event_id = ?`).bind(event.id),
      env.DB.prepare(`DELETE FROM notification_log WHERE event_id = ?`).bind(event.id),
      env.DB.prepare(`DELETE FROM events WHERE id = ?`).bind(event.id),
    ]);
  }

  const { results: ownedGroups } = await env.DB.prepare(
    `SELECT id FROM groups WHERE created_by = ?`,
  )
    .bind(userId)
    .all<{ id: string }>();
  for (const group of ownedGroups) {
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM group_members WHERE group_id = ?`).bind(group.id),
      env.DB.prepare(`DELETE FROM group_activity_nudges WHERE group_id = ?`).bind(group.id),
      env.DB.prepare(`UPDATE event_invites SET source_group_id = NULL WHERE source_group_id = ?`).bind(group.id),
      env.DB.prepare(`DELETE FROM groups WHERE id = ?`).bind(group.id),
    ]);
  }

  await env.DB.batch([
    env.DB.prepare(`DELETE FROM personal_event_overrides WHERE personal_event_id IN (SELECT id FROM personal_events WHERE user_id = ?)`).bind(userId),
    env.DB.prepare(`DELETE FROM personal_events WHERE user_id = ?`).bind(userId),
    env.DB.prepare(`DELETE FROM event_poll_votes WHERE user_id = ?`).bind(userId),
    env.DB.prepare(`DELETE FROM event_window_availability WHERE user_id = ?`).bind(userId),
    env.DB.prepare(`DELETE FROM event_invites WHERE user_id = ?`).bind(userId),
    env.DB.prepare(`DELETE FROM group_members WHERE user_id = ?`).bind(userId),
    env.DB.prepare(`DELETE FROM notification_log WHERE user_id = ?`).bind(userId),
    env.DB.prepare(`DELETE FROM user_guild_membership WHERE user_id = ?`).bind(userId),
    env.DB.prepare(`DELETE FROM users WHERE id = ?`).bind(userId),
  ]);
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
