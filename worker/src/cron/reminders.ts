import { DateTime } from 'luxon';
import type { Env } from '../env';
import type { EventRow, OverrideRow } from '../lib/events';
import { loadOverridesForEvents } from '../lib/events';
import { expandOccurrences, expandOccurrencesForEvent, loadRecurrenceRulesForEvents, type RecurrenceRule } from '../lib/recurrence';
import { resolvePastDeadlinePolls } from '../lib/polls';
import { resolvePastDeadlineChangeRequests } from '../lib/changeRequests';
import {
  countConfirmedAttendees,
  getConfirmedAttendeeIds,
  ladderStatusCase,
  ladderStatusCaseBinds,
  type RsvpStatus,
} from '../lib/attendance';
import { inviteStatements, type ResolvedInvitee } from '../lib/eventWrites';
import { newId } from '../lib/ids';
import { pruneStaleSessions } from '../lib/sessions';
import { deleteUserCompletely, MEMBERSHIP_GRACE_MS, revalidateStaleMemberships } from '../lib/db';
import { commonServerSet } from '../lib/groups';
import {
  deliverThroughOutbox,
  MAX_DELIVERY_ATTEMPTS,
  PENDING_NOTIFICATION_JOIN,
  PENDING_NOTIFICATION_WHERE,
  pendingNotificationJoinBinds,
  pendingNotificationWhereBinds,
  reapExhaustedDeliveries,
  type DmRecipient,
} from '../lib/outbox';
import { editBotDm } from '../lib/discord';
import { cancelButton, cancelOccurrenceButton, linkButton, pollSelect, rsvpButtons } from '../lib/dmComponents';
import { LIMITS } from '../lib/validate';
import { chunkIds, placeholders } from '../lib/d1';
import { planFrom, TickBudget } from './budget';
import {
  decodeEventKey,
  encodeEventKey,
  CursorStore,
  type CursorName,
} from './cursor';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

type ParticipantRow = DmRecipient;

// Cron never makes a live Discord call per recipient -- that would mean one
// Discord request per invitee on every 15-minute tick. It relies on the cache
// instead, but not on a cache of arbitrary age: every recipient query below
// requires the membership row to have been confirmed within this window, and
// sweepMembershipRevalidation (further down) is what keeps rows inside it.
//
// So a membership that Discord hasn't confirmed for over a day stops
// receiving DMs, the same bound interactive requests apply. Someone who left
// the server can't keep getting private event titles in their DMs
// indefinitely just because they never opened the app again.
function membershipCutoff(): number {
  return Date.now() - MEMBERSHIP_GRACE_MS;
}

// How many stale membership rows to re-verify per tick. Each one is an
// outbound Discord call, and on the Free plan a Worker invocation gets only
// ~50 of those in total -- the previous value of 50 could consume the entire
// allowance before a single reminder DM was attempted. Ten per tick is 40 an
// hour, still far more than a friend-group-sized install needs to keep
// everyone inside the one-hour freshness window, and it leaves the rest of
// the tick's budget for the notifications the cache exists to serve.
const MEMBERSHIP_REVALIDATIONS_PER_TICK = 10;

// Recurring events are processed in pages, and each page loads its own
// overrides. Previously one global preload ran for every recurring event in
// the database, outside the per-event try/catch -- so once that query got big
// enough to fail, it took the entire recurring sweep down with it before a
// single reminder was processed.
const RECURRING_PAGE_SIZE = 50;

// The single-event reminder scan is windowed to the next 24 hours, but that
// window has no bound on how many events fall inside it. Paged for the same
// reason the recurring scan is.
const SINGLE_EVENT_PAGE_SIZE = 100;

// A handful of sweeps below scan a table with no per-guild or per-tick
// bound at all -- "every recently closed poll", "every confirmed
// multi-winner option", "every group" -- across every guild the Worker
// serves. Without a LIMIT, a busy multi-guild install can make one of these
// `.all()` calls read and serialize an unbounded result set into Worker
// memory *before* the loop below ever consults the budget: the query costs
// "one query" no matter how many thousands of rows it returns. Capping each
// at this ceiling, and charging one query for it up front, keeps the read
// itself inside the same accounting the per-row work already goes through.
const GLOBAL_SCAN_LIMIT = 200;

// `incomplete` means the row still has obligations this tick could not
// discharge, so the cursor must not move past it. Returning nothing means the
// row is finished (including "there was nothing to do for it").
type RowOutcome = 'incomplete' | void;

// Walks one page of a global (multi-guild) scan, resuming from where the last
// tick stopped and committing progress only for rows it actually finished.
//
// Two separate things are needed here and only one of them is a LIMIT.
//
// The LIMIT bounds a single read but says nothing about *which* rows come
// back. With a fixed ORDER BY and no cursor, every tick got the identical
// prefix, so with 201 eligible rows and a limit of 200 the 201st was selected
// on no tick, ever. Unlike the reminder scans, whose predicate at least moves
// with the clock, these predicates ("confirmed", "recently closed", "has a
// deadline in the next day") keep matching after a notification is delivered,
// so a settled row holds its place in the prefix indefinitely.
//
// The cursor fixes that, but only if it records work *completed* rather than
// work *read*. The previous version advanced it to the last row of the page
// the moment the page came back, before the caller had processed any of it --
// so a tick with budget for one row of two hundred still persisted a cursor
// past all two hundred. For a stable predicate that only means a wait for the
// next pass; for a moving one it is permanent loss, because rows can fall out
// of the window (`poll_deadline_at >= now`, `start_at >= now`) while the
// cursor sits beyond them, and the eventual wrap does not bring them back.
//
// So the cursor moves one row at a time, after that row is done, and a page
// only resets the cursor once every row in it has been handled. A row the
// tick could not afford stays in front of the cursor and is the first thing
// the next tick sees.
//
// `sql` must select an `id` column and carry its own WHERE clause; the keyset
// predicate and ordering are appended here so every caller gets the same
// shape.
async function forEachGlobalRow<T extends { id: string }>(
  env: Env,
  budget: TickBudget,
  cursors: CursorStore,
  cursorName: CursorName,
  sql: string,
  binds: unknown[],
  handle: (row: T) => Promise<RowOutcome>,
  // The keyset column, qualified where the query joins more than one table
  // that has an `id`. The selected row must still expose it as `id`.
  idColumn = 'id',
): Promise<void> {
  if (!budget.trySpend(1)) return;
  const after = cursors.get(cursorName);
  const { results } = await env.DB.prepare(
    `${sql} AND (? IS NULL OR ${idColumn} > ?) ORDER BY ${idColumn} LIMIT ?`,
  )
    .bind(...binds, after, after ?? '', GLOBAL_SCAN_LIMIT)
    .all<T>();

  for (const row of results) {
    if (!budget.trySpend(SCAN_COST_PER_EVENT)) return;
    let outcome: RowOutcome;
    try {
      outcome = await handle(row);
    } catch (err) {
      // A row that throws is skipped rather than retried forever: the sweep
      // advances past it so one malformed record cannot block the page, and
      // the next pass around will come back to it.
      console.error(`${cursorName} sweep failed for row ${row.id}:`, err);
      cursors.set(cursorName, row.id);
      continue;
    }
    // Either the handler said so, or it ran out mid-row. Either way this row
    // is not finished, so the cursor stays in front of it.
    if (outcome === 'incomplete' || budget.exhausted) return;
    cursors.set(cursorName, row.id);
  }

  // Every row on the page was handled. A short page means that was the end of
  // the scan, so wrap for the next tick; a full page means there is more
  // behind it and the cursor already points at the right place.
  if (results.length < GLOBAL_SCAN_LIMIT) cursors.set(cursorName, null);
}

// A resolved/cancelled poll's notification obligations are done within a
// handful of cron ticks (the outbox already dedupes and backs off), so
// there's no reason to keep re-selecting and re-scanning that row every 15
// minutes for the rest of its life. Bounding these sweeps by recency is a
// read-time throttle; TERMINAL_HISTORY_RETENTION_MS below is what actually
// reclaims the storage once nobody could plausibly still need the row.
const TERMINAL_HISTORY_HOT_WINDOW_MS = 3 * DAY_MS;

function terminalHistoryHotCutoff(): number {
  return Date.now() - TERMINAL_HISTORY_HOT_WINDOW_MS;
}

// How long a cancelled event or a resolved/cancelled poll is kept at all.
// Past this, every calendar load and cron tick for the rest of the guild's
// life would otherwise keep paying a small, permanent tax for history nobody
// asked to see again -- this is the part of F-04 that a read-time filter
// alone can't fix, since the rows are still there to be (mis-)counted by
// anything that isn't careful.
const TERMINAL_HISTORY_RETENTION_MS = 90 * DAY_MS;

// Bounds how many terminal events one tick will purge, so a backlog (e.g.
// right after this feature ships, against however much history already
// exists) is worked off gradually across ticks rather than in one large
// batch.
const TERMINAL_HISTORY_PURGE_BATCH_SIZE = 100;

// Statements issued for the one chunk a tick processes -- one per
// non-cascading child table, two to break the fan-out pointer (below), and
// one for the parent. Kept next to the statement list below so the two stay
// in step.
//
// This used to read 8, undercounting by one (specs/0014 stage 1 added an
// event_attendance delete without updating it -- IDEAS item 53) *and* the
// purge used to spend `chunks.length * this` in one tick, trying to clear an
// entire backlog at once. Simply correcting the count to 9 broke
// pass6.test.ts's "backlog and a purge queue" budget-fit test: at zero
// margin against the old (buggy) figure, 9 x 2 chunks needed 18 on a tick
// measured to have only 16 left over, which no number of ticks closes -- the
// same "not at 40, not at 200" starvation IDEAS item 47 hit for the same
// reason. Item 56 then wanted an 11th statement here (two more, actually --
// see below) to fix a real FK error, which only made that arithmetic worse.
//
// The fix that closes both: a tick now buys and runs exactly one chunk, not
// "however many chunks this backlog's SELECT happened to return" (see
// sweepPurgeTerminalHistory below). That makes the per-tick cost this
// constant, full stop, independent of backlog size or how many child tables
// this purge ever grows to cover -- so a future 12th statement is just
// another safe bump here, not a second look at this same budget math.
const PURGE_STATEMENTS_PER_CHUNK = 11;

type NotificationType =
  | 'invite'
  | 'reminder_24h'
  | 'reminder_1h'
  | 'poll_resolved'
  | 'poll_deadline_reminder'
  | 'voice_channel_invite'
  | 'ladder_unanswered_96h'
  | 'ladder_unanswered_48h'
  | 'ladder_maybe_72h'
  | 'ladder_maybe_24h'
  | 'ladder_accepted_24h'
  | 'ladder_accepted_1h'
  | 'ladder_window_outside_hours'
  | 'organizer_cancel_prompt'
  | 'event_cancelled_below_minimum'
  | 'event_cancelled'
  | 'group_venue_drift'
  | 'minimum_attendees_deadline_warning';

// Event-scoped notifications go through the shared leased outbox (see
// lib/outbox.ts), keyed on the same four columns as notification_log's UNIQUE
// constraint.
async function notifyOnce(
  env: Env,
  budget: TickBudget,
  user: ParticipantRow,
  eventId: string,
  notificationType: NotificationType,
  occurrenceDate: string,
  content: string,
  components?: unknown[] | null,
): Promise<void> {
  await deliverThroughOutbox(
    env,
    'notification_log',
    {
      user_id: user.id,
      event_id: eventId,
      notification_type: notificationType,
      occurrence_date: occurrenceDate,
    },
    user,
    content,
    budget,
    components,
  );
}

// What one event costs a sweep before a single DM is sent. Charged up front
// so the tick stops walking events once it can no longer afford to look at
// one, rather than discovering that only when it tries to deliver.
const SCAN_COST_PER_EVENT = 1;

// The event participants who still need this particular notification.
//
// The settled filter is part of this query rather than a second one, because
// the overwhelmingly common case is an event whose notifications have all
// been delivered already: asking for three hundred participants and then
// asking again which of them are done costs two queries per event per tick
// to discover there is nothing to do. Folding the filter in makes an
// idle event cost one query and return nothing, and makes the LIMIT
// meaningful -- it now bounds actionable rows rather than a prefix that might
// be entirely settled.
async function pendingRecipients(
  env: Env,
  event: { id: string; guild_id: string; organizer_id: string },
  notificationType: NotificationType,
  occurrenceDate: string,
  limit: number,
): Promise<ParticipantRow[]> {
  const now = Date.now();
  const { results } = await env.DB.prepare(
    `SELECT u.id, u.notifications_enabled, u.dm_channel_id, u.timezone
     FROM users u
     JOIN user_guild_membership m ON m.user_id = u.id AND m.guild_id = ? AND m.is_member = 1 AND m.verified_at >= ?
     JOIN guilds g ON g.id = m.guild_id AND g.is_active = 1
     LEFT JOIN notification_log nl
       ON nl.user_id = u.id AND nl.event_id = ?
       AND nl.notification_type = ? AND nl.occurrence_date = ?
     WHERE u.id IN (SELECT user_id FROM event_invites WHERE event_id = ? UNION SELECT ?)
       -- The union stays unconditional here, unlike attendance.ts's: this is
       -- "everyone with a stake in the event", which already includes people
       -- who declined (a moved session is still news to them), so an organizer
       -- row cannot change the set either way.
       AND u.notifications_enabled = 1
       AND (
         nl.id IS NULL
         OR (nl.delivered_at IS NULL AND nl.failed_at IS NULL
             AND nl.attempt_count < ?
             AND (nl.claimed_until IS NULL OR nl.claimed_until < ?)
             AND (nl.next_attempt_at IS NULL OR nl.next_attempt_at <= ?))
       )
     ORDER BY u.id
     LIMIT ?`,
  )
    .bind(
      event.guild_id,
      membershipCutoff(),
      event.id,
      notificationType,
      occurrenceDate,
      event.id,
      event.organizer_id,
      MAX_DELIVERY_ATTEMPTS,
      now,
      now,
      limit,
    )
    .all<ParticipantRow>();
  return results;
}

type LadderStatusRow = ParticipantRow & { effective_status: LadderStatus };

// The ladder's recipient query, replacing pendingRecipients' "one fixed
// notification type for everyone" shape: different recipients of the same
// occurrence are due different rungs simultaneously, depending on their own
// per-occurrence status, so the type to dedupe on has to be computed per row
// rather than bound once for the whole query.
//
// At most three rungs can possibly be due for one occurrence at one tick --
// one per status bucket -- and that's computed in plain JS by the caller
// before this runs (ladderRungFor), with zero DB cost when nothing is due at
// all. This is one query, not up to three: a CTE computes
// attendance.ts's ladderStatusCase once, referenced by name afterwards,
// rather than repeating the CASE text (and its binds) at every splice point.
// Declined recipients are excluded in the WHERE clause directly -- a decline
// gets no rungs, so there is nothing for them to compute, and they are never
// fetched only to be discarded in JS.
async function pendingLadderRecipients(
  env: Env,
  event: EventRow,
  occurrenceDate: string,
  isWindowed: boolean,
  types: { unanswered: string | null; tentative: string | null; accepted: string | null },
  limit: number,
): Promise<LadderStatusRow[]> {
  const now = Date.now();
  const { results } = await env.DB.prepare(
    `WITH candidates AS (
       SELECT user_id FROM event_invites WHERE event_id = ?
       UNION SELECT ?
     ),
     statused AS (
       SELECT u.id, u.notifications_enabled, u.dm_channel_id, u.timezone,
         ${ladderStatusCase(isWindowed)} AS effective_status
       FROM candidates c
       JOIN users u ON u.id = c.user_id
       JOIN user_guild_membership m ON m.user_id = u.id AND m.guild_id = ? AND m.is_member = 1 AND m.verified_at >= ?
       JOIN guilds g ON g.id = m.guild_id AND g.is_active = 1
       LEFT JOIN event_attendance att ON att.event_id = ? AND att.occurrence_date = ? AND att.user_id = u.id
       WHERE (att.rsvp_status IS NULL OR att.rsvp_status != 'declined')
         AND u.notifications_enabled = 1
     )
     SELECT s.id, s.notifications_enabled, s.dm_channel_id, s.timezone, s.effective_status
     FROM statused s
     LEFT JOIN notification_log nl
       ON nl.user_id = s.id AND nl.event_id = ? AND nl.occurrence_date = ?
       AND nl.notification_type = CASE s.effective_status
             WHEN 'unanswered' THEN ? WHEN 'tentative' THEN ? WHEN 'accepted' THEN ? END
     WHERE (CASE s.effective_status WHEN 'unanswered' THEN ? WHEN 'tentative' THEN ? WHEN 'accepted' THEN ? END) IS NOT NULL
       AND (
         nl.id IS NULL
         OR (nl.delivered_at IS NULL AND nl.failed_at IS NULL
             AND nl.attempt_count < ?
             AND (nl.claimed_until IS NULL OR nl.claimed_until < ?)
             AND (nl.next_attempt_at IS NULL OR nl.next_attempt_at <= ?))
       )
     ORDER BY s.id
     LIMIT ?`,
  )
    // Bind order matches SQL text order, top to bottom -- NOT the order the
    // fragments are described or built in JS. ladderStatusCase's own binds
    // land third because the CASE it builds sits in the CTE's SELECT list,
    // which the SQL text reaches before the FROM/JOIN clause's guild/att
    // binds below it.
    .bind(
      event.id,
      event.organizer_id,
      ...ladderStatusCaseBinds(event.organizer_id, isWindowed, event),
      event.guild_id,
      membershipCutoff(),
      event.id,
      occurrenceDate,
      event.id,
      occurrenceDate,
      types.unanswered,
      types.tentative,
      types.accepted,
      types.unanswered,
      types.tentative,
      types.accepted,
      MAX_DELIVERY_ATTEMPTS,
      now,
      now,
      limit,
    )
    .all<LadderStatusRow>();
  return results;
}

