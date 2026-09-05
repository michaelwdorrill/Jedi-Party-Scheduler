// IDEAS item 2 / docs/specs/0017: the sweep that actually writes to Google.
//
// Separated from cron/reminders.ts rather than added to it. That file is three
// thousand lines of notification sweeps that share a set of helpers
// (notifyOnce, pendingRecipients, the outbox); this shares none of them --
// it delivers to a different provider, keyed per occurrence rather than per
// recipient, with no DM anywhere in it. Putting it there would have been
// filing by "runs on the cron" rather than by what the code is.
//
// The budget discipline it has to observe is the part worth reading
// cron/budget.ts for first. Three separate incidents are recorded there of a
// new fixed per-tick query starving sweepPurgeTerminalHistory outright, so
// this sweep adds no fixed cost: its discovery read is uncharged (like
// sweepStaleAccounts' and sweepPurgeTerminalHistory's own candidate SELECTs),
// it holds no cursor, it is not in reapExhaustedDeliveries' table list, and it
// runs last so it spends only what the notification sweeps left behind.

import type { Env } from '../env';
import { buildCalendarOccurrences } from '../lib/calendar';
import {
  accessTokenFor,
  deleteCalendarEvent,
  type GoogleConnectionRow,
  insertCalendarEvent,
  isGoogleConfigured,
  patchCalendarEvent,
  readRefreshToken,
  revokeToken,
} from '../lib/googleCalendar';
import { newId } from '../lib/ids';
import type { TickBudget } from './budget';

// How far ahead we mirror. Sixty days is already this app's own idea of
// "upcoming" -- the dashboard asked now->+60d before it merged into the
// calendar (IDEAS item 20), and LIMITS.MAX_WINDOW_SPAN_MS is the same figure.
// A window rather than everything, because a mirror of an infinite recurring
// series is infinite.
export const SYNC_WINDOW_MS = 60 * 24 * 60 * 60 * 1000;

// Deliberately small. Each connection costs a calendar read (see
// PER_CONNECTION_READ_QUERIES) before it writes anything, and this sweep runs
// after every notification sweep -- so on a busy tick it should do nothing at
// all rather than crowd out a reminder. Connections it does not reach are the
// ones it reaches first next tick, by the last_synced_at ordering below.
const MAX_CONNECTIONS_PER_TICK = 2;

// What buildCalendarOccurrences costs for one user: the event select, plus
// overrides, attendance, primary group, guild names, recurrence rules,
// confirmed options, pending options and personal events. Charged as one lump
// before the read runs, so a tick that cannot afford the read does not start
// it -- the same reserve-before-spend rule lib/outbox.ts's deliverThroughOutbox
// arrived at after the mirror-image bug.
const PER_CONNECTION_READ_QUERIES = 10;

// A safety valve on the disconnect path. If cleanup cannot succeed -- the
// grant is already revoked at Google's end, the calendar was deleted -- the
// connection is dropped anyway rather than holding a credential forever
// waiting for a tidy-up that will never work.
const MAX_DISCONNECT_ATTEMPTS = 5;

interface LinkRow {
  id: string;
  event_id: string;
  occurrence_date: string;
  google_event_id: string;
  synced_title: string | null;
  synced_start_at: number | null;
  synced_end_at: number | null;
}

interface DesiredOccurrence {
  eventId: string;
  occurrenceDate: string;
  title: string;
  startAt: number;
  endAt: number;
  guildName: string | null;
}

// The occurrence key, derived from the occurrenceId the calendar already
// builds. Three shapes exist: `<eventId>` for a plain event, `<eventId>::<date>`
// for one occurrence of a series, and `<eventId>::opt:<optionId>` for a
// confirmed multi-winner poll day.
//
// The first two are exactly event_attendance's convention (migration 0025 /
// specs/0014), which is why they are reused verbatim rather than re-derived:
// a per-occurrence decline has to key the same way the thing it suppresses
// does, or the two disagree about which night is which.
function occurrenceKey(occurrenceId: string, eventId: string): string {
  return occurrenceId.startsWith(`${eventId}::`) ? occurrenceId.slice(eventId.length + 2) : '';
}

