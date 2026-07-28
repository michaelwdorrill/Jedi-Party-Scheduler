import { DateTime } from 'luxon';
import type { Env } from '../env';
import type { EventRow, OverrideRow } from '../lib/events';
import { loadOverridesForEvents } from '../lib/events';
import { expandOccurrencesForEvent, loadRecurrenceRulesForEvents, type RecurrenceRule } from '../lib/recurrence';
import { resolvePastDeadlinePolls } from '../lib/polls';
import { getConfirmedAttendeeIds } from '../lib/attendance';
import { pruneStaleSessions } from '../lib/sessions';
import { MEMBERSHIP_GRACE_MS, revalidateStaleMemberships } from '../lib/db';
import { deliverThroughOutbox, MAX_DELIVERY_ATTEMPTS, reapExhaustedDeliveries, type DmRecipient } from '../lib/outbox';
import { chunkIds, placeholders } from '../lib/d1';
import { planFrom, TickBudget } from './budget';
import { readCursor, writeCursor, type CursorName } from './cursor';

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

type NotificationType =
  | 'invite'
  | 'reminder_24h'
  | 'reminder_1h'
  | 'poll_resolved'
  | 'poll_deadline_reminder'
  | 'voice_channel_invite';

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
  );
}

// One query answers "which of these users has this notification already been
// settled for?" for a whole recipient list at once.
//
// Without it, every recipient cost a claim() attempt whether or not anything
// was sent -- and at an event's 300-invitee maximum, the great majority of
// those are already delivered. The claim is cheap per row but there is no
// bound on how many rows there are, so the tick's *total* was unbounded:
// re-scanning a fully-delivered 300-invitee event cost hundreds of statements
// every fifteen minutes, forever, to send nothing.
//
// This is purely a filter, never the correctness boundary. claim() still
// re-checks each row under its lease, so a row that settles between this
// query and the attempt is still handled correctly. The set only stops the
// tick paying to ask a question it already has the answer to.
async function settledRecipients(
  env: Env,
  eventId: string,
  notificationType: NotificationType,
  occurrenceDate: string,
): Promise<Set<string>> {
  const now = Date.now();
  const { results } = await env.DB.prepare(
    `SELECT user_id FROM notification_log
     WHERE event_id = ? AND notification_type = ? AND occurrence_date = ?
       AND (delivered_at IS NOT NULL OR failed_at IS NOT NULL
            OR (claimed_until IS NOT NULL AND claimed_until > ?)
            OR (next_attempt_at IS NOT NULL AND next_attempt_at > ?))`,
  )
    .bind(eventId, notificationType, occurrenceDate, now, now)
    .all<{ user_id: string }>();
  return new Set(results.map((r) => r.user_id));
}

// What one event costs a sweep before a single DM is sent. Charged up front
// so the tick stops walking events once it can no longer afford to look at
// one, rather than discovering that only when it tries to deliver.
const SCAN_COST_PER_EVENT = 1;

// Delivers one notification type to a list of recipients, skipping the ones
// already settled and stopping the moment the tick can no longer afford a
// send. Stopping rather than skipping is deliberate: the next recipient costs
// at least as much as this one, so continuing the loop can only overspend.
// Whatever is left is still pending, and the next tick resumes from there.
async function notifyEach(
  env: Env,
  budget: TickBudget,
  recipients: readonly ParticipantRow[],
  eventId: string,
  notificationType: NotificationType,
  occurrenceDate: string,
  message: (user: ParticipantRow) => string,
): Promise<void> {
  if (recipients.length === 0 || budget.exhausted) return;
  const settled = await settledRecipients(env, eventId, notificationType, occurrenceDate);
  for (const user of recipients) {
    if (budget.exhausted) return;
    if (settled.has(user.id)) continue;
    await notifyOnce(env, budget, user, eventId, notificationType, occurrenceDate, message(user));
  }
}

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
): Promise<void> {
  for (const user of recipients) {
    if (budget.exhausted) return;
    await notifyOnce(env, budget, user, eventId, notificationType, occurrenceDate, message(user));
  }
}

