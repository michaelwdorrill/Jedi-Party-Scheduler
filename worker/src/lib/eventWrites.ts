import type { Env } from '../env';
import { chunkIds, chunkRows, placeholders } from './d1';
import { filterActiveGuildMembers } from './db';
import { newId } from './ids';
import {
  assertBoolean,
  assertOneOf,
  assertOptionalString,
  assertRecurrenceInput,
  assertSafeInt,
  assertString,
  assertStringArray,
  assertTimeRange,
  assertTimezone,
  LIMITS,
  ValidationError,
} from './validate';

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
  voiceChannelId?: string | null;
  voiceChannelName?: string | null;

  // single
  isRecurring?: boolean;
  recurrence?: RecurrenceInput;
  startAt?: number;
  endAt?: number;

  // poll
  pollStrategy?: 'threshold' | 'most_votes';
  pollThresholdCount?: number | null;
  pollDeadlineAt?: number;
  pollMode?: 'options' | 'window';
  pollResolutionMode?: 'single_winner' | 'multi_winner';
  pollOptions?: { startAt: number; endAt: number }[];
  windowStartAt?: number;
  windowEndAt?: number;
  windowBlockMinutes?: number;
}

// multi_winner only makes sense for discrete day/slot options (each day
// independently reaches its own quorum) and window mode always resolves to
// exactly one block, so the two combinations below are the only valid pairs.
function normalizePollModes(input: {
  pollMode?: 'options' | 'window';
  pollResolutionMode?: 'single_winner' | 'multi_winner';
}) {
  const pollMode = input.pollMode ?? 'options';
  const pollResolutionMode = pollMode === 'window' ? 'single_winner' : (input.pollResolutionMode ?? 'single_winner');
  return { pollMode, pollResolutionMode };
}

async function resolveInviteeUserIds(
  env: Env,
  guildId: string,
  userIds: string[],
  groupIds: string[],
): Promise<ResolvedInvitee[]> {
  const out = new Map<string, ResolvedInvitee>();

  if (userIds.length > 0) {
    // Direct invitees are organizer-chosen IDs -- validate every one is a
    // current active member of this guild and reject the whole request if
    // not, rather than silently inviting (and DM-notifying) an outsider.
    const active = await filterActiveGuildMembers(env, guildId, userIds);
    const invalid = userIds.filter((id) => !active.has(id));
    if (invalid.length > 0) {
      throw new ValidationError('One or more invited users are not current members of this server');
    }
    for (const userId of userIds) {
      out.set(userId, { userId, invitedVia: 'individual', sourceGroupId: null });
    }
  }

  for (const groupId of groupIds) {
    const { results } = await env.DB.prepare(
      `SELECT gm.user_id FROM group_members gm
       JOIN groups g ON g.id = gm.group_id
       WHERE gm.group_id = ? AND g.guild_id = ?`,
    )
      .bind(groupId, guildId)
      .all<{ user_id: string }>();
    // Group-derived invitees can drift out of guild membership over time
    // without anyone editing the group -- filter those out rather than
    // reject, since the organizer didn't choose them individually.
    const active = await filterActiveGuildMembers(env, guildId, results.map((r) => r.user_id));
    for (const row of results) {
      if (active.has(row.user_id) && !out.has(row.user_id)) {
        out.set(row.user_id, { userId: row.user_id, invitedVia: 'group', sourceGroupId: groupId });
      }
    }
  }

  if (out.size > LIMITS.MAX_RESOLVED_INVITEES) {
    throw new ValidationError(`Resolved invite list is too large (max ${LIMITS.MAX_RESOLVED_INVITEES})`);
  }

  return [...out.values()];
}

type ResolvedInvitee = { userId: string; invitedVia: 'individual' | 'group'; sourceGroupId: string | null };