// Delivers to a recipient list that has already been filtered down to the
// ones who need this notification, so there is no settled-set lookup to pay
// for. Stops rather than skips when the tick runs out: the next recipient
// costs at least as much as this one.
async function notifyPending(
  env: Env,
  budget: TickBudget,
  recipients: readonly ParticipantRow[],
  eventId: string,
  notificationType: NotificationType,
  occurrenceDate: string,
  message: (user: ParticipantRow) => string,
  // Per user, not per event: a candidate select's labels are rendered in the
  // recipient's own timezone, the same as the message text is.
  components?: (user: ParticipantRow) => unknown[] | null,
): Promise<void> {
  for (const user of recipients) {
    if (budget.exhausted) return;
    await notifyOnce(
      env,
      budget,
      user,
      eventId,
      notificationType,
      occurrenceDate,
      message(user),
      components?.(user) ?? null,
    );
  }
}

// Rendered in the *recipient's* configured timezone -- a DM saying "17:00
// GMT" is useless to someone who set themselves to Eastern.
function formatWhen(startAt: number, zone: string): string {
  return DateTime.fromMillis(startAt).setZone(zone).toFormat("ccc d LLL, h:mm a ZZZZ");
}

// A windowed poll resolves to a span, not just a start (specs/0013), and the
// span is the answer: "we found two and a half hours" and "everyone can stay
// until eleven" are different outcomes and the DM has to distinguish them.
// Fixed-slot polls keep the shorter copy -- their length was never in doubt.
function formatSpan(startAt: number, endAt: number, zone: string): string {
  const start = DateTime.fromMillis(startAt).setZone(zone);
  const end = DateTime.fromMillis(endAt).setZone(zone);
  const endFormat = end.hasSame(start, 'day') ? 'h:mm a ZZZZ' : 'ccc d LLL, h:mm a ZZZZ';
  return `${start.toFormat('ccc d LLL, h:mm a')} - ${end.toFormat(endFormat)}`;
}

// Deep link straight to the event so the DM is actionable rather than just
// informational -- HashRouter, so the fragment is part of the URL.
function eventLink(env: Env, eventId: string): string {
  return `${env.FRONTEND_URL}/#/events/${eventId}`;
}

// ---------------------------------------------------------------------------
// The reminder ladder (specs/0014 stage 2)
// ---------------------------------------------------------------------------

// unanswered/tentative/accepted only -- 'declined' gets no rungs at all and
// is excluded before this table is ever consulted (see the recipient query).
type LadderStatus = 'unanswered' | 'tentative' | 'accepted';

interface LadderRung {
  hours: number;
  type: NotificationType;
  // Which of the three answers make sense to offer from this rung -- "a rung
  // offers only the moves that make sense from where you are." Threaded
  // straight into dmComponents.ts's rsvpButtons.
  buttons: RsvpStatus[];
  render: (u: ParticipantRow, at: number) => string;
}

// One table drives the rung picker, the notification_type each rung dedupes
// on, its button set and its wording -- a single source of truth rather than
// four places that could drift out of step with each other or with the
// spec's own table. Entries within each status are ordered nearest-hours-
// first, which is what makes the picker below "nearest due wins" rather than
// "first listed wins" -- the same mutual-exclusion shape reminderFor already
// uses for today's 24h/1h pair, just per status instead of fixed. The
// accepted tier's wording is reminderFor's existing 24h/1h text verbatim --
// nothing about what those two rungs say has actually changed, only who
// else now gets a rung at all.
const LADDER: Record<LadderStatus, LadderRung[]> = {
  unanswered: [
    {
      hours: 48,
      type: 'ladder_unanswered_48h',
      buttons: ['accepted', 'tentative', 'declined'],
      render: (u, at) => `is coming up on ${formatWhen(at, u.timezone)} and you haven't answered yet -- are you in?`,
    },
    {
      hours: 96,
      type: 'ladder_unanswered_96h',
      buttons: ['accepted', 'tentative', 'declined'],
      render: (u, at) => `is coming up on ${formatWhen(at, u.timezone)}. Are you in?`,
    },
  ],
  tentative: [
    {
      hours: 24,
      type: 'ladder_maybe_24h',
      buttons: ['accepted', 'declined'],
      render: (u, at) =>
        `is coming up on ${formatWhen(at, u.timezone)} -- you said maybe. Still on, or should we let the others know?`,
    },
    {
      hours: 72,
      type: 'ladder_maybe_72h',
      buttons: ['accepted', 'declined'],
      render: (u, at) => `is coming up on ${formatWhen(at, u.timezone)} -- you said maybe. Any more certain now?`,
    },
  ],
  accepted: [
    {
      hours: 1,
      type: 'ladder_accepted_1h',
      buttons: ['declined'],
      render: (u, at) => `starts in about an hour (${formatWhen(at, u.timezone)})`,
    },
    {
      hours: 24,
      type: 'ladder_accepted_24h',
      buttons: ['declined'],
      render: (u, at) => `is coming up on ${formatWhen(at, u.timezone)}`,
    },
  ],
};

const LADDER_FARTHEST_HOURS = 96;

// Nearest due wins: rungs are ordered ascending, so the first one whose
// threshold `remaining` has already crossed is the one that fires. An
// unanswered person 90 hours out gets nothing yet; at 95 hours they cross
// into the 96h rung; once inside 48 hours the 96h rung is behind them and
// this returns the 48h one instead, never both in the same tick.
function ladderRungFor(status: LadderStatus, startAt: number, now: number): LadderRung | null {
  const remaining = startAt - now;
  for (const rung of LADDER[status]) {
    if (remaining <= rung.hours * HOUR_MS) return rung;
  }
  return null;
}

// ---------------------------------------------------------------------------
// The controls a DM carries (specs/0010)
// ---------------------------------------------------------------------------

// What kind of event this is, which is all the component builders need to
// know. A poll with `window_block_minutes` set is answered with a range and
// has no honest Discord control (specs/0013 + 0010), so it gets a link.
type EventShape = Pick<EventRow, 'id' | 'event_type' | 'window_block_minutes'>;

interface PollCandidate {
  id: string;
  start_at: number;
  end_at: number;
}

// One query per poll per tick, cached for the recipients that follow it, and
// charged to the budget like every other statement.
//
// When the tick cannot afford the lookup this returns null and the DM goes
// out *without* its select rather than not going out at all. That ordering is
// deliberate: a notification with no buttons is the notification we sent
// before this release, while a notification withheld to save a query is a
// person not told their poll is closing.
async function pollCandidates(
  env: Env,
  budget: TickBudget,
  eventId: string,
  cache: Map<string, PollCandidate[] | null>,
): Promise<PollCandidate[] | null> {
  const cached = cache.get(eventId);
  if (cached !== undefined) return cached;
  if (!budget.trySpend(1)) return null;

  const { results } = await env.DB.prepare(
    `SELECT id, start_at, end_at FROM event_poll_options WHERE event_id = ? ORDER BY display_order LIMIT ?`,
  )
    .bind(eventId, LIMITS.MAX_POLL_OPTIONS)
    .all<PollCandidate>();
  cache.set(eventId, results);
  return results;
}

// The controls for a DM about a poll that is still open: pick the nights that
// work. Labels are rendered in the recipient's timezone, so this is built per
// recipient from candidates fetched once.
function voteControls(event: EventShape, candidates: PollCandidate[] | null, env: Env, zone: string): unknown[] | null {
  if (event.window_block_minutes != null) {
    return linkButton('Choose your hours', eventLink(env, event.id));
  }
  if (!candidates || candidates.length === 0) return null;
  return pollSelect(
    event.id,
    candidates.map((c) => ({ id: c.id, label: formatSpan(c.start_at, c.end_at, zone) })),
  );
}

// A select can express "these work for me" and nothing else -- the website's
// per-candidate yes/**maybe**/no has no third state in a picker. Rather than
// quietly flattening a maybe into a yes (or a silence into a no), the DM says
// so in one line, and an unpicked candidate records no vote at all.
const VOTE_NUANCE = "\nPick every night that works. Anything you don't pick is left blank, not refused -- open it on the site if you want to mark a maybe.";

// The controls for a DM about something with a settled time -- an invite to a
// fixed-time event, a reminder, or a poll that has resolved into one. All
// three ask the same question, so all three get the same three buttons.
// occurrenceDate is '' for a non-recurring event or a poll (specs/0014: polls
// have no occurrences of their own until stage 3's fan-out).
function rsvpControls(event: EventShape, occurrenceDate: string): unknown[] {
  return rsvpButtons(event.id, occurrenceDate);
}

// A recurring event's invite DM keeps its bare series link (specs/0005,
// decision 6a), but its RSVP buttons need one concrete occurrence to target
// -- there's no such thing as an occurrence-less event_attendance row. Rather
// than drop the buttons (a visible regression: a working control
// disappearing), this targets the series' next upcoming occurrence, the same
// default the website falls back to for a bare /events/:id link (decision
// 6b) -- so the button's outward behaviour is unchanged, only its previously
// implicit scope now has to be named.
//
// null means "couldn't determine one" (no budget left, or the series has
// already ended) -- callers must render no buttons rather than guess '',
// which recordRsvp would reject outright for a recurring event.
async function inviteOccurrenceDate(
  env: Env,
  budget: TickBudget,
  eventId: string,
  isRecurring: boolean,
  cache: Map<string, string | null>,
): Promise<string | null> {
  if (!isRecurring) return '';
  const cached = cache.get(eventId);
  if (cached !== undefined) return cached;
  if (!budget.trySpend(1)) {
    cache.set(eventId, null);
    return null;
  }
  const event = await env.DB.prepare(`SELECT * FROM events WHERE id = ?`).bind(eventId).first<EventRow>();
  if (!event) {
    cache.set(eventId, null);
    return null;
  }
  const overrides = await loadOverridesForEvents(env, [eventId]);
  const occurrences = await expandOccurrencesForEvent(
    env,
    event,
    Date.now(),
    Date.now() + 366 * DAY_MS,
    overrides.get(eventId) ?? [],
  );
  const date = occurrences[0]?.date ?? null;
  cache.set(eventId, date);
  return date;
}

async function sweepNewInvites(env: Env, budget: TickBudget): Promise<void> {
  const now = Date.now();
  if (budget.exhausted) return;
  // Two fixes over the previous version, both in the WHERE clause:
  //
  // 1. It joins membership. This sweep discloses a private event's title and
  //    link by DM, and it was the one recipient query with no guild check at
  //    all -- an invite row left over from before someone left the server was
  //    enough to keep receiving them.
  // 2. It selects rows that are pending *and due*, not only rows with no log
  //    entry. Under the outbox model a transient failure leaves a pending
  //    row behind, and `nl.id IS NULL` would never match it again -- the
  //    first failed invite DM was the last one anyone would ever get.
  // 3. It skips the organizer's own row. Idea 26 gives every organizer an
  //    `event_invites` row, and without this that row is indistinguishable
  //    from a real invite -- so every organizer would be DM'd "You've been
  //    invited to <the event you created>", once per event they have ever
  //    run, the first time the sweep saw the backfilled rows.
  // 4. It does not invite anyone to vote on a poll that has already settled
  //    (IDEAS item 50). `status != 'cancelled'` alone is right for a
  //    fixed-time event -- "you're invited to this thing on Thursday" is true
  //    whatever the event's status -- but for a poll it is not: the DM says
  //    "you've been invited to vote on X" about a question with an answer,
  //    and since v0.5 it carries a select whose only possible reply is
  //    "Voting is closed for this event". A control that exists only to
  //    refuse.
  //
  //    It half-healed itself, which is what kept it hidden:
  //    sweepSingleWinnerPollNotifications runs *before* this sweep, so tick N
  //    sent the stale invite and recorded its message id, and tick N+1's
  //    edit-on-resolve rewrote it into "is settled: ...". The wrong DM
  //    existed for about fifteen minutes and then quietly became the right
  //    one -- so anyone looking later saw nothing wrong.
  const { results } = await env.DB.prepare(
    `SELECT ei.event_id, ei.user_id, e.title, e.event_type, e.window_block_minutes, e.is_recurring,
            u.notifications_enabled, u.dm_channel_id, u.timezone
     FROM event_invites ei
     JOIN events e ON e.id = ei.event_id
     JOIN users u ON u.id = ei.user_id
     JOIN user_guild_membership m
       ON m.user_id = ei.user_id AND m.guild_id = e.guild_id AND m.is_member = 1 AND m.verified_at >= ?
     JOIN guilds g ON g.id = m.guild_id AND g.is_active = 1
     LEFT JOIN notification_log nl
       ON nl.user_id = ei.user_id AND nl.event_id = ei.event_id
       AND nl.notification_type = 'invite' AND nl.occurrence_date = ''
     WHERE e.status != 'cancelled'
       AND NOT (e.event_type = 'poll' AND e.status != 'active')
       AND ei.user_id != e.organizer_id
       AND (
         nl.id IS NULL
         OR (nl.delivered_at IS NULL AND nl.failed_at IS NULL
             AND nl.attempt_count < ?
             AND (nl.claimed_until IS NULL OR nl.claimed_until < ?)
             AND (nl.next_attempt_at IS NULL OR nl.next_attempt_at <= ?))
       )
     ORDER BY ei.event_id, ei.user_id
     LIMIT ?`,
  )
    // The LIMIT is the point: this is the one sweep whose candidate set spans
    // every event at once, so it is where a large install's whole invite
    // backlog arrives in a single result set. Asking only for as many as the
    // tick could possibly deliver keeps that bounded; the deterministic ORDER
    // BY plus the fact that delivered rows drop out of the WHERE means
    // successive ticks work steadily through the backlog instead of
    // re-reading the same prefix.
    .bind(membershipCutoff(), MAX_DELIVERY_ATTEMPTS, now, now, budget.deliveriesAffordable)
    .all<
      {
        event_id: string;
        user_id: string;
        title: string;
        event_type: EventRow['event_type'];
        window_block_minutes: number | null;
        is_recurring: number;
      } & Omit<ParticipantRow, 'id'>
    >();

  // Rows arrive grouped by event, so one poll's candidates -- or one
  // recurring event's next occurrence -- are fetched once and reused for
  // every invitee of it in this tick.
  const candidateCache = new Map<string, PollCandidate[] | null>();
  const occurrenceDateCache = new Map<string, string | null>();

  for (const row of results) {
    if (budget.exhausted) return;
    try {
      const user = {
        id: row.user_id,
        notifications_enabled: row.notifications_enabled,
        dm_channel_id: row.dm_channel_id,
        timezone: row.timezone,
      };
      const event: EventShape = {
        id: row.event_id,
        event_type: row.event_type,
        window_block_minutes: row.window_block_minutes,
      };
      // An invitation asks two different questions depending on what it is
      // inviting you to: "are you coming?" for a fixed time, "which of these
      // works?" for a poll.
      const isOpenPoll = row.event_type === 'poll';
      let controls: unknown[] | null;
      if (isOpenPoll) {
        controls = voteControls(event, await pollCandidates(env, budget, row.event_id, candidateCache), env, row.timezone);
      } else {
        const rsvpDate = await inviteOccurrenceDate(env, budget, row.event_id, !!row.is_recurring, occurrenceDateCache);
        controls = rsvpDate !== null ? rsvpControls(event, rsvpDate) : [];
      }
      const body = isOpenPoll
        ? `You've been invited to vote on "${row.title}" on Uncle Owen.${VOTE_NUANCE}\n${eventLink(env, row.event_id)}`
        : `You've been invited to "${row.title}" on Uncle Owen.\n${eventLink(env, row.event_id)}`;

      await notifyOnce(env, budget, user, row.event_id, 'invite', '', body, controls);
    } catch (err) {
      console.error(`sweepNewInvites failed for event ${row.event_id}/user ${row.user_id}:`, err);
    }
  }
}

// Invitee change requests (docs/specs/0003-event-change-requests.md).

function requesterDisplayName(username: string, globalName: string | null): string {
  return globalName || username;
}

async function notifyChangeRequestOnce(
  env: Env,
  budget: TickBudget,
  user: ParticipantRow,
  requestId: string,
  notificationType: 'change_request_opened' | 'change_request_decision',
  content: string,
): Promise<void> {
  await deliverThroughOutbox(
    env,
    'change_request_log',
    { request_id: requestId, user_id: user.id, notification_type: notificationType },
    user,
    content,
    budget,
  );
}

