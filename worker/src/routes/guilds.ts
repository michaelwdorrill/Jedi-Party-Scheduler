import { Hono } from 'hono';
import type { AppEnv } from '../lib/authMiddleware';
import { chunkIds, chunkRows, placeholders } from '../lib/d1';
import { filterActiveGuildMembers, isGuildMember, listUserGuilds, MEMBERSHIP_GRACE_MS } from '../lib/db';
import { newId } from '../lib/ids';
import { expandOccurrencesForEvent, loadRecurrenceRulesForEvents } from '../lib/recurrence';
import type { EventRow } from '../lib/events';
import {
  mapOccurrence,
  loadOverridesForEvents,
  loadMyRsvpForEvents,
  loadPrimaryGroupForEvents,
  loadConfirmedOptionsForEvents,
} from '../lib/events';
import { createEventWithInvites, type EventWriteInput } from '../lib/eventWrites';
import { computeBusyBlocksForUsers } from '../lib/freeBusy';
import { expandPersonalOccurrences } from '../lib/personalEvents';
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

  // MAX_FREE_BUSY_USERS is 100, which with the guild ID would be 101 bound
  // parameters -- past D1's per-statement ceiling, so a fully-populated
  // scheduling assistant request would have failed outright. The freshness
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
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO groups (id, guild_id, name, game, idle_reminder_days, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(groupId, guildId, name, game, idleReminderDays, userId, now),
    ...chunkRows(memberIds, 3).map((chunk) =>
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

  // Only events the user is the organizer of, or is individually/group-invited
  // to -- and only ones that could possibly land in the requested window.
  // Without that second filter this loaded every event the user had ever been
  // part of on every calendar view, then discarded almost all of them after
  // expansion, so the cost of viewing one month grew with the guild's entire
  // history. Recurring events are unfiltered because whether they fall in the
  // window isn't a property of a stored timestamp -- a series has to be
  // expanded to find out.
  //
  // Polls used to get the same unconditional pass as recurring events, on
  // the theory that an open poll's eventual date is unknown ahead of time.
  // That's true for a poll that hasn't resolved yet, but a poll that HAS
  // resolved (single_winner) already has a real start_at and belongs under
  // the ordinary date-range branch below, not a blanket "load every poll
  // ever created" exemption -- a guild's entire history of old, resolved,
  // and cancelled polls was otherwise reloaded and discarded on every single
  // calendar view, forever, regardless of how old they were. So:
  //   - a still-open (non-multi_winner) poll is included only if its
  //     deadline actually falls in the requested window;
  //   - a multi_winner poll is included only if it's still open, or has a
  //     confirmed day landing in the window (`mw` below); and
  //   - a resolved single_winner poll falls through to the ordinary
  //     start_at-range branch, exactly like a fixed-time event.
  const { results: events } = await c.env.DB.prepare(
    `SELECT DISTINCT e.* FROM events e
     LEFT JOIN event_invites i ON i.event_id = e.id AND i.user_id = ?
     LEFT JOIN event_poll_options mw
       ON mw.event_id = e.id AND mw.confirmed_at IS NOT NULL AND mw.start_at <= ? AND mw.end_at >= ?
     WHERE e.guild_id = ? AND (e.organizer_id = ? OR i.user_id IS NOT NULL)
       AND (
         e.is_recurring = 1
         OR (e.event_type = 'poll' AND e.poll_resolution_mode = 'multi_winner' AND (e.status = 'active' OR mw.id IS NOT NULL))
         OR (
           e.event_type = 'poll' AND e.poll_resolution_mode != 'multi_winner' AND e.status != 'resolved'
           AND e.poll_deadline_at IS NOT NULL AND e.poll_deadline_at BETWEEN ? AND ?
         )
         OR (e.start_at IS NOT NULL AND e.start_at <= ? AND COALESCE(e.end_at, e.start_at) >= ?)
       )`,
  )
    .bind(userId, to, from, guildId, userId, from, to, to, from)
    .all<EventRow>();

  const eventIds = events.map((e) => e.id);
  const overridesByEvent = await loadOverridesForEvents(c.env, eventIds);
  const rsvpByEvent = await loadMyRsvpForEvents(c.env, eventIds, userId);
  const groupByEvent = await loadPrimaryGroupForEvents(c.env, eventIds);
  // Both bulk-loaded once for the whole visible list rather than once per
  // recurring event / per multi-winner poll -- previously the two largest
  // contributors to this route's query count scaling with how many events a
  // user could see, instead of staying roughly fixed per request.
  const recurrenceRulesByEvent = await loadRecurrenceRulesForEvents(
    c.env,
    events.filter((e) => e.is_recurring).map((e) => e.id),
  );
  const confirmedOptionsByEvent = await loadConfirmedOptionsForEvents(
    c.env,
    events.filter((e) => e.event_type === 'poll' && e.poll_resolution_mode === 'multi_winner').map((e) => e.id),
  );

  const occurrences = [];
  for (const event of events) {
    if (event.event_type === 'poll' && event.poll_resolution_mode === 'multi_winner') {
      // Each independently-confirmed day is its own occurrence, and stays on
      // the calendar even after the parent poll stops accepting new votes.
      const confirmedOptions = confirmedOptionsByEvent.get(event.id) ?? [];
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
      recurrenceRulesByEvent.get(event.id),
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

  const body = await readJsonBody<EventWriteInput>(c);
  const eventId = await createEventWithInvites(c.env, guildId, userId, body);
  return c.json({ id: eventId }, 201);
});