// Applied to every create/update -- both callers pass user-controlled JSON
// bodies with only compile-time typing (which enforces nothing at runtime).
// Every numeric field here is a potential CPU/DoS vector (see the window
// bounds especially: unbounded span x submissions is what let F-04 exhaust
// Worker CPU on both request and cron paths), so this validates everything
// present on the input, not just the fields a given call site happens to use.
function validateEventWriteInput(input: Partial<EventWriteInput>, requireComplete = false): void {
  if (input.title !== undefined) assertString(input.title, 'title', LIMITS.TITLE);
  if (input.description !== undefined) assertOptionalString(input.description, 'description', LIMITS.DESCRIPTION);
  if (input.game !== undefined) assertOptionalString(input.game, 'game', LIMITS.GAME);
  if (input.timezone !== undefined) assertTimezone(input.timezone, 'timezone');
  if (input.voiceChannelId !== undefined) assertOptionalString(input.voiceChannelId, 'voiceChannelId', 64);
  if (input.voiceChannelName !== undefined) assertOptionalString(input.voiceChannelName, 'voiceChannelName', LIMITS.CHANNEL_NAME);
  if (input.eventType !== undefined) assertOneOf(input.eventType, 'eventType', ['single', 'poll'] as const);
  // Typed as boolean but never checked at runtime until now: a string or a
  // number here silently reached the `input.eventType === 'single' &&
  // !!input.isRecurring` branch and decided whether start_at/end_at were
  // written, so a wrong type quietly produced a differently-shaped row.
  if (input.isRecurring !== undefined) assertBoolean(input.isRecurring, 'isRecurring');
  if (input.pollStrategy != null) assertOneOf(input.pollStrategy, 'pollStrategy', ['threshold', 'most_votes'] as const);
  if (input.pollMode !== undefined) assertOneOf(input.pollMode, 'pollMode', ['options', 'window'] as const);
  if (input.pollResolutionMode !== undefined) {
    assertOneOf(input.pollResolutionMode, 'pollResolutionMode', ['single_winner', 'multi_winner'] as const);
  }

  if (input.invites) {
    assertStringArray(input.invites.userIds, 'invites.userIds', LIMITS.MAX_INVITEES, 64);
    assertStringArray(input.invites.groupIds, 'invites.groupIds', LIMITS.MAX_GROUP_IDS, 64);
  }

  if (input.startAt !== undefined) assertSafeInt(input.startAt, 'startAt');
  if (input.endAt !== undefined) assertSafeInt(input.endAt, 'endAt');
  if (input.startAt !== undefined && input.endAt !== undefined) {
    assertTimeRange(input.startAt, input.endAt, 'event', LIMITS.MAX_EVENT_DURATION_MS);
  }

  // Normalized in place (deduped/sorted byWeekday, nulled-out irrelevant end
  // fields) -- every later reference to input.recurrence, including the
  // INSERT statements built below, uses this cleaned value, not the raw body.
  if (input.recurrence) {
    input.recurrence = assertRecurrenceInput(input.recurrence, 'recurrence') as RecurrenceInput;
  }

  // A threshold of 0 or a negative one resolves the poll the instant it's
  // created; one larger than the invite list can never be reached, so the
  // poll can only ever expire. Neither is a meaningful thing to ask for.
  if (input.pollThresholdCount != null) {
    const threshold = assertSafeInt(input.pollThresholdCount, 'pollThresholdCount');
    if (threshold < 1 || threshold > LIMITS.MAX_RESOLVED_INVITEES) {
      throw new ValidationError('pollThresholdCount out of range');
    }
  }
  if (input.pollDeadlineAt !== undefined) {
    const deadline = assertSafeInt(input.pollDeadlineAt, 'pollDeadlineAt');
    if (deadline <= 0) throw new ValidationError('pollDeadlineAt must be a positive timestamp');
  }

  if (input.pollOptions) {
    if (input.pollOptions.length > LIMITS.MAX_POLL_OPTIONS) {
      throw new ValidationError(`pollOptions must have ${LIMITS.MAX_POLL_OPTIONS} items or fewer`);
    }
    for (const opt of input.pollOptions) {
      assertSafeInt(opt.startAt, 'pollOptions[].startAt');
      assertSafeInt(opt.endAt, 'pollOptions[].endAt');
      assertTimeRange(opt.startAt, opt.endAt, 'pollOptions[]', LIMITS.MAX_EVENT_DURATION_MS);
    }
  }

  if (input.windowStartAt !== undefined) {
    assertSafeInt(input.windowStartAt, 'windowStartAt');
    assertSafeInt(input.windowEndAt, 'windowEndAt');
    assertSafeInt(input.windowBlockMinutes, 'windowBlockMinutes');
    assertTimeRange(input.windowStartAt, input.windowEndAt!, 'window', LIMITS.MAX_WINDOW_SPAN_MS);
    if (
      input.windowBlockMinutes! < LIMITS.MIN_WINDOW_BLOCK_MINUTES ||
      input.windowBlockMinutes! > LIMITS.MAX_WINDOW_BLOCK_MINUTES
    ) {
      throw new ValidationError('windowBlockMinutes out of range');
    }
  }

  if (requireComplete) assertCompleteEventShape(input);
}