// Both notification types from event_change_requests, in one query rather
// than two -- see budget.ts's RESERVED_QUERIES: every sweep here costs at
// least one fixed query even when it finds nothing to do, and this is one
// less than the naive "one sweep per notification type" split would have
// cost every tick, forever, for a feature most guilds will rarely use.
//
// The two branches share nothing structurally (different recipient sets,
// different source predicates) so they're combined as a discriminated
// UNION ALL rather than factored into shared SQL -- `kind_notif` says which
// one a row is, and the columns each branch doesn't use are NULL.
//
// "opened" notifies the organizer of every new request, and every other
// current invitee when it's a time_change (they're being asked to vote).
// "decision" notifies the requester once their own request is decided
// (withdrawn excluded -- that's self-initiated, there's no one to tell).
// Both are shaped like sweepNewInvites -- one flat, uncursored global scan
// -- for the same reason: the predicate only shrinks as rows are delivered,
// it never re-admits a delivered row the way a time-windowed sweep's can.
// See the spec's "Cron changes" section for why that means no
// source-independent retry consumer is needed here either.
async function sweepChangeRequestNotifications(env: Env, budget: TickBudget): Promise<void> {
  if (budget.exhausted) return;
  const now = Date.now();
  const cutoff = membershipCutoff();
  const { results } = await env.DB.prepare(
    `WITH opened_recipients AS (
       SELECT ecr.id AS request_id, e.organizer_id AS user_id, 1 AS is_organizer
       FROM event_change_requests ecr JOIN events e ON e.id = ecr.event_id
       UNION
       SELECT ecr.id AS request_id, ei.user_id AS user_id, 0 AS is_organizer
       FROM event_change_requests ecr
       JOIN event_invites ei ON ei.event_id = ecr.event_id
       WHERE ecr.kind = 'time_change' AND ei.user_id != ecr.requester_id
     )
     SELECT 'change_request_opened' AS kind_notif, r.request_id, r.user_id, r.is_organizer,
            ecr.kind, ecr.event_id, e.title, ecr.proposed_start_at,
            req.username AS requester_username, req.global_name AS requester_global_name,
            NULL AS status, NULL AS decision_note,
            u.notifications_enabled, u.dm_channel_id, u.timezone
     FROM opened_recipients r
     JOIN event_change_requests ecr ON ecr.id = r.request_id
     JOIN events e ON e.id = ecr.event_id
     JOIN users req ON req.id = ecr.requester_id
     JOIN users u ON u.id = r.user_id
     JOIN user_guild_membership m ON m.user_id = u.id AND m.guild_id = e.guild_id AND m.is_member = 1 AND m.verified_at >= ?
     JOIN guilds g ON g.id = e.guild_id AND g.is_active = 1
     LEFT JOIN change_request_log crl
       ON crl.request_id = r.request_id AND crl.user_id = r.user_id AND crl.notification_type = 'change_request_opened'
     WHERE (
       crl.id IS NULL
       OR (crl.delivered_at IS NULL AND crl.failed_at IS NULL AND crl.attempt_count < ?
           AND (crl.claimed_until IS NULL OR crl.claimed_until < ?) AND (crl.next_attempt_at IS NULL OR crl.next_attempt_at <= ?))
     )

     UNION ALL

     SELECT 'change_request_decision' AS kind_notif, ecr.id AS request_id, ecr.requester_id AS user_id, 0 AS is_organizer,
            ecr.kind, ecr.event_id, e.title, NULL AS proposed_start_at,
            '' AS requester_username, NULL AS requester_global_name,
            ecr.status, ecr.decision_note,
            u.notifications_enabled, u.dm_channel_id, u.timezone
     FROM event_change_requests ecr
     JOIN events e ON e.id = ecr.event_id
     JOIN users u ON u.id = ecr.requester_id
     JOIN user_guild_membership m ON m.user_id = u.id AND m.guild_id = e.guild_id AND m.is_member = 1 AND m.verified_at >= ?
     JOIN guilds g ON g.id = e.guild_id AND g.is_active = 1
     LEFT JOIN change_request_log crl
       ON crl.request_id = ecr.id AND crl.user_id = ecr.requester_id AND crl.notification_type = 'change_request_decision'
     WHERE ecr.status IN ('accepted','declined')
       AND (
         crl.id IS NULL
         OR (crl.delivered_at IS NULL AND crl.failed_at IS NULL AND crl.attempt_count < ?
             AND (crl.claimed_until IS NULL OR crl.claimed_until < ?) AND (crl.next_attempt_at IS NULL OR crl.next_attempt_at <= ?))
       )
     ORDER BY request_id, user_id
     LIMIT ?`,
  )
    .bind(
      cutoff, MAX_DELIVERY_ATTEMPTS, now, now,
      cutoff, MAX_DELIVERY_ATTEMPTS, now, now,
      budget.deliveriesAffordable,
    )
    .all<
      {
        kind_notif: 'change_request_opened' | 'change_request_decision';
        request_id: string;
        user_id: string;
        is_organizer: number;
        kind: 'time_change' | 'add_invitee';
        event_id: string;
        title: string;
        proposed_start_at: number | null;
        requester_username: string;
        requester_global_name: string | null;
        status: 'accepted' | 'declined' | null;
        decision_note: string | null;
      } & Omit<ParticipantRow, 'id'>
    >();

  for (const row of results) {
    if (budget.exhausted) return;
    const user: ParticipantRow = {
      id: row.user_id,
      notifications_enabled: row.notifications_enabled,
      dm_channel_id: row.dm_channel_id,
      timezone: row.timezone,
    };

    let content: string;
    if (row.kind_notif === 'change_request_opened') {
      const requesterName = requesterDisplayName(row.requester_username, row.requester_global_name);
      if (row.kind === 'time_change') {
        const when = formatWhen(row.proposed_start_at!, user.timezone);
        content = row.is_organizer
          ? `${requesterName} asked to move "${row.title}" to ${when}.\n${eventLink(env, row.event_id)}`
          : `${requesterName} proposed moving "${row.title}" to ${when} -- vote here:\n${eventLink(env, row.event_id)}`;
      } else {
        content = `${requesterName} asked to invite someone to "${row.title}".\n${eventLink(env, row.event_id)}`;
      }
    } else {
      content =
        row.status === 'accepted'
          ? `Your request on "${row.title}" was accepted.\n${eventLink(env, row.event_id)}`
          : `Your request on "${row.title}" was declined.${row.decision_note ? ` ${row.decision_note}` : ''}\n${eventLink(env, row.event_id)}`;
    }

    try {
      await notifyChangeRequestOnce(env, budget, user, row.request_id, row.kind_notif, content);
    } catch (err) {
      console.error(`sweepChangeRequestNotifications failed for request ${row.request_id}/user ${row.user_id}:`, err);
    }
  }
}

// Mirrors sweepPollDeadlines -- resolves any time_change vote whose deadline
// has passed, before the notification sweeps above run so the requester's
// decision DM goes out in the same tick where possible.
async function sweepChangeRequestDeadlines(env: Env, budget: TickBudget): Promise<void> {
  await resolvePastDeadlineChangeRequests(env, budget);
}

// A generous upper bound on the gap between one occurrence and the next,
// used only to size how far back ladderFloorFor looks for a predecessor --
// not the actual cadence, which expandOccurrences already computes exactly.
// MONTHLY's 31-day figure is deliberately loose (a monthly rule's true gap
// can be 28-31 days) since overshooting the lookback costs nothing but a
// slightly wider expandOccurrences call, while undershooting it would miss
// a real predecessor and wrongly treat an occurrence as a series' first.
function nominalGapMs(rule: RecurrenceRule): number {
  const interval = Math.max(1, rule.interval);
  if (rule.freq === 'DAILY') return interval * DAY_MS;
  if (rule.freq === 'WEEKLY') return interval * 7 * DAY_MS;
  return interval * 31 * DAY_MS;
}

// Decision 7: a recurring occurrence's ladder can't start until 24 hours
// after the *previous* occurrence ended -- otherwise a daily event would run
// several ladders in flight at once, one per occurrence inside the widened
// 96-hour window. Found by looking backward from the candidate occurrence
// over a window sized from the rule's own cadence (expandOccurrences already
// skips a cancelled date without pushing a result for it, so a cancelled
// predecessor is correctly looked past), capped to [7, 90] days so a long
// cancellation streak or a series' very first occurrence still resolves in
// one bounded call rather than an unbounded walk back through the rule.
//
// No predecessor found within that window -> event.created_at, standing in
// for "no predecessor exists" (a series' first occurrence, per the spec:
// "its ladder starts when the invitation is sent"). That only ever makes the
// ladder MORE eager, never silent -- the direction to err in if this cap is
// ever wrong for some rule shape.
function ladderFloorFor(
  event: EventRow,
  rule: RecurrenceRule,
  overrides: OverrideRow[],
  occ: { startAt: number },
): number {
  const gap = nominalGapMs(rule);
  const lookback = Math.min(Math.max(gap * 4, 7 * DAY_MS), 90 * DAY_MS);
  const predecessors = expandOccurrences(rule, event.timezone, occ.startAt - lookback, occ.startAt - 1, overrides);
  const prev = predecessors[predecessors.length - 1];
  return prev ? prev.endAt + 24 * HOUR_MS : event.created_at;
}

// Decision 2: the ladder only ever asks about the next occurrence. Per event
// per tick, only ever the earliest occurrence the (already widened-to-96h)
// window returns is considered -- if its floor hasn't cleared yet, the whole
// event is skipped this tick rather than falling through to a later
// occurrence in the same window. That silence is correct behaviour, not a
// bug to work around: it's decision 7 doing its job of keeping a daily event
// from running several ladders simultaneously. Occurrence floors are
// monotone along a normal series (each is built from the one before it), so
// checking only occurrences[0] is sufficient without walking the rest -- the
// one documented exception is an organizer manually dragging one occurrence
// earlier than its predecessor's original end via a per-occurrence override,
// whose worst case is one mis-gated tick for that one pair, not worth a full
// walk to close.
function activeOccurrence(
  occurrences: { date: string; startAt: number; endAt: number }[],
  event: EventRow,
  rule: RecurrenceRule,
  overrides: OverrideRow[],
  now: number,
): { date: string; startAt: number; endAt: number } | null {
  const next = occurrences[0];
  if (!next) return null;
  const floor = ladderFloorFor(event, rule, overrides, next);
  return floor <= now ? next : null;
}

// One occurrence's whole ladder pass: which rungs (if any) are due, the one
// query that finds who's due which, and the sends themselves -- grouped by
// status since each status's rung has its own notification_type, wording and
// button set. Shared between sweepReminders' single-event and recurring
// branches so the sequence can't drift between them the way reminderFor +
// pendingRecipients + notifyPending used to be duplicated across both.
//
// Returns whether every recipient this occurrence currently owes a rung to
// was reached (vs. the tick simply running out) -- the single-event branch's
// cursor bookkeeping needs to tell those apart the same way it already does
// for today's plain reminders.
async function sweepLadderOccurrence(
  env: Env,
  budget: TickBudget,
  event: EventRow,
  occ: { date: string; startAt: number; endAt: number },
): Promise<boolean> {
  const now = Date.now();
  const unanswered = ladderRungFor('unanswered', occ.startAt, now);
  const maybe = ladderRungFor('tentative', occ.startAt, now);
  const accepted = ladderRungFor('accepted', occ.startAt, now);
  if (!unanswered && !maybe && !accepted) return true;

  const limit = budget.deliveriesAffordable;
  if (limit <= 0) return false;
  if (!budget.trySpend(SCAN_COST_PER_EVENT)) return false;

  const isWindowed = event.event_type === 'poll' && event.window_block_minutes != null;
  const recipients = await pendingLadderRecipients(
    env,
    event,
    occ.date,
    isWindowed,
    { unanswered: unanswered?.type ?? null, tentative: maybe?.type ?? null, accepted: accepted?.type ?? null },
    limit,
  );

  const byStatus: Record<LadderStatus, LadderStatusRow[]> = { unanswered: [], tentative: [], accepted: [] };
  for (const r of recipients) byStatus[r.effective_status].push(r);

  const buckets: [LadderStatus, LadderRung | null][] = [
    ['unanswered', unanswered],
    ['tentative', maybe],
    ['accepted', accepted],
  ];
  for (const [status, rung] of buckets) {
    if (!rung || byStatus[status].length === 0) continue;
    await notifyPending(
      env,
      budget,
      byStatus[status],
      event.id,
      rung.type,
      occ.date,
      (user) => `"${event.title}" ${rung.render(user, occ.startAt)}.\n${eventLink(env, event.id)}`,
      () => rsvpButtons(event.id, occ.date, rung.buttons),
    );
  }

  return limit > 0 && recipients.length < limit && !budget.exhausted;
}

async function sweepReminders(env: Env, budget: TickBudget, cursors: CursorStore): Promise<void> {
  const now = Date.now();
  // specs/0014's farthest rung is 96h, not 24h -- both branches below widen
  // to it. The single-event query's own WHERE start_at <= windowEnd needs
  // this exactly as much as the recurring branch's expansion window does: a
  // fixed-time event 90 hours out would never even be *selected* under the
  // old 24h ceiling, so its 96h rung could never fire.
  const windowEnd = now + LADDER_FARTHEST_HOURS * HOUR_MS;

  // Ordered by start time so the most urgent reminders are attempted first,
  // and resumed from a keyset cursor so a backlog larger than one tick's
  // allowance rotates instead of the same prefix winning every tick forever.
  //
  // The comparison is spelled out rather than written as a row-value
  // `(start_at, id) > (?, ?)` so it does not depend on the SQLite build
  // supporting row values.
  const after = decodeEventKey(cursors.get('reminders_single'));
  const { results: singleEvents } = await env.DB.prepare(
    `SELECT * FROM events
     WHERE is_recurring = 0 AND status IN ('active','resolved')
       AND start_at IS NOT NULL AND start_at >= ? AND start_at <= ?
       AND (? IS NULL OR start_at > ? OR (start_at = ? AND id > ?))
     ORDER BY start_at, id
     LIMIT ?`,
  )
    .bind(
      now,
      windowEnd,
      after ? 1 : null,
      after?.startAt ?? 0,
      after?.startAt ?? 0,
      after?.id ?? '',
      SINGLE_EVENT_PAGE_SIZE,
    )
    .all<EventRow>();

  let lastKey: string | null = null;
  let stoppedEarly = false;
  for (const event of singleEvents) {
    // No separate scan charge here: sweepLadderOccurrence charges
    // SCAN_COST_PER_EVENT itself, once, only when a rung is actually due
    // (the recurring branch below relies on that same single charge, with
    // no outer one of its own -- a second charge here would double-bill
    // exactly the events that also cost the recurring branch nothing extra).
    // An event with nothing due this tick costs nothing to consider.
    //
    // Whether every recipient this event currently owes a reminder to was
    // reached, not just the prefix this tick could afford. A page capped at
    // `limit` and a `limit` of zero both mean "more may be pending, this
    // tick just couldn't find out" -- either way the cursor must not pass
    // this event, or a large event's un-sent tail (287 of 300 recipients, in
    // the reported case) gets skipped past and isn't revisited until the
    // whole scan wraps back around, roughly a day later at this cadence,
    // possibly after the reminder's own window has expired.
    let recipientsSettled = true;
    try {
      // A non-recurring event has no predecessor by construction, so
      // sweepLadderOccurrence's floor gate is never in play here -- passed
      // through the same helper as the recurring branch regardless, so the
      // rung/query/send sequence can't drift between the two.
      recipientsSettled = await sweepLadderOccurrence(env, budget, event, {
        date: '',
        startAt: event.start_at!,
        endAt: event.end_at ?? event.start_at!,
      });
    } catch (err) {
      console.error(`sweepReminders (single) failed for event ${event.id}:`, err);
    }
    if (!recipientsSettled) {
      stoppedEarly = true;
      break;
    }
    // Recorded even when the event needed no reminder: it *was* processed,
    // and leaving it out would make the next tick start from it again.
    lastKey = encodeEventKey({ startAt: event.start_at!, id: event.id });
  }

  // A short page means the scan reached the end of the result set, so the
  // next tick starts a fresh pass. A full page proves nothing either way --
  // inferring the end from it is what made the old cursor reset to zero and
  // never reach anything past the first page -- so the cursor simply stays at
  // the last key processed and the following tick continues from there.
  const reachedEnd = !stoppedEarly && singleEvents.length < SINGLE_EVENT_PAGE_SIZE;
  cursors.set('reminders_single', reachedEnd ? null : lastKey);

  await forEachRecurringPage(env, budget, cursors, 'reminders_recurring', `SELECT * FROM events WHERE is_recurring = 1 AND status = 'active'`, async (event, overrides, rule) => {
    // Defensive: a truly recurring event should always have a matching rule
    // row. If the preload somehow found none, skip this event for the
    // ladder rather than guess at a floor with nothing to compute it from --
    // the same "silence is fine, not a bug" reasoning activeOccurrence's own
    // floor gate relies on.
    if (!rule) return;
    const occurrences = await expandOccurrencesForEvent(env, event, now, windowEnd, overrides, rule);
    // Decision 2: only ever the next occurrence, gated by decision 7's
    // floor -- never the whole widened window, which is what makes a daily
    // event's up-to-4 candidate dates collapse to at most one ladder pass
    // per tick rather than one per occurrence.
    const occ = activeOccurrence(occurrences, event, rule, overrides, now);
    if (!occ) return;
    try {
      await sweepLadderOccurrence(env, budget, event, occ);
    } catch (err) {
      console.error(`sweepReminders (recurring) failed for event ${event.id}:`, err);
    }
  });
}

