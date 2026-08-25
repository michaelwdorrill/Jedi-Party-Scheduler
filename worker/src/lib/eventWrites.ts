import type { Env } from '../env';
import { chunkIds, chunkRows, conditionalRowsSql, placeholders } from './d1';
import { filterActiveGuildMembers } from './db';
import type { EventRow } from './events';
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
  ConflictError,
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

  // The revision the client actually read before building this edit
  // (F-08-B). Optional for backward compatibility with callers that don't
  // have one to offer -- when omitted, updateEvent falls back to `stored`'s
  // revision, which is the pre-fix behaviour: correct for a single caller
  // building its own `stored` read, but not a substitute for a real client
  // round trip. See updateEvent for how this is used.
  revision?: number;
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
  // The organizer, folded into the resolved list unless they are already in
  // it (idea 26). `null` only for the additive "invite more people" path,
  // which is adding named people to an event that already has its organizer
  // row -- see addInvitesToEvent.
  //
  // Passed in and applied here, rather than at each call site, because
  // updateEvent's replaceInviteStatements deletes every row not in the list
  // it is handed: a call site that forgot would not fail to add the row, it
  // would delete the existing one on the next edit.
  organizerId: string | null,
): Promise<ResolvedInvitee[]> {
  // `source` is `null` for a directly-chosen invitee and the winning group ID
  // for a group-derived one. Built up front, before any membership check
  // runs, so direct and group-derived candidates go through
  // filterActiveGuildMembers exactly once as a single combined set rather
  // than twice. Each call can spend up to MAX_LIVE_REVALIDATIONS_PER_REQUEST
  // live Discord checks (and the D1 writeback for their results) on its
  // own -- two calls at the configured maxima (100 direct + 200 group
  // invitees, both with 20 stale rows) doubled that cost for no reason, since
  // nothing about the check itself differs between the two sources.
  const source = new Map<string, string | null>();
  for (const userId of userIds) source.set(userId, null);

  if (groupIds.length > 0) {
    // One roster query per chunk of groups, not one per group. The old shape
    // cost (1 roster + ceil(members/80) membership chunks) per group. At the
    // configured maxima -- 50 groups of 200 members -- that is 200 D1
    // statements for a single request, four times the Free plan's whole
    // per-invocation allowance.
    const rosters: { user_id: string; group_id: string }[] = [];
    for (const chunk of chunkIds(groupIds, 1)) {
      const { results } = await env.DB.prepare(
        `SELECT gm.user_id, gm.group_id FROM group_members gm
         JOIN groups g ON g.id = gm.group_id
         WHERE gm.group_id IN (${placeholders(chunk.length)}) AND g.guild_id = ?`,
      )
        .bind(...chunk, guildId)
        .all<{ user_id: string; group_id: string }>();
      rosters.push(...results);
    }

    // First group that named a user wins as the attribution source, matching
    // the previous iteration order. A direct invitee (already in `source`
    // with a `null` source) is never reattributed to a group.
    for (const row of rosters) {
      if (!source.has(row.user_id)) source.set(row.user_id, row.group_id);
    }
  }

  // Admission check before the membership work, not after it. The cap is on
  // the resolved list, and the candidate set can only shrink from here
  // (membership filtering removes people), so a candidate set already over
  // the cap can never come back under it -- there is no reason to pay for
  // verifying it first.
  if (source.size > LIMITS.MAX_RESOLVED_INVITEES) {
    throw new ValidationError(`Resolved invite list is too large (max ${LIMITS.MAX_RESOLVED_INVITEES})`);
  }

  const active = await filterActiveGuildMembers(env, guildId, [...source.keys()]);

  // Direct invitees are organizer-chosen IDs -- validate every one is a
  // current active member of this guild and reject the whole request if not,
  // rather than silently inviting (and DM-notifying) an outsider.
  const invalidDirect = userIds.filter((id) => !active.has(id));
  if (invalidDirect.length > 0) {
    throw new ValidationError('One or more invited users are not current members of this server');
  }

  // Group-derived invitees can drift out of guild membership over time
  // without anyone editing the group -- filter those out rather than reject,
  // since the organizer didn't choose them individually.
  const out = new Map<string, ResolvedInvitee>();
  for (const [userId, groupId] of source) {
    if (!active.has(userId)) continue;
    out.set(
      userId,
      groupId === null
        ? { userId, invitedVia: 'individual', sourceGroupId: null, rsvpStatus: 'pending' }
        : { userId, invitedVia: 'group', sourceGroupId: groupId, rsvpStatus: 'pending' },
    );
  }

  // Idea 26: the organizer needs a real row or POST /events/:id/rsvp -- which
  // is `UPDATE event_invites ... WHERE event_id = ? AND user_id = ?`, then a
  // 403 when nothing matched -- tells them they are not invited to their own
  // event. It only ever struck an organizer who did not invite themselves: a
  // group event whose organizer is in the invited group already gets a row
  // through group resolution above (and since idea 16, a group's creator is
  // always a member of it), which is why this looked so arbitrary.
  //
  // Added *after* the membership filter, not before: their right to a place on
  // their own event does not depend on a cached membership row being fresh,
  // and routing them through `invalidDirect` would turn a stale cache into a
  // rejected event creation. The cron's own membership joins still exclude an
  // organizer who has actually left.
  //
  // 'accepted', not 'pending': they are the one person whose attendance is not
  // in question. Keeping the row (rather than hiding the buttons) is what
  // preserves the genuine case of an organizer who cannot make their own
  // session -- the DM can be ill.
  if (organizerId !== null && !out.has(organizerId)) {
    out.set(organizerId, {
      userId: organizerId,
      invitedVia: 'individual',
      sourceGroupId: null,
      rsvpStatus: 'accepted',
    });
  }

  if (out.size > LIMITS.MAX_RESOLVED_INVITEES) {
    throw new ValidationError(`Resolved invite list is too large (max ${LIMITS.MAX_RESOLVED_INVITEES})`);
  }

  return [...out.values()];
}

