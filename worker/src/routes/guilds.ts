import { Hono } from 'hono';
import type { AppEnv } from '../lib/authMiddleware';
import { chunkIds, chunkRows, placeholders } from '../lib/d1';
import { filterActiveGuildMembers, isGuildMember, listUserGuilds, MEMBERSHIP_GRACE_MS } from '../lib/db';
import { newId } from '../lib/ids';
import { createEventWithInvites, type EventWriteInput } from '../lib/eventWrites';
import { buildCalendarOccurrences } from '../lib/calendar';
import { computeBusyBlocksForUsers } from '../lib/freeBusy';
import { fetchGuildVoiceChannels } from '../lib/discord';
import {
  assertOptionalString,
  assertSafeInt,
  assertStringArray,
  assertString,
  LIMITS,
  readJsonBody,
  ValidationError,
} from '../lib/validate';

export const guildRoutes = new Hono<AppEnv>();

// Same grace window used for interactive access and cron recipients (see
// lib/db.ts) -- a listing/target query is a way to learn about or select a
// user just as surely as an invite is, so it gets the same staleness bound.
// Without this, listFriends()/free-busy targets could keep showing someone
// as present indefinitely if the background revalidation sweep never got to
// their row, even though that same person would be denied if they tried to
// use the app themselves.
function membershipListCutoff(): number {
  return Date.now() - MEMBERSHIP_GRACE_MS;
}

function parseRangeQuery(
  c: { req: { query: (k: string) => string | undefined } },
  maxRangeMs: number = LIMITS.MAX_QUERY_RANGE_MS,
): { from: number; to: number } {
  const from = Number(c.req.query('from'));
  const to = Number(c.req.query('to'));
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to)) {
    throw new ValidationError('from and to (unix ms) are required');
  }
  if (to <= from) throw new ValidationError('to must be after from');
  if (to - from > maxRangeMs) throw new ValidationError('from/to range is too large');
  return { from, to };
}

guildRoutes.get('/', async (c) => {
  const userId = c.get('userId');
  return c.json(await listUserGuilds(c.env, userId));
});

