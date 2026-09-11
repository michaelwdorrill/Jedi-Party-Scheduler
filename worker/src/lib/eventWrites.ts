import { DateTime } from 'luxon';
import type { Env } from '../env';
import { chunkIds, chunkRows, conditionalRowsSql, placeholders } from './d1';
import { filterActiveGuildMembers } from './db';
import type { EventRow } from './events';
import { commonServerSet } from './groups';
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

  // specs/0007's decision 1: an event on a server appears on that server's
  // noticeboard unless the organiser marks it private. Absent means visible,
  // which is the schema default for new rows -- and deliberately NOT what
  // existing rows got, since migration 0038 backfilled every one of them to
  // private rather than changing their visibility retroactively.
  isPrivate?: boolean;

  // specs/0014 stage 3, decision 4. Optional; `null`/absent means no
  // minimum. Only settable on a non-recurring, non-poll event -- see
  // assertCoherentMergedEvent and assertCompleteEventShape for why the
  // other shapes are rejected outright rather than silently ignored.
  minimumAttendees?: number | null;
  autoCancelBelowMinimum?: boolean;
  // IDEAS item 54. Exactly one applies, decided by isRecurring: a
  // non-recurring event may set deadlineAt (an absolute point -- optional,
  // its absence keeps the original v0.6.2 real-time reactive cascade); a
  // recurring event must set deadlineHoursBefore (evaluated fresh per
  // occurrence, since there is no single date to anchor an absolute one to).
  minimumAttendeesDeadlineAt?: number | null;
  minimumAttendeesDeadlineHoursBefore?: number | null;

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
  // Legacy request shape only -- normalizeWindowInput turns these into a
  // single candidate before anything else sees them.
  windowStartAt?: number;
  windowEndAt?: number;
  // The minimum session length, and the only thing that decides whether this
  // poll's candidates are fixed slots or windows. `null` is meaningful and
  // distinct from absent: it turns a windowed poll back into a fixed-slot
  // one, where absent leaves whatever is stored alone.
  windowBlockMinutes?: number | null;

  // The revision the client actually read before building this edit
  // (F-08-B). Optional for backward compatibility with callers that don't
  // have one to offer -- when omitted, updateEvent falls back to `stored`'s
  // revision, which is the pre-fix behaviour: correct for a single caller
  // building its own `stored` read, but not a substitute for a real client
  // round trip. See updateEvent for how this is used.
  revision?: number;
}

// Every poll is now an options poll (IDEAS 40, specs/0013). What used to be
// a second mode is a poll with exactly one candidate and a minimum session
// length, so `poll_mode` has one value from here on and multi_winner is no
// longer excluded by it: a windowed candidate resolves independently to its
// own best span, which is precisely what multi-winner means.
//
// The column is still written -- dropping a column the deployed Worker reads
// is the two-release change deploy-worker.yml's ordering comment warns about
// -- but nothing reads it any more. `window_block_minutes IS NULL` is what
// decides a poll's shape.
function normalizePollModes(input: { pollResolutionMode?: 'single_winner' | 'multi_winner' }) {
  return { pollMode: 'options' as const, pollResolutionMode: input.pollResolutionMode ?? 'single_winner' };
}