type ResolvedInvitee = {
  userId: string;
  invitedVia: 'individual' | 'group';
  sourceGroupId: string | null;
  // Everyone starts 'pending'; only the organizer's own row starts 'accepted'.
  // On an edit this is written through ON CONFLICT DO NOTHING, so an organizer
  // who has since declined keeps that answer rather than being re-accepted.
  rsvpStatus: 'pending' | 'accepted';
};

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
  if (input.revision !== undefined) {
    const revision = assertSafeInt(input.revision, 'revision');
    if (revision < 0) throw new ValidationError('revision must not be negative');
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
// The two coherent shapes a single event's schedule can have: a series with a
// recurrence rule, or a one-off with a concrete start and end. Never both,
// never neither.
//
// Shared by create and PATCH deliberately. PATCH validates the fields present
// in its delta, which is necessary but not sufficient -- `{isRecurring: true}`
// on its own is a *valid delta* made of valid fields, and applying it set
// is_recurring = 1, nulled start_at/end_at, deleted the old recurrence rule
// and inserted no new one, storing a series with no definition of when it
// recurs. Every reader downstream then has to cope with a shape the create
// path would have rejected outright: the calendar expands nothing, free/busy
// silently contributes no blocks for it, and the cron sweeps skip it. A
// partial update still has to leave a complete object behind.
function assertCompleteScheduleShape(input: Partial<EventWriteInput>): void {
  if (input.isRecurring) {
    if (!input.recurrence) throw new ValidationError('recurrence is required when isRecurring is true');
  } else if (input.startAt == null || input.endAt == null) {
    throw new ValidationError('startAt and endAt are required for a non-recurring event');
  }
}

// Validates the event a PATCH would *leave behind*, not the delta it carries.
//
// Field-by-field validation of a delta is necessary but not sufficient, and
// the gap is not hypothetical: every field in `{pollStrategy: 'threshold',
// pollThresholdCount: 2, pollOptions: [...]}` is individually valid, and
// applying it to a plain single event stored poll state on a row that is not
// a poll. Likewise `{isRecurring: true, recurrence: {...}}` applied to a poll
// produced a poll with a recurrence rule and null one-off timestamps. Neither
// shape is reachable through create, so nothing downstream is written to
// expect them -- the calendar, free/busy and the cron sweeps all branch on
// `event_type` and `is_recurring` and quietly do the wrong thing with a row
// that is both.
//
// The four shapes below are the whole supported set. Anything else is
// rejected here rather than stored and coped with later.
function assertCoherentMergedEvent(stored: EventRow, input: Partial<EventWriteInput>): void {
  // event_type is immutable: a poll and a single event have different child
  // tables and different resolution semantics, and nothing in the app offers
  // to convert between them.
  if (input.eventType !== undefined && input.eventType !== stored.event_type) {
    throw new ValidationError('An event cannot change between a poll and a single event');
  }

  const isPoll = stored.event_type === 'poll';
  const touchesPollState =
    input.pollOptions !== undefined ||
    input.pollStrategy !== undefined ||
    input.pollThresholdCount !== undefined ||
    input.pollDeadlineAt !== undefined ||
    input.pollMode !== undefined ||
    input.pollResolutionMode !== undefined ||
    input.windowStartAt !== undefined ||
    input.windowEndAt !== undefined ||
    input.windowBlockMinutes !== undefined;

  if (!isPoll && touchesPollState) {
    throw new ValidationError('Poll settings cannot be set on an event that is not a poll');
  }

  // Recurrence belongs to single events. A recurring poll has no meaning
  // here: the poll resolves to one concrete slot (or a set of confirmed
  // ones), which is what a series would otherwise be generating.
  if (isPoll && input.isRecurring === true) {
    throw new ValidationError('A poll cannot be made recurring');
  }

  // The resulting schedule must still be one of the two coherent shapes.
  // Only checked when this PATCH actually rewrites the schedule; an edit that
  // only changes the title inherits whatever the stored row already had.
  if (input.isRecurring !== undefined) assertCompleteScheduleShape(input);
}

function assertCompleteEventShape(input: Partial<EventWriteInput>): void {
  assertString(input.title, 'title', LIMITS.TITLE);
  assertTimezone(input.timezone, 'timezone');
  const eventType = assertOneOf(input.eventType, 'eventType', ['single', 'poll'] as const);

  if (eventType === 'single') {
    assertCompleteScheduleShape(input);
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

// Per-guild ceilings, checked at create time (and, for the recurring cap
// specifically, whenever PATCH converts an existing event into a recurring
// one -- see updateEvent). Individually every event here is legitimate; the
// problem is aggregate growth, which is what turns "one member creating
// events" into a durable, cross-user failure -- every other member's
// calendar has to load and expand the accumulated set on every request, and
// the cron has to walk all of it every 15 minutes. Nothing else in the app
// caps how many rows one person can add.
//
// This is a friendly, specific-message pre-check for the common case, not
// the actual enforcement -- that's the WHERE-guarded INSERT/UPDATE built
// into the caller's statement (see guardedEventInsertGuard /
// guardedRecurringConversionGuard below), which closes the TOCTOU window
// between this check and the write.
async function assertGuildEventQuota(env: Env, guildId: string, organizerId: string, isRecurring: boolean): Promise<void> {
  const counts = await env.DB.prepare(
    `SELECT
       SUM(CASE WHEN status != 'cancelled' THEN 1 ELSE 0 END) AS total,
       SUM(CASE WHEN status != 'cancelled' AND organizer_id = ? THEN 1 ELSE 0 END) AS mine,
       SUM(CASE WHEN status != 'cancelled' AND is_recurring = 1 THEN 1 ELSE 0 END) AS recurring,
       COUNT(*) AS all_rows
     FROM events WHERE guild_id = ?`,
  )
    .bind(organizerId, guildId)
    .first<{ total: number | null; mine: number | null; recurring: number | null; all_rows: number }>();

  // Counts cancelled rows too. The three quotas below deliberately don't, so
  // that tidying up frees capacity -- but that also means create-then-cancel
  // is otherwise unlimited, and a cancelled row still occupies storage (and
  // is still read) until the 90-day purge reaches it. Without this ceiling,
  // churn can outpace the purge indefinitely.
  if ((counts?.all_rows ?? 0) >= LIMITS.MAX_TOTAL_EVENT_ROWS_PER_GUILD) {
    throw new ValidationError(
      'This server has too much event history -- cancelled events are cleared automatically after 90 days, please try again later',
    );
  }
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

// SQL fragment (3 `?` placeholders: guildId, guildId, MAX_ACTIVE; guildId,
// organizerId, MAX_ORGANIZER; and conditionally guildId, MAX_RECURRING) that
// makes the quota check part of the same atomic statement as the write,
// rather than a separate query a concurrent request could race between.
// Appended to an INSERT's SELECT ... WHERE clause (create) or an UPDATE's
// WHERE clause (recurring conversion on PATCH). If the guard fails, the
// statement affects zero rows instead of erroring -- the caller checks
// meta.changes to tell "blocked by quota" apart from every other outcome.
function eventQuotaGuardSql(includeRecurring: boolean): string {
  const allRows = `(SELECT COUNT(*) FROM events WHERE guild_id = ?) < ?`;
  const total = `(SELECT COUNT(*) FROM events WHERE guild_id = ? AND status != 'cancelled') < ?`;
  const mine = `(SELECT COUNT(*) FROM events WHERE guild_id = ? AND organizer_id = ? AND status != 'cancelled') < ?`;
  const recurring = `(SELECT COUNT(*) FROM events WHERE guild_id = ? AND status != 'cancelled' AND is_recurring = 1) < ?`;
  return includeRecurring ? `${allRows} AND ${total} AND ${mine} AND ${recurring}` : `${allRows} AND ${total} AND ${mine}`;
}

function eventQuotaGuardParams(guildId: string, organizerId: string, includeRecurring: boolean): unknown[] {
  const params: unknown[] = [
    guildId, LIMITS.MAX_TOTAL_EVENT_ROWS_PER_GUILD,
    guildId, LIMITS.MAX_ACTIVE_EVENTS_PER_GUILD,
    guildId, organizerId, LIMITS.MAX_EVENTS_PER_ORGANIZER_PER_GUILD,
  ];
  if (includeRecurring) params.push(guildId, LIMITS.MAX_RECURRING_EVENTS_PER_GUILD);
  return params;
}

// Multi-row inserts rather than one statement per invitee: an event may
// resolve to MAX_RESOLVED_INVITEES people, and a batch of that many separate
// statements pushes against D1's per-invocation query limit for no reason.
// ON CONFLICT DO NOTHING is what preserves an existing invitee's RSVP.
const INVITE_COLUMNS = ['id', 'event_id', 'user_id', 'invited_via', 'source_group_id', 'rsvp_status', 'invited_at'] as const;

// `guarded` conditions every row on the parent event existing, which the
// create path needs: its parent insert carries a quota guard that can write
// zero rows, and unconditional children would then violate the event foreign
// key and abort the whole batch with an opaque error instead of the intended
// no-op plus friendly quota message. Update paths pass false -- their parent
// is already known to exist, and the extra EXISTS would just be noise.
// `extraGuard` additionally conditions a guarded write on more than the
// parent existing -- the recurring-conversion PATCH path uses it to require
// `is_recurring = 1`, so a quota claim that failed earlier in the very same
// batch (see updateEvent) makes the invite writes a no-op too, not just the
// event row itself.
function inviteStatements(
  env: Env,
  eventId: string,
  invitees: ResolvedInvitee[],
  guarded: boolean,
  mutationToken: string | null = null,
): D1PreparedStatement[] {
  const extraGuard = mutationToken === null ? '' : ' AND mutation_token = ?';
  const extraBinds = mutationToken === null ? [] : [mutationToken];
  const now = Date.now();
  const conflict = 'ON CONFLICT(event_id, user_id) DO NOTHING';
  return chunkRows(invitees, INVITE_COLUMNS.length, guarded ? 1 : 0).map((chunk) => {
    const values = chunk.flatMap((invitee) => [
      newId(),
      eventId,
      invitee.userId,
      invitee.invitedVia,
      invitee.sourceGroupId,
      invitee.rsvpStatus,
      now,
    ]);
    if (!guarded) {
      return env.DB.prepare(
        `INSERT INTO event_invites (${INVITE_COLUMNS.join(', ')})
         VALUES ${chunk.map(() => `(${INVITE_COLUMNS.map(() => '?').join(', ')})`).join(', ')}
         ${conflict}`,
      ).bind(...values);
    }
    return env.DB.prepare(
      conditionalRowsSql('event_invites', INVITE_COLUMNS, chunk.length, 'events', conflict, extraGuard),
    ).bind(...values, eventId, ...extraBinds);
  });
}

const POLL_OPTION_COLUMNS = ['id', 'event_id', 'start_at', 'end_at', 'display_order'] as const;

// Same reasoning as inviteStatements: one statement per option turned a
// 50-option poll -- the configured maximum -- into 51 statements before a
// single invite, past the Free plan's whole per-invocation allowance.
// `extraGuard` narrows the parent condition beyond mere existence, the same
// way inviteStatements' does -- the recurring-conversion PATCH passes
// `is_recurring = 1` so replacement options are written only if that
// conversion's quota admission actually applied.
function pollOptionStatements(
  env: Env,
  eventId: string,
  options: readonly { startAt: number; endAt: number }[],
  guarded: boolean,
  mutationToken: string | null = null,
): D1PreparedStatement[] {
  const extraGuard = mutationToken === null ? '' : ' AND mutation_token = ?';
  const extraBinds = mutationToken === null ? [] : [mutationToken];
  let order = 0;
  const rows = options.map((opt) => [newId(), eventId, opt.startAt, opt.endAt, order++]);
  return chunkRows(rows, POLL_OPTION_COLUMNS.length, guarded ? 1 : 0).map((chunk) => {
    const values = chunk.flat();
    if (!guarded) {
      return env.DB.prepare(
        `INSERT INTO event_poll_options (${POLL_OPTION_COLUMNS.join(', ')})
         VALUES ${chunk.map(() => `(${POLL_OPTION_COLUMNS.map(() => '?').join(', ')})`).join(', ')}`,
      ).bind(...values);
    }
    return env.DB.prepare(
      conditionalRowsSql('event_poll_options', POLL_OPTION_COLUMNS, chunk.length, 'events', '', extraGuard),
    ).bind(...values, eventId, ...extraBinds);
  });
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
// `mutationToken`, when passed, conditions both the removals and the
// additions on the event carrying that exact token, so a PATCH whose own main
// UPDATE did not apply leaves invite membership untouched.
async function replaceInviteStatements(
  env: Env,
  eventId: string,
  invitees: ResolvedInvitee[],
  mutationToken: string | null = null,
): Promise<D1PreparedStatement[]> {
  const { results: current } = await env.DB.prepare(
    `SELECT user_id FROM event_invites WHERE event_id = ?`,
  )
    .bind(eventId)
    .all<{ user_id: string }>();

  const keep = new Set(invitees.map((i) => i.userId));
  const remove = current.map((r) => r.user_id).filter((id) => !keep.has(id));

  const statements: D1PreparedStatement[] = [];
  for (const chunk of chunkIds(remove, mutationToken === null ? 1 : 3)) {
    if (mutationToken !== null) {
      statements.push(
        env.DB.prepare(
          `DELETE FROM event_invites WHERE event_id = ? AND user_id IN (${placeholders(chunk.length)})
           AND EXISTS (SELECT 1 FROM events WHERE id = ? AND mutation_token = ?)`,
        ).bind(eventId, ...chunk, eventId, mutationToken),
      );
    } else {
      statements.push(
        env.DB.prepare(
          `DELETE FROM event_invites WHERE event_id = ? AND user_id IN (${placeholders(chunk.length)})`,
        ).bind(eventId, ...chunk),
      );
    }
  }
  statements.push(...inviteStatements(env, eventId, invitees, mutationToken !== null, mutationToken));
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
  // `null`: additive-only, and the organizer's row was written at creation.
  // Folding them in here would be harmless (ON CONFLICT DO NOTHING) but would
  // also mean this path silently invites the organizer to an event they might
  // deliberately have been removed from -- so it stays out of it.
  const invitees = await resolveInviteeUserIds(env, guildId, userIds, groupIds, null);
  if (invitees.length === 0) return;
  await env.DB.batch(inviteStatements(env, eventId, invitees, false));
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

  // Friendly, specific-message rejection for the common (non-racing) case --
  // see the guarded INSERT below for the actual atomic enforcement.
  await assertGuildEventQuota(env, guildId, organizerId, isRecurring);

  // Resolved (and validated) before anything is written, so a rejected
  // invite list (F-05: cross-guild targets) never leaves a half-created
  // event behind for the caller to retry into.
  const invitees = await resolveInviteeUserIds(
    env,
    guildId,
    input.invites?.userIds ?? [],
    input.invites?.groupIds ?? [],
    organizerId,
  );

  // Everything below is one D1 batch -- a failure partway through (a full
  // event with no recurrence rule, or no invites) is exactly the partial-
  // object problem F-08 flagged; batch() commits all-or-nothing.
  //
  // The main INSERT is itself guarded (INSERT ... SELECT ... WHERE <quota
  // check>) so the check-then-write gap between assertGuildEventQuota above
  // and this statement can't be raced by a concurrent create: if a concurrent
  // request already filled the last slot, this INSERT affects zero rows
  // instead of erroring.
  //
  // Every child statement below is then guarded on the parent actually
  // existing. That is not belt-and-braces -- it's load-bearing. D1 enforces
  // foreign keys by default, so an unconditional child INSERT after a
  // guard-tripped parent would fail the whole batch with a constraint error,
  // which rolls back correctly but surfaces as an opaque 500 rather than the
  // "you've hit the limit" the caller needs. Making the children conditional
  // instead means the losing batch commits cleanly as a no-op, and the
  // changes-count check after it is what turns that into a real message.
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      `INSERT INTO events (id, guild_id, organizer_id, title, description, game, event_type, timezone,
         start_at, end_at, status, poll_strategy, poll_threshold_count, poll_deadline_at,
         poll_mode, poll_resolution_mode, window_start_at, window_end_at, window_block_minutes,
         is_recurring, voice_channel_id, voice_channel_name, created_at, updated_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
       WHERE ${eventQuotaGuardSql(isRecurring)}`,
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
      ...eventQuotaGuardParams(guildId, organizerId, isRecurring),
    ),
  ];

  if (isRecurring && input.recurrence) {
    const r = input.recurrence;
    statements.push(
      env.DB.prepare(
        `INSERT INTO event_recurrence_rules
           (event_id, freq, interval, by_weekday, by_month_day, start_date, start_time,
            duration_minutes, end_type, end_date, end_count)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
         WHERE EXISTS (SELECT 1 FROM events WHERE id = ?)`,
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
        eventId,
      ),
    );
  }

  if (input.eventType === 'poll' && pollMode === 'options' && input.pollOptions) {
    statements.push(...pollOptionStatements(env, eventId, input.pollOptions, true));
  }

  statements.push(...inviteStatements(env, eventId, invitees, true));

  const results = await env.DB.batch(statements);

  // Guard tripped: a concurrent request used the last slot between
  // assertGuildEventQuota's check above and this batch. Because every child
  // statement is conditioned on the parent existing, nothing at all was
  // written -- there is no partial event to clean up, only a message to
  // return.
  if (results[0].meta.changes === 0) {
    throw new ValidationError('This server just hit its event limit -- please try again');
  }

  return eventId;
}

// `stored` is the event row the caller loaded and authorized against. It is
// passed whole rather than as a `wasRecurring` boolean for two reasons: its
// `revision` is the optimistic-concurrency token every statement below is
// conditioned on, and merging the delta onto it is what lets the resulting
// event be validated as a complete object rather than as a bag of
// individually-valid fields.
export async function updateEvent(
  env: Env,
  eventId: string,
  guildId: string,
  input: Partial<EventWriteInput>,
  stored: EventRow,
): Promise<void> {
  validateEventWriteInput(input);
  assertCoherentMergedEvent(stored, input);
  const now = Date.now();
  const wasRecurring = !!stored.is_recurring;

  // The caller's revision, and the one this request's own writes will produce.
  //
  // Every statement in the batch below is conditioned on `mutationToken`,
  // which only exists on the row if *this* request's main UPDATE matched
  // `revision = storedRevision` and stamped it. That is the difference from
  // the previous state-based guard: `is_recurring = 1` is a condition any
  // concurrent request can satisfy on your behalf, so a stale loser's
  // siblings rode in on the winner's success.
  //
  // F-08-B: this used to be unconditionally `stored.revision`, and `stored`
  // was always read by the route immediately before calling updateEvent --
  // so the guard compared a fresh read to itself and could never observe a
  // client working from stale data. The route still has to load `stored`
  // fresh (it's how PATCH authorizes the request and gets guild_id), but the
  // number that actually has to match is the one the *client* saw when it
  // fetched the event to build this edit, not the one the server just
  // re-read a moment ago. When the caller supplies it, that's what's used;
  // callers with no client round trip to report (an internal caller passing
  // its own freshly-read `stored`) fall back to the old behaviour.
  const storedRevision = input.revision !== undefined ? input.revision : (stored.revision ?? 0);
  // Drawn fresh for this request. `revision + 1` would not do: it is derived
  // from what the caller read, so two requests working from the same stale
  // read compute the same value, and the loser's siblings would match the row
  // the winner just wrote.
  const mutationToken = newId();

  // createEventWithInvites checks this at write time; PATCH previously never
  // did, so an existing non-recurring event could be converted to recurring
  // after the guild was already at its recurring-event cap -- every visible
  // calendar and cron sweep would then carry one more expansion than the
  // limit was meant to allow. Only relevant for an actual false->true
  // transition; editing an already-recurring event's schedule doesn't add a
  // new recurring row, so it isn't re-checked against the cap.
  // Claimed up front, as its own atomic statement, rather than as a guard on
  // the main UPDATE inside the batch. The guarded-inside-the-batch version
  // was wrong in a way that matters: the batch's *other* statements -- new
  // invitees, replaced poll options, window availability -- were not
  // conditioned on the guard, so losing the race committed all of those and
  // then reported failure. An edit that says it failed must not have changed
  // anything.
  //
  // The claim itself is taken further down, immediately before the batch --
  // see the comment there. Everything between here and that point must be
  // free to throw without having changed anything.
  const convertingToRecurring = input.isRecurring === true && !wasRecurring;

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
  //
  // The schedule shape itself was already validated by
  // assertCoherentMergedEvent above, against the stored event rather than the
  // delta alone.
  if (input.isRecurring !== undefined) {
    setClauses.push('is_recurring = ?', 'start_at = ?', 'end_at = ?');
    if (input.isRecurring) {
      values.push(1, null, null);
    } else {
      values.push(0, input.startAt ?? null, input.endAt ?? null);
    }
  }

  values.push(eventId);

  // The recurring-slot admission check, folded directly into the main
  // UPDATE's WHERE clause rather than claimed as an earlier, separately
  // committed statement. A standalone claim statement can succeed and then
  // never reach the batch below -- a thrown validation error, a Discord
  // lookup that times out, a D1 read failure -- leaving the event marked
  // recurring with its old one-off schedule, no recurrence rule, none of the
  // requested edit applied, and a quota slot spent by a request that
  // reported failure. Worse, if the Worker is terminated in that exact gap,
  // no catch block ever runs to hand the slot back.
  //
  // Guarding the UPDATE itself removes the gap entirely: the claim and the
  // edit are the same statement, inside the same D1 batch (one transaction)
  // as everything else the PATCH touches. `results[0].meta.changes === 0`
  // after the batch is how a failed claim is detected -- and because it's
  // inside the transaction, nothing else in the batch needs a separate
  // rollback path either.
  const quotaGuardSql = convertingToRecurring
    ? ` AND is_recurring = 0
        AND (SELECT COUNT(*) FROM events WHERE guild_id = ? AND status != 'cancelled' AND is_recurring = 1) < ?`
    : '';
  const quotaGuardParams = convertingToRecurring ? [guildId, LIMITS.MAX_RECURRING_EVENTS_PER_GUILD] : [];

  // Invitee resolution (and possible rejection -- F-05) happens before any
  // statement is queued, same reasoning as createEventWithInvites: a request
  // that's going to fail validation shouldn't partially apply first.
  // The organizer goes back in on every edit, because replaceInviteStatements
  // removes anyone absent from this list -- without them here, saving the edit
  // form would delete the organizer's own row and put the 403 straight back.
  const invitees = input.invites
    ? await resolveInviteeUserIds(
        env,
        guildId,
        input.invites.userIds,
        input.invites.groupIds,
        stored.organizer_id,
      )
    : null;

  // Every conditional block below queues its statements instead of running
  // them immediately; one env.DB.batch() at the end makes the whole PATCH
  // atomic -- a single request editing both, say, the schedule and the poll
  // options can't leave the poll options replaced but the schedule untouched.
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      `UPDATE events SET ${setClauses.join(', ')}, revision = revision + 1, mutation_token = ?
       WHERE id = ? AND revision = ?${quotaGuardSql}`,
    ).bind(...values.slice(0, -1), mutationToken, values[values.length - 1], storedRevision, ...quotaGuardParams),
  ];

  // Every sibling statement below is conditioned on this request's own main
  // UPDATE having applied, by requiring the revision that UPDATE produces.
  //
  // Two passes got this wrong in different ways. First the siblings carried
  // no guard at all, so a conversion that lost the quota race replaced poll
  // options and rewrote poll fields before reporting failure -- batch() rolls
  // back on *error*, and a statement matching zero rows is not an error. Then
  // they were guarded on `is_recurring = 1`, which fixed the sequential case
  // but not the concurrent one: that condition is equally true when a
  // *different* request just converted the event, so a stale loser's siblings
  // still ran, on the back of the winner's success.
  //
  // `mutation_token = ?` cannot be satisfied by anyone else: the value is
  // generated per request and only this request's own main UPDATE writes it.
  // A derived token would not be enough -- see migration 0013 for why
  // `revision + 1` fails exactly this test.
  const siblingGuard = ` AND EXISTS (SELECT 1 FROM events WHERE id = ? AND mutation_token = ?)`;
  const guardBinds = [eventId, mutationToken];
  const guardedStatement = (sql: string, ...binds: unknown[]): D1PreparedStatement =>
    env.DB.prepare(`${sql}${siblingGuard}`).bind(...binds, ...guardBinds);

  if (input.isRecurring !== undefined) {
    statements.push(guardedStatement(`DELETE FROM event_recurrence_rules WHERE event_id = ?`, eventId));
    if (input.isRecurring && input.recurrence) {
      const r = input.recurrence;
      statements.push(
        env.DB.prepare(
          `INSERT INTO event_recurrence_rules
             (event_id, freq, interval, by_weekday, by_month_day, start_date, start_time,
              duration_minutes, end_type, end_date, end_count)
           SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
           -- Same request-specific guard as every other sibling: the rule is
           -- attached only if this request's own main UPDATE applied, which
           -- also means the row really is a series now.
           WHERE EXISTS (SELECT 1 FROM events WHERE id = ? AND mutation_token = ?)`,
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
          eventId,
          mutationToken,
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
      guardedStatement(
        `DELETE FROM event_poll_votes WHERE option_id IN (SELECT id FROM event_poll_options WHERE event_id = ?)`,
        eventId,
      ),
      guardedStatement(`DELETE FROM event_poll_options WHERE event_id = ?`, eventId),
    );
    statements.push(...pollOptionStatements(env, eventId, input.pollOptions, true, mutationToken));
    statements.push(
      guardedStatement(
        `UPDATE events SET poll_strategy = ?, poll_threshold_count = ?, poll_deadline_at = ?,
           poll_mode = ?, poll_resolution_mode = ?, window_start_at = NULL, window_end_at = NULL,
           window_block_minutes = NULL
         WHERE id = ?`,
        // F-08-A: a PATCH carrying only `pollOptions` (e.g. re-ordering the
        // candidate slots) still reaches this UPDATE, since replacing the
        // options is what triggers it. `?? null` on the other three fields
        // meant "the caller didn't send a strategy" was indistinguishable
        // from "the caller wants to clear it" -- every options-only edit
        // silently wiped poll_strategy, poll_threshold_count and
        // poll_deadline_at back to null. Falling back to what's already
        // stored preserves them unless the request actually included a
        // replacement value.
        input.pollStrategy !== undefined ? input.pollStrategy : stored.poll_strategy,
        input.pollThresholdCount !== undefined ? input.pollThresholdCount : stored.poll_threshold_count,
        input.pollDeadlineAt !== undefined ? input.pollDeadlineAt : stored.poll_deadline_at,
        pollMode,
        pollResolutionMode,
        eventId,
      ),
    );
  }

  if (input.windowStartAt !== undefined) {
    statements.push(
      guardedStatement(`DELETE FROM event_window_availability WHERE event_id = ?`, eventId),
      guardedStatement(
        `UPDATE events SET poll_strategy = ?, poll_threshold_count = ?, poll_deadline_at = ?,
           poll_mode = 'window', poll_resolution_mode = 'single_winner',
           window_start_at = ?, window_end_at = ?, window_block_minutes = ?
         WHERE id = ?`,
        // Same preservation as the pollOptions branch above (F-08-A): a
        // window-only edit must not clear the strategy/threshold/deadline
        // fields it didn't mention.
        input.pollStrategy !== undefined ? input.pollStrategy : stored.poll_strategy,
        input.pollThresholdCount !== undefined ? input.pollThresholdCount : stored.poll_threshold_count,
        input.pollDeadlineAt !== undefined ? input.pollDeadlineAt : stored.poll_deadline_at,
        input.windowStartAt,
        input.windowEndAt ?? null,
        input.windowBlockMinutes ?? null,
        eventId,
      ),
    );
  }

  if (invitees) {
    statements.push(...(await replaceInviteStatements(env, eventId, invitees, mutationToken)));
  }

  // One batch, one transaction: both admission checks -- the caller's
  // revision and, on a conversion, the guild's recurring quota -- live in the
  // main UPDATE's WHERE clause, so there is no window between "claimed" and
  // "applied" for a thrown error or a killed Worker to land in.
  //
  // Every other statement in the batch requires this request's own
  // `mutation_token`, which only its main UPDATE writes. So if the main
  // UPDATE matched nothing, every sibling matches nothing too and the failed
  // request changes nothing observable. That is enforced statement by
  // statement -- via `guardedStatement`, `pollOptionStatements` and
  // `replaceInviteStatements` -- and is *not* a property of batch() itself:
  // batch() rolls back on an error, and a statement that legitimately matches
  // zero rows is not an error. Two earlier versions of this code got that
  // wrong in different ways (unguarded siblings, then siblings guarded on
  // state a concurrent request could establish). If a new sibling statement
  // is added above, it needs the same guard.
  const results = await env.DB.batch(statements);
  if (results[0].meta.changes > 0) return;

  // Nothing applied. Two different reasons, and they mean different things to
  // the caller, so read the row once -- only on this failure path -- to say
  // which. If the event is still at the revision we read, our own admission
  // was the only thing that could have failed, which on a conversion means
  // the quota; otherwise someone else has edited the event since.
  const current = await env.DB.prepare(`SELECT revision, is_recurring FROM events WHERE id = ?`)
    .bind(eventId)
    .first<{ revision: number; is_recurring: number }>();

  if (current && (current.revision ?? 0) !== storedRevision) throw new ConflictError();
  if (convertingToRecurring) {
    throw new ValidationError('This server has reached its limit of recurring events');
  }
  // The row is gone, or something else about it no longer matches. Either
  // way the caller's copy is stale.
  throw new ConflictError();
}