// Walks a recurring-event query in pages, preloading each page's occurrence
// overrides *and* recurrence rules, and isolating failures at both levels:
// one bad event skips only itself, and one bad page (including its preloads)
// skips only that page. The previous shape -- one global preload for every
// recurring event in the database, outside the loop's try/catch -- meant that
// query failing aborted the whole sweep before any event was processed.
//
// Preloading the *rules* matters as much as the overrides: without it each
// event fell back to its own recurrence-rule query inside
// expandOccurrencesForEvent, so a hundred recurring events cost a hundred
// queries here -- past the whole Free-plan per-invocation allowance before
// any participant lookup or delivery had happened.
async function forEachRecurringPage(
  env: Env,
  budget: TickBudget,
  cursors: CursorStore,
  cursorName: CursorName,
  sql: string,
  handle: (event: EventRow, overrides: OverrideRow[], rule: RecurrenceRule | undefined) => Promise<void>,
): Promise<void> {
  // Resumes where the last tick stopped. Without this the scan restarts at
  // zero every time, and once there are more recurring events than one tick's
  // allowance covers, everything past that prefix is never reached at all --
  // deferral turns into permanent starvation. See migration 0010.
  // Keyset, not OFFSET: these scans' result sets change between ticks as
  // events are created, cancelled or purged, and an offset counted against
  // one tick's set points somewhere else in the next one's. Resuming after
  // the last id actually processed is stable under all of that.
  let afterId = cursors.get(cursorName);

  for (;;) {
    // Paging itself costs a query per page, so an exhausted tick stops
    // walking rather than reading pages it can't act on.
    if (!budget.trySpend(1)) {
      cursors.set(cursorName, afterId);
      return;
    }
    const { results: page } = await env.DB.prepare(
      `${sql} AND (? IS NULL OR id > ?) ORDER BY id LIMIT ?`,
    )
      .bind(afterId, afterId ?? '', RECURRING_PAGE_SIZE)
      .all<EventRow>();
    // End of the scan: wrap so the next tick starts a fresh pass. Reaching
    // here from a non-null cursor is normal -- the pass simply began partway
    // through and the following one will cover what it skipped.
    if (page.length === 0) {
      cursors.set(cursorName, null);
      return;
    }

    // Each page runs two more scalable reads beyond the page SELECT itself
    // -- occurrence overrides and recurrence rules -- and both were
    // previously free as far as the budget was concerned. A page charged one
    // query but spent three, so twelve pages (600 recurring events at the
    // configured per-guild cap) actually cost 36 D1 queries while the budget
    // believed it had spent 12. Charged here, before either preload runs, so
    // an exhausted tick stops rather than running work it can't afford and
    // only noticing afterward.
    if (!budget.trySpend(2)) {
      cursors.set(cursorName, afterId);
      return;
    }

    try {
      const pageIds = page.map((e) => e.id);
      const overridesByEvent = await loadOverridesForEvents(env, pageIds);
      const rulesByEvent = await loadRecurrenceRulesForEvents(env, pageIds);
      for (const event of page) {
        if (budget.exhausted) {
          cursors.set(cursorName, afterId);
          return;
        }
        try {
          await handle(event, overridesByEvent.get(event.id) ?? [], rulesByEvent.get(event.id));
        } catch (err) {
          console.error(`recurring sweep failed for event ${event.id}:`, err);
        }
        // `handle` can itself run out of budget partway through an event's
        // occurrences/recipients (a recurring event can carry the same
        // hundreds-of-invitees fanout a single event can) and simply stop,
        // the same way notifyPending does. If it left the tick
        // exhausted, this event cannot be assumed done -- advancing past it
        // anyway is exactly the single-event cursor bug this budget check
        // exists to avoid, just for the recurring scan. Not advancing means
        // the next tick resumes on this same event with a fresh allowance;
        // whichever recipients already got a notification_log row this pass
        // are excluded from it the next time around.
        if (budget.exhausted) {
          cursors.set(cursorName, afterId);
          return;
        }
        afterId = event.id;
      }
    } catch (err) {
      // The page's own preloads failed, so no event on it was processed.
      // Skip past it rather than retrying it forever -- the next pass will
      // come back around to these events.
      console.error(`recurring sweep failed for page after id ${afterId}:`, err);
      afterId = page[page.length - 1].id;
    }

    if (page.length < RECURRING_PAGE_SIZE) {
      cursors.set(cursorName, null);
      return;
    }
  }
}

// Transitions any polls whose deadline has passed (threshold not reached in
// time, or window/most-votes polls that only resolve at the deadline).
// Notification is handled separately below, decoupled from *when* a poll
// resolves -- single_winner/window polls often resolve synchronously the
// moment a vote crosses the threshold, well before any deadline, and that
// path needs to be notified too, not just the deadline-driven one.
async function sweepPollDeadlines(env: Env, budget: TickBudget): Promise<void> {
  await resolvePastDeadlinePolls(env, budget);
}

// specs/0010's edit-on-resolve, and what migration 0022's message id was for.
//
// When a poll settles, the DM that asked people to vote is still sitting in
// their client offering a vote. This rewrites it in place: the confirmed time
// (or the fact that it was cancelled) and, for a resolved poll, the RSVP
// buttons -- because the question has changed from "which night" to "are you
// coming".
//
// Three properties this path has to have, all of them about *not* mattering
// too much:
//
//   * It is charged to the budget explicitly, like every other outbound call.
//     An unbudgeted subrequest per recipient is precisely what the Pass 9
//     review found.
//   * It ranks below the notification. A tick that can afford one of the two
//     sends the new DM and leaves the old message alone: a stale vote control
//     next to a fresh "it's confirmed for Thursday" is survivable, a missing
//     DM is not. That ordering is why this runs after notifyPending in each
//     caller, and why it stops the moment the budget says so.
//   * A failed edit is not retried into the ground. 404 and 403 are ordinary
//     here (see editBotDm), so the row is marked as attempted and left alone;
//     only a 5xx or a network failure is left for the next tick.
// `render`/`controls` are supplied by the caller rather than derived here,
// because what a settled poll's DM should say and offer is not one rule --
// single_winner has a settled time (per-recipient timezone) and RSVP
// buttons once resolved; multi_winner (specs/0014 stage 3) never has its
// own start_at at all (only its options do) and, once a confirmed day fans
// out into a real event, offering RSVP on the *poll's* own DM is not just
// redundant but wrong -- a decline there cannot mean "which day". Before
// this split, multi_winner always fell through to editSettledPollDms' old
// "was cancelled" text even when genuinely resolved, because that text's
// own condition (`start_at != null`) can never be true for a multi_winner
// event -- found while building the fan-out this same release adds.
async function editSettledPollDms(
  env: Env,
  budget: TickBudget,
  event: EventRow,
  render: (timezone: string) => string,
  controls: unknown[] | null,
): Promise<void> {
  if (budget.exhausted) return;
  if (!budget.trySpend(1)) return;

  // The invite DM is the one that carried the vote control. Rows with no
  // message id are skipped in the query rather than fetched and discarded:
  // every delivery predating migration 0022 has none, and there is nothing to
  // do about those.
  const { results: rows } = await env.DB.prepare(
    `SELECT nl.id, nl.message_id, u.id AS user_id, u.dm_channel_id, u.timezone
     FROM notification_log nl
     JOIN users u ON u.id = nl.user_id
     WHERE nl.event_id = ? AND nl.notification_type = 'invite'
       AND nl.message_id IS NOT NULL AND nl.message_edited_at IS NULL
       AND u.dm_channel_id IS NOT NULL
     ORDER BY nl.id
     LIMIT ?`,
  )
    .bind(event.id, Math.max(0, budget.deliveriesAffordable))
    .all<{ id: string; message_id: string; user_id: string; dm_channel_id: string; timezone: string }>();

  for (const row of rows) {
    // One subrequest for the PATCH plus one statement to record it, which is
    // what a cached-channel delivery costs -- so it is reserved the same way
    // rather than through a second accounting path.
    if (!budget.reserveDelivery(true)) return;

    const result = await editBotDm(
      env.DISCORD_BOT_TOKEN,
      row.dm_channel_id,
      row.message_id,
      render(row.timezone),
      controls,
    );

    if (!result.ok && result.retryable) continue;

    // Marked on success *and* on a permanent failure: a 403 from the wrong
    // application will be a 403 forever, and re-attempting it every fifteen
    // minutes would spend the allowance on a call that cannot succeed.
    await env.DB.prepare(`UPDATE notification_log SET message_edited_at = ? WHERE id = ?`)
      .bind(Date.now(), row.id)
      .run();
  }
}

// Covers every resolved/cancelled single_winner (incl. window-mode) poll,
// regardless of whether it resolved synchronously via threshold or via the
// deadline sweep above -- notifyOnce's dedupe makes it safe to re-scan all
// of them every tick rather than track "which ones are new".
async function sweepSingleWinnerPollNotifications(
  env: Env,
  budget: TickBudget,
  cursors: CursorStore,
): Promise<void> {
  await forEachGlobalRow<EventRow>(
    env,
    budget,
    cursors,
    'single_winner_polls',
    `SELECT * FROM events
     WHERE event_type = 'poll' AND poll_resolution_mode = 'single_winner' AND status IN ('resolved','cancelled')
       AND updated_at >= ?`,
    [terminalHistoryHotCutoff()],
    async (event) => {
      const limit = budget.deliveriesAffordable;
      const pending = await pendingRecipients(env, event, 'poll_resolved', '', limit);
      await notifyPending(
        env,
        budget,
        pending,
        event.id,
        'poll_resolved',
        '',
        (user) =>
          event.status === 'resolved'
            ? `"${event.title}" is on! Time locked in: ${
                event.window_block_minutes != null
                  ? formatSpan(event.start_at!, event.end_at!, user.timezone)
                  : formatWhen(event.start_at!, user.timezone)
              }.\n${eventLink(env, event.id)}`
            : `"${event.title}" didn't get enough votes and was cancelled.`,
        // The poll question is settled, so this DM asks the *next* one: now
        // that there is a time, are you coming? A cancelled poll asks nothing
        // and carries no controls -- there is nothing left to answer.
        () => (event.status === 'resolved' ? rsvpControls(event, '') : null),
      );
      // A full page of recipients means there may be more behind it, and an
      // exhausted budget means we stopped part-way through the ones we had.
      // Either way this row is not finished.
      if (pending.length >= limit || budget.exhausted) return 'incomplete';

      // specs/0014's window-poll state 2: someone submitted availability
      // that doesn't cover the span that actually won. The resolution
      // algorithm optimises most-people-then-longest, so this is routine,
      // and before this it was silent -- getConfirmedAttendeeIds simply
      // excluded them and nothing ever said why. One-shot, not a repeating
      // rung: it's a fact about a resolution that already happened, not a
      // countdown to the future. They also read as 'unanswered' for the
      // ladder itself (attendance.ts's ladderStatusCase), so they get the
      // full ladder on top of this -- the two aren't mutually exclusive.
      if (event.status === 'resolved' && event.window_block_minutes != null && event.start_at != null && event.end_at != null) {
        const outsideLimit = budget.deliveriesAffordable;
        if (outsideLimit > 0) {
          const outside = await pendingOutsideHoursRecipients(
            env,
            { id: event.id, guild_id: event.guild_id, start_at: event.start_at!, end_at: event.end_at! },
            outsideLimit,
          );
          await notifyPending(
            env,
            budget,
            outside,
            event.id,
            'ladder_window_outside_hours',
            '',
            (user) =>
              `"${event.title}" landed on ${formatSpan(event.start_at!, event.end_at!, user.timezone)}, which is outside the hours you gave.\n${eventLink(env, event.id)}`,
            () => rsvpButtons(event.id, '', ['accepted', 'declined']),
          );
        }
      }

      // Only once the notifications for this poll are done, so the edit can
      // never take the allowance a DM needed (specs/0010).
      await editSettledPollDms(
        env,
        budget,
        event,
        (timezone) =>
          event.status === 'resolved' && event.start_at != null && event.end_at != null
            ? `"${event.title}" is settled: ${
                event.window_block_minutes != null
                  ? formatSpan(event.start_at, event.end_at, timezone)
                  : formatWhen(event.start_at, timezone)
              }.\n${eventLink(env, event.id)}`
            : `"${event.title}" was cancelled -- voting is closed.\n${eventLink(env, event.id)}`,
        // A cancelled poll asks nothing, so it keeps no controls at all.
        event.status === 'resolved' ? rsvpControls(event, '') : [],
      );
      if (budget.exhausted) return 'incomplete';
    },
  );
}

// specs/0014 window-poll state 2 (see the call site above): everyone who
// submitted availability for this event but whose range doesn't cover the
// span that actually won. Matched on the event, not the winning candidate --
// same reasoning as getConfirmedAttendeeIds' window branch: candidates
// within one poll never overlap in any shape the form can produce, so this
// is unambiguous regardless.
async function pendingOutsideHoursRecipients(
  env: Env,
  event: { id: string; guild_id: string; start_at: number; end_at: number },
  limit: number,
): Promise<ParticipantRow[]> {
  const now = Date.now();
  const { results } = await env.DB.prepare(
    `SELECT u.id, u.notifications_enabled, u.dm_channel_id, u.timezone
     FROM users u
     JOIN user_guild_membership m ON m.user_id = u.id AND m.guild_id = ? AND m.is_member = 1 AND m.verified_at >= ?
     JOIN guilds g ON g.id = m.guild_id AND g.is_active = 1
     ${PENDING_NOTIFICATION_JOIN}
     WHERE u.id IN (
       SELECT user_id FROM event_window_availability
       WHERE event_id = ? AND NOT (avail_start_at <= ? AND avail_end_at >= ?)
     )
     AND ${PENDING_NOTIFICATION_WHERE}
     ORDER BY u.id
     LIMIT ?`,
  )
    .bind(
      event.guild_id,
      membershipCutoff(),
      ...pendingNotificationJoinBinds(event.id, 'ladder_window_outside_hours', ''),
      event.id,
      event.start_at,
      event.end_at,
      ...pendingNotificationWhereBinds(now),
      limit,
    )
    .all<ParticipantRow>();
  return results;
}

// multi_winner events only ever transition out of 'active' via the deadline
// sweep (never synchronously -- individual options confirm independently
// while the event stays active), so this one is safe to drive off "closed
// this tick" the same way sweepPollDeadlines is a one-shot state change.
async function sweepMultiWinnerPollClosedNotifications(
  env: Env,
  budget: TickBudget,
  cursors: CursorStore,
): Promise<void> {
  await forEachGlobalRow<EventRow>(
    env,
    budget,
    cursors,
    'multi_winner_closed',
    `SELECT * FROM events
     WHERE event_type = 'poll' AND poll_resolution_mode = 'multi_winner' AND status IN ('resolved','cancelled')
       AND updated_at >= ?`,
    [terminalHistoryHotCutoff()],
    async (event) => {
      if (!budget.trySpend(1)) return 'incomplete';
      // Per-day confirmations are notified separately (as they happen, to
      // just that day's yes-voters) by sweepConfirmedMultiWinnerOptions --
      // this is just a "voting closed" note to everyone else invited.
      const { results: confirmedCount } = await env.DB.prepare(
        `SELECT COUNT(*) as n FROM event_poll_options WHERE event_id = ? AND confirmed_at IS NOT NULL`,
      )
        .bind(event.id)
        .all<{ n: number }>();
      const n = confirmedCount[0]?.n ?? 0;
      const limit = budget.deliveriesAffordable;
      const pending = await pendingRecipients(env, event, 'poll_resolved', '', limit);
      const message =
        n > 0
          ? `Voting for "${event.title}" has closed. ${n} day(s) got confirmed -- check the event for details.\n${eventLink(env, event.id)}`
          : `"${event.title}" didn't get enough interest on any day and was cancelled.`;
      await notifyPending(env, budget, pending, event.id, 'poll_resolved', '', () => message);
      // A full page of recipients means there may be more behind it, and an
      // exhausted budget means we stopped part-way through the ones we had.
      // Either way this row is not finished.
      if (pending.length >= limit || budget.exhausted) return 'incomplete';

      // The vote control goes away here too, but not before: a multi-winner
      // poll confirms individual days while it is still collecting votes on
      // the others, so its DM stays answerable until the poll itself closes.
      // No RSVP controls, ever, for multi_winner -- unlike single_winner,
      // this event never has its own start_at, and once fan-out gives each
      // confirmed day a real event of its own, "are you coming" belongs on
      // that day's DM, not on the poll's.
      await editSettledPollDms(env, budget, event, () => message, []);
      if (budget.exhausted) return 'incomplete';
    },
  );
}

