import { Hono } from 'hono';
import type { AppEnv } from '../lib/authMiddleware';
import { buildCalendarOccurrences } from '../lib/calendar';
import { chunkIds, placeholders } from '../lib/d1';
import { deleteUserCompletely, isGuildMember, isOwner, listFriends, mapUser, MEMBERSHIP_GRACE_MS, type UserRow } from '../lib/db';
import { assertBoolean, assertTimezone, LIMITS, readJsonBody, ValidationError } from '../lib/validate';

export const meRoutes = new Hono<AppEnv>();

const PROFILE_COLUMNS = `id, username, global_name, avatar_hash, timezone, notifications_enabled, free_busy_visible`;

meRoutes.get('/', async (c) => {
  const userId = c.get('userId');
  const row = await c.env.DB.prepare(`SELECT ${PROFILE_COLUMNS} FROM users WHERE id = ?`)
    .bind(userId)
    .first<UserRow>();
  if (!row) return c.text('User not found', 404);
  return c.json(mapUser(row, isOwner(c.env, userId)));
});

meRoutes.patch('/', async (c) => {
  const userId = c.get('userId');
  const body = await readJsonBody<{
    timezone?: string;
    notificationsEnabled?: boolean;
    freeBusyVisible?: boolean;
  }>(c);
  if (body.timezone !== undefined) assertTimezone(body.timezone, 'timezone');
  if (body.notificationsEnabled !== undefined) assertBoolean(body.notificationsEnabled, 'notificationsEnabled');
  if (body.freeBusyVisible !== undefined) assertBoolean(body.freeBusyVisible, 'freeBusyVisible');

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
  return c.json(mapUser(row!, isOwner(c.env, userId)));
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
  c.header('Cache-Control', 'no-store, private');
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

// The cross-guild personal calendar -- everything you organize or are
// invited to, across every server you're still an active member of, plus your
// own personal time blocks. This is what makes the app calendar-first rather
// than server-first (docs/specs/0006): there was previously no way to ask
// "what's on for me" without first picking a server.
//
// Cheaper than it sounds, and cheaper than the per-guild route it
// generalizes: both are bounded by what the caller is personally attached to,
// not by how much exists in a guild. See lib/calendar.ts.
meRoutes.get('/events', async (c) => {
  const userId = c.get('userId');
  const from = Number(c.req.query('from'));
  const to = Number(c.req.query('to'));
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to)) {
    throw new ValidationError('from and to (unix ms) are required');
  }
  if (to <= from) throw new ValidationError('to must be after from');
  if (to - from > LIMITS.MAX_QUERY_RANGE_MS) throw new ValidationError('from/to range is too large');

  return c.json(await buildCalendarOccurrences(c.env, userId, from, to));
});

// Every group the caller is a member of, across every server they are still
// an active member of. The only group-listing endpoint there is: the
// per-guild GET /guilds/:id/groups was removed in v0.4.3 (IDEAS item 34),
// which is why the event form's invitee picker now reads this one too.
meRoutes.get('/groups', async (c) => {
  const userId = c.get('userId');

  // Two predicates doing two different jobs, and both are load-bearing.
  //
  // `group_members` is the visibility rule (item 34): a group's roster is a
  // list of people, and being in the same server as those people is not a
  // reason to be handed it. Before this, any member of a server received
  // every group in it *and* every one of those groups' full member lists --
  // not through a leak, but because the query only ever joined on guild
  // membership.
  //
  // The `user_guild_membership` join stays anyway, and is not made redundant
  // by the first: `group_members` rows are not deleted when someone leaves a
  // server, so without it a departed member would keep seeing that server's
  // groups forever. Same freshness bound the calendar and the cron's
  // recipient queries use, rather than trusting a row of unbounded age.
  const { results: groups } = await c.env.DB.prepare(
    `SELECT gr.id, gr.guild_id, gr.name, gr.game, gr.idle_reminder_days, gr.created_by, g.name AS guild_name
     FROM groups gr
     JOIN group_members mine ON mine.group_id = gr.id AND mine.user_id = ?
     JOIN user_guild_membership m
       ON m.guild_id = gr.guild_id AND m.user_id = ? AND m.is_member = 1 AND m.verified_at >= ?
     JOIN guilds g ON g.id = gr.guild_id AND g.is_active = 1
     ORDER BY g.name, gr.name`,
  )
    .bind(userId, userId, Date.now() - MEMBERSHIP_GRACE_MS)
    .all<{
      id: string;
      guild_id: string;
      name: string;
      game: string | null;
      idle_reminder_days: number;
      created_by: string;
      guild_name: string;
    }>();

  // One chunked query for every group's members rather than one per group --
  // same reason the per-guild route does it that way.
  const membersByGroup = new Map<string, { id: string; username: string; global_name: string | null; avatar_hash: string | null }[]>();
  for (const chunk of chunkIds(groups.map((g) => g.id))) {
    const { results } = await c.env.DB.prepare(
      `SELECT gm.group_id, u.id, u.username, u.global_name, u.avatar_hash
       FROM group_members gm JOIN users u ON u.id = gm.user_id
       WHERE gm.group_id IN (${placeholders(chunk.length)})`,
    )
      .bind(...chunk)
      .all<{ group_id: string; id: string; username: string; global_name: string | null; avatar_hash: string | null }>();
    for (const row of results) {
      if (!membersByGroup.has(row.group_id)) membersByGroup.set(row.group_id, []);
      membersByGroup.get(row.group_id)!.push(row);
    }
  }

  return c.json(
    groups.map((g) => ({
      id: g.id,
      guildId: g.guild_id,
      guildName: g.guild_name,
      name: g.name,
      game: g.game,
      idleReminderDays: g.idle_reminder_days,
      createdBy: g.created_by,
      members: (membersByGroup.get(g.id) ?? []).map((m) => ({
        id: m.id,
        username: m.username,
        globalName: m.global_name,
        avatarHash: m.avatar_hash,
      })),
    })),
  );
});

meRoutes.get('/friends', async (c) => {
  const userId = c.get('userId');
  const guildId = c.req.query('guild_id');
  if (!guildId) return c.text('guild_id is required', 400);
  if (!(await isGuildMember(c.env, userId, guildId))) return c.text('Forbidden', 403);

  return c.json(await listFriends(c.env, userId, guildId));
});