// What should be on the person's Google calendar right now.
//
// Reuses buildCalendarOccurrences rather than issuing its own query, because
// "which sessions is this person committed to" is a question with one correct
// answer and two implementations of it would drift -- the argument
// lib/calendar.ts's own header makes for why that function exists at all.
export async function desiredOccurrencesFor(
  env: Env,
  userId: string,
  now: number,
): Promise<DesiredOccurrence[]> {
  const occurrences = await buildCalendarOccurrences(env, userId, now, now + SYNC_WINDOW_MS, {
    // Personal time blocks came *from* the rest of this person's life. Pushing
    // them back into the calendar they most likely came from is a loop, and at
    // best a duplicate of something already there.
    includePersonal: false,
  });

  const out: DesiredOccurrence[] = [];
  for (const occ of occurrences) {
    // A poll's candidate days are a maybe, not a commitment -- the same rule
    // lib/freeBusy.ts applies when deciding what counts as busy. Writing them
    // would put four provisional Tuesdays on someone's real calendar.
    //
    // Tested with `in` rather than read directly because
    // buildCalendarOccurrences returns a union: personal occurrences don't
    // carry the field at all. `includePersonal: false` above means none can
    // actually reach here, but narrowing on the property is free and keeps
    // this correct if that ever changes -- a cast would just hide it.
    if ('isProvisional' in occ && occ.isProvisional) continue;
    // An unresolved poll's deadline chip has no time of its own; so does
    // nothing else worth mirroring. Both fall out of the null check.
    if (occ.startAt == null || occ.endAt == null) continue;
    if (occ.status === 'cancelled') continue;
    // The one answer that means "I am not going". 'tentative' and 'pending'
    // both still belong on the calendar -- a maybe you have been invited to is
    // a thing you need to see.
    if (occ.myRsvpStatus === 'declined') continue;
    // Already happened. The window is forward-looking; anything behind `now`
    // is either history or an in-progress session nobody needs a new entry for.
    if (occ.endAt < now) continue;

    out.push({
      eventId: occ.eventId,
      occurrenceDate: occurrenceKey(occ.occurrenceId, occ.eventId),
      title: occ.title,
      startAt: occ.startAt,
      endAt: occ.endAt,
      guildName: occ.guildName ?? null,
    });
  }
  return out;
}

