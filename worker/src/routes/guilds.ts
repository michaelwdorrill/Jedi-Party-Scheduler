import { Hono } from 'hono';
import type { AppEnv } from '../lib/authMiddleware';
import { isGuildMember, listUserGuilds } from '../lib/db';
import { newId } from '../lib/ids';
import { expandOccurrencesForEvent } from '../lib/recurrence';
import type { EventRow } from '../lib/events';
import { mapOccurrence, loadOverridesForEvents, loadMyRsvpForEvents } from '../lib/events';
import { createEventWithInvites } from '../lib/eventWrites';

export const guildRoutes = new Hono<AppEnv>();

guildRoutes.get('/', async (c) => {
  const userId = c.get('userId');
  return c.json(await listUserGuilds(c.env, userId));
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
  if (!body.name?.trim()) return c.text('name is required', 400);

  const groupId = newId();
  const now = Date.now();
  await c.env.DB.prepare(
    `INSERT INTO groups (id, guild_id, name, game, idle_reminder_days, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(groupId, guildId, body.name.trim(), body.game?.trim() || null, body.idle_reminder_days ?? 2, userId, now)
    .run();

  for (const memberId of body.member_user_ids ?? []) {
    await c.env.DB.prepare(
      `INSERT OR IGNORE INTO group_members (group_id, user_id, added_at) VALUES (?, ?, ?)`,
    )
      .bind(groupId, memberId, now)
      .run();
  }

  return c.json({ id: groupId }, 201);
});

guildRoutes.get('/:guildId/events', async (c) => {
  const userId = c.get('userId');
  const guildId = c.req.param('guildId');
  if (!(await isGuildMember(c.env, userId, guildId))) return c.text('Forbidden', 403);

  const from = Number(c.req.query('from'));
  const to = Number(c.req.query('to'));
  if (!from || !to) return c.text('from and to (unix ms) are required', 400);

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
            mapOccurrence(event, `${event.id}::opt:${opt.id}`, opt.start_at, opt.end_at, rsvpByEvent.get(event.id) ?? null),
          );
        }
      }
      if (
        event.status === 'active' &&
        event.poll_deadline_at &&
        event.poll_deadline_at >= from &&
        event.poll_deadline_at <= to
      ) {
        occurrences.push(mapOccurrence(event, event.id, null, null, rsvpByEvent.get(event.id) ?? null));
      }
      continue;
    }
    if (event.event_type === 'poll' && event.status !== 'resolved') {
      // Unresolved polls show once, at the poll deadline, not per-occurrence.
      if (event.poll_deadline_at && event.poll_deadline_at >= from && event.poll_deadline_at <= to) {
        occurrences.push(mapOccurrence(event, event.id, null, null, rsvpByEvent.get(event.id) ?? null));
      }
      continue;
    }
    if (!event.is_recurring) {
      if (event.start_at && event.start_at <= to && (event.end_at ?? event.start_at) >= from) {
        occurrences.push(mapOccurrence(event, event.id, event.start_at, event.end_at, rsvpByEvent.get(event.id) ?? null));
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
        mapOccurrence(event, `${event.id}::${occ.date}`, occ.startAt, occ.endAt, rsvpByEvent.get(event.id) ?? null),
      );
    }
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
