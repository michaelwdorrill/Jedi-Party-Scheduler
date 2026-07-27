import { DateTime } from 'luxon';
import type { Env } from '../env';
import { newId } from '../lib/ids';
import { sendBotDm } from '../lib/discord';
import type { EventRow } from '../lib/events';
import { loadOverridesForEvents } from '../lib/events';
import { expandOccurrencesForEvent } from '../lib/recurrence';
import { resolvePastDeadlinePolls } from '../lib/polls';

const HOUR_MS = 60 * 60 * 1000;

interface ParticipantRow {
  id: string;
  notifications_enabled: number;
  dm_channel_id: string | null;
  timezone: string;
}

async function getEventParticipants(env: Env, eventId: string, organizerId: string): Promise<ParticipantRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT id, notifications_enabled, dm_channel_id, timezone FROM users WHERE id IN
       (SELECT user_id FROM event_invites WHERE event_id = ? UNION SELECT ?)`,
  )
    .bind(eventId, organizerId)
    .all<ParticipantRow>();
  return results;
}

async function deliverDm(env: Env, user: ParticipantRow, content: string): Promise<void> {
  const { result, channelId } = await sendBotDm(env.DISCORD_BOT_TOKEN, user.id, content, user.dm_channel_id);
  if (channelId && channelId !== user.dm_channel_id) {
    await env.DB.prepare(`UPDATE users SET dm_channel_id = ? WHERE id = ?`).bind(channelId, user.id).run();
  }
  if (result.status === 429 && result.retryAfterMs) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(result.retryAfterMs!, 5000)));
  }
}

// Inserts the dedupe record *before* attempting delivery -- the row's
// insertion succeeding (not the DM succeeding) is what "sent" means here.
// If the insert fails (UNIQUE violation), a notification of this exact kind
// was already logged and we skip sending again.
async function notifyOnce(
  env: Env,
  user: ParticipantRow,
  eventId: string,
  notificationType: 'invite' | 'reminder_24h' | 'reminder_1h' | 'poll_resolved' | 'poll_deadline_reminder',
  occurrenceDate: string,
  content: string,
): Promise<void> {
  if (!user.notifications_enabled) return;

  try {
    await env.DB.prepare(
      `INSERT INTO notification_log (id, user_id, event_id, notification_type, occurrence_date, sent_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
      .bind(newId(), user.id, eventId, notificationType, occurrenceDate, Date.now())
      .run();
  } catch {
    return; // already logged (and thus already attempted) for this exact notification
  }

  await deliverDm(env, user, content);
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

async function sweepNewInvites(env: Env): Promise<void> {
  const { results } = await env.DB.prepare(
    `SELECT ei.event_id, ei.user_id, e.title
     FROM event_invites ei
     JOIN events e ON e.id = ei.event_id
     LEFT JOIN notification_log nl
       ON nl.user_id = ei.user_id AND nl.event_id = ei.event_id
       AND nl.notification_type = 'invite' AND nl.occurrence_date = ''
     WHERE e.status != 'cancelled' AND nl.id IS NULL`,
  ).all<{ event_id: string; user_id: string; title: string }>();

  for (const row of results) {
    const user = await env.DB.prepare(
      `SELECT id, notifications_enabled, dm_channel_id, timezone FROM users WHERE id = ?`,
    )
      .bind(row.user_id)
      .first<ParticipantRow>();
    if (!user) continue;
    await notifyOnce(
      env,
      user,
      row.event_id,
      'invite',
      '',
      `You've been invited to "${row.title}" on Uncle Owen.\n${eventLink(env, row.event_id)}`,
    );
  }
}