// Create requires a *coherent* event, not just individually-valid fields.
// PATCH deliberately doesn't run this: it's a partial update by design, and
// the shape it produces is the union of the stored row and the delta.
//
// Without this, a create could omit both a schedule and a recurrence rule (an
// event that never occurs and shows on nobody's calendar), or declare a poll
// with no candidates and no deadline (a poll that can never resolve and that
// the deadline sweep will re-examine on every tick forever). Both were
// storable, and both left rows that only ever made sense to delete.
function assertCompleteEventShape(input: Partial<EventWriteInput>): void {
  assertString(input.title, 'title', LIMITS.TITLE);
  assertTimezone(input.timezone, 'timezone');
  const eventType = assertOneOf(input.eventType, 'eventType', ['single', 'poll'] as const);

  if (eventType === 'single') {
    if (input.isRecurring) {
      if (!input.recurrence) throw new ValidationError('recurrence is required when isRecurring is true');
    } else if (input.startAt == null || input.endAt == null) {
      throw new ValidationError('startAt and endAt are required for a non-recurring event');
    }
    return;
  }

  if (input.pollDeadlineAt == null) throw new ValidationError('pollDeadlineAt is required for a poll');
  const { pollMode } = normalizePollModes(input);
  if (pollMode === 'window') {
    if (input.windowStartAt == null || input.windowEndAt == null || input.windowBlockMinutes == null) {
      throw new ValidationError('windowStartAt, windowEndAt and windowBlockMinutes are required for a window poll');
    }
  } else if (!input.pollOptions || input.pollOptions.length === 0) {
    throw new ValidationError('a poll needs at least one option');
  }
  if (input.pollStrategy === 'threshold' && input.pollThresholdCount == null) {
    throw new ValidationError('pollThresholdCount is required when pollStrategy is threshold');
  }
}

// Per-guild ceilings, checked at create time. Individually every event here is
// legitimate; the problem is aggregate growth, which is what turns "one member
// creating events" into a durable, cross-user failure -- every other member's
// calendar has to load and expand the accumulated set on every request, and
// the cron has to walk all of it every 15 minutes. Nothing else in the app
// caps how many rows one person can add.
async function assertGuildEventQuota(env: Env, guildId: string, organizerId: string, isRecurring: boolean): Promise<void> {
  const counts = await env.DB.prepare(
    `SELECT
       COUNT(*) AS total,
       SUM(CASE WHEN organizer_id = ? THEN 1 ELSE 0 END) AS mine,
       SUM(CASE WHEN is_recurring = 1 THEN 1 ELSE 0 END) AS recurring
     FROM events WHERE guild_id = ? AND status != 'cancelled'`,
  )
    .bind(organizerId, guildId)
    .first<{ total: number; mine: number | null; recurring: number | null }>();

  if ((counts?.total ?? 0) >= LIMITS.MAX_ACTIVE_EVENTS_PER_GUILD) {
    throw new ValidationError('This server has reached its limit of scheduled events -- delete some old ones first');
  }
  if ((counts?.mine ?? 0) >= LIMITS.MAX_EVENTS_PER_ORGANIZER_PER_GUILD) {
    throw new ValidationError("You've reached your limit of scheduled events on this server");
  }
  if (isRecurring && (counts?.recurring ?? 0) >= LIMITS.MAX_RECURRING_EVENTS_PER_GUILD) {
    throw new ValidationError('This server has reached its limit of recurring events');
  }
}

// Multi-row inserts rather than one statement per invitee: an event may
// resolve to MAX_RESOLVED_INVITEES people, and a batch of that many separate
// statements pushes against D1's per-invocation query limit for no reason.
// ON CONFLICT DO NOTHING is what preserves an existing invitee's RSVP.
function inviteStatements(env: Env, eventId: string, invitees: ResolvedInvitee[]): D1PreparedStatement[] {
  const now = Date.now();
  return chunkRows(invitees, 6).map((chunk) =>
    env.DB.prepare(
      `INSERT INTO event_invites (id, event_id, user_id, invited_via, source_group_id, rsvp_status, invited_at)
       VALUES ${chunk.map(() => `(?, ?, ?, ?, ?, 'pending', ?)`).join(', ')}
       ON CONFLICT(event_id, user_id) DO NOTHING`,
    ).bind(
      ...chunk.flatMap((invitee) => [newId(), eventId, invitee.userId, invitee.invitedVia, invitee.sourceGroupId, now]),
    ),
  );
}