// Scheduling assistant. Returns opaque busy ranges only -- never titles,
// games, or who someone is with. A user is included only if they share this
// guild with the caller AND haven't switched off free_busy_visible; users who
// opted out are returned with visible:false and an empty block list so the UI
// can say "hidden" rather than mislead by showing them as free.
guildRoutes.get('/:guildId/free-busy', async (c) => {
  const userId = c.get('userId');
  const guildId = c.req.param('guildId');
  if (!(await isGuildMember(c.env, userId, guildId))) return c.text('Forbidden', 403);

  // Deliberately a much shorter window than the calendar's: free/busy cost is
  // users x events x occurrences, so the range is one of the factors that has
  // to stay small rather than merely finite.
  const { from, to } = parseRangeQuery(c, LIMITS.MAX_FREE_BUSY_RANGE_MS);

  const requested = assertStringArray(
    (c.req.query('user_ids') ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    'user_ids',
    LIMITS.MAX_FREE_BUSY_USERS,
    64,
  );
  if (requested.length === 0) return c.json([]);

  // Chunked because the requested-user list plus the guild id can exceed
  // D1's 100-bound-parameter ceiling -- at the original cap of 100 users it
  // did so exactly, and a fully-populated scheduling assistant request failed
  // outright. Chunking keeps that correct independently of where the cap
  // sits today. The freshness
  // cutoff matters here too: a target whose membership hasn't been confirmed
  // within the grace window is treated the same as someone who left --
  // otherwise a departed member could remain visible here indefinitely even
  // though they can no longer authenticate into the guild themselves.
  const members: { id: string; username: string; global_name: string | null; free_busy_visible: number }[] = [];
  for (const chunk of chunkIds(requested, 2)) {
    const { results } = await c.env.DB.prepare(
      `SELECT u.id, u.username, u.global_name, u.free_busy_visible
       FROM users u JOIN user_guild_membership m ON m.user_id = u.id
       WHERE m.guild_id = ? AND m.is_member = 1 AND m.verified_at >= ? AND u.id IN (${placeholders(chunk.length)})`,
    )
      .bind(guildId, membershipListCutoff(), ...chunk)
      .all<{ id: string; username: string; global_name: string | null; free_busy_visible: number }>();
    members.push(...results);
  }

  const visibleIds = members.filter((m) => !!m.free_busy_visible || m.id === userId).map((m) => m.id);
  const busyByUser = await computeBusyBlocksForUsers(c.env, visibleIds, from, to);

  const out = [];
  for (const member of members) {
    const visible = !!member.free_busy_visible || member.id === userId;
    out.push({
      userId: member.id,
      username: member.username,
      globalName: member.global_name,
      visible,
      busy: visible ? (busyByUser.get(member.id) ?? []) : [],
    });
  }
  return c.json(out);
});

guildRoutes.get('/:guildId/voice-channels', async (c) => {
  const userId = c.get('userId');
  const guildId = c.req.param('guildId');
  if (!(await isGuildMember(c.env, userId, guildId))) return c.text('Forbidden', 403);

  try {
    return c.json(await fetchGuildVoiceChannels(c.env.DISCORD_BOT_TOKEN, guildId));
  } catch (err) {
    // Most likely the bot hasn't been invited to this server yet.
    return c.text(`Could not list voice channels: ${(err as Error).message}`, 502);
  }
});

guildRoutes.get('/:guildId/groups', async (c) => {
  const userId = c.get('userId');
  const guildId = c.req.param('guildId');
  if (!(await isGuildMember(c.env, userId, guildId))) return c.text('Forbidden', 403);

  const { results: groups } = await c.env.DB.prepare(
    `SELECT id, guild_id, name, game, idle_reminder_days, created_by FROM groups WHERE guild_id = ? ORDER BY name`,
  )
    .bind(guildId)
    .all<{ id: string; guild_id: string; name: string; game: string | null; idle_reminder_days: number; created_by: string }>();

  // One chunked query for every group's members, rather than one query per
  // group: the previous N+1 shape issued a database round trip per group on
  // a page that loads on every visit to the groups screen, and D1 also caps
  // how many queries a single Worker invocation may issue.
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

guildRoutes.post('/:guildId/groups', async (c) => {
  const userId = c.get('userId');
  const guildId = c.req.param('guildId');
  if (!(await isGuildMember(c.env, userId, guildId))) return c.text('Forbidden', 403);

  const body = await readJsonBody<{ name: string; game?: string | null; idle_reminder_days?: number; member_user_ids: string[] }>(c);
  const name = assertString(body.name, 'name', LIMITS.GROUP_NAME);
  const game = assertOptionalString(body.game, 'game', LIMITS.GAME);
  const idleReminderDays = body.idle_reminder_days === undefined ? 2 : assertSafeInt(body.idle_reminder_days, 'idle_reminder_days');
  if (idleReminderDays < 1 || idleReminderDays > 3650) throw new ValidationError('idle_reminder_days out of range');
  const memberIds = assertStringArray(body.member_user_ids ?? [], 'member_user_ids', LIMITS.MAX_GROUP_MEMBERS, 64);

  const active = await filterActiveGuildMembers(c.env, guildId, memberIds);
  if (memberIds.some((id) => !active.has(id))) {
    throw new ValidationError('One or more members are not current members of this server');
  }

  const groupCount = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM groups WHERE guild_id = ?`)
    .bind(guildId)
    .first<{ n: number }>();
  if ((groupCount?.n ?? 0) >= LIMITS.MAX_GROUPS_PER_GUILD) {
    throw new ValidationError('This server has reached its limit of groups');
  }

  const groupId = newId();
  const now = Date.now();
  // The creator is always a member of their own group (migration 0017).
  // Deduped here rather than relying on INSERT OR IGNORE alone, so the count
  // against MAX_GROUP_MEMBERS below reflects the roster that actually gets
  // written -- and so a creator who *did* tick themselves in the picker
  // doesn't silently consume two slots' worth of parameters.
  const rosterIds = memberIds.includes(userId) ? memberIds : [userId, ...memberIds];
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO groups (id, guild_id, name, game, idle_reminder_days, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(groupId, guildId, name, game, idleReminderDays, userId, now),
    ...chunkRows(rosterIds, 3).map((chunk) =>
      c.env.DB.prepare(
        `INSERT OR IGNORE INTO group_members (group_id, user_id, added_at)
         VALUES ${chunk.map(() => '(?, ?, ?)').join(', ')}`,
      ).bind(...chunk.flatMap((memberId) => [groupId, memberId, now])),
    ),
  ]);

  return c.json({ id: groupId }, 201);
});

guildRoutes.get('/:guildId/events', async (c) => {
  const userId = c.get('userId');
  const guildId = c.req.param('guildId');
  if (!(await isGuildMember(c.env, userId, guildId))) return c.text('Forbidden', 403);

  const { from, to } = parseRangeQuery(c);
  // The shared builder (lib/calendar.ts), scoped to this one guild. GET
  // /me/events is the same call without the scope -- keeping them one
  // implementation is what stops the two views disagreeing about what a
  // resolved poll or an overridden recurrence looks like.
  return c.json(await buildCalendarOccurrences(c.env, userId, from, to, { guildId }));
});

guildRoutes.post('/:guildId/events', async (c) => {
  const userId = c.get('userId');
  const guildId = c.req.param('guildId');
  if (!(await isGuildMember(c.env, userId, guildId))) return c.text('Forbidden', 403);

  const body = await readJsonBody<EventWriteInput>(c);
  const eventId = await createEventWithInvites(c.env, guildId, userId, body);
  return c.json({ id: eventId }, 201);
});