// specs/0014 stage 3: a confirmed multi-winner day becomes a real,
// standalone event rather than living only as a confirmed
// event_poll_options row with a one-off "you're confirmed" DM and no
// per-occurrence attendance. Once it exists, sweepReminders' ordinary
// single-event path and the ladder pick it up with no special case at all
// -- it is not a poll any more.
//
// The parent's invite list is copied via inviteStatements rather than a raw
// SQL `INSERT ... SELECT`: every id in this app is minted in the Worker
// (lib/ids.ts), never SQL-side, so a literal copy would have no correct way
// to produce fresh invite ids.
async function createFannedOutEvent(
  env: Env,
  budget: TickBudget,
  opt: {
    id: string;
    event_id: string;
    start_at: number;
    end_at: number;
    title: string;
    guild_id: string;
    organizer_id: string;
    timezone: string;
    voice_channel_id: string | null;
    voice_channel_name: string | null;
  },
): Promise<RowOutcome> {
  if (!budget.trySpend(1)) return 'incomplete';
  const { results: parentInvites } = await env.DB.prepare(
    `SELECT user_id, invited_via, source_group_id FROM event_invites WHERE event_id = ?`,
  )
    .bind(opt.event_id)
    .all<{ user_id: string; invited_via: 'individual' | 'group'; source_group_id: string | null }>();

  // Same convention inviteStatements' own comment describes: everyone starts
  // 'pending', only the organizer's row starts 'accepted' -- rsvp_status is
  // vestigial post-specs/0014 either way (real attendance is event_attendance),
  // but the column stays NOT NULL until it is dropped outright.
  const invitees: ResolvedInvitee[] = parentInvites.map((row) => ({
    userId: row.user_id,
    invitedVia: row.invited_via,
    sourceGroupId: row.source_group_id,
    rsvpStatus: row.user_id === opt.organizer_id ? 'accepted' : 'pending',
  }));

  const newEventId = newId();
  const now = Date.now();
  const inviteStmts = inviteStatements(env, newEventId, invitees, true);
  if (!budget.trySpend(1 + inviteStmts.length)) return 'incomplete';

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO events (id, guild_id, organizer_id, title, description, game, event_type, timezone,
         start_at, end_at, status, poll_strategy, poll_threshold_count, poll_deadline_at,
         poll_mode, poll_resolution_mode, window_start_at, window_end_at, window_block_minutes,
         is_recurring, voice_channel_id, voice_channel_name, created_from_poll_id, created_from_option_id,
         created_at, updated_at)
       SELECT ?, ?, ?, ?, NULL, NULL, 'single', ?, ?, ?, 'active', NULL, NULL, NULL,
         'options', 'single_winner', NULL, NULL, NULL, 0, ?, ?, ?, ?, ?, ?
       WHERE NOT EXISTS (SELECT 1 FROM events WHERE created_from_option_id = ?)`,
    ).bind(
      newEventId,
      opt.guild_id,
      opt.organizer_id,
      opt.title,
      opt.timezone,
      opt.start_at,
      opt.end_at,
      opt.voice_channel_id,
      opt.voice_channel_name,
      opt.event_id,
      opt.id,
      now,
      now,
      opt.id,
    ),
    ...inviteStmts,
  ]);
}

// Multi-winner polls confirm individual days as soon as they hit quorum
// (checked synchronously in the vote route), independent of the deadline.
// This sweep fans out each newly-confirmed day into its own event
// (specs/0014 stage 3). The query's own NOT EXISTS keeps the cursor moving
// forward through genuinely new confirmations rather than revisiting settled
// ones forever; the guarded INSERT's separate WHERE NOT EXISTS inside
// createFannedOutEvent is the belt-and-suspenders that makes a second
// concurrent attempt at the same option -- a race between two ticks, not the
// steady state -- a no-op rather than a duplicate event.
async function sweepConfirmedMultiWinnerOptions(
  env: Env,
  budget: TickBudget,
  cursors: CursorStore,
): Promise<void> {
  await forEachGlobalRow<{
    id: string;
    event_id: string;
    start_at: number;
    end_at: number;
    title: string;
    guild_id: string;
    organizer_id: string;
    timezone: string;
    voice_channel_id: string | null;
    voice_channel_name: string | null;
  }>(
    env,
    budget,
    cursors,
    'confirmed_options',
    `SELECT epo.id AS id, epo.event_id, epo.start_at, epo.end_at, e.title, e.guild_id, e.organizer_id,
            e.timezone, e.voice_channel_id, e.voice_channel_name
     FROM event_poll_options epo
     JOIN events e ON e.id = epo.event_id
     WHERE e.poll_resolution_mode = 'multi_winner' AND epo.confirmed_at IS NOT NULL
       AND e.status != 'cancelled'
       AND NOT EXISTS (SELECT 1 FROM events fanned WHERE fanned.created_from_option_id = epo.id)`,
    [],
    (opt) => createFannedOutEvent(env, budget, opt),
    'epo.id',
  );
}

// specs/0014 stage 3, decision 4, both halves of the cascade in one sweep --
// deliberately, the same discipline sweepChangeRequestNotifications already
// established: two separate cursored sweeps would each cost one more fixed
// query on every tick forever, even an empty one, and RESERVED_QUERIES'
// own comment records what that already did once (folding item 47's
// reminders into an existing sweep instead of giving them one of their own,
// because one extra fixed query was measured taking sweepPurgeTerminalHistory
// from "runs every tick" to "never runs at all"). A flat, uncursored UNION
// ALL -- not forEachGlobalRow, which appends its cursor predicate in a way
// that assumes one SELECT, not a union of two -- covers both, matching the
// same "global scan, capped, dedupe makes re-scanning safe" shape
// sweepNewInvites and sweepChangeRequestNotifications already use for a
// population expected to stay small (this is an opt-in field nobody has
// been able to set before this release).
//
// **The prompt half** (`kind = 'prompt'`): a non-recurring event with a
// minimum set, still active, with auto-cancel off. Its own attendance count
// is re-read live rather than cached -- there is no cheaper signal for "is
// this event still below its minimum right now" than asking, and the
// candidate set is exactly the events that opted into this feature, not
// every event in the install.
//
// **The notice half** (`kind = 'notice'`): any cancelled, non-recurring
// event owes a notice to everyone who was still marked as coming (IDEAS
// item 55) -- not just the minimum-attendees cascade's own cancellations
// (automatic, via recordRsvp's guarded UPDATE, or the organizer's own press
// in interactions.ts) but also a plain organizer cancel through
// DELETE /:eventId, which had never told anyone anything since v0.1.
// sendCancelledEventNotice below picks the wording (and notification_type)
// based on whether minimum_attendees is set, so the two don't get the same
// message for different reasons.
//
// Still `is_recurring = 0`: DELETE /:eventId cancels a whole recurring
// series the same way it cancels a one-off, but this app has no settled
// answer yet for what a per-occurrence notice should mean for a series (the
// same "per-occurrence state, not per-occurrence nagging" question
// specs/0014 had to answer for the reminder ladder) -- see IDEAS item 54.
// Recurring cancellations are left exactly as silent as they already were
// rather than guessed at here.
// Its own discovery read is deliberately uncharged against the ledger, the
// same as sweepPurgeTerminalHistory's candidate SELECT just below it: a
// *charged* fixed query here would come out of the same near-zero-margin
// pool that sweep already draws its own delete batch from (measured: 16
// needed, 16 available, before this existed), and RESERVED_QUERIES cannot
// fix that by being bumped to match -- it reduces the starting ledger by
// the same amount this would charge it, so the two cancel out to a net
// *smaller* remainder at the purge, not an unchanged one. That is exactly
// what happened the first time this trap was hit (see RESERVED_QUERIES'
// own comment on item 47) and bumping the reserve "to match" didn't save
// it then either -- the fix was leaving the reserve alone and not adding a
// new charged call site, which is what this does too.
async function sweepCancellationCascade(env: Env, budget: TickBudget): Promise<void> {
  // SELECT * on both halves, not a narrower column list -- UNION ALL
  // requires matching column sets, and the alternative (a narrow projection,
  // cast to EventRow at the call sites below) would be typechecked but not
  // actually true: getConfirmedAttendeeIds branches on event_type and
  // window_block_minutes, and a row that never selected them would silently
  // run the *wrong* branch rather than fail loudly.
  // Each branch wrapped as a subquery, not written as a bare
  // `SELECT ... LIMIT ? UNION ALL SELECT ... LIMIT ?`: SQLite rejects a
  // LIMIT on a non-final UNION ALL arm ("LIMIT clause should come after
  // UNION ALL not before") unless that arm is parenthesized, and this
  // build's SQLite (node:sqlite, same engine the test shim runs against)
  // doesn't accept the parenthesized-compound-select form either -- a
  // newer-SQLite-only grammar addition, not something to rely on D1 having.
  // The subquery wrapping below is the portable version of the same thing.
  // Without either fix this whole sweep threw on every tick, silently,
  // since runIsolated exists precisely to keep one sweep's failure from
  // taking down the rest -- caught only by actually exercising it in a test.
  const { results } = await env.DB.prepare(
    `SELECT * FROM (
       SELECT *, 'prompt' AS kind FROM events
       WHERE status = 'active' AND event_type = 'single' AND is_recurring = 0
         AND minimum_attendees IS NOT NULL AND auto_cancel_below_minimum = 0
       LIMIT ?
     )

     UNION ALL

     SELECT * FROM (
       SELECT *, 'notice' AS kind FROM events
       WHERE status = 'cancelled' AND is_recurring = 0
         AND updated_at >= ?
       LIMIT ?
     )`,
  )
    .bind(GLOBAL_SCAN_LIMIT, terminalHistoryHotCutoff(), GLOBAL_SCAN_LIMIT)
    .all<EventRow & { kind: 'prompt' | 'notice'; minimum_attendees: number | null }>();

  for (const row of results) {
    if (budget.exhausted) return;
    try {
      if (row.kind === 'prompt') {
        // Guaranteed non-null by this arm's own WHERE clause above, unlike
        // the notice arm's rows (a plain cancel has no minimum at all).
        await maybeSendOrganizerCancelPrompt(env, budget, row as EventRow & { minimum_attendees: number });
      } else {
        await sendCancelledEventNotice(env, budget, row);
      }
    } catch (err) {
      console.error(`sweepCancellationCascade failed for event ${row.id} (${row.kind}):`, err);
    }
  }
}

async function maybeSendOrganizerCancelPrompt(
  env: Env,
  budget: TickBudget,
  event: EventRow & { minimum_attendees: number },
): Promise<void> {
  if (!budget.trySpend(1)) return;
  const confirmed = await countConfirmedAttendees(env, event, '');
  if (confirmed >= event.minimum_attendees) return;

  const now = Date.now();
  const recipient = await env.DB.prepare(
    `SELECT u.id, u.notifications_enabled, u.dm_channel_id, u.timezone
     FROM users u
     JOIN user_guild_membership m ON m.user_id = u.id AND m.guild_id = ? AND m.is_member = 1 AND m.verified_at >= ?
     JOIN guilds g ON g.id = m.guild_id AND g.is_active = 1
     ${PENDING_NOTIFICATION_JOIN}
     WHERE u.id = ?
       AND ${PENDING_NOTIFICATION_WHERE}`,
  )
    .bind(
      event.guild_id,
      membershipCutoff(),
      ...pendingNotificationJoinBinds(event.id, 'organizer_cancel_prompt', ''),
      event.organizer_id,
      ...pendingNotificationWhereBinds(now),
    )
    .first<ParticipantRow>();
  if (!recipient) return;

  await notifyPending(
    env,
    budget,
    [recipient],
    event.id,
    'organizer_cancel_prompt',
    '',
    () => `"${event.title}" has dropped below its minimum of ${event.minimum_attendees}. Cancel it?\n${eventLink(env, event.id)}`,
    () => cancelButton(event.id),
  );
}

async function sendCancelledEventNotice(
  env: Env,
  budget: TickBudget,
  event: EventRow & { minimum_attendees: number | null },
): Promise<void> {
  const limit = budget.deliveriesAffordable;
  if (limit <= 0) return;
  // IDEAS item 55: a plain organizer cancel (DELETE /:eventId) gets its own
  // type and wording rather than reusing 'event_cancelled_below_minimum' --
  // that message states a reason ("attendance dropped below the minimum")
  // that isn't true for it, and the two need separate notification_log rows
  // anyway since dedupe is keyed on notification_type.
  const notificationType = event.minimum_attendees != null ? 'event_cancelled_below_minimum' : 'event_cancelled';
  // Deliberately not getConfirmedAttendeeIds' `PendingFor` shape -- that
  // dedupes against a *different* notification's history, which is exactly
  // wrong for "did we already tell you this one is cancelled."
  const pending = await getConfirmedAttendeeIds(env, event, null, '', {
    notificationType,
    occurrenceDate: '',
    limit,
  });
  await notifyPending(
    env,
    budget,
    pending,
    event.id,
    notificationType,
    '',
    () =>
      event.minimum_attendees != null
        ? `"${event.title}" has been cancelled -- attendance dropped below the minimum for it.\n${eventLink(env, event.id)}`
        : `"${event.title}" has been cancelled by the organizer.\n${eventLink(env, event.id)}`,
  );
}

// IDEAS item 54: the deadline-based half of the minimum-attendees cascade,
// covering both shapes a deadline can take -- see migration 0033's comment.
// Deliberately separate from sweepCancellationCascade above rather than
// folded into it: that sweep's two arms are the *reactive* model (evaluate
// continuously, on every decline), and this one is a genuinely different
// resolution rule (evaluate once, at a deadline) that both event shapes can
// now opt into. An event with neither deadline column set never reaches
// here at all -- it stays on the original reactive path in
// lib/attendance.ts's recordRsvp exactly as before.
//
// No cursor, uncharged discovery reads, same reasoning as
// sweepCancellationCascade and sweepGroupDrift's own comments -- see
// RESERVED_QUERIES in cron/budget.ts.
async function sweepMinimumAttendeesDeadlines(env: Env, budget: TickBudget): Promise<void> {
  const now = Date.now();

  const { results: dueNonRecurring } = await env.DB.prepare(
    `SELECT * FROM events
     WHERE status = 'active' AND event_type = 'single' AND is_recurring = 0
       AND minimum_attendees IS NOT NULL AND minimum_attendees_deadline_at IS NOT NULL
       AND minimum_attendees_deadline_at <= ?
     LIMIT ?`,
  )
    .bind(now, GLOBAL_SCAN_LIMIT)
    .all<EventRow & { minimum_attendees: number }>();

  for (const event of dueNonRecurring) {
    if (budget.exhausted) return;
    try {
      await resolveMinimumAttendeesDeadline(env, budget, event, '');
    } catch (err) {
      console.error(`sweepMinimumAttendeesDeadlines failed for event ${event.id}:`, err);
    }
  }

  const { results: recurringCandidates } = await env.DB.prepare(
    `SELECT * FROM events
     WHERE status = 'active' AND event_type = 'single' AND is_recurring = 1
       AND minimum_attendees IS NOT NULL AND minimum_attendees_deadline_hours_before IS NOT NULL
     LIMIT ?`,
  )
    .bind(GLOBAL_SCAN_LIMIT)
    .all<EventRow & { minimum_attendees: number; minimum_attendees_deadline_hours_before: number }>();

  for (const event of recurringCandidates) {
    if (budget.exhausted) return;
    try {
      const hoursBeforeMs = event.minimum_attendees_deadline_hours_before * HOUR_MS;
      const overrides = (await loadOverridesForEvents(env, [event.id])).get(event.id) ?? [];
      // Occurrences starting soon enough that their own deadline
      // (start - hoursBefore) has already arrived, but that haven't started
      // yet -- nothing to resolve for one already underway or past.
      const occurrences = await expandOccurrencesForEvent(env, event, now, now + hoursBeforeMs, overrides);
      for (const occ of occurrences) {
        if (budget.exhausted) return;
        if (occ.startAt - hoursBeforeMs > now) continue; // this occurrence's own deadline isn't due yet
        await resolveMinimumAttendeesDeadline(env, budget, event, occ.date);
      }
    } catch (err) {
      console.error(`sweepMinimumAttendeesDeadlines failed for recurring event ${event.id}:`, err);
    }
  }
}

// One occurrence (or the whole event, for the non-recurring case --
// occurrenceDate '') past its deadline, still below minimum. Cancels it
// (auto_cancel_below_minimum) or prompts the organizer, exactly once each,
// the same two outcomes decision 4 already established -- just resolved at
// a deadline instead of reactively.
async function resolveMinimumAttendeesDeadline(
  env: Env,
  budget: TickBudget,
  event: EventRow & { minimum_attendees: number },
  occurrenceDate: string,
): Promise<void> {
  if (!budget.trySpend(1)) return;
  const confirmed = await countConfirmedAttendees(env, event, occurrenceDate);
  if (confirmed >= event.minimum_attendees) return;

  if (event.auto_cancel_below_minimum) {
    let changed: number;
    if (occurrenceDate) {
      // One occurrence, not the series -- same primitive
      // POST /events/:eventId/occurrences/:date/cancel already uses. The
      // WHERE on the DO UPDATE branch is this sweep's own dedupe: a second
      // tick finding the same already-cancelled occurrence changes nothing
      // and sends no second notice.
      const res = await env.DB.prepare(
        `INSERT INTO event_occurrence_overrides (id, event_id, occurrence_date, is_cancelled)
         VALUES (?, ?, ?, 1)
         ON CONFLICT(event_id, occurrence_date) DO UPDATE SET is_cancelled = 1
         WHERE event_occurrence_overrides.is_cancelled = 0`,
      )
        .bind(newId(), event.id, occurrenceDate)
        .run();
      changed = res.meta.changes;
    } else {
      const res = await env.DB.prepare(
        `UPDATE events SET status = 'cancelled', updated_at = ? WHERE id = ? AND status = 'active'`,
      )
        .bind(Date.now(), event.id)
        .run();
      changed = res.meta.changes;
    }
    if (changed === 0) return; // already cancelled by an earlier tick

    const limit = budget.deliveriesAffordable;
    if (limit <= 0) return;
    const pending = await getConfirmedAttendeeIds(env, event, null, occurrenceDate, {
      notificationType: 'event_cancelled_below_minimum',
      occurrenceDate,
      limit,
    });
    await notifyPending(
      env,
      budget,
      pending,
      event.id,
      'event_cancelled_below_minimum',
      occurrenceDate,
      () => `"${event.title}" has been cancelled -- attendance dropped below the minimum for it.\n${eventLink(env, event.id)}`,
    );
    return;
  }

  const now = Date.now();
  const recipient = await env.DB.prepare(
    `SELECT u.id, u.notifications_enabled, u.dm_channel_id, u.timezone
     FROM users u
     JOIN user_guild_membership m ON m.user_id = u.id AND m.guild_id = ? AND m.is_member = 1 AND m.verified_at >= ?
     JOIN guilds g ON g.id = m.guild_id AND g.is_active = 1
     ${PENDING_NOTIFICATION_JOIN}
     WHERE u.id = ?
       AND ${PENDING_NOTIFICATION_WHERE}`,
  )
    .bind(
      event.guild_id,
      membershipCutoff(),
      ...pendingNotificationJoinBinds(event.id, 'organizer_cancel_prompt', occurrenceDate),
      event.organizer_id,
      ...pendingNotificationWhereBinds(now),
    )
    .first<ParticipantRow>();
  if (!recipient) return;

  await notifyPending(
    env,
    budget,
    [recipient],
    event.id,
    'organizer_cancel_prompt',
    occurrenceDate,
    () => `"${event.title}" has dropped below its minimum of ${event.minimum_attendees}. Cancel it?\n${eventLink(env, event.id)}`,
    () => (occurrenceDate ? cancelOccurrenceButton(event.id, occurrenceDate) : cancelButton(event.id)),
  );
}

// T-24h-before-deadline heads-up, so the organizer isn't caught off guard
// the moment the deadline resolves. Purely informational -- no button, and
// it fires whether or not auto-cancel is on, since a below-minimum session
// is worth knowing about either way. Scoped to the same deadline-opted-in
// events sweepMinimumAttendeesDeadlines covers, and shares its shape for the
// same reason: no cursor, uncharged discovery, per RESERVED_QUERIES.
async function sweepMinimumAttendeesDeadlineWarnings(env: Env, budget: TickBudget): Promise<void> {
  const now = Date.now();
  const warningWindowEnd = now + DAY_MS;

  const { results: dueNonRecurring } = await env.DB.prepare(
    `SELECT * FROM events
     WHERE status = 'active' AND event_type = 'single' AND is_recurring = 0
       AND minimum_attendees IS NOT NULL AND minimum_attendees_deadline_at IS NOT NULL
       AND minimum_attendees_deadline_at > ? AND minimum_attendees_deadline_at <= ?
     LIMIT ?`,
  )
    .bind(now, warningWindowEnd, GLOBAL_SCAN_LIMIT)
    .all<EventRow & { minimum_attendees: number }>();

  for (const event of dueNonRecurring) {
    if (budget.exhausted) return;
    try {
      await sendMinimumAttendeesDeadlineWarning(env, budget, event, '');
    } catch (err) {
      console.error(`sweepMinimumAttendeesDeadlineWarnings failed for event ${event.id}:`, err);
    }
  }

  const { results: recurringCandidates } = await env.DB.prepare(
    `SELECT * FROM events
     WHERE status = 'active' AND event_type = 'single' AND is_recurring = 1
       AND minimum_attendees IS NOT NULL AND minimum_attendees_deadline_hours_before IS NOT NULL
     LIMIT ?`,
  )
    .bind(GLOBAL_SCAN_LIMIT)
    .all<EventRow & { minimum_attendees: number; minimum_attendees_deadline_hours_before: number }>();

  for (const event of recurringCandidates) {
    if (budget.exhausted) return;
    try {
      const hoursBeforeMs = event.minimum_attendees_deadline_hours_before * HOUR_MS;
      const overrides = (await loadOverridesForEvents(env, [event.id])).get(event.id) ?? [];
      const occurrences = await expandOccurrencesForEvent(env, event, now, now + hoursBeforeMs + DAY_MS, overrides);
      for (const occ of occurrences) {
        if (budget.exhausted) return;
        const deadline = occ.startAt - hoursBeforeMs;
        if (deadline <= now || deadline > warningWindowEnd) continue;
        await sendMinimumAttendeesDeadlineWarning(env, budget, event, occ.date);
      }
    } catch (err) {
      console.error(`sweepMinimumAttendeesDeadlineWarnings failed for recurring event ${event.id}:`, err);
    }
  }
}

async function sendMinimumAttendeesDeadlineWarning(
  env: Env,
  budget: TickBudget,
  event: EventRow & { minimum_attendees: number },
  occurrenceDate: string,
): Promise<void> {
  if (!budget.trySpend(1)) return;
  const confirmed = await countConfirmedAttendees(env, event, occurrenceDate);
  if (confirmed >= event.minimum_attendees) return;

  const now = Date.now();
  const recipient = await env.DB.prepare(
    `SELECT u.id, u.notifications_enabled, u.dm_channel_id, u.timezone
     FROM users u
     JOIN user_guild_membership m ON m.user_id = u.id AND m.guild_id = ? AND m.is_member = 1 AND m.verified_at >= ?
     JOIN guilds g ON g.id = m.guild_id AND g.is_active = 1
     ${PENDING_NOTIFICATION_JOIN}
     WHERE u.id = ?
       AND ${PENDING_NOTIFICATION_WHERE}`,
  )
    .bind(
      event.guild_id,
      membershipCutoff(),
      ...pendingNotificationJoinBinds(event.id, 'minimum_attendees_deadline_warning', occurrenceDate),
      event.organizer_id,
      ...pendingNotificationWhereBinds(now),
    )
    .first<ParticipantRow>();
  if (!recipient) return;

  await notifyPending(
    env,
    budget,
    [recipient],
    event.id,
    'minimum_attendees_deadline_warning',
    occurrenceDate,
    () =>
      `"${event.title}"${occurrenceDate ? ` (${occurrenceDate})` : ''} is currently below its minimum of ` +
      `${event.minimum_attendees} with a day left before that decides it. ${confirmed} confirmed so far.\n${eventLink(env, event.id)}`,
  );
}

// Reminds invitees 24h before a poll's deadline, but only the ones who
// haven't cast a single vote (options mode) or submitted availability
// (window mode) yet -- people who already responded don't need a nudge.
async function sweepPollDeadlineReminders(env: Env, budget: TickBudget, cursors: CursorStore): Promise<void> {
  const now = Date.now();
  const windowEnd = now + 24 * HOUR_MS;

  await forEachGlobalRow<EventRow>(
    env,
    budget,
    cursors,
    'poll_deadline_reminders',
    `SELECT * FROM events
     WHERE event_type = 'poll' AND status = 'active'
       AND poll_deadline_at IS NOT NULL AND poll_deadline_at >= ? AND poll_deadline_at <= ?`,
    [now, windowEnd],
    async (poll) => {
      const limit = budget.deliveriesAffordable;
      if (limit <= 0) return 'incomplete';
      const hasVotedSubquery =
        poll.window_block_minutes != null
          ? `SELECT 1 FROM event_window_availability WHERE event_id = ei.event_id AND user_id = ei.user_id`
          : `SELECT 1 FROM event_poll_votes WHERE user_id = ei.user_id
             AND option_id IN (SELECT id FROM event_poll_options WHERE event_id = ei.event_id)`;

      const { results: nonVoters } = await env.DB.prepare(
        `SELECT u.id, u.notifications_enabled, u.dm_channel_id, u.timezone
         FROM event_invites ei
         JOIN users u ON u.id = ei.user_id
         JOIN user_guild_membership m ON m.user_id = u.id AND m.guild_id = ? AND m.is_member = 1 AND m.verified_at >= ?
         JOIN guilds g ON g.id = m.guild_id AND g.is_active = 1
         ${PENDING_NOTIFICATION_JOIN}
         WHERE ei.event_id = ? AND NOT EXISTS (${hasVotedSubquery})
           AND ${PENDING_NOTIFICATION_WHERE}
         ORDER BY u.id
         LIMIT ?`,
      )
        .bind(
          poll.guild_id,
          membershipCutoff(),
          ...pendingNotificationJoinBinds(poll.id, 'poll_deadline_reminder', ''),
          poll.id,
          ...pendingNotificationWhereBinds(),
          limit,
        )
        .all<ParticipantRow>();

      // Everyone in `nonVoters` is by definition someone who has not answered,
      // so this is the DM most likely to be acted on from Discord itself.
      const candidates = await pollCandidates(env, budget, poll.id, new Map());
      await notifyPending(
        env,
        budget,
        nonVoters,
        poll.id,
        'poll_deadline_reminder',
        '',
        () => `Voting for "${poll.title}" closes soon -- you haven't responded yet.${VOTE_NUANCE}\n${eventLink(env, poll.id)}`,
        (user) => voteControls(poll, candidates, env, user.timezone),
      );
      if (nonVoters.length >= limit || budget.exhausted) return 'incomplete';
    },
  );
}