// Full replacement: also removes invite rows for anyone NOT in the
// newly-resolved list. This is what the edit form's invitee picker implies --
// it submits the complete desired list, so unchecking someone and saving
// should actually revoke their access, not just leave the old row in place
// alongside whatever got added. RSVP state for anyone who remains is
// preserved via inviteStatements' ON CONFLICT DO NOTHING.
//
// Expressed as a read-then-diff rather than the obvious `NOT IN (...every
// invitee...)`: that list can hold up to MAX_RESOLVED_INVITEES entries, three
// times D1's per-statement bound-parameter ceiling, and NOT IN is the one
// shape that can't simply be chunked (each chunk would delete everyone absent
// from *that* chunk, including people present in another). Reading the
// current rows and computing the removals turns it into a positive IN list,
// which chunks correctly -- and is usually empty, since most edits add people
// rather than remove them.
async function replaceInviteStatements(
  env: Env,
  eventId: string,
  invitees: ResolvedInvitee[],
): Promise<D1PreparedStatement[]> {
  const { results: current } = await env.DB.prepare(
    `SELECT user_id FROM event_invites WHERE event_id = ?`,
  )
    .bind(eventId)
    .all<{ user_id: string }>();

  const keep = new Set(invitees.map((i) => i.userId));
  const remove = current.map((r) => r.user_id).filter((id) => !keep.has(id));

  const statements: D1PreparedStatement[] = [];
  for (const chunk of chunkIds(remove, 1)) {
    statements.push(
      env.DB.prepare(
        `DELETE FROM event_invites WHERE event_id = ? AND user_id IN (${placeholders(chunk.length)})`,
      ).bind(eventId, ...chunk),
    );
  }
  statements.push(...inviteStatements(env, eventId, invitees));
  return statements;
}

// Additive-only: for the dedicated "invite more people" endpoint (POST
// /events/:eventId/invites), which -- unlike a full edit-form submission --
// should never remove anyone already invited.
export async function addInvitesToEvent(
  env: Env,
  eventId: string,
  guildId: string,
  userIds: string[],
  groupIds: string[],
): Promise<void> {
  assertStringArray(userIds, 'userIds', LIMITS.MAX_INVITEES, 64);
  assertStringArray(groupIds, 'groupIds', LIMITS.MAX_GROUP_IDS, 64);
  const invitees = await resolveInviteeUserIds(env, guildId, userIds, groupIds);
  if (invitees.length === 0) return;
  await env.DB.batch(inviteStatements(env, eventId, invitees));
}

export async function createEventWithInvites(
  env: Env,
  guildId: string,
  organizerId: string,
  input: EventWriteInput,
): Promise<string> {
  validateEventWriteInput(input, true);
  const eventId = newId();
  const now = Date.now();
  const isRecurring = input.eventType === 'single' && !!input.isRecurring;
  const { pollMode, pollResolutionMode } = normalizePollModes(input);

  await assertGuildEventQuota(env, guildId, organizerId, isRecurring);

  // Resolved (and validated) before anything is written, so a rejected
  // invite list (F-05: cross-guild targets) never leaves a half-created
  // event behind for the caller to retry into.
  const invitees = await resolveInviteeUserIds(
    env,
    guildId,
    input.invites?.userIds ?? [],
    input.invites?.groupIds ?? [],
  );

  // Everything below is one D1 batch -- a failure partway through (a full
  // event with no recurrence rule, or no invites) is exactly the partial-
  // object problem F-08 flagged; batch() commits all-or-nothing.
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      `INSERT INTO events (id, guild_id, organizer_id, title, description, game, event_type, timezone,
         start_at, end_at, status, poll_strategy, poll_threshold_count, poll_deadline_at,
         poll_mode, poll_resolution_mode, window_start_at, window_end_at, window_block_minutes,
         is_recurring, voice_channel_id, voice_channel_name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
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
      pollMode,
      pollResolutionMode,
      input.eventType === 'poll' && pollMode === 'window' ? (input.windowStartAt ?? null) : null,
      input.eventType === 'poll' && pollMode === 'window' ? (input.windowEndAt ?? null) : null,
      input.eventType === 'poll' && pollMode === 'window' ? (input.windowBlockMinutes ?? null) : null,
      isRecurring ? 1 : 0,
      input.voiceChannelId ?? null,
      input.voiceChannelName ?? null,
      now,
      now,
    ),
  ];

  if (isRecurring && input.recurrence) {
    const r = input.recurrence;
    statements.push(
      env.DB.prepare(
        `INSERT INTO event_recurrence_rules
           (event_id, freq, interval, by_weekday, by_month_day, start_date, start_time,
            duration_minutes, end_type, end_date, end_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
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
      ),
    );
  }

  if (input.eventType === 'poll' && pollMode === 'options' && input.pollOptions) {
    let order = 0;
    for (const opt of input.pollOptions) {
      statements.push(
        env.DB.prepare(
          `INSERT INTO event_poll_options (id, event_id, start_at, end_at, display_order) VALUES (?, ?, ?, ?, ?)`,
        ).bind(newId(), eventId, opt.startAt, opt.endAt, order++),
      );
    }
  }

  statements.push(...inviteStatements(env, eventId, invitees));

  await env.DB.batch(statements);

  return eventId;
}

