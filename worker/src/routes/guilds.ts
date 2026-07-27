import { Hono } from 'hono';
import type { AppEnv } from '../lib/authMiddleware';
import { filterActiveGuildMembers, isGuildMember, listUserGuilds } from '../lib/db';
import { newId } from '../lib/ids';
import { expandOccurrencesForEvent } from '../lib/recurrence';
import type { EventRow } from '../lib/events';
import { mapOccurrence, loadOverridesForEvents, loadMyRsvpForEvents, loadPrimaryGroupForEvents } from '../lib/events';
import { createEventWithInvites } from '../lib/eventWrites';
import { computeBusyBlocks } from '../lib/freeBusy';
import { expandPersonalOccurrences } from '../lib/personalEvents';
import { fetchGuildVoiceChannels } from '../lib/discord';
import {
  assertOptionalString,
  assertSafeInt,
  assertStringArray,
  assertString,
  LIMITS,
  ValidationError,
} from '../lib/validate';

export const guildRoutes = new Hono<AppEnv>();

function parseRangeQuery(c: { req: { query: (k: string) => string | undefined } }): { from: number; to: number } {
  const from = Number(c.req.query('from'));
  const to = Number(c.req.query('to'));
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to)) {
    throw new ValidationError('from and to (unix ms) are required');
  }
  if (to <= from) throw new ValidationError('to must be after from');
  if (to - from > LIMITS.MAX_QUERY_RANGE_MS) throw new ValidationError('from/to range is too large');
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

  const { from, to } = parseRangeQuery(c);

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

  const placeholders = requested.map(() => '?').join(',');
  const { results: members } = await c.env.DB.prepare(
    `SELECT u.id, u.username, u.global_name, u.free_busy_visible
     FROM users u JOIN user_guild_membership m ON m.user_id = u.id
     WHERE m.guild_id = ? AND m.is_member = 1 AND u.id IN (${placeholders})`,
  )
    .bind(guildId, ...requested)
    .all<{ id: string; username: string; global_name: string | null; free_busy_visible: number }>();

  const out = [];
  for (const member of members) {
    const visible = !!member.free_busy_visible || member.id === userId;
    out.push({
      userId: member.id,
      username: member.username,
      globalName: member.global_name,
      visible,
      busy: visible ? await computeBusyBlocks(c.env, member.id, from, to) : [],
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

  const out = [];
  for (const g of groups) {
    const { results: members } = await c.env.DB.prepare(
      `SELECT u.id, u.username, u.global_name, u.avatar_hash
       FROM group_members gm JOIN users u ON u.id = gm.user_id
       WHERE gm.group_id = ?`,
    )
      .bind(g.id)
      .all<{ id: string; username: string; global_name: string | null; avatar_hash: string | null }>();

    out.push({
      id: g.id,
      guildId: g.guild_id,
      name: g.name,
      game: g.game,
      idleReminderDays: g.idle_reminder_days,
      createdBy: g.created_by,
      members: members.map((m) => ({
        id: m.id,
        username: m.username,
        globalName: m.global_name,
        avatarHash: m.avatar_hash,
      })),
    });
  }
  return c.json(out);
});

guildRoutes.post('/:guildId/groups', async (c) => {
  const userId = c.get('userId');
  const guildId = c.req.param('guildId');
  if (!(await isGuildMember(c.env, userId, guildId))) return c.text('Forbidden', 403);

  const body = await c.req.json<{ name: string; game?: string | null; idle_reminder_days?: number; member_user_ids: string[] }>();
  const name = assertString(body.name, 'name', LIMITS.GROUP_NAME);
  const game = assertOptionalString(body.game, 'game', LIMITS.GAME);
  const idleReminderDays = body.idle_reminder_days === undefined ? 2 : assertSafeInt(body.idle_reminder_days, 'idle_reminder_days');
  if (idleReminderDays < 1 || idleReminderDays > 3650) throw new ValidationError('idle_reminder_days out of range');
  const memberIds = assertStringArray(body.member_user_ids ?? [], 'member_user_ids', LIMITS.MAX_GROUP_MEMBERS, 64);

  const active = await filterActiveGuildMembers(c.env, guildId, memberIds);
  if (memberIds.some((id) => !active.has(id))) {
    throw new ValidationError('One or more members are not current members of this server');
  }

  const groupId = newId();
  const now = Date.now();
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO groups (id, guild_id, name, game, idle_reminder_days, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(groupId, guildId, name, game, idleReminderDays, userId, now),
    ...memberIds.map((memberId) =>
      c.env.DB.prepare(
        `INSERT OR IGNORE INTO group_members (group_id, user_id, added_at) VALUES (?, ?, ?)`,
      ).bind(groupId, memberId, now),
    ),
  ]);

  return c.json({ id: groupId }, 201);
});