// Deep link into the specific voice channel. Discord bots have no API to
// force a disconnected user into a voice channel -- this is as close as a
// DM can get, and it's still one click for someone who said they'd be there.
function voiceChannelLink(guildId: string, channelId: string): string {
  return `https://discord.com/channels/${guildId}/${channelId}`;
}

// How far ahead the voice sweep looks for events about to start.
//
// This has to be *longer than the cron interval*, which it previously was
// not: with a 15-minute trigger and a 10-minute window, an event starting 12
// minutes after a tick was outside the window at that tick and already three
// minutes into the past at the next one, where `start_at >= now` excluded it.
// Every start time in that five-minute band was missed, deterministically, on
// an idle database with the budget untouched -- a gap in the schedule's
// arithmetic rather than a resource problem.
//
// A window at least as wide as the interval guarantees every future start is
// caught by some tick; the extra five-minute margin over CRON_INTERVAL_MS
// covers ordinary jitter in when Cloudflare actually fires an on-schedule
// invocation, not a whole skipped one. A tick that fires on time always has
// a window reaching past the next tick's nominal start, so a single late
// invocation is already covered by the on-time one before it; only a run of
// *consecutive* missed invocations spanning more than the margin can still
// open a gap, and nothing here claims otherwise. The cost of the wider
// window is only that a DM can arrive further ahead of the event; the
// outbox's dedupe means it is still sent exactly once.
const CRON_INTERVAL_MS = 15 * 60 * 1000;
const VOICE_INVITE_LEAD_MS = CRON_INTERVAL_MS + 5 * 60 * 1000;

// Nudges confirmed attendees toward the event's voice channel a few minutes
// before it starts. Only fires for events where the organizer picked a
// channel; scoped to whoever actually committed (accepted RSVP / yes-voted
// the winning poll option / window availability covering the resolved time),
// never the full invite list.
async function sweepVoiceChannelInvites(env: Env, budget: TickBudget, cursors: CursorStore): Promise<void> {
  const now = Date.now();
  const windowEnd = now + VOICE_INVITE_LEAD_MS;

  await forEachGlobalRow<EventRow>(
    env,
    budget,
    cursors,
    'voice_fixed',
    `SELECT * FROM events
     WHERE voice_channel_id IS NOT NULL AND is_recurring = 0 AND status IN ('active','resolved')
       AND start_at IS NOT NULL AND start_at >= ? AND start_at <= ?`,
    [now, windowEnd],
    async (event) => {
      const limit = budget.deliveriesAffordable;
      if (limit <= 0) return 'incomplete';
      // 'window' is not an option id -- it is what a window poll resolved to
      // before specs/0013 gave every poll real candidates. Passing it on
      // would look up votes for a row that does not exist; the windowed
      // branch of getConfirmedAttendeeIds handles those polls anyway.
      const optionId =
        event.event_type === 'poll' && event.resolved_option_id !== 'window' ? event.resolved_option_id : null;
      const attendees = await getConfirmedAttendeeIds(env, event, optionId, '', {
        notificationType: 'voice_channel_invite',
        occurrenceDate: '',
        limit,
      });
      await notifyPending(env, budget, attendees, event.id, 'voice_channel_invite', '', () =>
        `"${event.title}" is starting soon -- join the "${event.voice_channel_name}" voice channel:\n${voiceChannelLink(event.guild_id, event.voice_channel_id!)}`,
      );
      if (attendees.length >= limit || budget.exhausted) return 'incomplete';
    },
  );

  await forEachRecurringPage(
    env,
    budget,
    cursors,
    'voice_recurring',
    `SELECT * FROM events WHERE voice_channel_id IS NOT NULL AND is_recurring = 1 AND status = 'active'`,
    async (event, overrides, rule) => {
      const occurrences = await expandOccurrencesForEvent(env, event, now, windowEnd, overrides, rule);
      if (occurrences.length === 0) return;

      for (const occ of occurrences) {
        if (!budget.trySpend(SCAN_COST_PER_EVENT)) return;
        const attendees = await getConfirmedAttendeeIds(env, event, null, occ.date, {
          notificationType: 'voice_channel_invite',
          occurrenceDate: occ.date,
          limit: budget.deliveriesAffordable,
        });
        await notifyPending(env, budget, attendees, event.id, 'voice_channel_invite', occ.date, () =>
          `"${event.title}" is starting soon -- join the "${event.voice_channel_name}" voice channel:\n${voiceChannelLink(event.guild_id, event.voice_channel_id!)}`,
        );
      }
    },
  );

  // multi_winner polls confirm each day independently, so each confirmed
  // option has its own attendee list (whoever voted yes on that day).
  await forEachGlobalRow<EventRow>(
    env,
    budget,
    cursors,
    'voice_multi_winner',
    `SELECT * FROM events
     WHERE voice_channel_id IS NOT NULL AND event_type = 'poll' AND poll_resolution_mode = 'multi_winner'`,
    [],
    async (poll) => {
      if (!budget.trySpend(1)) return 'incomplete';
      const { results: options } = await env.DB.prepare(
        `SELECT id FROM event_poll_options
         WHERE event_id = ? AND confirmed_at IS NOT NULL AND start_at >= ? AND start_at <= ?`,
      )
        .bind(poll.id, now, windowEnd)
        .all<{ id: string }>();

      for (const opt of options) {
        const limit = budget.deliveriesAffordable;
        if (limit <= 0) return 'incomplete';
        const attendees = await getConfirmedAttendeeIds(env, poll, opt.id, '', {
          notificationType: 'voice_channel_invite',
          occurrenceDate: opt.id,
          limit,
        });
        await notifyPending(env, budget, attendees, poll.id, 'voice_channel_invite', opt.id, () =>
          `"${poll.title}" is starting soon -- join the "${poll.voice_channel_name}" voice channel:\n${voiceChannelLink(poll.guild_id, poll.voice_channel_id!)}`,
        );
        if (attendees.length >= limit || budget.exhausted) return 'incomplete';
      }
    },
  );
}

interface GroupIdleRow {
  id: string;
  idle_reminder_days: number;
}