async function loadLinks(env: Env, userId: string): Promise<LinkRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT id, event_id, occurrence_date, google_event_id, synced_title, synced_start_at, synced_end_at
     FROM google_event_links WHERE user_id = ?`,
  )
    .bind(userId)
    .all<LinkRow>();
  return results;
}

async function markUnauthorized(env: Env, userId: string, message: string): Promise<void> {
  // sync_enabled = 0, not just an error message: a dead grant cannot recover
  // on its own, and leaving it enabled means every future tick spends part of
  // its allowance rediscovering that. The user reconnects, which resets both.
  await env.DB.prepare(
    `UPDATE google_calendar_connections SET sync_enabled = 0, last_error = ?, updated_at = ? WHERE user_id = ?`,
  )
    .bind(message, Date.now(), userId)
    .run();
}

// Removes what we wrote, then lets go of the credential. Ordered that way on
// purpose: revoking first would strand every entry we created in someone's
// real calendar with no way for us to reach them again (specs/0017).
async function runDisconnect(
  env: Env,
  row: GoogleConnectionRow,
  accessToken: string | null,
  budget: TickBudget,
): Promise<void> {
  const now = Date.now();
  const links = await loadLinks(env, row.user_id);
  // Past entries are left alone deliberately. They are a record of something
  // that actually happened, and reaching into someone's calendar history to
  // erase it is a worse default than leaving it there.
  const future = links.filter((l) => (l.synced_end_at ?? 0) >= now);

  let allCleared = true;
  if (accessToken) {
    for (const link of future) {
      if (!budget.tryCalendarWrite()) {
        // Out of allowance, not out of options: the row stays 'disconnecting'
        // and the next tick picks up where this stopped.
        return;
      }
      const result = await deleteCalendarEvent(accessToken, row.calendar_id, link.google_event_id);
      if (result.ok) {
        await env.DB.prepare(`DELETE FROM google_event_links WHERE id = ?`).bind(link.id).run();
      } else {
        allCleared = false;
        if (result.kind === 'unauthorized') break;
      }
    }
  } else {
    allCleared = false;
  }

  const attempts = row.disconnect_attempts + 1;
  if (!allCleared && attempts < MAX_DISCONNECT_ATTEMPTS) {
    await env.DB.prepare(
      `UPDATE google_calendar_connections SET disconnect_attempts = ?, updated_at = ? WHERE user_id = ?`,
    )
      .bind(attempts, Date.now(), row.user_id)
      .run();
    return;
  }

  if (!allCleared) {
    console.warn(
      `Google disconnect for ${row.user_id} gave up clearing calendar entries after ${attempts} attempts; ` +
        'revoking and dropping the connection anyway.',
    );
  }

  const refreshToken = await readRefreshToken(env, row);
  if (refreshToken) await revokeToken(refreshToken);

  await env.DB.batch([
    env.DB.prepare(`DELETE FROM google_event_links WHERE user_id = ?`).bind(row.user_id),
    env.DB.prepare(`DELETE FROM google_calendar_connections WHERE user_id = ?`).bind(row.user_id),
  ]);
}

async function syncOneConnection(
  env: Env,
  row: GoogleConnectionRow,
  accessToken: string,
  budget: TickBudget,
): Promise<void> {
  const now = Date.now();

  if (!budget.trySpend(PER_CONNECTION_READ_QUERIES)) return;
  const desired = await desiredOccurrencesFor(env, row.user_id, now);

  if (!budget.trySpend(1)) return;
  const links = await loadLinks(env, row.user_id);
  const linkByKey = new Map(links.map((l) => [`${l.event_id}::${l.occurrence_date}`, l]));

  for (const occ of desired) {
    const key = `${occ.eventId}::${occ.occurrenceDate}`;
    const existing = linkByKey.get(key);
    linkByKey.delete(key);

    const payload = {
      title: occ.title,
      startAt: occ.startAt,
      endAt: occ.endAt,
      guildName: occ.guildName,
      eventUrl: `${env.FRONTEND_URL}/#/events/${occ.eventId}`,
      eventId: occ.eventId,
      occurrenceDate: occ.occurrenceDate,
    };

    if (existing) {
      const unchanged =
        existing.synced_title === occ.title &&
        existing.synced_start_at === occ.startAt &&
        existing.synced_end_at === occ.endAt;
      // The common case by a wide margin: a steady calendar costs nothing per
      // tick beyond the two reads above.
      if (unchanged) continue;

      if (!budget.tryCalendarWrite()) return;
      const result = await patchCalendarEvent(accessToken, row.calendar_id, existing.google_event_id, payload);
      if (result.ok) {
        await env.DB.prepare(
          `UPDATE google_event_links SET synced_title = ?, synced_start_at = ?, synced_end_at = ?, synced_at = ?
           WHERE id = ?`,
        )
          .bind(occ.title, occ.startAt, occ.endAt, now, existing.id)
          .run();
      } else if (result.kind === 'missing') {
        // Someone deleted our copy from inside Google, which is an entirely
        // reasonable thing to do. Drop the stale link so the next tick treats
        // this as a fresh insert rather than patching an id that is gone.
        await env.DB.prepare(`DELETE FROM google_event_links WHERE id = ?`).bind(existing.id).run();
      } else if (result.kind === 'unauthorized') {
        await markUnauthorized(env, row.user_id, 'Google access was revoked. Reconnect to resume syncing.');
        return;
      }
      continue;
    }

    if (!budget.tryCalendarWrite()) return;
    const result = await insertCalendarEvent(accessToken, row.calendar_id, payload);
    if (result.ok) {
      await env.DB.prepare(
        `INSERT INTO google_event_links
           (id, user_id, event_id, occurrence_date, google_event_id, synced_title, synced_start_at, synced_end_at, synced_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, event_id, occurrence_date) DO UPDATE SET
           google_event_id = excluded.google_event_id,
           synced_title = excluded.synced_title,
           synced_start_at = excluded.synced_start_at,
           synced_end_at = excluded.synced_end_at,
           synced_at = excluded.synced_at`,
      )
        .bind(newId(), row.user_id, occ.eventId, occ.occurrenceDate, result.value.id, occ.title, occ.startAt, occ.endAt, now)
        .run();
    } else if (result.kind === 'unauthorized') {
      await markUnauthorized(env, row.user_id, 'Google access was revoked. Reconnect to resume syncing.');
      return;
    }
  }

  // Whatever is left in the map has a link row but no live occurrence any
  // more: cancelled, declined since, edited out of the window, or simply now
  // in the past. Only the first three should actually be removed from Google.
  for (const orphan of linkByKey.values()) {
    // A past entry is not an orphan, it is history -- and the window is
    // forward-looking, so everything that has happened falls out of `desired`
    // on the next tick regardless. Deleting on that basis would quietly erase
    // someone's record of every session they have ever played.
    if ((orphan.synced_end_at ?? 0) < now) continue;

    if (!budget.tryCalendarWrite()) return;
    const result = await deleteCalendarEvent(accessToken, row.calendar_id, orphan.google_event_id);
    if (result.ok) {
      await env.DB.prepare(`DELETE FROM google_event_links WHERE id = ?`).bind(orphan.id).run();
    } else if (result.kind === 'unauthorized') {
      await markUnauthorized(env, row.user_id, 'Google access was revoked. Reconnect to resume syncing.');
      return;
    }
  }

  await env.DB.prepare(
    `UPDATE google_calendar_connections SET last_synced_at = ?, last_error = NULL, updated_at = ? WHERE user_id = ?`,
  )
    .bind(now, now, row.user_id)
    .run();
}

