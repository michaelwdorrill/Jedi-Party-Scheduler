import { Hono } from 'hono';
import type { AppEnv } from '../lib/authMiddleware';
import { chunkIds, placeholders } from '../lib/d1';
import { isGuildMember, listUserGuilds, MEMBERSHIP_GRACE_MS } from '../lib/db';
import { createEventWithInvites, type EventWriteInput } from '../lib/eventWrites';
import { buildCalendarOccurrences } from '../lib/calendar';
import { computeBusyBlocksForUsers } from '../lib/freeBusy';
import { fetchGuildVoiceChannels } from '../lib/discord';
import { assertStringArray, LIMITS, readJsonBody, ValidationError } from '../lib/validate';

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
  const excludeEventId = c.req.query('exclude_event_id') || undefined;
  const busyByUser = await computeBusyBlocksForUsers(c.env, visibleIds, from, to, excludeEventId);

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

// GET /:guildId/groups was removed in v0.4.3 (IDEAS item 34). It returned
// every group in the server -- and every one of those groups' full member
// lists -- to anyone in the server, whether or not they were in the group.
// Groups are now listed only by GET /me/groups, which is scoped to the
// groups the caller is actually in. Creating one moved to POST /groups
// (specs/0011 / IDEAS item 36) -- a group is no longer scoped to a server at
// creation, so there is nothing left for this guild-scoped route to do.

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
