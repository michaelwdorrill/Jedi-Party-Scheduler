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
}

async function getEventParticipants(env: Env, eventId: string, organizerId: string): Promise<ParticipantRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT id, notifications_enabled, dm_channel_id FROM users WHERE id IN
       (SELECT user_id FROM event_invites WHERE event_id = ? UNION SELECT ?)`,
  )
    .bind(eventId, organizerId)
    .all<ParticipantRow>();
  return results;
}

// Inserts the dedupe record *before* attempting delivery -- the row's
// insertion succeeding (not the DM succeeding) is what "sent" means here.
// If the insert fails (UNIQUE violation), a notification of this exact kind
// was already logged and we skip sending again.
async function notifyOnce(
  env: Env,
  user: ParticipantRow,
  eventId: string,
  notificationType: 'invite' | 'reminder_24h' | 'reminder_1h' | 'poll_resolved',
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

  const { result, channelId } = await sendBotDm(env.DISCORD_BOT_TOKEN, user.id, content, user.dm_channel_id);
  if (channelId && channelId !== user.dm_channel_id) {
    await env.DB.prepare(`UPDATE users SET dm_channel_id = ? WHERE id = ?`).bind(channelId, user.id).run();
  }
  if (result.status === 429 && result.retryAfterMs) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(result.retryAfterMs!, 5000)));
  }
}

function formatWhen(startAt: number): string {
  return new Date(startAt).toUTCString();
}

async function sweepNewInvites(env: Env): Promise<void> {
  const { results } = await env.DB.prepare(
    `SELECT ei.event_id, ei.user_id, e.title
     FROM event_invites ei
     JOIN events e ON e.id = ei.event_id
     LEFT JOIN notification_log nl
       ON nl.user_id = ei.user_id AND nl.event_id = ei.event_id
       AND nl.notification_type = 'invite' AND nl.occurrence_date = ''
     WHERE e.status = 'active' AND nl.id IS NULL`,
  ).all<{ event_id: string; user_id: string; title: string }>();

  for (const row of results) {
    const user = await env.DB.prepare(
      `SELECT id, notifications_enabled, dm_channel_id FROM users WHERE id = ?`,
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
      `You've been invited to "${row.title}" on Jedi Party Scheduler.`,
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
        await notifyOnce(env, user, event.id, 'reminder_1h', '', `"${event.title}" starts in about an hour (${formatWhen(event.start_at!)}).`);
      }
      if (remaining <= 24 * HOUR_MS) {
        await notifyOnce(env, user, event.id, 'reminder_24h', '', `"${event.title}" is coming up on ${formatWhen(event.start_at!)}.`);
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
            await notifyOnce(env, user, event.id, 'reminder_1h', occ.date, `"${event.title}" starts in about an hour (${formatWhen(occ.startAt)}).`);
          }
          if (remaining <= 24 * HOUR_MS) {
            await notifyOnce(env, user, event.id, 'reminder_24h', occ.date, `"${event.title}" is coming up on ${formatWhen(occ.startAt)}.`);
          }
        }
      }
    }
  }
}

async function sweepResolvedPolls(env: Env): Promise<void> {
  const resolvedEventIds = await resolvePastDeadlinePolls(env);
  for (const eventId of resolvedEventIds) {
    const event = await env.DB.prepare(`SELECT * FROM events WHERE id = ?`).bind(eventId).first<EventRow>();
    if (!event) continue;
    const participants = await getEventParticipants(env, event.id, event.organizer_id);
    const message =
      event.status === 'resolved'
        ? `"${event.title}" is on! Time locked in: ${formatWhen(event.start_at!)}.`
        : `"${event.title}" didn't get enough votes and was cancelled.`;
    for (const user of participants) {
      await notifyOnce(env, user, event.id, 'poll_resolved', '', message);
    }
  }
}

export async function runReminderSweep(env: Env): Promise<void> {
  // Order matters: resolve polls first so newly-resolved events' invitees get
  // a poll_resolved DM in the same tick, then invites, then time-based reminders.
  await sweepResolvedPolls(env);
  await sweepNewInvites(env);
  await sweepReminders(env);
}