// If a group has had at least one past event but nothing scheduled since,
// and it's been idle longer than the group's configured window, nudge every
// member to plan something. Fires once per idle episode (dedup keyed on the
// group's last known event time), not on every 15-minute tick.
async function sweepIdleGroups(env: Env, budget: TickBudget, cursors: CursorStore): Promise<void> {
  const now = Date.now();
  await forEachGlobalRow<GroupIdleRow>(
    env,
    budget,
    cursors,
    'idle_groups',
    `SELECT id, idle_reminder_days FROM groups WHERE 1 = 1`,
    [],
    async (group) => {
      if (!budget.trySpend(1)) return 'incomplete';
      const { results: eventRows } = await env.DB.prepare(
        `SELECT DISTINCT e.start_at, e.end_at FROM events e
         JOIN event_invites ei ON ei.event_id = e.id
         WHERE ei.source_group_id = ? AND e.status != 'cancelled' AND e.start_at IS NOT NULL`,
      )
        .bind(group.id)
        .all<{ start_at: number; end_at: number }>();

      if (eventRows.length === 0) return; // never had an event -- not "idle", just new

      const lastEventAt = Math.max(...eventRows.map((e) => e.end_at ?? e.start_at));
      const hasUpcoming = eventRows.some((e) => e.start_at > now);
      if (hasUpcoming) return;

      const idleMs = group.idle_reminder_days * 24 * HOUR_MS;
      if (now - lastEventAt < idleMs) return;

      // specs/0011 / IDEAS item 36: a group no longer belongs to one guild,
      // so there is no single `user_guild_membership` row left to join on
      // here -- and per the decided access model, there doesn't need to be
      // one. Group membership alone is who's "in" the group for every
      // purpose, nudges included.
      const { results: members } = await env.DB.prepare(
        `SELECT u.id, u.notifications_enabled, u.dm_channel_id, u.timezone, g.name as group_name
         FROM group_members gm
         JOIN users u ON u.id = gm.user_id
         JOIN groups g ON g.id = gm.group_id
         WHERE gm.group_id = ?`,
      )
        .bind(group.id)
        .all<ParticipantRow & { group_name: string }>();

      // Nudges now go through the same leased outbox as every other DM,
      // keyed per member per idle episode. Previously this fired a bare
      // send and then recorded the group as nudged regardless of the
      // outcome, so a rate-limited or 5xx nudge was silently dropped and
      // the "already nudged" marker guaranteed it was never retried.
      //
      // That marker is also no longer the gate -- the outbox row is. Once a
      // member's nudge is delivered (or permanently fails) their row is
      // terminal and re-running this sweep is a no-op for them, while a
      // member whose nudge is still pending gets picked up on a later tick.
      // Same settled-set pre-filter as the event notifications, against this
      // episode's nudge rows: without it every member of every idle group
      // costs a claim attempt on every tick for as long as the group stays
      // idle, which is exactly the case where nothing needs sending.
      const { results: settledRows } = await env.DB.prepare(
        `SELECT user_id FROM group_nudge_log
         WHERE group_id = ? AND last_event_at = ?
           AND (delivered_at IS NOT NULL OR failed_at IS NOT NULL
                OR (claimed_until IS NOT NULL AND claimed_until > ?)
                OR (next_attempt_at IS NOT NULL AND next_attempt_at > ?))`,
      )
        .bind(group.id, lastEventAt, now, now)
        .all<{ user_id: string }>();
      const settled = new Set(settledRows.map((r) => r.user_id));

      for (const member of members) {
        if (budget.exhausted) break;
        if (settled.has(member.id)) continue;
        await deliverThroughOutbox(
          env,
          'group_nudge_log',
          { group_id: group.id, user_id: member.id, last_event_at: lastEventAt },
          member,
          `It's been a while since "${member.group_name}" last played -- want to schedule something?\n${env.FRONTEND_URL}/#/calendar`,
          budget,
        );
      }

      // Kept purely as the "when did this group last get nudged" record the
      // rest of the app reads; it no longer decides whether to send.
      await env.DB.prepare(
        `INSERT INTO group_activity_nudges (group_id, last_event_at, notified_at) VALUES (?, ?, ?)
         ON CONFLICT(group_id) DO UPDATE SET last_event_at = excluded.last_event_at, notified_at = excluded.notified_at`,
      )
        .bind(group.id, lastEventAt, now)
        .run();
      if (budget.exhausted) return 'incomplete';
    },
  );
}

// specs/0011 / IDEAS item 36: an event invited people through a group whose
// common-server set no longer includes the event's own venue -- someone
// left a server such that the group can no longer vouch for a shared venue.
// The event still happens as scheduled (decided: never auto-cancel or
// re-anchor it), but the people still invited to it are told, once, so it
// doesn't come as a surprise later.
//
// Only upcoming events: a drift on something that already happened has
// nothing left to warn anyone about.
//
// No cursor, deliberately -- same shape as sweepCancellationCascade and
// sweepStaleAccounts, and for the same reason their own comments give (see
// RESERVED_QUERIES in cron/budget.ts): this is a new, genuinely new fixed
// scan, and both "give it a cursor via forEachGlobalRow" and "bump
// RESERVED_QUERIES to match" were tried and measured to starve
// sweepPurgeTerminalHistory, which has no margin left to give. The discovery
// read here runs uncharged against the ledger, capped at GLOBAL_SCAN_LIMIT
// rather than paged -- a group-sourced-invite population large enough for
// that cap to matter is not this app's scale, the same judgement call
// sweepCancellationCascade's own comment already made.
async function sweepGroupDrift(env: Env, budget: TickBudget): Promise<void> {
  const { results } = await env.DB.prepare(
    `SELECT DISTINCT e.id, e.guild_id, e.organizer_id, ei.source_group_id
     FROM events e
     JOIN event_invites ei ON ei.event_id = e.id
     WHERE e.status = 'active' AND (e.start_at IS NULL OR e.start_at > ?) AND ei.source_group_id IS NOT NULL
     LIMIT ?`,
  )
    .bind(Date.now(), GLOBAL_SCAN_LIMIT)
    .all<{ id: string; guild_id: string; organizer_id: string; source_group_id: string }>();
  if (results.length === 0) return;

  const commonServerIdsCache = new Map<string, Set<string>>();
  async function groupServerIds(groupId: string): Promise<Set<string>> {
    const cached = commonServerIdsCache.get(groupId);
    if (cached) return cached;
    const { results: memberRows } = await env.DB.prepare(`SELECT user_id FROM group_members WHERE group_id = ?`)
      .bind(groupId)
      .all<{ user_id: string }>();
    const servers = new Set((await commonServerSet(env, memberRows.map((r) => r.user_id))).map((s) => s.id));
    commonServerIdsCache.set(groupId, servers);
    return servers;
  }

  for (const row of results) {
    if (budget.exhausted) return;
    try {
      const servers = await groupServerIds(row.source_group_id);
      if (servers.has(row.guild_id)) continue; // still shares this event's venue -- nothing drifted

      const recipients = await pendingRecipients(env, row, 'group_venue_drift', '', budget.deliveriesAffordable);
      if (recipients.length === 0) continue;
      await notifyPending(
        env,
        budget,
        recipients,
        row.id,
        'group_venue_drift',
        '',
        () =>
          "One of the group members invited to this event no longer shares a server with the rest of the group " +
          `it came from -- the session is still happening as scheduled, just worth knowing.\n${eventLink(env, row.id)}`,
      );
    } catch (err) {
      console.error(`sweepGroupDrift failed for event ${row.id}:`, err);
    }
  }
}

// New idea captured alongside IDEAS item 54 (Sept 2026): the organizer hears
// about every invitee's RSVP, for every event they organize -- not just
// minimum-attendees ones. Its own outbox table (organizer_rsvp_notice_log,
// migration 0035) rather than notification_log: that table's dedupe key has
// no room for *which invitee* answered, so a second invitee's answer to the
// same event/occurrence would collide with the first and be silently
// dropped as "already notified". responded_at is part of this table's own
// key for the same reason group_nudge_log's last_event_at is: a person's
// second, different answer is a new notification, not a no-op against an
// already-delivered row.
//
// No cursor, uncharged discovery read, same shape and same reasoning as
// every other sweep added tonight -- see RESERVED_QUERIES in cron/budget.ts.
// Unlike those, this one scales with genuine user activity (every RSVP)
// rather than rare event configuration, so it is capped at GLOBAL_SCAN_LIMIT
// the same way a large backlog anywhere else in this cron is: a quiet tick
// works through more of it, not all of it at once.
const RSVP_ANSWER_THIRD_PERSON: Record<RsvpStatus, string> = {
  accepted: 'is in',
  tentative: 'might be able to make it',
  declined: "can't make it",
};

async function sweepOrganizerRsvpNotices(env: Env, budget: TickBudget): Promise<void> {
  const { results } = await env.DB.prepare(
    `SELECT ea.event_id, ea.occurrence_date, ea.user_id AS responder_id, ea.rsvp_status, ea.responded_at,
            e.title, e.organizer_id,
            ou.notifications_enabled AS organizer_notifications_enabled,
            ou.dm_channel_id AS organizer_dm_channel_id, ou.timezone AS organizer_timezone,
            ru.username AS responder_username, ru.global_name AS responder_global_name
     FROM event_attendance ea
     JOIN events e ON e.id = ea.event_id
     JOIN users ou ON ou.id = e.organizer_id
     JOIN users ru ON ru.id = ea.user_id
     LEFT JOIN organizer_rsvp_notice_log l
       ON l.organizer_id = e.organizer_id AND l.event_id = ea.event_id AND l.occurrence_date = ea.occurrence_date
          AND l.responder_id = ea.user_id AND l.responded_at = ea.responded_at
     WHERE l.id IS NULL AND e.status = 'active' AND ea.user_id != e.organizer_id
     LIMIT ?`,
  )
    .bind(GLOBAL_SCAN_LIMIT)
    .all<{
      event_id: string;
      occurrence_date: string;
      responder_id: string;
      rsvp_status: RsvpStatus;
      responded_at: number;
      title: string;
      organizer_id: string;
      organizer_notifications_enabled: number;
      organizer_dm_channel_id: string | null;
      organizer_timezone: string;
      responder_username: string;
      responder_global_name: string | null;
    }>();

  for (const row of results) {
    if (budget.exhausted) return;
    try {
      const responderName = row.responder_global_name ?? row.responder_username;
      const content =
        `${responderName} ${RSVP_ANSWER_THIRD_PERSON[row.rsvp_status]} for "${row.title}"` +
        `${row.occurrence_date ? ` (${row.occurrence_date})` : ''}.\n${eventLink(env, row.event_id)}`;
      await deliverThroughOutbox(
        env,
        'organizer_rsvp_notice_log',
        {
          organizer_id: row.organizer_id,
          event_id: row.event_id,
          occurrence_date: row.occurrence_date,
          responder_id: row.responder_id,
          responded_at: row.responded_at,
        },
        {
          id: row.organizer_id,
          notifications_enabled: row.organizer_notifications_enabled,
          dm_channel_id: row.organizer_dm_channel_id,
          timezone: row.organizer_timezone,
        },
        content,
        budget,
      );
    } catch (err) {
      console.error(`sweepOrganizerRsvpNotices failed for event ${row.event_id}/${row.responder_id}:`, err);
    }
  }
}

// IDEAS item 10 / docs/specs/0016: warn, then purge, an account that has gone
// stale. "Stale" is measured from the last real login, not merely from
// holding a valid session -- sessions.ts caps a session at a 7-day absolute
// TTL with no indefinite renewal (SESSION_TTL_MS), so anyone actively using
// the app is forced through a real Discord login, and therefore a
// markLoginSucceeded stamp, at least once a week. last_login_at is already
// exactly the "have they used this" signal item 10 wants; no separate concept
// is needed.
//
// A user who never completed a real login (last_login_at NULL -- upsertUser
// stamps last_login_attempt_at before the allow-list check that gates
// issuing a session, so a rejected caller can have a row with no login ever
// recorded) is measured from created_at instead, so a never-verified row
// doesn't sit forever.
const STALE_ACCOUNT_MS = 365 * DAY_MS;
const STALE_WARNING_2WK_MS = STALE_ACCOUNT_MS - 14 * DAY_MS;
const STALE_WARNING_1WK_MS = STALE_ACCOUNT_MS - 7 * DAY_MS;

// The erasure this sweep can trigger is deliberately uncounted against the
// shared TickBudget (see cron/budget.ts's RESERVED_QUERIES comment) and is
// therefore not self-limiting the way a delivery is -- so it gets its own
// cap, independent of the budget, purely to bound one tick's worst case.
// One is enough: two accounts crossing the exact same 365-day boundary in the
// same 15-minute window is not a case this app's scale needs to plan for, and
// a second candidate is simply picked up on the very next tick.
const STALE_PURGE_MAX_PER_TICK = 1;

interface StaleAccountRow {
  id: string;
  notifications_enabled: number;
  dm_channel_id: string | null;
  timezone: string;
  created_at: number;
  last_login_at: number | null;
}

// The date is rendered in the recipient's own timezone, for formatWhen's
// reason above applied to a date rather than a time: a Worker runs in UTC, so
// someone in Los Angeles who last signed in at 5pm local would otherwise be
// told a date a day later than the one they remember. Date-only rather than
// formatWhen's date-and-time -- the hour they last logged in a year ago is
// noise, and pretending to that precision invites arguing with it.
function staleAccountWarningContent(
  env: Env,
  warningType: 'stale_2wk' | 'stale_1wk',
  referenceAt: number,
  zone: string,
): string {
  const window = warningType === 'stale_1wk' ? 'one week' : 'two weeks';
  const lastSeen = DateTime.fromMillis(referenceAt).setZone(zone).toFormat('ccc d LLL yyyy');
  return (
    `You haven't logged in since ${lastSeen}. If you don't log back in within the next ` +
    `${window}, your account and everything in it will be permanently deleted.\n${env.FRONTEND_URL}/#/calendar`
  );
}

