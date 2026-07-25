import type { Env } from '../env';
import { newId } from './ids';

export interface RecurrenceInput {
  freq: 'DAILY' | 'WEEKLY' | 'MONTHLY';
  interval: number;
  byWeekday: number[] | null;
  byMonthDay: number | null;
  startDate: string;
  startTime: string;
  durationMinutes: number;
  endType: 'never' | 'on_date' | 'after_count';
  endDate: string | null;
  endCount: number | null;
}

export interface EventWriteInput {
  title: string;
  description: string | null;
  game: string | null;
  eventType: 'single' | 'poll';
  timezone: string;
  invites: { userIds: string[]; groupIds: string[] };

  // single
  isRecurring?: boolean;
  recurrence?: RecurrenceInput;
  startAt?: number;
  endAt?: number;

  // poll
  pollStrategy?: 'threshold' | 'most_votes';
  pollThresholdCount?: number | null;
  pollDeadlineAt?: number;
  pollOptions?: { startAt: number; endAt: number }[];
}

async function resolveInviteeUserIds(
  env: Env,
  guildId: string,
  userIds: string[],
  groupIds: string[],
): Promise<ResolvedInvitee[]> {
  const out = new Map<string, ResolvedInvitee>();

  for (const userId of userIds) {
    out.set(userId, { userId, invitedVia: 'individual', sourceGroupId: null });
  }

  for (const groupId of groupIds) {
    const { results } = await env.DB.prepare(
      `SELECT gm.user_id FROM group_members gm
       JOIN groups g ON g.id = gm.group_id
       WHERE gm.group_id = ? AND g.guild_id = ?`,
    )
      .bind(groupId, guildId)
      .all<{ user_id: string }>();
    for (const row of results) {
      if (!out.has(row.user_id)) {
        out.set(row.user_id, { userId: row.user_id, invitedVia: 'group', sourceGroupId: groupId });
      }
    }
  }

  return [...out.values()];
}

type ResolvedInvitee = { userId: string; invitedVia: 'individual' | 'group'; sourceGroupId: string | null };

async function insertInvites(env: Env, eventId: string, invitees: ResolvedInvitee[]) {
  const now = Date.now();
  for (const invitee of invitees) {
    await env.DB.prepare(
      `INSERT INTO event_invites (id, event_id, user_id, invited_via, source_group_id, rsvp_status, invited_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?)
       ON CONFLICT(event_id, user_id) DO NOTHING`,
    )
      .bind(newId(), eventId, invitee.userId, invitee.invitedVia, invitee.sourceGroupId, now)
      .run();
  }
}

export async function createEventWithInvites(
  env: Env,
  guildId: string,
  organizerId: string,
  input: EventWriteInput,
): Promise<string> {
  const eventId = newId();
  const now = Date.now();
  const isRecurring = input.eventType === 'single' && !!input.isRecurring;

  await env.DB.prepare(
    `INSERT INTO events (id, guild_id, organizer_id, title, description, game, event_type, timezone,
       start_at, end_at, status, poll_strategy, poll_threshold_count, poll_deadline_at,
       is_recurring, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      eventId,
      guildId,
      organizerId,
      input.title,
      input.description ?? null,
      input.game ?? null,
      input.eventType,
      input.timezone,
      isRecurring ? null : (input.startAt ?? null),
      isRecurring ? null : (input.endAt ?? null),
      input.eventType === 'poll' ? (input.pollStrategy ?? null) : null,
      input.eventType === 'poll' ? (input.pollThresholdCount ?? null) : null,
      input.eventType === 'poll' ? (input.pollDeadlineAt ?? null) : null,
      isRecurring ? 1 : 0,
      now,
      now,
    )
    .run();

  if (isRecurring && input.recurrence) {
    const r = input.recurrence;
    await env.DB.prepare(
      `INSERT INTO event_recurrence_rules
         (event_id, freq, interval, by_weekday, by_month_day, start_date, start_time,
          duration_minutes, end_type, end_date, end_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        eventId,
        r.freq,
        r.interval,
        r.byWeekday && r.byWeekday.length > 0 ? r.byWeekday.join(',') : null,
        r.byMonthDay ?? null,
        r.startDate,
        r.startTime,
        r.durationMinutes,
        r.endType,
        r.endDate ?? null,
        r.endCount ?? null,
      )
      .run();
  }

  if (input.eventType === 'poll' && input.pollOptions) {
    let order = 0;
    for (const opt of input.pollOptions) {
      await env.DB.prepare(
        `INSERT INTO event_poll_options (id, event_id, start_at, end_at, display_order) VALUES (?, ?, ?, ?, ?)`,
      )
        .bind(newId(), eventId, opt.startAt, opt.endAt, order++)
        .run();
    }
  }

  const invitees = await resolveInviteeUserIds(
    env,
    guildId,
    input.invites?.userIds ?? [],
    input.invites?.groupIds ?? [],
  );
  await insertInvites(env, eventId, invitees);

  return eventId;
}