async function sweepReminders(env: Env): Promise<void> {
  const now = Date.now();
  const windowEnd = now + 24 * HOUR_MS;

  const { results: singleEvents } = await env.DB.prepare(
    `SELECT * FROM events
     WHERE is_recurring = 0 AND status IN ('active','resolved')
       AND start_at IS NOT NULL AND start_at >= ? AND start_at <= ?`,
  )
    .bind(now, windowEnd)
    .all<EventRow>();

  for (const event of singleEvents) {
    const participants = await getEventParticipants(env, event.id, event.organizer_id);
    const remaining = event.start_at! - now;
    for (const user of participants) {
      if (remaining <= HOUR_MS) {
        await notifyOnce(env, user, event.id, 'reminder_1h', '', `"${event.title}" starts in about an hour (${formatWhen(event.start_at!, user.timezone)}).\n${eventLink(env, event.id)}`);
      }
      if (remaining <= 24 * HOUR_MS) {
        await notifyOnce(env, user, event.id, 'reminder_24h', '', `"${event.title}" is coming up on ${formatWhen(event.start_at!, user.timezone)}.\n${eventLink(env, event.id)}`);
      }
    }
  }

  const { results: recurringEvents } = await env.DB.prepare(
    `SELECT * FROM events WHERE is_recurring = 1 AND status = 'active'`,
  ).all<EventRow>();

  if (recurringEvents.length > 0) {
    const overridesByEvent = await loadOverridesForEvents(env, recurringEvents.map((e) => e.id));
    for (const event of recurringEvents) {
      const occurrences = await expandOccurrencesForEvent(
        env,
        event,
        now,
        windowEnd,
        overridesByEvent.get(event.id) ?? [],
      );
      if (occurrences.length === 0) continue;

      const participants = await getEventParticipants(env, event.id, event.organizer_id);
      for (const occ of occurrences) {
        const remaining = occ.startAt - now;
        for (const user of participants) {
          if (remaining <= HOUR_MS) {
            await notifyOnce(env, user, event.id, 'reminder_1h', occ.date, `"${event.title}" starts in about an hour (${formatWhen(occ.startAt, user.timezone)}).\n${eventLink(env, event.id)}`);
          }
          if (remaining <= 24 * HOUR_MS) {
            await notifyOnce(env, user, event.id, 'reminder_24h', occ.date, `"${event.title}" is coming up on ${formatWhen(occ.startAt, user.timezone)}.\n${eventLink(env, event.id)}`);
          }
        }
      }
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
async function sweepSingleWinnerPollNotifications(env: Env): Promise<void> {
  const { results: polls } = await env.DB.prepare(
    `SELECT * FROM events
     WHERE event_type = 'poll' AND poll_resolution_mode = 'single_winner' AND status IN ('resolved','cancelled')`,
  ).all<EventRow>();

  for (const event of polls) {
    const participants = await getEventParticipants(env, event.id, event.organizer_id);
    for (const user of participants) {
      const message =
        event.status === 'resolved'
          ? `"${event.title}" is on! Time locked in: ${formatWhen(event.start_at!, user.timezone)}.\n${eventLink(env, event.id)}`
          : `"${event.title}" didn't get enough votes and was cancelled.`;
      await notifyOnce(env, user, event.id, 'poll_resolved', '', message);
    }
  }
}

// multi_winner events only ever transition out of 'active' via the deadline
// sweep (never synchronously -- individual options confirm independently
// while the event stays active), so this one is safe to drive off "closed
// this tick" the same way sweepPollDeadlines is a one-shot state change.
async function sweepMultiWinnerPollClosedNotifications(env: Env): Promise<void> {
  const { results: polls } = await env.DB.prepare(
    `SELECT * FROM events
     WHERE event_type = 'poll' AND poll_resolution_mode = 'multi_winner' AND status IN ('resolved','cancelled')`,
  ).all<EventRow>();

  for (const event of polls) {
    // Per-day confirmations are notified separately (as they happen, to
    // just that day's yes-voters) by sweepConfirmedMultiWinnerOptions --
    // this is just a "voting closed" note to everyone else invited.
    const { results: confirmedCount } = await env.DB.prepare(
      `SELECT COUNT(*) as n FROM event_poll_options WHERE event_id = ? AND confirmed_at IS NOT NULL`,
    )
      .bind(event.id)
      .all<{ n: number }>();
    const n = confirmedCount[0]?.n ?? 0;
    const participants = await getEventParticipants(env, event.id, event.organizer_id);
    const message =
      n > 0
        ? `Voting for "${event.title}" has closed. ${n} day(s) got confirmed -- check the event for details.\n${eventLink(env, event.id)}`
        : `"${event.title}" didn't get enough interest on any day and was cancelled.`;
    for (const user of participants) {
      await notifyOnce(env, user, event.id, 'poll_resolved', '', message);
    }
  }
}

// Multi-winner polls confirm individual days as soon as they hit quorum
// (checked synchronously in the vote route), independent of the deadline.
// This sweep notifies just that day's yes-voters, as soon as we notice.
async function sweepConfirmedMultiWinnerOptions(env: Env): Promise<void> {
  const { results } = await env.DB.prepare(
    `SELECT epo.id as option_id, epo.event_id, epo.start_at, epo.end_at, e.title
     FROM event_poll_options epo
     JOIN events e ON e.id = epo.event_id
     WHERE e.poll_resolution_mode = 'multi_winner' AND epo.confirmed_at IS NOT NULL`,
  ).all<{ option_id: string; event_id: string; start_at: number; end_at: number; title: string }>();

  for (const opt of results) {
    const { results: yesVoters } = await env.DB.prepare(
      `SELECT u.id, u.notifications_enabled, u.dm_channel_id, u.timezone
       FROM event_poll_votes epv JOIN users u ON u.id = epv.user_id
       WHERE epv.option_id = ? AND epv.vote = 'yes'`,
    )
      .bind(opt.option_id)
      .all<ParticipantRow>();

    for (const user of yesVoters) {
      await notifyOnce(
        env,
        user,
        opt.event_id,
        'poll_resolved',
        opt.option_id,
        `"${opt.title}" is on for ${formatWhen(opt.start_at, user.timezone)}! You're confirmed.\n${eventLink(env, opt.event_id)}`,
      );
    }
  }
}

// Reminds invitees 24h before a poll's deadline, but only the ones who
// haven't cast a single vote (options mode) or submitted availability
// (window mode) yet -- people who already responded don't need a nudge.
async function sweepPollDeadlineReminders(env: Env): Promise<void> {
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
    const hasVotedSubquery =
      poll.poll_mode === 'window'
        ? `SELECT 1 FROM event_window_availability WHERE event_id = ei.event_id AND user_id = ei.user_id`
        : `SELECT 1 FROM event_poll_votes WHERE user_id = ei.user_id
           AND option_id IN (SELECT id FROM event_poll_options WHERE event_id = ei.event_id)`;

    const { results: nonVoters } = await env.DB.prepare(
      `SELECT u.id, u.notifications_enabled, u.dm_channel_id, u.timezone
       FROM event_invites ei JOIN users u ON u.id = ei.user_id
       WHERE ei.event_id = ? AND NOT EXISTS (${hasVotedSubquery})`,
    )
      .bind(poll.id)
      .all<ParticipantRow>();

    for (const user of nonVoters) {
      await notifyOnce(
        env,
        user,
        poll.id,
        'poll_deadline_reminder',
        '',
        `Voting for "${poll.title}" closes soon -- you haven't responded yet.\n${eventLink(env, poll.id)}`,
      );
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
async function sweepIdleGroups(env: Env): Promise<void> {
  const now = Date.now();
  const { results: groups } = await env.DB.prepare(
    `SELECT id, idle_reminder_days FROM groups`,
  ).all<GroupIdleRow>();

  for (const group of groups) {
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

    const already = await env.DB.prepare(
      `SELECT last_event_at FROM group_activity_nudges WHERE group_id = ?`,
    )
      .bind(group.id)
      .first<{ last_event_at: number }>();
    if (already && already.last_event_at === lastEventAt) continue; // already nudged for this idle episode

    const { results: members } = await env.DB.prepare(
      `SELECT u.id, u.notifications_enabled, u.dm_channel_id, u.timezone, g.name as group_name
       FROM group_members gm JOIN users u ON u.id = gm.user_id
       JOIN groups g ON g.id = gm.group_id
       WHERE gm.group_id = ?`,
    )
      .bind(group.id)
      .all<ParticipantRow & { group_name: string }>();

    for (const member of members) {
      if (!member.notifications_enabled) continue;
      await deliverDm(
        env,
        member,
        `It's been a while since "${member.group_name}" last played -- want to schedule something?\n${env.FRONTEND_URL}/#/calendar`,
      );
    }

    await env.DB.prepare(
      `INSERT INTO group_activity_nudges (group_id, last_event_at, notified_at) VALUES (?, ?, ?)
       ON CONFLICT(group_id) DO UPDATE SET last_event_at = excluded.last_event_at, notified_at = excluded.notified_at`,
    )
      .bind(group.id, lastEventAt, now)
      .run();
  }
}

export async function runReminderSweep(env: Env): Promise<void> {
  // Order matters: transition deadline-passed polls first so their invitees
  // get a poll_resolved DM in the same tick, then invites, then time-based
  // reminders. The two "poll resolution" notification sweeps re-scan every
  // resolved/cancelled poll each tick (dedupe makes that safe) rather than
  // depending on "resolved this exact tick", since single_winner polls often
  // resolve synchronously via threshold well before any deadline.
  await sweepPollDeadlines(env);
  await sweepSingleWinnerPollNotifications(env);
  await sweepMultiWinnerPollClosedNotifications(env);
  await sweepConfirmedMultiWinnerOptions(env);
  await sweepNewInvites(env);
  await sweepReminders(env);
  await sweepPollDeadlineReminders(env);
  await sweepIdleGroups(env);
}