export async function sweepGoogleCalendar(env: Env, budget: TickBudget): Promise<void> {
  if (!isGoogleConfigured(env)) return;

  // Uncharged, like sweepStaleAccounts' and sweepPurgeTerminalHistory's own
  // candidate reads -- see this file's header for why adding a charged fixed
  // query here would be the mistake cron/budget.ts records three times.
  //
  // ORDER BY last_synced_at is the cursor: SQLite sorts NULLs first, so a
  // never-synced connection goes ahead of every synced one, and whatever this
  // tick could not afford is at the front of the next tick's page. That is a
  // cursor's whole job, without a CursorStore slot or the statement it costs.
  const { results: connections } = await env.DB.prepare(
    `SELECT * FROM google_calendar_connections
     WHERE status = 'disconnecting' OR (sync_enabled = 1 AND status = 'active')
     ORDER BY status DESC, last_synced_at ASC
     LIMIT ?`,
  )
    .bind(MAX_CONNECTIONS_PER_TICK)
    .all<GoogleConnectionRow>();

  for (const row of connections) {
    if (budget.exhausted) return;

    const token = await accessTokenFor(env, row);

    if (row.status === 'disconnecting') {
      // A disconnect proceeds even without a usable token -- the point is to
      // stop holding the credential, and runDisconnect's own attempt counter
      // decides when to give up on the tidy-up.
      await runDisconnect(env, row, token.ok ? token.accessToken : null, budget);
      continue;
    }

    if (!token.ok) {
      if (token.reason === 'unauthorized') {
        await markUnauthorized(env, row.user_id, token.message);
      } else {
        // Transient. Left enabled and untouched: last_synced_at has not moved,
        // so this connection stays at the front of the queue and is retried
        // first next tick.
        console.warn(`Google sync deferred for ${row.user_id}: ${token.message}`);
      }
      continue;
    }

    await syncOneConnection(env, row, token.accessToken, budget);
  }
}