guildRoutes.get('/:guildId/events', async (c) => {
  const userId = c.get('userId');
  const guildId = c.req.param('guildId');
  if (!(await isGuildMember(c.env, userId, guildId))) return c.text('Forbidden', 403);

  const { from, to } = parseRangeQuery(c);

  // Only events the user is the organizer of, or is individually/group-invited to.
  const { results: events } = await c.env.DB.prepare(
    `SELECT DISTINCT e.* FROM events e
     LEFT JOIN event_invites i ON i.event_id = e.id AND i.user_id = ?
     WHERE e.guild_id = ? AND (e.organizer_id = ? OR i.user_id IS NOT NULL)`,
  )
    .bind(userId, guildId, userId)
    .all<EventRow>();

  const overridesByEvent = await loadOverridesForEvents(c.env, events.map((e) => e.id));
  const rsvpByEvent = await loadMyRsvpForEvents(c.env, events.map((e) => e.id), userId);
  const groupByEvent = await loadPrimaryGroupForEvents(c.env, events.map((e) => e.id));

  const occurrences = [];
  for (const event of events) {
    if (event.event_type === 'poll' && event.poll_resolution_mode === 'multi_winner') {
      // Each independently-confirmed day is its own occurrence, and stays on
      // the calendar even after the parent poll stops accepting new votes.
      const { results: confirmedOptions } = await c.env.DB.prepare(
        `SELECT id, start_at, end_at FROM event_poll_options WHERE event_id = ? AND confirmed_at IS NOT NULL`,
      )
        .bind(event.id)
        .all<{ id: string; start_at: number; end_at: number }>();
      for (const opt of confirmedOptions) {
        if (opt.start_at <= to && opt.end_at >= from) {
          occurrences.push(
            mapOccurrence(event, `${event.id}::opt:${opt.id}`, opt.start_at, opt.end_at, rsvpByEvent.get(event.id) ?? null, groupByEvent.get(event.id) ?? null),
          );
        }
      }
      if (
        event.status === 'active' &&
        event.poll_deadline_at &&
        event.poll_deadline_at >= from &&
        event.poll_deadline_at <= to
      ) {
        occurrences.push(mapOccurrence(event, event.id, null, null, rsvpByEvent.get(event.id) ?? null, groupByEvent.get(event.id) ?? null));
      }
      continue;
    }
    if (event.event_type === 'poll' && event.status !== 'resolved') {
      // Unresolved polls show once, at the poll deadline, not per-occurrence.
      if (event.poll_deadline_at && event.poll_deadline_at >= from && event.poll_deadline_at <= to) {
        occurrences.push(mapOccurrence(event, event.id, null, null, rsvpByEvent.get(event.id) ?? null, groupByEvent.get(event.id) ?? null));
      }
      continue;
    }
    if (!event.is_recurring) {
      if (event.start_at && event.start_at <= to && (event.end_at ?? event.start_at) >= from) {
        occurrences.push(mapOccurrence(event, event.id, event.start_at, event.end_at, rsvpByEvent.get(event.id) ?? null, groupByEvent.get(event.id) ?? null));
      }
      continue;
    }
    const expanded = await expandOccurrencesForEvent(
      c.env,
      event,
      from,
      to,
      overridesByEvent.get(event.id) ?? [],
    );
    for (const occ of expanded) {
      occurrences.push(
        mapOccurrence(event, `${event.id}::${occ.date}`, occ.startAt, occ.endAt, rsvpByEvent.get(event.id) ?? null, groupByEvent.get(event.id) ?? null),
      );
    }
  }

  // The caller's own personal events ride along on whichever guild calendar
  // they're viewing -- they aren't guild-scoped, but the point of them is to
  // see your real availability next to your gaming schedule. Never returned
  // for anyone but their owner.
  for (const occ of await expandPersonalOccurrences(c.env, userId, from, to)) {
    occurrences.push({
      occurrenceId: `personal:${occ.occurrenceId}`,
      eventId: occ.event.id,
      title: occ.event.title,
      description: occ.event.description,
      game: null,
      eventType: 'single' as const,
      status: occ.event.status,
      timezone: occ.event.timezone,
      startAt: occ.startAt,
      endAt: occ.endAt,
      isRecurring: !!occ.event.is_recurring,
      isPersonal: true,
      organizerId: occ.event.user_id,
      myRsvpStatus: null,
      pollDeadlineAt: null,
      groupId: null,
    });
  }

  return c.json(occurrences);
});

guildRoutes.post('/:guildId/events', async (c) => {
  const userId = c.get('userId');
  const guildId = c.req.param('guildId');
  if (!(await isGuildMember(c.env, userId, guildId))) return c.text('Forbidden', 403);

  const body = await c.req.json();
  const eventId = await createEventWithInvites(c.env, guildId, userId, body);
  return c.json({ id: eventId }, 201);
});