// Rendered in the *recipient's* configured timezone -- a DM saying "17:00
// GMT" is useless to someone who set themselves to Eastern.
function formatWhen(startAt: number, zone: string): string {
  return DateTime.fromMillis(startAt).setZone(zone).toFormat("ccc d LLL, h:mm a ZZZZ");
}

// Deep link straight to the event so the DM is actionable rather than just
// informational -- HashRouter, so the fragment is part of the URL.
function eventLink(env: Env, eventId: string): string {
  return `${env.FRONTEND_URL}/#/events/${eventId}`;
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
  const { results } = await env.DB.prepare(
    `SELECT ei.event_id, ei.user_id, e.title,
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
    .all<{ event_id: string; user_id: string; title: string } & Omit<ParticipantRow, 'id'>>();

  for (const row of results) {
    if (budget.exhausted) return;
    try {
      await notifyOnce(
        env,
        budget,
        {
          id: row.user_id,
          notifications_enabled: row.notifications_enabled,
          dm_channel_id: row.dm_channel_id,
          timezone: row.timezone,
        },
        row.event_id,
        'invite',
        '',
        `You've been invited to "${row.title}" on Uncle Owen.\n${eventLink(env, row.event_id)}`,
      );
    } catch (err) {
      console.error(`sweepNewInvites failed for event ${row.event_id}/user ${row.user_id}:`, err);
    }
  }
}

