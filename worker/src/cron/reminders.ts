import { DateTime } from 'luxon';
import type { Env } from '../env';
import { newId } from '../lib/ids';
import { sendBotDm } from '../lib/discord';
import type { EventRow } from '../lib/events';
import { loadOverridesForEvents } from '../lib/events';
import { expandOccurrencesForEvent } from '../lib/recurrence';
import { resolvePastDeadlinePolls } from '../lib/polls';
import { getConfirmedAttendeeIds } from '../lib/attendance';
import { pruneStaleSessions } from '../lib/sessions';

const HOUR_MS = 60 * 60 * 1000;

interface ParticipantRow {
  id: string;
  notifications_enabled: number;
  dm_channel_id: string | null;
  timezone: string;
}

// Cron never makes a live Discord call per recipient (unlike the interactive
// isGuildMember() path) -- that would mean one Discord request per invitee on
// every 15-minute tick. Instead this just requires the *cached* membership to
// still say active guild + current member, which is enough to stop DMing
// someone who left or whose guild got deactivated; live revalidation happens
// next time they hit the app themselves.
async function getEventParticipants(env: Env, eventId: string, guildId: string, organizerId: string): Promise<ParticipantRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT u.id, u.notifications_enabled, u.dm_channel_id, u.timezone
     FROM users u
     JOIN user_guild_membership m ON m.user_id = u.id AND m.guild_id = ? AND m.is_member = 1
     JOIN guilds g ON g.id = m.guild_id AND g.is_active = 1
     WHERE u.id IN (SELECT user_id FROM event_invites WHERE event_id = ? UNION SELECT ?)`,
  )
    .bind(guildId, eventId, organizerId)
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

type NotificationType =
  | 'invite'
  | 'reminder_24h'
  | 'reminder_1h'
  | 'poll_resolved'
  | 'poll_deadline_reminder'
  | 'voice_channel_invite';

// Outbox semantics: `sent_at` means "first attempted" (it's also the claim
// timestamp), `delivered_at` is set only once Discord confirms success, and
// `failed_at` is set only for a permanent (non-retryable) failure. Both NULL
// means still pending -- the next sweep tries again. This replaces the old
// behavior where the dedupe row's mere existence meant "sent," so a
// transient Discord/network failure permanently looked delivered and was
// never retried.
async function notifyOnce(
  env: Env,
  user: ParticipantRow,
  eventId: string,
  notificationType: NotificationType,
  occurrenceDate: string,
  content: string,
): Promise<void> {
  if (!user.notifications_enabled) return;

  const existing = await env.DB.prepare(
    `SELECT id, delivered_at, failed_at FROM notification_log
     WHERE user_id = ? AND event_id = ? AND notification_type = ? AND occurrence_date = ?`,
  )
    .bind(user.id, eventId, notificationType, occurrenceDate)
    .first<{ id: string; delivered_at: number | null; failed_at: number | null }>();

  if (existing && (existing.delivered_at != null || existing.failed_at != null)) {
    return; // already resolved, one way or the other -- nothing to retry
  }

  let logId: string;
  if (existing) {
    // Retrying a previously-pending attempt. Claim it with a compare-and-set
    // so two overlapping cron ticks can't both send the same DM -- if
    // another process already resolved or is mid-attempt, this affects 0
    // rows and we back off rather than double-send.
    logId = existing.id;
    const claim = await env.DB.prepare(
      `UPDATE notification_log SET sent_at = ? WHERE id = ? AND delivered_at IS NULL AND failed_at IS NULL`,
    )
      .bind(Date.now(), logId)
      .run();
    if (claim.meta.changes === 0) return;
  } else {
    logId = newId();
    try {
      await env.DB.prepare(
        `INSERT INTO notification_log (id, user_id, event_id, notification_type, occurrence_date, sent_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
        .bind(logId, user.id, eventId, notificationType, occurrenceDate, Date.now())
        .run();
    } catch (err) {
      // A UNIQUE-constraint violation means a concurrent call already
      // inserted the same claim between our SELECT and this INSERT -- that
      // other call owns this attempt. Any other failure (D1 outage, schema
      // drift, a bug) must not be swallowed the same way.
      const message = (err as Error).message ?? '';
      if (message.includes('UNIQUE constraint failed')) return;
      console.error(`notifyOnce insert failed for ${notificationType}/${eventId}/${user.id}:`, err);
      throw err;
    }
  }

  const { result, channelId } = await sendBotDm(env.DISCORD_BOT_TOKEN, user.id, content, user.dm_channel_id);
  if (channelId && channelId !== user.dm_channel_id) {
    await env.DB.prepare(`UPDATE users SET dm_channel_id = ? WHERE id = ?`).bind(channelId, user.id).run();
  }

  if (result.ok) {
    await env.DB.prepare(`UPDATE notification_log SET delivered_at = ? WHERE id = ?`).bind(Date.now(), logId).run();
    return;
  }

  if (result.status === 429) {
    if (result.retryAfterMs) await new Promise((resolve) => setTimeout(resolve, Math.min(result.retryAfterMs!, 5000)));
    return; // leave pending -- retried next tick (Discord's own rate limit, not our fault)
  }

  if (result.status >= 500) {
    return; // transient -- leave pending for retry next tick
  }

  // A permanent 4xx (e.g. the recipient blocked DMs, or the cached channel
  // is gone) won't succeed by retrying it verbatim -- mark it terminal so it
  // stops being picked up, without pretending it was delivered.
  await env.DB.prepare(`UPDATE notification_log SET failed_at = ? WHERE id = ?`).bind(Date.now(), logId).run();
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
    try {
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
    } catch (err) {
      console.error(`sweepNewInvites failed for event ${row.event_id}/user ${row.user_id}:`, err);
    }
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
    try {
      const participants = await getEventParticipants(env, event.id, event.guild_id, event.organizer_id);
      const remaining = event.start_at! - now;
      for (const user of participants) {
        if (remaining <= HOUR_MS) {
          await notifyOnce(env, user, event.id, 'reminder_1h', '', `"${event.title}" starts in about an hour (${formatWhen(event.start_at!, user.timezone)}).\n${eventLink(env, event.id)}`);
        }
        if (remaining <= 24 * HOUR_MS) {
          await notifyOnce(env, user, event.id, 'reminder_24h', '', `"${event.title}" is coming up on ${formatWhen(event.start_at!, user.timezone)}.\n${eventLink(env, event.id)}`);
        }
      }
    } catch (err) {
      console.error(`sweepReminders (single) failed for event ${event.id}:`, err);
    }
  }

  const { results: recurringEvents } = await env.DB.prepare(
    `SELECT * FROM events WHERE is_recurring = 1 AND status = 'active'`,
  ).all<EventRow>();

  if (recurringEvents.length > 0) {
    const overridesByEvent = await loadOverridesForEvents(env, recurringEvents.map((e) => e.id));
    for (const event of recurringEvents) {
      try {
        const occurrences = await expandOccurrencesForEvent(
          env,
          event,
          now,
          windowEnd,
          overridesByEvent.get(event.id) ?? [],
        );
        if (occurrences.length === 0) continue;

        const participants = await getEventParticipants(env, event.id, event.guild_id, event.organizer_id);
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
      } catch (err) {
        console.error(`sweepReminders (recurring) failed for event ${event.id}:`, err);
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
    try {
      const participants = await getEventParticipants(env, event.id, event.guild_id, event.organizer_id);
      for (const user of participants) {
        const message =
          event.status === 'resolved'
            ? `"${event.title}" is on! Time locked in: ${formatWhen(event.start_at!, user.timezone)}.\n${eventLink(env, event.id)}`
            : `"${event.title}" didn't get enough votes and was cancelled.`;
        await notifyOnce(env, user, event.id, 'poll_resolved', '', message);
      }
    } catch (err) {
      console.error(`sweepSingleWinnerPollNotifications failed for event ${event.id}:`, err);
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
      const participants = await getEventParticipants(env, event.id, event.guild_id, event.organizer_id);
      const message =
        n > 0
          ? `Voting for "${event.title}" has closed. ${n} day(s) got confirmed -- check the event for details.\n${eventLink(env, event.id)}`
          : `"${event.title}" didn't get enough interest on any day and was cancelled.`;
      for (const user of participants) {
        await notifyOnce(env, user, event.id, 'poll_resolved', '', message);
      }
    } catch (err) {
      console.error(`sweepMultiWinnerPollClosedNotifications failed for event ${event.id}:`, err);
    }
  }
}

// Multi-winner polls confirm individual days as soon as they hit quorum
// (checked synchronously in the vote route), independent of the deadline.
// This sweep notifies just that day's yes-voters, as soon as we notice.
async function sweepConfirmedMultiWinnerOptions(env: Env): Promise<void> {
  const { results } = await env.DB.prepare(
    `SELECT epo.id as option_id, epo.event_id, epo.start_at, epo.end_at, e.title, e.guild_id
     FROM event_poll_options epo
     JOIN events e ON e.id = epo.event_id
     WHERE e.poll_resolution_mode = 'multi_winner' AND epo.confirmed_at IS NOT NULL`,
  ).all<{ option_id: string; event_id: string; start_at: number; end_at: number; title: string; guild_id: string }>();

  for (const opt of results) {
    try {
      const { results: yesVoters } = await env.DB.prepare(
        `SELECT u.id, u.notifications_enabled, u.dm_channel_id, u.timezone
         FROM event_poll_votes epv
         JOIN users u ON u.id = epv.user_id
         JOIN user_guild_membership m ON m.user_id = u.id AND m.guild_id = ? AND m.is_member = 1
         JOIN guilds g ON g.id = m.guild_id AND g.is_active = 1
         WHERE epv.option_id = ? AND epv.vote = 'yes'`,
      )
        .bind(opt.guild_id, opt.option_id)
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
    } catch (err) {
      console.error(`sweepConfirmedMultiWinnerOptions failed for option ${opt.option_id}:`, err);
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
         JOIN user_guild_membership m ON m.user_id = u.id AND m.guild_id = ? AND m.is_member = 1
         JOIN guilds g ON g.id = m.guild_id AND g.is_active = 1
         WHERE ei.event_id = ? AND NOT EXISTS (${hasVotedSubquery})`,
      )
        .bind(poll.guild_id, poll.id)
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
async function sweepVoiceChannelInvites(env: Env): Promise<void> {
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
    try {
      const optionId = event.event_type === 'poll' && event.poll_mode === 'options' ? event.resolved_option_id : null;
      const attendees = await getConfirmedAttendeeIds(env, event, optionId);
      for (const user of attendees) {
        await notifyOnce(
          env,
          user,
          event.id,
          'voice_channel_invite',
          '',
          `"${event.title}" is starting soon -- join the "${event.voice_channel_name}" voice channel:\n${voiceChannelLink(event.guild_id, event.voice_channel_id!)}`,
        );
      }
    } catch (err) {
      console.error(`sweepVoiceChannelInvites (fixed-time) failed for event ${event.id}:`, err);
    }
  }

  const { results: recurringEvents } = await env.DB.prepare(
    `SELECT * FROM events WHERE voice_channel_id IS NOT NULL AND is_recurring = 1 AND status = 'active'`,
  ).all<EventRow>();

  if (recurringEvents.length > 0) {
    const overridesByEvent = await loadOverridesForEvents(env, recurringEvents.map((e) => e.id));
    for (const event of recurringEvents) {
      try {
        const occurrences = await expandOccurrencesForEvent(
          env,
          event,
          now,
          windowEnd,
          overridesByEvent.get(event.id) ?? [],
        );
        if (occurrences.length === 0) continue;

        const attendees = await getConfirmedAttendeeIds(env, event, null);
        for (const occ of occurrences) {
          for (const user of attendees) {
            await notifyOnce(
              env,
              user,
              event.id,
              'voice_channel_invite',
              occ.date,
              `"${event.title}" is starting soon -- join the "${event.voice_channel_name}" voice channel:\n${voiceChannelLink(event.guild_id, event.voice_channel_id!)}`,
            );
          }
        }
      } catch (err) {
        console.error(`sweepVoiceChannelInvites (recurring) failed for event ${event.id}:`, err);
      }
    }
  }

  // multi_winner polls confirm each day independently, so each confirmed
  // option has its own attendee list (whoever voted yes on that day).
  const { results: multiWinnerPolls } = await env.DB.prepare(
    `SELECT * FROM events
     WHERE voice_channel_id IS NOT NULL AND event_type = 'poll' AND poll_resolution_mode = 'multi_winner'`,
  ).all<EventRow>();

  for (const poll of multiWinnerPolls) {
    try {
      const { results: options } = await env.DB.prepare(
        `SELECT id FROM event_poll_options
         WHERE event_id = ? AND confirmed_at IS NOT NULL AND start_at >= ? AND start_at <= ?`,
      )
        .bind(poll.id, now, windowEnd)
        .all<{ id: string }>();

      for (const opt of options) {
        const attendees = await getConfirmedAttendeeIds(env, poll, opt.id);
        for (const user of attendees) {
          await notifyOnce(
            env,
            user,
            poll.id,
            'voice_channel_invite',
            opt.id,
            `"${poll.title}" is starting soon -- join the "${poll.voice_channel_name}" voice channel:\n${voiceChannelLink(poll.guild_id, poll.voice_channel_id!)}`,
          );
        }
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
async function sweepIdleGroups(env: Env): Promise<void> {
  const now = Date.now();
  const { results: groups } = await env.DB.prepare(
    `SELECT id, idle_reminder_days FROM groups`,
  ).all<GroupIdleRow>();

  for (const group of groups) {
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

      const already = await env.DB.prepare(
        `SELECT last_event_at FROM group_activity_nudges WHERE group_id = ?`,
      )
        .bind(group.id)
        .first<{ last_event_at: number }>();
      if (already && already.last_event_at === lastEventAt) continue; // already nudged for this idle episode

      const { results: members } = await env.DB.prepare(
        `SELECT u.id, u.notifications_enabled, u.dm_channel_id, u.timezone, g.name as group_name
         FROM group_members gm
         JOIN users u ON u.id = gm.user_id
         JOIN groups g ON g.id = gm.group_id
         JOIN user_guild_membership m ON m.user_id = u.id AND m.guild_id = g.guild_id AND m.is_member = 1
         JOIN guilds gu ON gu.id = m.guild_id AND gu.is_active = 1
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
    } catch (err) {
      console.error(`sweepIdleGroups failed for group ${group.id}:`, err);
    }
  }
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
  await runIsolated('pollDeadlines', () => sweepPollDeadlines(env));
  await runIsolated('singleWinnerPollNotifications', () => sweepSingleWinnerPollNotifications(env));
  await runIsolated('multiWinnerPollClosedNotifications', () => sweepMultiWinnerPollClosedNotifications(env));
  await runIsolated('confirmedMultiWinnerOptions', () => sweepConfirmedMultiWinnerOptions(env));
  await runIsolated('newInvites', () => sweepNewInvites(env));
  await runIsolated('reminders', () => sweepReminders(env));
  await runIsolated('pollDeadlineReminders', () => sweepPollDeadlineReminders(env));
  await runIsolated('voiceChannelInvites', () => sweepVoiceChannelInvites(env));
  await runIsolated('idleGroups', () => sweepIdleGroups(env));
  await runIsolated('pruneStaleSessions', () => pruneStaleSessions(env));
}