export async function updateEvent(
  env: Env,
  eventId: string,
  guildId: string,
  input: Partial<EventWriteInput>,
): Promise<void> {
  validateEventWriteInput(input);
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
  if (input.voiceChannelId !== undefined) {
    setClauses.push('voice_channel_id = ?', 'voice_channel_name = ?');
    values.push(input.voiceChannelId, input.voiceChannelName ?? null);
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

  // Invitee resolution (and possible rejection -- F-05) happens before any
  // statement is queued, same reasoning as createEventWithInvites: a request
  // that's going to fail validation shouldn't partially apply first.
  const invitees = input.invites
    ? await resolveInviteeUserIds(env, guildId, input.invites.userIds, input.invites.groupIds)
    : null;

  // Every conditional block below queues its statements instead of running
  // them immediately; one env.DB.batch() at the end makes the whole PATCH
  // atomic -- a single request editing both, say, the schedule and the poll
  // options can't leave the poll options replaced but the schedule untouched.
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(`UPDATE events SET ${setClauses.join(', ')} WHERE id = ?`).bind(...values),
  ];

  if (input.isRecurring !== undefined) {
    statements.push(env.DB.prepare(`DELETE FROM event_recurrence_rules WHERE event_id = ?`).bind(eventId));
    if (input.isRecurring && input.recurrence) {
      const r = input.recurrence;
      statements.push(
        env.DB.prepare(
          `INSERT INTO event_recurrence_rules
             (event_id, freq, interval, by_weekday, by_month_day, start_date, start_time,
              duration_minutes, end_type, end_date, end_count)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
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
        ),
      );
    }
  }

  if (input.pollOptions) {
    // Replacing poll options resets any votes already cast on the old set --
    // acceptable for v1 since editing a poll's candidate slots after voting
    // has started is an edge case, not the common path.
    const { pollMode, pollResolutionMode } = normalizePollModes(input);
    statements.push(
      env.DB.prepare(
        `DELETE FROM event_poll_votes WHERE option_id IN (SELECT id FROM event_poll_options WHERE event_id = ?)`,
      ).bind(eventId),
      env.DB.prepare(`DELETE FROM event_poll_options WHERE event_id = ?`).bind(eventId),
    );
    let order = 0;
    for (const opt of input.pollOptions) {
      statements.push(
        env.DB.prepare(
          `INSERT INTO event_poll_options (id, event_id, start_at, end_at, display_order) VALUES (?, ?, ?, ?, ?)`,
        ).bind(newId(), eventId, opt.startAt, opt.endAt, order++),
      );
    }
    statements.push(
      env.DB.prepare(
        `UPDATE events SET poll_strategy = ?, poll_threshold_count = ?, poll_deadline_at = ?,
           poll_mode = ?, poll_resolution_mode = ?, window_start_at = NULL, window_end_at = NULL,
           window_block_minutes = NULL
         WHERE id = ?`,
      ).bind(
        input.pollStrategy ?? null,
        input.pollThresholdCount ?? null,
        input.pollDeadlineAt ?? null,
        pollMode,
        pollResolutionMode,
        eventId,
      ),
    );
  }

  if (input.windowStartAt !== undefined) {
    statements.push(
      env.DB.prepare(`DELETE FROM event_window_availability WHERE event_id = ?`).bind(eventId),
      env.DB.prepare(
        `UPDATE events SET poll_strategy = ?, poll_threshold_count = ?, poll_deadline_at = ?,
           poll_mode = 'window', poll_resolution_mode = 'single_winner',
           window_start_at = ?, window_end_at = ?, window_block_minutes = ?
         WHERE id = ?`,
      ).bind(
        input.pollStrategy ?? null,
        input.pollThresholdCount ?? null,
        input.pollDeadlineAt ?? null,
        input.windowStartAt,
        input.windowEndAt ?? null,
        input.windowBlockMinutes ?? null,
        eventId,
      ),
    );
  }

  if (invitees) {
    statements.push(...(await replaceInviteStatements(env, eventId, invitees)));
  }

  await env.DB.batch(statements);
}