// The legacy `pollMode: 'window'` request shape, expressed in the new one.
//
// A window poll was "one span plus a block length". That is a one-candidate
// windowed poll, exactly, so it is translated at the boundary and no code
// past this point has to know the old shape existed. Callers that already
// send candidates plus a minimum pass through untouched.
//
// This is what keeps the change additive across the deploy gap: the Worker
// ships before Pages does, so for a few minutes the previous frontend is
// still creating polls the old way.
export function normalizeWindowInput<T extends Partial<EventWriteInput>>(input: T): T {
  if (input.pollMode !== 'window') return input;
  if (input.pollOptions && input.pollOptions.length > 0) {
    return { ...input, pollMode: 'options' };
  }
  if (input.windowStartAt == null || input.windowEndAt == null) {
    // Incomplete: leave it alone so validation can produce its own message
    // rather than turning it into a mysteriously empty poll here.
    return input;
  }
  return {
    ...input,
    pollMode: 'options',
    pollOptions: [{ startAt: input.windowStartAt, endAt: input.windowEndAt }],
    windowStartAt: undefined,
    windowEndAt: undefined,
  };
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
  // Who is actually asking. Distinct from `organizerId`, which is null on the
  // additive path and is about whose row gets folded into the result -- this
  // one is about authority, and every caller has it (each route has already
  // proven the caller owns the event). Pass-11 review, F-25 / R08.
  actorId: string,
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
    // Pass-11 review (F-25 / R08): a group id is a capability to read that
    // group's roster, so it has to be checked against the person holding it.
    // Rosters are private everywhere else -- GET /groups/:id requires
    // membership, and the per-guild listing was removed in v0.4.3 for exactly
    // this reason -- but this resolver expanded any id it was handed. The ids
    // are not secret either: `sourceGroupId` on GET /events/:id discloses one
    // to every invitee of any event built from that group. So someone removed
    // from a group could keep reading its roster by creating an event from
    // it, and everyone still in it got an invite DM from a stranger.
    //
    // MAX_GROUP_IDS is 10, so one statement covers it with no chunking.
    const { results: ownGroups } = await env.DB.prepare(
      `SELECT group_id FROM group_members WHERE user_id = ? AND group_id IN (${placeholders(groupIds.length)})`,
    )
      .bind(actorId, ...groupIds)
      .all<{ group_id: string }>();
    const allowed = new Set(ownGroups.map((r) => r.group_id));
    if (groupIds.some((id) => !allowed.has(id))) {
      // Deliberately does not name which id was refused: that would confirm
      // the existence of a group to someone probing for one.
      throw new ValidationError('You can only invite through groups you belong to');
    }

    // One roster query per chunk of groups, not one per group. specs/0011 /
    // IDEAS item 36: a group no longer belongs to one guild, so there is no
    // `g.guild_id = ?` left to filter on here -- every member of a selected
    // group is a candidate, and the guild-membership filter below (checking
    // against *this event's* guild specifically) is what narrows that down,
    // same as it already did for a member who'd simply left the venue guild
    // before this release.
    const rosters: { user_id: string; group_id: string }[] = [];
    for (const chunk of chunkIds(groupIds, 1)) {
      const { results } = await env.DB.prepare(
        `SELECT gm.user_id, gm.group_id FROM group_members gm
         WHERE gm.group_id IN (${placeholders(chunk.length)})`,
      )
        .bind(...chunk)
        .all<{ user_id: string; group_id: string }>();
      rosters.push(...results);
    }

    // A group whose own intersection has gone empty (some member shares no
    // server at all with the rest, per specs/0011) cannot be used to create
    // a new event -- decided (Michael, Sept 2026): this is a hard error at
    // creation time, not a silent drop the way a member missing from *this
    // event's specific* guild is (handled below, unchanged). Checked per
    // group, not over the whole resolved roster, so the error names the
    // group actually at fault.
    const rostersByGroup = new Map<string, string[]>();
    for (const row of rosters) {
      if (!rostersByGroup.has(row.group_id)) rostersByGroup.set(row.group_id, []);
      rostersByGroup.get(row.group_id)!.push(row.user_id);
    }
    const { results: groupNames } = await env.DB.prepare(
      `SELECT id, name FROM groups WHERE id IN (${placeholders(groupIds.length)})`,
    )
      .bind(...groupIds)
      .all<{ id: string; name: string }>();
    const nameById = new Map(groupNames.map((g) => [g.id, g.name]));
    for (const [groupId, memberIds] of rostersByGroup) {
      if ((await commonServerSet(env, memberIds)).length === 0) {
        throw new ValidationError(
          `The group "${nameById.get(groupId) ?? groupId}" no longer shares a server across all its members, ` +
            'so it can\'t be used to invite anyone to a new event until that\'s fixed.',
        );
      }
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

// Exported for specs/0014 stage 3's fan-out (cron/reminders.ts), the one
// caller outside this file that needs to build invite rows for an event it
// didn't create through the normal HTTP path -- a confirmed multi-winner
// day's invite list is copied from its parent poll, not resolved from a
// request body, so it constructs this shape directly rather than going
// through resolveInviteeUserIds.
export type ResolvedInvitee = {
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
  // specs/0007. Checked at runtime like every other client-supplied field:
  // TypeScript's generic on readJsonBody is a compile-time annotation only, and
  // a truthy string here would silently flip an event's visibility.
  if (input.isPrivate !== undefined) assertBoolean(input.isPrivate, 'isPrivate');
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

  // specs/0014 stage 3: same reasoning as pollThresholdCount just above --
  // below 1 is meaningless (an event can't fall below "nobody"), and above
  // the invitee ceiling can never be reached. Whether this is even settable
  // on the event's own shape (non-recurring, non-poll) is a separate,
  // merged-shape question -- assertCompleteEventShape (create) and
  // assertCoherentMergedEvent (patch) answer it, since only they know the
  // full picture a partial PATCH delta alone does not.
  if (input.minimumAttendees != null) {
    const minimum = assertSafeInt(input.minimumAttendees, 'minimumAttendees');
    if (minimum < 1 || minimum > LIMITS.MAX_RESOLVED_INVITEES) {
      throw new ValidationError('minimumAttendees out of range');
    }
  }
  if (input.autoCancelBelowMinimum !== undefined) {
    assertBoolean(input.autoCancelBelowMinimum, 'autoCancelBelowMinimum');
  }
  if (input.minimumAttendeesDeadlineAt != null) {
    const deadline = assertSafeInt(input.minimumAttendeesDeadlineAt, 'minimumAttendeesDeadlineAt');
    if (deadline <= 0) throw new ValidationError('minimumAttendeesDeadlineAt must be a positive timestamp');
  }
  if (input.minimumAttendeesDeadlineHoursBefore != null) {
    const hours = assertSafeInt(input.minimumAttendeesDeadlineHoursBefore, 'minimumAttendeesDeadlineHoursBefore');
    if (hours < 1 || hours > 24 * 365) throw new ValidationError('minimumAttendeesDeadlineHoursBefore out of range');
  }

  // `windowBlockMinutes` is no longer part of a separate mode -- it is the
  // one field that decides whether a poll's candidates are fixed slots or
  // windows -- so it is validated on its own rather than behind
  // `windowStartAt`. `null` is the deliberate "these are fixed slots after
  // all" and has to stay expressible.
  if (input.windowBlockMinutes != null) {
    assertSafeInt(input.windowBlockMinutes, 'windowBlockMinutes');
    if (
      input.windowBlockMinutes < LIMITS.MIN_WINDOW_BLOCK_MINUTES ||
      input.windowBlockMinutes > LIMITS.MAX_WINDOW_BLOCK_MINUTES
    ) {
      throw new ValidationError('windowBlockMinutes out of range');
    }
  }

  if (input.pollOptions) {
    if (input.pollOptions.length > LIMITS.MAX_POLL_OPTIONS) {
      throw new ValidationError(`pollOptions must have ${LIMITS.MAX_POLL_OPTIONS} items or fewer`);
    }
    // A fixed candidate *is* the session, so it is bounded like one. A window
    // is a range to find a session inside, so it gets the far more generous
    // window ceiling -- "any evening over the next fortnight" is a reasonable
    // thing to ask and is not a two-week game.
    const windowed = input.windowBlockMinutes != null;
    const maxSpan = windowed ? LIMITS.MAX_WINDOW_SPAN_MS : LIMITS.MAX_EVENT_DURATION_MS;
    const minSpan = windowed ? input.windowBlockMinutes! * 60 * 1000 : 0;
    for (const opt of input.pollOptions) {
      assertSafeInt(opt.startAt, 'pollOptions[].startAt');
      assertSafeInt(opt.endAt, 'pollOptions[].endAt');
      assertTimeRange(opt.startAt, opt.endAt, 'pollOptions[]', maxSpan);
      // A window shorter than the minimum can never resolve -- there is no
      // span inside it long enough to clear the bar -- so it is rejected at
      // write time rather than becoming a candidate nobody can ever win.
      if (opt.endAt - opt.startAt < minSpan) {
        throw new ValidationError('every window must be at least as long as the minimum session length');
      }
    }
  }

  // Only reachable from the legacy request shape (see normalizeWindowInput),
  // which converts a complete one into candidates before this runs.
  if (input.windowStartAt !== undefined) {
    assertSafeInt(input.windowStartAt, 'windowStartAt');
    assertSafeInt(input.windowEndAt, 'windowEndAt');
    assertTimeRange(input.windowStartAt, input.windowEndAt!, 'window', LIMITS.MAX_WINDOW_SPAN_MS);
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

// IDEAS item 54: exactly which of the two deadline fields applies is decided
// by whether the merged event is recurring, the same way minimumAttendees
// itself already went from "forbidden on a recurring event" to "requires a
// deadline shaped for one". Shared between the create path
// (assertCompleteEventShape) and the PATCH path (assertCoherentMergedEvent)
// so the two can't drift into accepting different shapes for the same data.
function assertMinimumAttendeesDeadlineShape(
  minimumAttendees: number | null | undefined,
  deadlineAt: number | null | undefined,
  deadlineHoursBefore: number | null | undefined,
  isRecurring: boolean,
): void {
  if (minimumAttendees == null) {
    if (deadlineAt != null || deadlineHoursBefore != null) {
      throw new ValidationError('a minimum-attendees deadline requires minimumAttendees to be set');
    }
    return;
  }
  if (isRecurring) {
    if (deadlineHoursBefore == null) {
      throw new ValidationError('a recurring event with minimumAttendees requires minimumAttendeesDeadlineHoursBefore');
    }
    if (deadlineAt != null) {
      throw new ValidationError('minimumAttendeesDeadlineAt cannot be set on a recurring event');
    }
  } else if (deadlineHoursBefore != null) {
    throw new ValidationError('minimumAttendeesDeadlineHoursBefore can only be set on a recurring event');
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

  // specs/0014 stage 3 / IDEAS item 54: the merged event's shape, not just
  // this delta -- `{minimumAttendees: 3}` alone is a valid delta on an event
  // a PATCH elsewhere in the same request just made recurring, or on a
  // poll, and a poll still has no occurrence for the cascade to act on (a
  // poll resolves to a slot, not a session with its own attendance yet).
  // Recurring is no longer rejected outright -- see
  // assertMinimumAttendeesDeadlineShape for what it requires instead.
  if (input.minimumAttendees != null && isPoll) {
    throw new ValidationError('minimumAttendees can only be set on a non-poll event');
  }
  if (input.minimumAttendees !== undefined || input.minimumAttendeesDeadlineAt !== undefined || input.minimumAttendeesDeadlineHoursBefore !== undefined) {
    const mergedIsRecurring = input.isRecurring !== undefined ? input.isRecurring : !!stored.is_recurring;
    const mergedMinimum = input.minimumAttendees !== undefined ? input.minimumAttendees : stored.minimum_attendees;
    const mergedDeadlineAt =
      input.minimumAttendeesDeadlineAt !== undefined ? input.minimumAttendeesDeadlineAt : stored.minimum_attendees_deadline_at;
    const mergedDeadlineHoursBefore =
      input.minimumAttendeesDeadlineHoursBefore !== undefined
        ? input.minimumAttendeesDeadlineHoursBefore
        : stored.minimum_attendees_deadline_hours_before;
    assertMinimumAttendeesDeadlineShape(mergedMinimum, mergedDeadlineAt, mergedDeadlineHoursBefore, mergedIsRecurring);
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

// Found in 0.8.1 sandbox verification: the form lets "Confirm once N people
// say yes" be typed freely, with nothing stopping N from exceeding the
// number of people actually invited. A threshold that high can never be
// reached -- the poll can only ever hit its deadline -- and the range check
// in validateEventWriteInput doesn't catch it, because it only bounds N
// against the app-wide MAX_RESOLVED_INVITEES ceiling, not against *this
// event's* invite list, which validateEventWriteInput has no DB access to
// read. So this runs later, once the invitee count is actually known --
// after resolveInviteeUserIds on create, and after either that or a stored-
// count read on update (see updateEvent below).
//
// inviteeCount includes the organizer, who resolveInviteeUserIds always folds
// in: they are one of the people whose "yes" the threshold is counting.
function assertThresholdReachable(
  pollStrategy: string | null | undefined,
  pollThresholdCount: number | null | undefined,
  inviteeCount: number,
): void {
  if (pollStrategy !== 'threshold' || pollThresholdCount == null) return;
  if (pollThresholdCount > inviteeCount) {
    throw new ValidationError(
      `pollThresholdCount (${pollThresholdCount}) cannot exceed the number of people invited (${inviteeCount})`,
    );
  }
}

function assertCompleteEventShape(input: Partial<EventWriteInput>): void {
  assertString(input.title, 'title', LIMITS.TITLE);
  assertTimezone(input.timezone, 'timezone');
  const eventType = assertOneOf(input.eventType, 'eventType', ['single', 'poll'] as const);

  if (eventType === 'single') {
    assertCompleteScheduleShape(input);
    // specs/0014 stage 3 / IDEAS item 54: mirrors assertCoherentMergedEvent's
    // PATCH-side check, for the create path -- see that check's comment and
    // assertMinimumAttendeesDeadlineShape for what a recurring event with a
    // minimum now requires instead of being rejected outright.
    assertMinimumAttendeesDeadlineShape(
      input.minimumAttendees,
      input.minimumAttendeesDeadlineAt,
      input.minimumAttendeesDeadlineHoursBefore,
      !!input.isRecurring,
    );
    return;
  }

  if (input.minimumAttendees != null) {
    throw new ValidationError('minimumAttendees can only be set on a non-poll event');
  }
  if (input.pollDeadlineAt == null) throw new ValidationError('pollDeadlineAt is required for a poll');
  // One rule for both shapes, because there is only one shape: a poll is its
  // candidates. A windowed poll is candidates that happen to be windows.
  if (!input.pollOptions || input.pollOptions.length === 0) {
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
//
// rsvp_status is vestigial as of specs/0014: nothing reads it any more (real
// attendance lives in event_attendance, keyed per occurrence), but the
// column is still NOT NULL, so a value still has to be written here to
// satisfy it -- and stays exactly as it always did (organizer 'accepted',
// everyone else 'pending') until a later release drops the column outright.
// ON CONFLICT DO NOTHING no longer preserves anything that matters on
// re-invite; it just avoids clobbering the row's id/invited_at.
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
export function inviteStatements(
  env: Env,
  eventId: string,
  invitees: ResolvedInvitee[],
  guarded: boolean,
  mutationToken: string | null = null,
  // R21: when set, each statement refuses to write if the event's invite
  // count has already reached this total. Evaluated at execution time inside
  // the batch, so rows written by an earlier chunk of the same batch count --
  // and so does a concurrent request that got there first, which is the part
  // a preflight count cannot cover. Only the additive path passes it; a full
  // replace is bounded by the resolved set it submits.
  totalCap: number | null = null,
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
      if (totalCap !== null) {
        const arms = chunk
          .map((_, i) =>
            i === 0
              ? `SELECT ${INVITE_COLUMNS.map((c) => `? AS ${c}`).join(', ')}`
              : `SELECT ${INVITE_COLUMNS.map(() => '?').join(', ')}`,
          )
          .join(' UNION ALL ');
        // Pass-12 review (P12-12). The WHERE alone is a threshold, not a
        // reservation: SQLite evaluates it once for the whole statement, so a
        // count one below the cap admitted the ENTIRE chunk. Two concurrent
        // additions to a 23-invitee event, one adding a person and the other
        // adding two, both passed their preflight and both passed this guard,
        // and the event ended with 26 against a cap of 25.
        //
        // The LIMIT is the reservation: at most the remaining capacity is
        // taken, whatever the chunk holds. MAX(0, ...) because a negative
        // LIMIT means "no limit" in SQLite, which would turn an over-capacity
        // event into an unbounded insert -- the exact opposite of the guard.
        //
        // The WHERE stays. It is redundant against the LIMIT for correctness,
        // but an INSERT ... SELECT followed directly by ON CONFLICT is
        // ambiguous to SQLite's parser unless a WHERE separates them.
        return env.DB.prepare(
          `INSERT INTO event_invites (${INVITE_COLUMNS.join(', ')})
           SELECT * FROM (${arms})
           WHERE (SELECT COUNT(*) FROM event_invites WHERE event_id = ?) < ?
           LIMIT MAX(0, ? - (SELECT COUNT(*) FROM event_invites WHERE event_id = ?))
           ${conflict}`,
        ).bind(...values, eventId, totalCap, totalCap, eventId);
      }
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
// `displayOrder` is explicit only for the reconciling edit path, which inserts
// a subset of the desired candidates and so cannot derive each one's position
// from its position in the array it was given. Omitting it keeps the original
// behaviour -- position in the array is the display order.
function pollOptionStatements(
  env: Env,
  eventId: string,
  options: readonly { startAt: number; endAt: number; displayOrder?: number }[],
  guarded: boolean,
  mutationToken: string | null = null,
): D1PreparedStatement[] {
  const extraGuard = mutationToken === null ? '' : ' AND mutation_token = ?';
  const extraBinds = mutationToken === null ? [] : [mutationToken];
  const rows = options.map((opt, index) => [
    newId(),
    eventId,
    opt.startAt,
    opt.endAt,
    opt.displayOrder ?? index,
  ]);
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
// alongside whatever got added.
//
// Their event_attendance rows (every occurrence, specs/0014) are removed in
// the same pass. Under the old model this was automatic -- rsvp_status lived
// on the invite row itself, so deleting it deleted the answer too.
// event_attendance is a separate table with no FK back to event_invites (it
// only cascades from events), so revoking access has to say so explicitly or
// a removed invitee's stale accepted row would keep counting them as
// confirmed for a voice-channel invite they can no longer even see.
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
      statements.push(
        env.DB.prepare(
          `DELETE FROM event_attendance WHERE event_id = ? AND user_id IN (${placeholders(chunk.length)})
           AND EXISTS (SELECT 1 FROM events WHERE id = ? AND mutation_token = ?)`,
        ).bind(eventId, ...chunk, eventId, mutationToken),
      );
    } else {
      statements.push(
        env.DB.prepare(
          `DELETE FROM event_invites WHERE event_id = ? AND user_id IN (${placeholders(chunk.length)})`,
        ).bind(eventId, ...chunk),
      );
      statements.push(
        env.DB.prepare(
          `DELETE FROM event_attendance WHERE event_id = ? AND user_id IN (${placeholders(chunk.length)})`,
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
  // The event's organizer, which every caller has already established is the
  // person asking (F-25 / R08). Needed even though the organizer's own invite
  // row is not written here -- the group ids still have to be checked against
  // somebody, and this path was previously the one with no actor at all.
  actorId: string,
): Promise<{ notAdded: string[] }> {
  assertStringArray(userIds, 'userIds', LIMITS.MAX_INVITEES, 64);
  assertStringArray(groupIds, 'groupIds', LIMITS.MAX_GROUP_IDS, 64);
  // `null`: additive-only, and the organizer's row was written at creation.
  // Folding them in here would be harmless (ON CONFLICT DO NOTHING) but would
  // also mean this path silently invites the organizer to an event they might
  // deliberately have been removed from -- so it stays out of it.
  const invitees = await resolveInviteeUserIds(env, guildId, userIds, groupIds, null, actorId);
  if (invitees.length === 0) return { notAdded: [] };

  // Pass-11 review (R21). resolveInviteeUserIds caps the set *this request*
  // resolves, and nothing anywhere checked the existing-plus-new union -- so
  // repeated calls to this endpoint walked an event past
  // MAX_RESOLVED_INVITEES without ever tripping a limit. The cap is not
  // decoration: every downstream query that fans out over an invite list
  // (event detail, the noticeboard, vote tallies, DM fan-out) is sized on the
  // assumption that it holds, and lib/changeRequests.ts already had to write
  // its own preflight count because this function had none.
  //
  // Two layers, deliberately. The read-then-check gives a refusal the
  // organizer can act on; the guard inside each INSERT is what actually holds
  // under two concurrent additions, where both preflights can pass. Neither
  // alone is enough -- a preflight is racy, and a bare guard would refuse with
  // no explanation.
  const { results: existing } = await env.DB.prepare(
    `SELECT user_id FROM event_invites WHERE event_id = ?`,
  )
    .bind(eventId)
    .all<{ user_id: string }>();
  const alreadyInvited = new Set(existing.map((r) => r.user_id));
  const union = new Set(alreadyInvited);
  for (const invitee of invitees) union.add(invitee.userId);
  if (union.size > LIMITS.MAX_RESOLVED_INVITEES) {
    throw new ValidationError(
      `This event would have ${union.size} invitees, more than the limit of ${LIMITS.MAX_RESOLVED_INVITEES}`,
    );
  }

  // Pass-13 review (P13-09). People already on the event are removed BEFORE
  // the capacity guard sees them, which is the regression P12-12's fix
  // introduced.
  //
  // That guard is `LIMIT MAX(0, cap - count)` on an INSERT ... SELECT, and
  // SQLite applies a LIMIT to the SELECT -- before ON CONFLICT gets to
  // discard anything. So with 24 of 25 seats taken and a request naming one
  // existing invitee and one new person, the single available row went to the
  // existing one, the conflict clause dropped it, and the new person was never
  // considered. Response 200, nobody added. No concurrency needed: inviting a
  // group that overlaps the current invite list does it, which is an ordinary
  // thing to do.
  const genuinelyNew = invitees.filter((i) => !alreadyInvited.has(i.userId));
  if (genuinelyNew.length === 0) return { notAdded: [] };

  // And the outcome is inspected rather than assumed. Under two concurrent
  // additions the guard can still admit fewer than asked -- that is what it is
  // for -- but the caller was being told it had succeeded. Returning who did
  // not make it is the honest answer, and cheap: meta.changes per statement.
  const results = await env.DB.batch(
    inviteStatements(env, eventId, genuinelyNew, false, null, LIMITS.MAX_RESOLVED_INVITEES),
  );
  const admitted = results.reduce((total, r) => total + r.meta.changes, 0);
  if (admitted >= genuinelyNew.length) return { notAdded: [] };

  const { results: nowInvited } = await env.DB.prepare(`SELECT user_id FROM event_invites WHERE event_id = ?`)
    .bind(eventId)
    .all<{ user_id: string }>();
  const present = new Set(nowInvited.map((r) => r.user_id));
  return { notAdded: genuinelyNew.filter((i) => !present.has(i.userId)).map((i) => i.userId) };
}

export async function createEventWithInvites(
  env: Env,
  guildId: string,
  organizerId: string,
  input: EventWriteInput,
): Promise<string> {
  input = normalizeWindowInput(input);
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
    organizerId,
  );
  assertThresholdReachable(input.pollStrategy, input.pollThresholdCount, invitees.length);

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
         is_recurring, voice_channel_id, voice_channel_name, minimum_attendees, auto_cancel_below_minimum,
         minimum_attendees_deadline_at, minimum_attendees_deadline_hours_before,
         is_private, created_at, updated_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
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
      // window_start_at/_end_at are dead weight now: a candidate carries its
      // own span. Written NULL rather than dropped, for the same
      // two-release reason poll_mode is still written at all.
      null,
      null,
      // The one field that decides the poll's shape. Set means every
      // candidate is a window and this is the minimum session length inside
      // it; NULL means each candidate *is* the session.
      input.eventType === 'poll' ? (input.windowBlockMinutes ?? null) : null,
      isRecurring ? 1 : 0,
      input.voiceChannelId ?? null,
      input.voiceChannelName ?? null,
      // Validated above (assertMinimumAttendeesDeadlineShape) to already be
      // a coherent combination -- deadlineAt only when non-recurring,
      // deadlineHoursBefore only when recurring -- so no further gate is
      // needed here the way poll fields and start_at/end_at have one.
      input.minimumAttendees ?? null,
      input.autoCancelBelowMinimum ? 1 : 0,
      input.minimumAttendeesDeadlineAt ?? null,
      input.minimumAttendeesDeadlineHoursBefore ?? null,
      // specs/0007: visible on the server's noticeboard unless the organiser
      // said otherwise. Written explicitly rather than left to the column
      // default so the value is decided in one readable place.
      input.isPrivate ? 1 : 0,
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

  if (input.eventType === 'poll' && input.pollOptions) {
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

// specs/0014 decision 3: the ISO date an instant falls on, local to a given
// timezone -- the "date" a schedule edit's before/after gets compared by.
// Deliberately the timezone at each end of the comparison, not one held
// fixed for both: a pure timezone correction (organizer fixes a wrong zone,
// touching no UTC instant at all) genuinely changes what date every invitee
// sees, and decision 3's own test -- "if we move it to a different day,
// you'll be asked again" -- is about the *displayed* date, not the
// underlying instant. Holding one zone fixed would let a timezone-only fix
// silently redisplay a different day without re-asking anyone.
function localDateKey(ms: number, zone: string): string {
  return DateTime.fromMillis(ms, { zone }).toISODate() ?? '';
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
  input = normalizeWindowInput(input);
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
  // specs/0007. Changeable after creation in both directions: an organiser who
  // realises a session is more private than they thought must be able to take
  // it off the noticeboard, and hiding something is exactly the direction that
  // should never require deleting and recreating it.
  if (input.isPrivate !== undefined) {
    setClauses.push('is_private = ?');
    values.push(input.isPrivate ? 1 : 0);
  }
  // specs/0014 stage 3. Coherence (non-recurring, non-poll) already checked
  // by assertCoherentMergedEvent against the merged shape, not just this
  // delta -- see its comment.
  if (input.minimumAttendees !== undefined) {
    setClauses.push('minimum_attendees = ?');
    values.push(input.minimumAttendees);
  }
  if (input.autoCancelBelowMinimum !== undefined) {
    setClauses.push('auto_cancel_below_minimum = ?');
    values.push(input.autoCancelBelowMinimum ? 1 : 0);
  }
  if (input.minimumAttendeesDeadlineAt !== undefined) {
    setClauses.push('minimum_attendees_deadline_at = ?');
    values.push(input.minimumAttendeesDeadlineAt);
  }
  if (input.minimumAttendeesDeadlineHoursBefore !== undefined) {
    setClauses.push('minimum_attendees_deadline_hours_before = ?');
    values.push(input.minimumAttendeesDeadlineHoursBefore);
  }

  // isRecurring is the signal that this request is a full single-event
  // schedule edit (the frontend always sends it alongside startAt/endAt or
  // recurrence); only then do we touch start_at/end_at/is_recurring.
  //
  // The schedule shape itself was already validated by
  // assertCoherentMergedEvent above, against the stored event rather than the
  // delta alone.
  // specs/0014 decision 3: a schedule edit clears attendance only if the
  // *local* date actually moves. Only reachable for a non-recurring event
  // staying non-recurring (input.isRecurring === false, matching the branch
  // above that actually writes input.startAt) with a real previous start_at
  // to compare against -- a series being converted to a one-off has none
  // (recurring events never carry a start_at), and there is nothing to
  // clear for it either: event_attendance for occurrence_date = '' cannot
  // exist yet on a row that has only ever been a series.
  const clearsAttendanceOnDateMove =
    input.isRecurring === false &&
    !wasRecurring &&
    stored.start_at != null &&
    input.startAt !== undefined &&
    localDateKey(stored.start_at, stored.timezone) !== localDateKey(input.startAt, input.timezone ?? stored.timezone);

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
        stored.organizer_id,
      )
    : null;

  // assertThresholdReachable needs the invitee count either way, but this
  // PATCH doesn't necessarily touch invites -- "raise the threshold" is a
  // perfectly normal edit on its own. `invitees` above is only populated when
  // the request also carries a new invite list; otherwise the count has to
  // come from what's already stored, one extra read paid only on the PATCHes
  // that actually need it (a poll, changing or already carrying a threshold).
  const mergedPollStrategy = input.pollStrategy !== undefined ? input.pollStrategy : stored.poll_strategy;
  const mergedThresholdCount =
    input.pollThresholdCount !== undefined ? input.pollThresholdCount : stored.poll_threshold_count;
  if (mergedPollStrategy === 'threshold' && mergedThresholdCount != null) {
    const inviteeCount =
      invitees !== null
        ? invitees.length
        : (await env.DB.prepare('SELECT COUNT(*) AS n FROM event_invites WHERE event_id = ?').bind(eventId).first<{ n: number }>())!.n;
    assertThresholdReachable(mergedPollStrategy, mergedThresholdCount, inviteeCount);
  }

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

  if (clearsAttendanceOnDateMove) {
    statements.push(
      guardedStatement(`DELETE FROM event_attendance WHERE event_id = ? AND occurrence_date = ''`, eventId),
    );
  }

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
    const { pollMode } = normalizePollModes(input);
    // Pass-12 review (P12-15). normalizePollModes applies the CREATE-time
    // default -- `?? 'single_winner'` -- which on this path means a PATCH that
    // does not mention pollResolutionMode silently converts a multi-winner
    // poll into a single-winner one. Same F-08-A preservation as the four
    // fields below, and for the same reason: "the caller didn't send a mode"
    // and "the caller wants the default" are not the same request. The current
    // form always sends it, so the exposure is a partial API caller rather
    // than an ordinary save -- but every other field in this UPDATE learned
    // that lesson already.
    const pollResolutionMode =
      input.pollResolutionMode !== undefined ? input.pollResolutionMode : stored.poll_resolution_mode;

    // Pass-11 review (R05). This block used to delete every vote on the event
    // and then every candidate row, rebuilding the whole set from the request.
    // EventFormPage sends `pollOptions` on *every* poll save -- it has no
    // notion of "the candidates didn't change" -- so correcting a typo in the
    // title, or just pressing Save changes, silently destroyed every vote
    // already cast, with no warning and no confirmation. The option ids that
    // existing Discord vote messages point at changed underneath them too.
    //
    // So candidates are now reconciled rather than replaced. Identity is the
    // (start_at, end_at) pair, which is the only identity available: the
    // request carries no ids, and two candidate slots with the same start and
    // end *are* the same candidate to anyone voting on them. A row that
    // survives keeps its id, and with it its votes, its window-availability
    // submissions and its confirmed_at -- so an unrelated edit is now a no-op
    // against all three, and an edit that changes one slot out of five no
    // longer takes the votes on the other four with it.
    const { results: existingOptions } = await env.DB.prepare(
      `SELECT id, start_at, end_at, display_order FROM event_poll_options WHERE event_id = ?`,
    )
      .bind(eventId)
      .all<{ id: string; start_at: number; end_at: number; display_order: number }>();

    const slotKey = (startAt: number, endAt: number) => `${startAt}:${endAt}`;
    const survivingByKey = new Map(existingOptions.map((row) => [slotKey(row.start_at, row.end_at), row]));
    const desiredKeys = new Set(input.pollOptions.map((opt) => slotKey(opt.startAt, opt.endAt)));

    // Candidates the organizer actually removed. Their votes and window
    // submissions both cascade from event_poll_options (see that table's
    // foreign keys), so deleting the row is enough to take them with it --
    // which is correct here, unlike the blanket delete this replaces: these
    // are the only candidates that genuinely stopped existing.
    const removedIds = existingOptions
      .filter((row) => !desiredKeys.has(slotKey(row.start_at, row.end_at)))
      .map((row) => row.id);

    // Pass-12 review (P12-16 / F-29). Once sweepConfirmedMultiWinnerOptions
    // has turned a confirmed candidate into a real event, that event points
    // back at the candidate through migration 0027's created_from_option_id,
    // which has no ON DELETE action -- so deleting the candidate fails the
    // foreign key, the batch rolls back, and an edit the UI offered comes back
    // as "Internal error". Retiming reaches it the same way: (start_at,
    // end_at) is the identity here, so a moved slot is a removal plus an add.
    //
    // Refused rather than cascaded. The generated event is a real session that
    // has been DMed about, may be on Google calendars, and may already have
    // RSVPs against it; deleting it as a side effect of editing the poll it
    // came from would be a far worse answer than declining the edit. The
    // organizer can cancel that session directly if that is what they meant.
    if (removedIds.length > 0) {
      const materialized = await env.DB.prepare(
        `SELECT 1 FROM events WHERE created_from_option_id IN (${placeholders(removedIds.length)}) LIMIT 1`,
      )
        .bind(...removedIds)
        .first();
      if (materialized) {
        throw new ValidationError(
          'One of the times you removed has already been confirmed and scheduled as its own session, so it can no longer be changed here. Cancel that session if it is not going ahead.',
        );
      }
    }

    // Reserving the two binds guardedStatement appends, the same way
    // chunkRows' callers reserve theirs.
    for (const chunk of chunkIds(removedIds, guardBinds.length)) {
      statements.push(
        guardedStatement(`DELETE FROM event_poll_options WHERE id IN (${placeholders(chunk.length)})`, ...chunk),
      );
    }

    // Reordering the candidate list has to move the surviving rows with it, or
    // the poll would render in its old order while claiming the new one.
    const added: { startAt: number; endAt: number; displayOrder: number }[] = [];
    input.pollOptions.forEach((opt, index) => {
      const surviving = survivingByKey.get(slotKey(opt.startAt, opt.endAt));
      if (!surviving) {
        added.push({ startAt: opt.startAt, endAt: opt.endAt, displayOrder: index });
        return;
      }
      if (surviving.display_order !== index) {
        statements.push(
          guardedStatement(`UPDATE event_poll_options SET display_order = ? WHERE id = ?`, index, surviving.id),
        );
      }
    });

    statements.push(...pollOptionStatements(env, eventId, added, true, mutationToken));
    statements.push(
      guardedStatement(
        `UPDATE events SET poll_strategy = ?, poll_threshold_count = ?, poll_deadline_at = ?,
           poll_mode = ?, poll_resolution_mode = ?, window_start_at = NULL, window_end_at = NULL,
           window_block_minutes = ?
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
        // Same F-08-A preservation as the three fields above, and for a
        // sharper reason: this one decides what the candidates *mean*. An
        // edit that only re-orders the candidate slots must not quietly turn
        // a windowed poll back into a fixed-slot one.
        input.windowBlockMinutes !== undefined ? input.windowBlockMinutes : stored.window_block_minutes,
        eventId,
      ),
    );
  }

  // Toggling the minimum on its own, with the candidates left as they are --
  // "actually, treat these as windows" (or the reverse).
  if (input.windowBlockMinutes !== undefined && !input.pollOptions) {
    // Turning windows *off* makes every submitted sub-range meaningless --
    // the candidate is the session now, and there is nothing to submit a
    // range within. Turning them on, or changing the minimum, leaves
    // submissions alone: they are still honest statements of when someone is
    // free, and bestWindowSpan re-reads them against the new bar.
    if (input.windowBlockMinutes === null) {
      statements.push(guardedStatement(`DELETE FROM event_window_availability WHERE event_id = ?`, eventId));
    }
    statements.push(
      guardedStatement(`UPDATE events SET window_block_minutes = ? WHERE id = ?`, input.windowBlockMinutes, eventId),
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