// Whether this account still has a live reason to exist despite being stale:
// organizing, or holding a non-declined invite to, an event that hasn't
// happened yet. Purging out from under either would change who a still-live
// session counts on -- an organizer's departure deletes the event outright
// (deleteUserCompletely), and an invitee's departure can drop a session below
// its minimum-attendees threshold (specs/0014's cancellation cascade). Both
// are exactly the kind of surprise item 10 exists to avoid causing, not the
// integration-runs-forever problem it exists to fix -- that problem is about
// someone who has stopped using the app entirely, not someone with something
// scheduled. A poll with no candidate resolved yet has start_at IS NULL and
// counts as "hasn't happened", same reasoning.
async function hasUpcomingStake(env: Env, userId: string, now: number): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT 1 FROM events WHERE organizer_id = ? AND status = 'active' AND (start_at IS NULL OR start_at > ?)
     UNION
     SELECT 1 FROM event_invites ei JOIN events e ON e.id = ei.event_id
       WHERE ei.user_id = ? AND ei.rsvp_status != 'declined'
         AND e.status = 'active' AND (e.start_at IS NULL OR e.start_at > ?)
     LIMIT 1`,
  )
    .bind(userId, now, userId, now)
    .first();
  return row != null;
}

// One combined scan rather than a warning sweep and a purge sweep, for the
// same reason IDEAS item 47's reminders were folded into an existing sweep
// (see RESERVED_QUERIES's comment): nothing here needs two passes over the
// same table to decide "warn" vs "purge" -- it's the same
// COALESCE(last_login_at, created_at) age compared against three thresholds
// instead of one.
//
// No cursor, and the discovery read below is not charged against the shared
// budget -- the same shape as sweepCancellationCascade just above, and for
// the same reason (see RESERVED_QUERIES's comment in cron/budget.ts): this
// table is small enough for an ordinary install that one bounded scan a tick
// is not a fairness problem, and this feature's own threshold is a year of
// inactivity, so a row missed by the LIMIT below simply matches again next
// tick with nothing lost.
async function sweepStaleAccounts(env: Env, budget: TickBudget): Promise<void> {
  const now = Date.now();
  const { results } = await env.DB.prepare(
    `SELECT id, notifications_enabled, dm_channel_id, timezone, created_at, last_login_at
     FROM users
     WHERE COALESCE(last_login_at, created_at) <= ?
     ORDER BY id
     LIMIT ?`,
  )
    .bind(now - STALE_WARNING_2WK_MS, GLOBAL_SCAN_LIMIT)
    .all<StaleAccountRow>();

  let purged = 0;
  let warned = 0;
  for (const user of results) {
    if (budget.exhausted) {
      // Worth saying, because this sweep runs last: "no warnings went out"
      // and "no warnings were due" look identical from outside, and only one
      // of them is a reason to look closer.
      console.log(`Stale-account sweep stopped early with ${results.length - warned - purged} row(s) unexamined; the allowance went to notifications.`);
      return;
    }
    const referenceAt = user.last_login_at ?? user.created_at;
    const age = now - referenceAt;

    if (age >= STALE_ACCOUNT_MS) {
      if (purged >= STALE_PURGE_MAX_PER_TICK) continue; // picked up again next tick
      if (await hasUpcomingStake(env, user.id, now)) {
        // Not noise: this is the difference between "the purge is broken" and
        // "the purge deliberately declined", which is otherwise unanswerable
        // without reproducing the predicate by hand.
        console.log(`Stale account ${user.id} not purged: still organizing or invited to an upcoming event.`);
        continue;
      }
      // Logged *before* the delete, so the record survives a failure partway
      // through -- and at warn level because this is the most consequential
      // thing the cron does: the account and every event it organised, gone,
      // with nothing to undo it from.
      console.warn(
        `Purging stale account ${user.id}: no login since ${new Date(referenceAt).toISOString()} ` +
          `(${Math.floor(age / DAY_MS)} days).`,
      );
      await deleteUserCompletely(env, user.id);
      purged++;
      continue;
    }

    const warningType: 'stale_2wk' | 'stale_1wk' = age >= STALE_WARNING_1WK_MS ? 'stale_1wk' : 'stale_2wk';
    // Sent regardless of notifications_enabled: that toggle opts out of
    // gameplay pings, not out of the one message that exists to stop an
    // otherwise-irreversible deletion. Recipient is reconstructed rather than
    // passing `user` through, so this override is explicit at the call site
    // rather than hidden in the row shape.
    const recipient: DmRecipient = {
      id: user.id,
      notifications_enabled: 1,
      dm_channel_id: user.dm_channel_id,
      timezone: user.timezone,
    };
    if (
      await deliverThroughOutbox(
        env,
        'account_purge_warnings',
        { user_id: user.id, last_login_at: referenceAt, warning_type: warningType },
        recipient,
        staleAccountWarningContent(env, warningType, referenceAt, user.timezone),
        budget,
      )
    ) {
      warned++;
    }
  }

  // Only when something actually happened -- the overwhelmingly common tick
  // has no stale accounts at all, and a line saying so every fifteen minutes
  // is how a log stops being read.
  if (warned > 0 || purged > 0) {
    console.log(`Stale-account sweep: ${warned} warning(s) sent, ${purged} account(s) purged.`);
  }
}

interface DueRetryRow extends DmRecipient {
  id: string;
  event_id: string;
  notification_type: NotificationType;
  components: string | null;
  occurrence_date: string;
  content: string;
}

// Source-independent retry consumer for notification_log (F-04-H2).
//
// Every other sweep above finds its recipients by asking "what's due for
// *this* event/poll right now" -- which only works while that event/poll
// still matches the sweep's own window. A retryable Discord failure sets
// next_attempt_at and clears the lease, but nothing re-selects the row once
// its source event has started, its poll has resolved, or its deadline has
// passed: the row sits there with a real due time and nothing ever reads it
// again. That can strand a single notification for a single user -- it does
// not need scale to happen.
//
// This scans notification_log directly by next_attempt_at instead of by
// source state, so a due retry is found regardless of whether its event is
// still "current" by any other sweep's definition. It reuses the content
// captured on the row by an earlier attempt (see migration 0014) rather than
// re-deriving the message -- re-deriving is exactly the operation that just
// failed to have an answer, since the source may no longer describe the same
// commitment it did when the DM was first attempted.
//
// Still guild-scoped for membership and notification preference, same as
// every other recipient query: a retry must not outlive the reasons the
// original send was allowed.
function parseStoredComponents(stored: string | null, rowId: string): unknown[] | null {
  if (!stored) return null;
  try {
    const parsed = JSON.parse(stored);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    console.warn(`notification_log ${rowId} has components that are not valid JSON; retrying without them`);
    return null;
  }
}

async function sweepDueNotificationRetries(env: Env, budget: TickBudget, cursors: CursorStore): Promise<void> {
  await forEachGlobalRow<DueRetryRow>(
    env,
    budget,
    cursors,
    'due_notification_retries',
    `SELECT nl.id, nl.user_id AS id, nl.event_id, nl.notification_type, nl.occurrence_date, nl.content,
            nl.components,
            u.notifications_enabled, u.dm_channel_id, u.timezone
     FROM notification_log nl
     JOIN events e ON e.id = nl.event_id
     JOIN users u ON u.id = nl.user_id
     JOIN user_guild_membership m ON m.user_id = u.id AND m.guild_id = e.guild_id AND m.is_member = 1 AND m.verified_at >= ?
     JOIN guilds g ON g.id = e.guild_id AND g.is_active = 1
     WHERE nl.delivered_at IS NULL AND nl.failed_at IS NULL
       AND nl.next_attempt_at IS NOT NULL AND nl.next_attempt_at <= ?
       AND (nl.claimed_until IS NULL OR nl.claimed_until < ?)
       AND nl.content IS NOT NULL`,
    [membershipCutoff(), Date.now(), Date.now()],
    async (row) => {
      if (budget.exhausted) return 'incomplete';
      await deliverThroughOutbox(
        env,
        'notification_log',
        { user_id: row.id, event_id: row.event_id, notification_type: row.notification_type, occurrence_date: row.occurrence_date },
        row,
        row.content,
        budget,
        // Carried forward rather than re-derived, for migration 0014's
        // reason applied to migration 0023's column: this consumer exists
        // precisely because the state that produced the DM may no longer
        // produce it, and a poll's candidate list is the clearest case of
        // that. Unparseable JSON degrades to no components -- the retry
        // still delivers the text, which is what the recipient is owed.
        parseStoredComponents(row.components, row.id),
      );
      if (budget.exhausted) return 'incomplete';
    },
    'nl.id',
  );
}

interface DueNudgeRetryRow extends DmRecipient {
  id: string;
  group_id: string;
  last_event_at: number;
  content: string;
  group_name: string;
}

// The group-nudge equivalent of sweepDueNotificationRetries, for the same
// reason: sweepIdleGroups only re-selects a group while it is still idle by
// this tick's definition, and a group's idle episode ends (a new event gets
// scheduled) independently of whether a member's nudge DM has actually gone
// out yet.
async function sweepDueNudgeRetries(env: Env, budget: TickBudget, cursors: CursorStore): Promise<void> {
  await forEachGlobalRow<DueNudgeRetryRow>(
    env,
    budget,
    cursors,
    'due_nudge_retries',
    // specs/0011 / IDEAS item 36: no single guild left to join on -- see
    // sweepIdleGroups' comment just above for why group membership alone is
    // enough here too.
    `SELECT gnl.id, gnl.user_id AS id, gnl.group_id, gnl.last_event_at, gnl.content,
            u.notifications_enabled, u.dm_channel_id, u.timezone, g.name AS group_name
     FROM group_nudge_log gnl
     JOIN groups g ON g.id = gnl.group_id
     JOIN users u ON u.id = gnl.user_id
     WHERE gnl.delivered_at IS NULL AND gnl.failed_at IS NULL
       AND gnl.next_attempt_at IS NOT NULL AND gnl.next_attempt_at <= ?
       AND (gnl.claimed_until IS NULL OR gnl.claimed_until < ?)
       AND gnl.content IS NOT NULL`,
    [Date.now(), Date.now()],
    async (row) => {
      if (budget.exhausted) return 'incomplete';
      await deliverThroughOutbox(
        env,
        'group_nudge_log',
        { group_id: row.group_id, user_id: row.id, last_event_at: row.last_event_at },
        row,
        row.content,
        budget,
      );
      if (budget.exhausted) return 'incomplete';
    },
    'gnl.id',
  );
}

// Permanently deletes terminal history once nobody could plausibly still
// need it: cancelled events (any type) and resolved/cancelled polls,
// TERMINAL_HISTORY_RETENTION_MS after their last update. This is what
// actually reclaims the storage and stops these rows counting against any
// future scan at all -- the hot-window filters on the sweeps above only stop
// re-scanning recent terminal rows, they don't remove old ones.
//
// Bounded to one batch of TERMINAL_HISTORY_PURGE_BATCH_SIZE events per tick,
// same reasoning as the recurring-event paging above: a backlog gets worked
// off gradually across ticks rather than in one unbounded sweep.
async function sweepPurgeTerminalHistory(env: Env, budget: TickBudget): Promise<void> {
  const cutoff = Date.now() - TERMINAL_HISTORY_RETENTION_MS;
  const { results: candidates } = await env.DB.prepare(
    `SELECT id FROM events
     WHERE updated_at < ? AND (status = 'cancelled' OR (event_type = 'poll' AND status = 'resolved'))
     ORDER BY updated_at ASC
     LIMIT ?`,
  )
    .bind(cutoff, TERMINAL_HISTORY_PURGE_BATCH_SIZE)
    .all<{ id: string }>();
  if (candidates.length === 0) return;

  // Charged, not reserved for. Reserving PURGE_STATEMENTS_PER_CHUNK
  // permanently would take it away from notifications on every tick,
  // including the overwhelming majority where there is nothing to purge at
  // all. Charging it means a tick that has spent its allowance sending DMs
  // simply doesn't purge this time. Deleting ninety-day-old cancelled events
  // is the least urgent thing the cron does; it can wait for a quieter tick.
  //
  // Only the first chunk, not every chunk this batch's SELECT happened to
  // return (IDEAS items 53/56 -- see PURGE_STATEMENTS_PER_CHUNK's comment).
  // `candidates.length > 0` above guarantees chunkIds returns at least one
  // chunk here. The SELECT re-runs every tick and naturally picks up
  // wherever the last tick left off, since a purged row simply stops
  // matching it -- an already-large backlog drains a chunk at a time across
  // ticks rather than needing its entire size to fit in one.
  const [chunk] = chunkIds(candidates.map((c) => c.id));
  if (!budget.trySpend(PURGE_STATEMENTS_PER_CHUNK)) {
    console.log('Skipping terminal-history purge this tick; the allowance went to notifications.');
    return;
  }

  // Deletes are scoped to these specific, already-selected ids rather than
  // repeating the SELECT above as a subquery in each statement -- plain
  // DELETE doesn't support ORDER BY/LIMIT directly, and re-running an
  // unordered version of the same predicate per statement would risk each
  // one matching a slightly different set if a row's state changed between
  // them.
  // Same child-first, id-scoped shape as deleteUserCompletely: not every
  // table below cascades from `events` (see migration comments), so the
  // ones that don't are deleted explicitly rather than relied on to cascade.
  const ph = placeholders(chunk.length);
  const statements: D1PreparedStatement[] = [
    // IDEAS item 56: migration 0027's created_from_poll_id/created_from_option_id
    // are a fanned-out event's pointer back to the multi-winner poll and
    // option it came from, and neither carries ON DELETE CASCADE. A
    // still-live fanned-out event (not terminal, so never itself in this
    // chunk) can hold one of these pointing at a poll or option this chunk
    // is about to delete -- left set, that's a bare "FOREIGN KEY constraint
    // failed" naming nothing, the same shape item 38 hit from a different
    // column, and clean-sandbox.sql already works around it the same way:
    // break the pointer before anything it points at is removed. Two
    // statements, not one `OR` -- binding `chunk` on both sides of one
    // statement would double its parameter count, and a full-size chunk
    // already sits at D1's per-statement ceiling with one use of it.
    env.DB.prepare(`UPDATE events SET created_from_poll_id = NULL WHERE created_from_poll_id IN (${ph})`).bind(
      ...chunk,
    ),
    env.DB.prepare(
      `UPDATE events SET created_from_option_id = NULL
       WHERE created_from_option_id IN (SELECT id FROM event_poll_options WHERE event_id IN (${ph}))`,
    ).bind(...chunk),
    env.DB.prepare(
      `DELETE FROM event_poll_votes WHERE option_id IN (SELECT id FROM event_poll_options WHERE event_id IN (${ph}))`,
    ).bind(...chunk),
    env.DB.prepare(`DELETE FROM event_poll_options WHERE event_id IN (${ph})`).bind(...chunk),
    env.DB.prepare(`DELETE FROM event_window_availability WHERE event_id IN (${ph})`).bind(...chunk),
    env.DB.prepare(`DELETE FROM event_invites WHERE event_id IN (${ph})`).bind(...chunk),
    env.DB.prepare(`DELETE FROM event_attendance WHERE event_id IN (${ph})`).bind(...chunk),
    env.DB.prepare(`DELETE FROM event_recurrence_rules WHERE event_id IN (${ph})`).bind(...chunk),
    env.DB.prepare(`DELETE FROM event_occurrence_overrides WHERE event_id IN (${ph})`).bind(...chunk),
    env.DB.prepare(`DELETE FROM notification_log WHERE event_id IN (${ph})`).bind(...chunk),
    env.DB.prepare(`DELETE FROM events WHERE id IN (${ph})`).bind(...chunk),
  ];
  await env.DB.batch(statements);

  console.log(`Purged ${chunk.length} terminal event(s) older than ${TERMINAL_HISTORY_RETENTION_MS / DAY_MS} days.`);
}

// Keeps the membership cache fresh enough for every recipient query above to
// filter on verified_at alone. Without this the cron would face a choice
// between one live Discord call per recipient per tick (unaffordable) and
// trusting rows of unbounded age (what review flagged) -- this is the third
// option: a bounded, steady background refresh that neither scales with the
// notification volume nor lets any row drift past the grace window.
async function sweepMembershipRevalidation(env: Env, budget: TickBudget): Promise<void> {
  const checked = await revalidateStaleMemberships(env, MEMBERSHIP_REVALIDATIONS_PER_TICK, budget);
  if (checked > 0) console.log(`Revalidated ${checked} stale guild membership row(s).`);
}

// Each sweep is independently fault-isolated: one throwing (a malformed row
// that slipped past write-time validation, a transient D1 error) must not
// prevent the other sweep types from running this tick, since they cover
// unrelated notifications on their own schedules.
async function runIsolated(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    console.error(`Cron sweep "${name}" failed:`, err);
  }
}

export async function runReminderSweep(env: Env): Promise<void> {
  // Order matters: transition deadline-passed polls first so their invitees
  // get a poll_resolved DM in the same tick, then invites, then time-based
  // reminders. The two "poll resolution" notification sweeps re-scan every
  // resolved/cancelled poll each tick (dedupe makes that safe) rather than
  // depending on "resolved this exact tick", since single_winner polls often
  // resolve synchronously via threshold well before any deadline.
  // Runs first so every recipient query in the sweeps below sees the
  // freshest membership state this tick can afford.
  // One allowance shared by every sweep in this tick. Cloudflare enforces
  // per-invocation ceilings on both D1 queries and outbound subrequests, and
  // the notification sweeps below are the only things here whose cost scales
  // with user data rather than being roughly fixed -- so they draw from a
  // common pool and stop when it runs dry, instead of each being separately
  // "reasonable" and collectively over the line.
  const budget = new TickBudget(planFrom(env.WORKERS_PLAN));

  // Every sweep's scan position, read in one query here and written back in
  // one batch below. Ten cursored sweeps doing their own read/write would be
  // twenty statements of fixed bookkeeping per tick against a Free-plan
  // allowance of fifty.
  const cursors = await CursorStore.load(env);

  await runIsolated('membershipRevalidation', () => sweepMembershipRevalidation(env, budget));
  await runIsolated('pollDeadlines', () => sweepPollDeadlines(env, budget));
  await runIsolated('changeRequestDeadlines', () => sweepChangeRequestDeadlines(env, budget));
  await runIsolated('singleWinnerPollNotifications', () => sweepSingleWinnerPollNotifications(env, budget, cursors));
  await runIsolated('multiWinnerPollClosedNotifications', () =>
    sweepMultiWinnerPollClosedNotifications(env, budget, cursors),
  );
  await runIsolated('confirmedMultiWinnerOptions', () => sweepConfirmedMultiWinnerOptions(env, budget, cursors));
  await runIsolated('cancellationCascade', () => sweepCancellationCascade(env, budget));
  await runIsolated('minimumAttendeesDeadlines', () => sweepMinimumAttendeesDeadlines(env, budget));
  await runIsolated('minimumAttendeesDeadlineWarnings', () => sweepMinimumAttendeesDeadlineWarnings(env, budget));
  await runIsolated('newInvites', () => sweepNewInvites(env, budget));
  await runIsolated('changeRequestNotifications', () => sweepChangeRequestNotifications(env, budget));
  await runIsolated('reminders', () => sweepReminders(env, budget, cursors));
  await runIsolated('pollDeadlineReminders', () => sweepPollDeadlineReminders(env, budget, cursors));
  await runIsolated('voiceChannelInvites', () => sweepVoiceChannelInvites(env, budget, cursors));
  await runIsolated('idleGroups', () => sweepIdleGroups(env, budget, cursors));
  await runIsolated('groupDrift', () => sweepGroupDrift(env, budget));
  await runIsolated('organizerRsvpNotices', () => sweepOrganizerRsvpNotices(env, budget));
  await runIsolated('pruneStaleSessions', () => pruneStaleSessions(env));
  await runIsolated('purgeTerminalHistory', () => sweepPurgeTerminalHistory(env, budget));
  // Source-independent retry consumers (F-04-H2): a row whose source
  // event/poll/group has already left every other sweep's scan window can
  // still be due for retry, so these scan the outbox tables directly by
  // next_attempt_at. Run before reaping so a row that just became due gets a
  // chance at delivery in the same tick it's picked up in, rather than
  // possibly being reaped on a tick it was never actually retried.
  await runIsolated('dueNotificationRetries', () => sweepDueNotificationRetries(env, budget, cursors));
  await runIsolated('dueNudgeRetries', () => sweepDueNudgeRetries(env, budget, cursors));
  // Last of the budget-charged sweeps, deliberately: its own threshold is a
  // year of inactivity, so it has nothing to lose by going last and being the
  // one starved on a busy tick, and everything above it (same-day reminders,
  // the terminal-history purge with its own zero-margin budget fit -- see
  // test/pass6.test.ts) is more time-sensitive than a warning DM or a purge
  // that would fire again next tick regardless.
  await runIsolated('staleAccounts', () => sweepStaleAccounts(env, budget));
  // Last, so it settles anything that used up its final attempt during this
  // tick rather than leaving it for the next one.
  await runIsolated('reapExhaustedDeliveries', () => reapExhaustedDeliveries(env));

  // Persisted once, after every sweep has had its turn. Isolated like the
  // sweeps themselves: losing the cursor write costs a tick of re-scanning,
  // which the outbox dedupes, and must not mask a tick that otherwise worked.
  await runIsolated('flushCursors', () => cursors.flush());

  // Routinely hitting zero means work is being deferred every tick, which is
  // survivable (the next tick resumes it) but worth knowing about -- it means
  // either the install has outgrown the Free plan or a limit needs revisiting.
  if (budget.exhausted) {
    console.warn('Cron tick exhausted its work budget; remaining notifications deferred to the next tick.');
  }
}