export async function updateEvent(
  env: Env,
  eventId: string,
  guildId: string,
  input: Partial<EventWriteInput>,
): Promise<void> {
  const now = Date.now();

  // Build the SET clause only from fields the caller actually included --
  // e.g. POST /events/:id/invites calls this with just `{ invites }`, and
  // must not blow away the event's title/schedule as a side effect.
  const setClauses: string[] = ['updated_at = ?'];
  const values: unknown[] = [now];

  if (input.title !== undefined) {
    setClauses.push('title = ?');
    values.push(input.title);
  }
  if (input.description !== undefined) {
    setClauses.push('description = ?');
    values.push(input.description);
  }
  if (input.game !== undefined) {
    setClauses.push('game = ?');
    values.push(input.game);
  }
  if (input.timezone !== undefined) {
    setClauses.push('timezone = ?');
    values.push(input.timezone);
  }

  // isRecurring is the signal that this request is a full single-event
  // schedule edit (the frontend always sends it alongside startAt/endAt or
  // recurrence); only then do we touch start_at/end_at/is_recurring.
  if (input.isRecurring !== undefined) {
    setClauses.push('is_recurring = ?', 'start_at = ?', 'end_at = ?');
    if (input.isRecurring) {
      values.push(1, null, null);
    } else {
      values.push(0, input.startAt ?? null, input.endAt ?? null);
    }
  }

  values.push(eventId);
  await env.DB.prepare(`UPDATE events SET ${setClauses.join(', ')} WHERE id = ?`)
    .bind(...values)
    .run();

  if (input.isRecurring !== undefined) {
    await env.DB.prepare(`DELETE FROM event_recurrence_rules WHERE event_id = ?`).bind(eventId).run();
    if (input.isRecurring && input.recurrence) {
      const r = input.recurrence;
      await env.DB.prepare(
        `INSERT INTO event_recurrence_rules
           (event_id, freq, interval, by_weekday, by_month_day, start_date, start_time,
            duration_minutes, end_type, end_date, end_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(
          eventId,
          r.freq,
          r.interval,
          r.byWeekday && r.byWeekday.length > 0 ? r.byWeekday.join(',') : null,
          r.byMonthDay ?? null,
          r.startDate,
          r.startTime,
          r.durationMinutes,
          r.endType,
          r.endDate ?? null,
          r.endCount ?? null,
        )
        .run();
    }
  }

  if (input.pollOptions) {
    // Replacing poll options resets any votes already cast on the old set --
    // acceptable for v1 since editing a poll's candidate slots after voting
    // has started is an edge case, not the common path.
    await env.DB.prepare(
      `DELETE FROM event_poll_votes WHERE option_id IN (SELECT id FROM event_poll_options WHERE event_id = ?)`,
    )
      .bind(eventId)
      .run();
    await env.DB.prepare(`DELETE FROM event_poll_options WHERE event_id = ?`).bind(eventId).run();
    let order = 0;
    for (const opt of input.pollOptions) {
      await env.DB.prepare(
        `INSERT INTO event_poll_options (id, event_id, start_at, end_at, display_order) VALUES (?, ?, ?, ?, ?)`,
      )
        .bind(newId(), eventId, opt.startAt, opt.endAt, order++)
        .run();
    }
    await env.DB.prepare(
      `UPDATE events SET poll_strategy = ?, poll_threshold_count = ?, poll_deadline_at = ? WHERE id = ?`,
    )
      .bind(input.pollStrategy ?? null, input.pollThresholdCount ?? null, input.pollDeadlineAt ?? null, eventId)
      .run();
  }

  if (input.invites) {
    const invitees = await resolveInviteeUserIds(env, guildId, input.invites.userIds, input.invites.groupIds);
    await insertInvites(env, eventId, invitees);
  }
}