async function sweepReminders(env: Env, budget: TickBudget): Promise<void> {
  const now = Date.now();
  const windowEnd = now + 24 * HOUR_MS;

  // Ordered by start time so the most urgent reminders are attempted first,
  // and resumed from a cursor so a backlog larger than one tick's allowance
  // rotates instead of the same prefix winning every tick forever.
  const singleStart = await readCursor(env, 'reminders_single');
  const { results: singleEvents } = await env.DB.prepare(
    `SELECT * FROM events
     WHERE is_recurring = 0 AND status IN ('active','resolved')
       AND start_at IS NOT NULL AND start_at >= ? AND start_at <= ?
     ORDER BY start_at, id
     LIMIT ? OFFSET ?`,
  )
    .bind(now, windowEnd, SINGLE_EVENT_PAGE_SIZE, singleStart)
    .all<EventRow>();

  // Mutually exclusive, deliberately. These used to both fire for an event
  // inside the hour, which doubled the fan-out of the single most expensive
  // moment in the sweep to say two versions of the same thing -- and a
  // "coming up tomorrow" note is useless once the event is 40 minutes away
  // regardless.
  const reminderFor = (startAt: number): { type: NotificationType; render: (u: ParticipantRow) => string } | null => {
    const remaining = startAt - now;
    if (remaining <= HOUR_MS) {
      return { type: 'reminder_1h', render: (u) => `starts in about an hour (${formatWhen(startAt, u.timezone)})` };
    }
    if (remaining <= 24 * HOUR_MS) {
      return { type: 'reminder_24h', render: (u) => `is coming up on ${formatWhen(startAt, u.timezone)}` };
    }
    return null;
  };

  let scanned = 0;
  for (const event of singleEvents) {
    if (!budget.trySpend(SCAN_COST_PER_EVENT)) break;
    scanned++;
    try {
      const reminder = reminderFor(event.start_at!);
      if (!reminder) continue;
      const pending = await pendingRecipients(env, event, reminder.type, '', budget.deliveriesAffordable);
      await notifyPending(env, budget, pending, event.id, reminder.type, '', (user) =>
        `"${event.title}" ${reminder.render(user)}.\n${eventLink(env, event.id)}`,
      );
    } catch (err) {
      console.error(`sweepReminders (single) failed for event ${event.id}:`, err);
    }
  }
  // Wrap to the start once the whole scan has been covered, so the next tick
  // begins a fresh pass rather than running off the end.
  await writeCursor(env, 'reminders_single', scanned < singleEvents.length ? singleStart + scanned : 0);

  await forEachRecurringPage(env, budget, 'reminders_recurring', `SELECT * FROM events WHERE is_recurring = 1 AND status = 'active'`, async (event, overrides, rule) => {
    const occurrences = await expandOccurrencesForEvent(env, event, now, windowEnd, overrides, rule);
    if (occurrences.length === 0) return;

    for (const occ of occurrences) {
      const reminder = reminderFor(occ.startAt);
      if (!reminder) continue;
      if (!budget.trySpend(SCAN_COST_PER_EVENT)) return;
      const pending = await pendingRecipients(env, event, reminder.type, occ.date, budget.deliveriesAffordable);
      await notifyPending(env, budget, pending, event.id, reminder.type, occ.date, (user) =>
        `"${event.title}" ${reminder.render(user)}.\n${eventLink(env, event.id)}`,
      );
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
  cursorName: CursorName,
  sql: string,
  handle: (event: EventRow, overrides: OverrideRow[], rule: RecurrenceRule | undefined) => Promise<void>,
): Promise<void> {
  // Resumes where the last tick stopped. Without this the scan restarts at
  // zero every time, and once there are more recurring events than one tick's
  // allowance covers, everything past that prefix is never reached at all --
  // deferral turns into permanent starvation. See migration 0010.
  const start = await readCursor(env, cursorName);
  let offset = start;

  for (;;) {
    // Paging itself costs a query per page, so an exhausted tick stops
    // walking rather than reading pages it can't act on.
    if (!budget.trySpend(1)) {
      await writeCursor(env, cursorName, offset);
      return;
    }
    const { results: page } = await env.DB.prepare(`${sql} ORDER BY id LIMIT ? OFFSET ?`)
      .bind(RECURRING_PAGE_SIZE, offset)
      .all<EventRow>();
    // End of the scan: wrap so the next tick starts a fresh pass. Reaching
    // here from a non-zero start is normal -- the pass simply began partway
    // through and the following one will cover what it skipped.
    if (page.length === 0) {
      await writeCursor(env, cursorName, 0);
      return;
    }

    try {
      const pageIds = page.map((e) => e.id);
      const overridesByEvent = await loadOverridesForEvents(env, pageIds);
      const rulesByEvent = await loadRecurrenceRulesForEvents(env, pageIds);
      for (const event of page) {
        if (budget.exhausted) {
          await writeCursor(env, cursorName, offset);
          return;
        }
        try {
          await handle(event, overridesByEvent.get(event.id) ?? [], rulesByEvent.get(event.id));
        } catch (err) {
          console.error(`recurring sweep failed for event ${event.id}:`, err);
        }
        offset++;
      }
    } catch (err) {
      console.error(`recurring sweep failed for page at offset ${offset}:`, err);
      offset += page.length;
    }

    if (page.length < RECURRING_PAGE_SIZE) {
      await writeCursor(env, cursorName, 0);
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
async function sweepPollDeadlines(env: Env): Promise<void> {
  await resolvePastDeadlinePolls(env);
}

// Covers every resolved/cancelled single_winner (incl. window-mode) poll,
// regardless of whether it resolved synchronously via threshold or via the
// deadline sweep above -- notifyOnce's dedupe makes it safe to re-scan all
// of them every tick rather than track "which ones are new".
async function sweepSingleWinnerPollNotifications(env: Env, budget: TickBudget): Promise<void> {
  if (budget.exhausted) return;
  const { results: polls } = await env.DB.prepare(
    `SELECT * FROM events
     WHERE event_type = 'poll' AND poll_resolution_mode = 'single_winner' AND status IN ('resolved','cancelled')
       AND updated_at >= ?`,
  )
    .bind(terminalHistoryHotCutoff())
    .all<EventRow>();

  for (const event of polls) {
    if (!budget.trySpend(SCAN_COST_PER_EVENT)) return;
    try {
      const pending = await pendingRecipients(env, event, 'poll_resolved', '', budget.deliveriesAffordable);
      await notifyPending(env, budget, pending, event.id, 'poll_resolved', '', (user) =>
        event.status === 'resolved'
          ? `"${event.title}" is on! Time locked in: ${formatWhen(event.start_at!, user.timezone)}.\n${eventLink(env, event.id)}`
          : `"${event.title}" didn't get enough votes and was cancelled.`,
      );
    } catch (err) {
      console.error(`sweepSingleWinnerPollNotifications failed for event ${event.id}:`, err);
    }
  }
}

// multi_winner events only ever transition out of 'active' via the deadline
// sweep (never synchronously -- individual options confirm independently
// while the event stays active), so this one is safe to drive off "closed
// this tick" the same way sweepPollDeadlines is a one-shot state change.
async function sweepMultiWinnerPollClosedNotifications(env: Env, budget: TickBudget): Promise<void> {
  if (budget.exhausted) return;
  const { results: polls } = await env.DB.prepare(
    `SELECT * FROM events
     WHERE event_type = 'poll' AND poll_resolution_mode = 'multi_winner' AND status IN ('resolved','cancelled')
       AND updated_at >= ?`,
  )
    .bind(terminalHistoryHotCutoff())
    .all<EventRow>();

  for (const event of polls) {
    if (!budget.trySpend(SCAN_COST_PER_EVENT + 1)) return;
    try {
      // Per-day confirmations are notified separately (as they happen, to
      // just that day's yes-voters) by sweepConfirmedMultiWinnerOptions --
      // this is just a "voting closed" note to everyone else invited.
      const { results: confirmedCount } = await env.DB.prepare(
        `SELECT COUNT(*) as n FROM event_poll_options WHERE event_id = ? AND confirmed_at IS NOT NULL`,
      )
        .bind(event.id)
        .all<{ n: number }>();
      const n = confirmedCount[0]?.n ?? 0;
      const pending = await pendingRecipients(env, event, 'poll_resolved', '', budget.deliveriesAffordable);
      const message =
        n > 0
          ? `Voting for "${event.title}" has closed. ${n} day(s) got confirmed -- check the event for details.\n${eventLink(env, event.id)}`
          : `"${event.title}" didn't get enough interest on any day and was cancelled.`;
      await notifyPending(env, budget, pending, event.id, 'poll_resolved', '', () => message);
    } catch (err) {
      console.error(`sweepMultiWinnerPollClosedNotifications failed for event ${event.id}:`, err);
    }
  }
}

// Multi-winner polls confirm individual days as soon as they hit quorum
// (checked synchronously in the vote route), independent of the deadline.
// This sweep notifies just that day's yes-voters, as soon as we notice.
async function sweepConfirmedMultiWinnerOptions(env: Env, budget: TickBudget): Promise<void> {
  if (budget.exhausted) return;
  const { results } = await env.DB.prepare(
    `SELECT epo.id as option_id, epo.event_id, epo.start_at, epo.end_at, e.title, e.guild_id
     FROM event_poll_options epo
     JOIN events e ON e.id = epo.event_id
     WHERE e.poll_resolution_mode = 'multi_winner' AND epo.confirmed_at IS NOT NULL`,
  ).all<{ option_id: string; event_id: string; start_at: number; end_at: number; title: string; guild_id: string }>();

  for (const opt of results) {
    if (!budget.trySpend(SCAN_COST_PER_EVENT)) return;
    try {
      const { results: yesVoters } = await env.DB.prepare(
        `SELECT u.id, u.notifications_enabled, u.dm_channel_id, u.timezone
         FROM event_poll_votes epv
         JOIN users u ON u.id = epv.user_id
         JOIN user_guild_membership m ON m.user_id = u.id AND m.guild_id = ? AND m.is_member = 1 AND m.verified_at >= ?
         JOIN guilds g ON g.id = m.guild_id AND g.is_active = 1
         WHERE epv.option_id = ? AND epv.vote = 'yes'`,
      )
        .bind(opt.guild_id, membershipCutoff(), opt.option_id)
        .all<ParticipantRow>();

      await notifyEach(
        env,
        budget,
        yesVoters,
        opt.event_id,
        'poll_resolved',
        opt.option_id,
        (user) =>
          `"${opt.title}" is on for ${formatWhen(opt.start_at, user.timezone)}! You're confirmed.\n${eventLink(env, opt.event_id)}`,
      );
    } catch (err) {
      console.error(`sweepConfirmedMultiWinnerOptions failed for option ${opt.option_id}:`, err);
    }
  }
}

// Reminds invitees 24h before a poll's deadline, but only the ones who
// haven't cast a single vote (options mode) or submitted availability
// (window mode) yet -- people who already responded don't need a nudge.
async function sweepPollDeadlineReminders(env: Env, budget: TickBudget): Promise<void> {
  if (budget.exhausted) return;
  const now = Date.now();
  const windowEnd = now + 24 * HOUR_MS;

  const { results: polls } = await env.DB.prepare(
    `SELECT * FROM events
     WHERE event_type = 'poll' AND status = 'active'
       AND poll_deadline_at IS NOT NULL AND poll_deadline_at >= ? AND poll_deadline_at <= ?`,
  )
    .bind(now, windowEnd)
    .all<EventRow>();

  for (const poll of polls) {
    if (!budget.trySpend(SCAN_COST_PER_EVENT)) return;
    try {
      const hasVotedSubquery =
        poll.poll_mode === 'window'
          ? `SELECT 1 FROM event_window_availability WHERE event_id = ei.event_id AND user_id = ei.user_id`
          : `SELECT 1 FROM event_poll_votes WHERE user_id = ei.user_id
             AND option_id IN (SELECT id FROM event_poll_options WHERE event_id = ei.event_id)`;

      const { results: nonVoters } = await env.DB.prepare(
        `SELECT u.id, u.notifications_enabled, u.dm_channel_id, u.timezone
         FROM event_invites ei
         JOIN users u ON u.id = ei.user_id
         JOIN user_guild_membership m ON m.user_id = u.id AND m.guild_id = ? AND m.is_member = 1 AND m.verified_at >= ?
         JOIN guilds g ON g.id = m.guild_id AND g.is_active = 1
         WHERE ei.event_id = ? AND NOT EXISTS (${hasVotedSubquery})`,
      )
        .bind(poll.guild_id, membershipCutoff(), poll.id)
        .all<ParticipantRow>();

      await notifyEach(
        env,
        budget,
        nonVoters,
        poll.id,
        'poll_deadline_reminder',
        '',
        () => `Voting for "${poll.title}" closes soon -- you haven't responded yet.\n${eventLink(env, poll.id)}`,
      );
    } catch (err) {
      console.error(`sweepPollDeadlineReminders failed for poll ${poll.id}:`, err);
    }
  }
}

// Deep link into the specific voice channel. Discord bots have no API to
// force a disconnected user into a voice channel -- this is as close as a
// DM can get, and it's still one click for someone who said they'd be there.
function voiceChannelLink(guildId: string, channelId: string): string {
  return `https://discord.com/channels/${guildId}/${channelId}`;
}

const VOICE_INVITE_LEAD_MS = 10 * 60 * 1000;

// Nudges confirmed attendees toward the event's voice channel a few minutes
// before it starts. Only fires for events where the organizer picked a
// channel; scoped to whoever actually committed (accepted RSVP / yes-voted
// the winning poll option / window availability covering the resolved time),
// never the full invite list.
async function sweepVoiceChannelInvites(env: Env, budget: TickBudget): Promise<void> {
  if (budget.exhausted) return;
  const now = Date.now();
  const windowEnd = now + VOICE_INVITE_LEAD_MS;

  const { results: fixedTimeEvents } = await env.DB.prepare(
    `SELECT * FROM events
     WHERE voice_channel_id IS NOT NULL AND is_recurring = 0 AND status IN ('active','resolved')
       AND start_at IS NOT NULL AND start_at >= ? AND start_at <= ?`,
  )
    .bind(now, windowEnd)
    .all<EventRow>();

  for (const event of fixedTimeEvents) {
    if (!budget.trySpend(SCAN_COST_PER_EVENT)) return;
    try {
      const optionId = event.event_type === 'poll' && event.poll_mode === 'options' ? event.resolved_option_id : null;
      const attendees = await getConfirmedAttendeeIds(env, event, optionId);
      await notifyEach(env, budget, attendees, event.id, 'voice_channel_invite', '', () =>
        `"${event.title}" is starting soon -- join the "${event.voice_channel_name}" voice channel:\n${voiceChannelLink(event.guild_id, event.voice_channel_id!)}`,
      );
    } catch (err) {
      console.error(`sweepVoiceChannelInvites (fixed-time) failed for event ${event.id}:`, err);
    }
  }

  await forEachRecurringPage(
    env,
    budget,
    'voice_recurring',
    `SELECT * FROM events WHERE voice_channel_id IS NOT NULL AND is_recurring = 1 AND status = 'active'`,
    async (event, overrides, rule) => {
      const occurrences = await expandOccurrencesForEvent(env, event, now, windowEnd, overrides, rule);
      if (occurrences.length === 0) return;

      const attendees = await getConfirmedAttendeeIds(env, event, null);
      for (const occ of occurrences) {
        if (!budget.trySpend(SCAN_COST_PER_EVENT)) return;
        await notifyEach(env, budget, attendees, event.id, 'voice_channel_invite', occ.date, () =>
          `"${event.title}" is starting soon -- join the "${event.voice_channel_name}" voice channel:\n${voiceChannelLink(event.guild_id, event.voice_channel_id!)}`,
        );
      }
    },
  );

  if (budget.exhausted) return;

  // multi_winner polls confirm each day independently, so each confirmed
  // option has its own attendee list (whoever voted yes on that day).
  const { results: multiWinnerPolls } = await env.DB.prepare(
    `SELECT * FROM events
     WHERE voice_channel_id IS NOT NULL AND event_type = 'poll' AND poll_resolution_mode = 'multi_winner'`,
  ).all<EventRow>();

  for (const poll of multiWinnerPolls) {
    if (!budget.trySpend(1)) return;
    try {
      const { results: options } = await env.DB.prepare(
        `SELECT id FROM event_poll_options
         WHERE event_id = ? AND confirmed_at IS NOT NULL AND start_at >= ? AND start_at <= ?`,
      )
        .bind(poll.id, now, windowEnd)
        .all<{ id: string }>();

      for (const opt of options) {
        if (!budget.trySpend(SCAN_COST_PER_EVENT)) return;
        const attendees = await getConfirmedAttendeeIds(env, poll, opt.id);
        await notifyEach(env, budget, attendees, poll.id, 'voice_channel_invite', opt.id, () =>
          `"${poll.title}" is starting soon -- join the "${poll.voice_channel_name}" voice channel:\n${voiceChannelLink(poll.guild_id, poll.voice_channel_id!)}`,
        );
      }
    } catch (err) {
      console.error(`sweepVoiceChannelInvites (multi-winner) failed for poll ${poll.id}:`, err);
    }
  }
}

interface GroupIdleRow {
  id: string;
  idle_reminder_days: number;
}

// If a group has had at least one past event but nothing scheduled since,
// and it's been idle longer than the group's configured window, nudge every
// member to plan something. Fires once per idle episode (dedup keyed on the
// group's last known event time), not on every 15-minute tick.
async function sweepIdleGroups(env: Env, budget: TickBudget): Promise<void> {
  if (budget.exhausted) return;
  const now = Date.now();
  const { results: groups } = await env.DB.prepare(
    `SELECT id, idle_reminder_days FROM groups`,
  ).all<GroupIdleRow>();

  for (const group of groups) {
    if (!budget.trySpend(SCAN_COST_PER_EVENT + 1)) return;
    try {
      const { results: eventRows } = await env.DB.prepare(
        `SELECT DISTINCT e.start_at, e.end_at FROM events e
         JOIN event_invites ei ON ei.event_id = e.id
         WHERE ei.source_group_id = ? AND e.status != 'cancelled' AND e.start_at IS NOT NULL`,
      )
        .bind(group.id)
        .all<{ start_at: number; end_at: number }>();

      if (eventRows.length === 0) continue; // never had an event -- not "idle", just new

      const lastEventAt = Math.max(...eventRows.map((e) => e.end_at ?? e.start_at));
      const hasUpcoming = eventRows.some((e) => e.start_at > now);
      if (hasUpcoming) continue;

      const idleMs = group.idle_reminder_days * 24 * HOUR_MS;
      if (now - lastEventAt < idleMs) continue;

      const { results: members } = await env.DB.prepare(
        `SELECT u.id, u.notifications_enabled, u.dm_channel_id, u.timezone, g.name as group_name
         FROM group_members gm
         JOIN users u ON u.id = gm.user_id
         JOIN groups g ON g.id = gm.group_id
         JOIN user_guild_membership m ON m.user_id = u.id AND m.guild_id = g.guild_id AND m.is_member = 1 AND m.verified_at >= ?
         JOIN guilds gu ON gu.id = m.guild_id AND gu.is_active = 1
         WHERE gm.group_id = ?`,
      )
        .bind(membershipCutoff(), group.id)
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
    } catch (err) {
      console.error(`sweepIdleGroups failed for group ${group.id}:`, err);
    }
  }
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
async function sweepPurgeTerminalHistory(env: Env): Promise<void> {
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

  // Deletes are scoped to these specific, already-selected ids (chunked
  // below D1's parameter ceiling) rather than repeating the SELECT above as
  // a subquery in each statement -- plain DELETE doesn't support ORDER
  // BY/LIMIT directly, and re-running an unordered version of the same
  // predicate per statement would risk each one matching a slightly
  // different set if a row's state changed between them.
  const eventIds = candidates.map((c) => c.id);

  // Same child-first, id-scoped shape as deleteUserCompletely: D1 doesn't
  // enforce these foreign keys, so the children are deleted explicitly
  // rather than relied on to cascade.
  const statements: D1PreparedStatement[] = [];
  for (const chunk of chunkIds(eventIds)) {
    const ph = placeholders(chunk.length);
    statements.push(
      env.DB.prepare(
        `DELETE FROM event_poll_votes WHERE option_id IN (SELECT id FROM event_poll_options WHERE event_id IN (${ph}))`,
      ).bind(...chunk),
      env.DB.prepare(`DELETE FROM event_poll_options WHERE event_id IN (${ph})`).bind(...chunk),
      env.DB.prepare(`DELETE FROM event_window_availability WHERE event_id IN (${ph})`).bind(...chunk),
      env.DB.prepare(`DELETE FROM event_invites WHERE event_id IN (${ph})`).bind(...chunk),
      env.DB.prepare(`DELETE FROM event_recurrence_rules WHERE event_id IN (${ph})`).bind(...chunk),
      env.DB.prepare(`DELETE FROM event_occurrence_overrides WHERE event_id IN (${ph})`).bind(...chunk),
      env.DB.prepare(`DELETE FROM notification_log WHERE event_id IN (${ph})`).bind(...chunk),
      env.DB.prepare(`DELETE FROM events WHERE id IN (${ph})`).bind(...chunk),
    );
  }
  await env.DB.batch(statements);

  console.log(`Purged ${candidates.length} terminal event(s) older than ${TERMINAL_HISTORY_RETENTION_MS / DAY_MS} days.`);
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

  await runIsolated('membershipRevalidation', () => sweepMembershipRevalidation(env, budget));
  await runIsolated('pollDeadlines', () => sweepPollDeadlines(env));
  await runIsolated('singleWinnerPollNotifications', () => sweepSingleWinnerPollNotifications(env, budget));
  await runIsolated('multiWinnerPollClosedNotifications', () => sweepMultiWinnerPollClosedNotifications(env, budget));
  await runIsolated('confirmedMultiWinnerOptions', () => sweepConfirmedMultiWinnerOptions(env, budget));
  await runIsolated('newInvites', () => sweepNewInvites(env, budget));
  await runIsolated('reminders', () => sweepReminders(env, budget));
  await runIsolated('pollDeadlineReminders', () => sweepPollDeadlineReminders(env, budget));
  await runIsolated('voiceChannelInvites', () => sweepVoiceChannelInvites(env, budget));
  await runIsolated('idleGroups', () => sweepIdleGroups(env, budget));
  await runIsolated('pruneStaleSessions', () => pruneStaleSessions(env));
  await runIsolated('purgeTerminalHistory', () => sweepPurgeTerminalHistory(env));
  // Last, so it settles anything that used up its final attempt during this
  // tick rather than leaving it for the next one.
  await runIsolated('reapExhaustedDeliveries', () => reapExhaustedDeliveries(env));

  // Routinely hitting zero means work is being deferred every tick, which is
  // survivable (the next tick resumes it) but worth knowing about -- it means
  // either the install has outgrown the Free plan or a limit needs revisiting.
  if (budget.exhausted) {
    console.warn('Cron tick exhausted its work budget; remaining notifications deferred to the next tick.');
  }
}
