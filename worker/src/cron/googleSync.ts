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
// it holds no cursor, and it is not in reapExhaustedDeliveries' table list.
//
// It also runs at most hourly, and *first* on the tick it runs, rather than
// last on every tick. That is not a priority claim -- see SYNC_INTERVAL_MS
// for the measurement that forced it, and for why "last, on the leftovers"
// cannot work for a task whose first useful unit costs ten queries.

import type { Env } from '../env';
import { buildCalendarOccurrences } from '../lib/calendar';
import {
  accessTokenFor,
  deleteCalendarEvent,
  type GoogleConnectionRow,
  insertCalendarEvent,
  isGoogleConfigured,
  patchCalendarEvent,
  queryFreeBusy,
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

// One per tick. At PER_CONNECTION_READ_QUERIES + a write apiece, two would
// take almost the whole Free-plan allowance on the tick this runs, and the
// notification sweeps it borrows from are the more urgent half. A second
// connection waits for the next hour, ordered first by last_synced_at.
const MAX_CONNECTIONS_PER_TICK = 1;

// What buildCalendarOccurrences costs for one user: the event select, plus
// overrides, attendance, primary group, guild names, recurrence rules,
// confirmed options, pending options and personal events.
const PER_CONNECTION_READ_QUERIES = 10;

// How long a connection waits between syncs.
//
// This is the fix for the bug that made this feature not work at all, and the
// reasoning is worth keeping because the naive version looked obviously right.
//
// Originally this sweep ran on every tick, last, taking whatever the
// notification sweeps left. Measured against a real sandbox, what they leave
// is **11 queries** -- stable, every tick. The sweep asked for 10 for the
// calendar read, got them, then could not afford the two a single write costs.
// So it spent eleven queries doing reads it then threw away, returned before
// stamping last_synced_at, and did that ~380 times over four days: no entries
// written, no error recorded, nothing in the logs. A feature that never ran
// and never said so.
//
// "Run last and take the leftovers" is the wrong shape for work that comes in
// an indivisible lump. It works for deliveries, which are one cheap unit each,
// and fails for this, which needs a fixed ten before the first unit of useful
// work. So the sweep now runs **hourly instead of every tick, and goes first
// on the tick it runs**, where the full allowance is still intact.
//
// Hourly is the honest cadence for a mirror rather than a compromise: a
// session appearing on someone's Google calendar within the hour is fine,
// where a reminder that misses its window is not. And on the other ~three
// ticks in four the sweep now costs *nothing at all* rather than burning
// eleven queries for no result -- so the notification sweeps are better off
// than they were before this feature existed.
//
// 55 minutes, not 60, so it stays anchored to whichever quarter-hour tick it
// first ran on rather than drifting an extra tick later each hour.
export const SYNC_INTERVAL_MS = 55 * 60 * 1000;

// How far ahead the busy cache reaches (the pull half, migration 0037).
//
// Matched to LIMITS.MAX_FREE_BUSY_RANGE_MS rather than to SYNC_WINDOW_MS,
// because this cache answers a different question from the push half: it feeds
// the scheduling assistant, whose own request range is capped at the same ~2
// months. Caching further would be work nobody can ask about; caching less
// would leave a gap inside a range they can.
export const BUSY_CACHE_WINDOW_MS = 62 * 24 * 60 * 60 * 1000;

// A ceiling on how many busy intervals are stored for one person.
//
// freebusy.query merges overlapping events itself, so a normal calendar yields
// tens of intervals across two months, not thousands. This exists so a
// pathological calendar cannot put an unbounded blob in a column that
// lib/freeBusy.ts parses inside a request. Exceeding it keeps the EARLIEST
// blocks, since the assistant is overwhelmingly used for the near term.
const MAX_CACHED_BUSY_BLOCKS = 400;

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
  let removed = 0;
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
        removed += 1;
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

  // Says what happened, for the same reason the sync path does: without this a
  // successful disconnect is completely silent in `wrangler tail`, so the one
  // question an operator has -- did letting go of the credential actually
  // work? -- has no answer short of querying the database. Logged once, at the
  // end, where the outcome is known.
  console.log(
    `Google disconnect for ${row.user_id}: ${removed} upcoming entr${removed === 1 ? 'y' : 'ies'} removed, ` +
      `${links.length - future.length} past left in place, token revoked, connection dropped.`,
  );

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

  // Reserve the reads AND the link load AND at least one write before doing
  // any of them. Reserving only the read is what made this sweep useless: it
  // could afford ten queries of reading and then not the two a single write
  // costs, so it read the whole calendar, wrote nothing, and returned without
  // even recording that it had tried.
  //
  // This is lib/outbox.ts's rule applied properly -- "reserving first means a
  // delivery this tick cannot afford costs nothing at all". The unit of work
  // here is not one write, it is read-then-write, so that is what has to be
  // affordable before anything starts.
  if (!budget.trySpend(PER_CONNECTION_READ_QUERIES + 1)) {
    console.warn(
      `Google sync skipped for ${row.user_id}: this tick could not afford the calendar read ` +
        `(${PER_CONNECTION_READ_QUERIES + 1} queries needed). Retrying next hour.`,
    );
    return;
  }
  if (budget.exhausted) {
    // Affordable to read, but with nothing left to write with. Refunding is
    // not possible through TickBudget's interface, so the check goes here --
    // before the reads run, which is the part that matters.
    console.warn(
      `Google sync skipped for ${row.user_id}: enough allowance to read but not to write. Retrying next hour.`,
    );
    return;
  }

  const desired = await desiredOccurrencesFor(env, row.user_id, now);
  const links = await loadLinks(env, row.user_id);
  const linkByKey = new Map(links.map((l) => [`${l.event_id}::${l.occurrence_date}`, l]));

  // Counted so a tick that did something says so, once, at the end.
  //
  // Without this the sweep is completely silent on its happy path -- and
  // because it is idempotent, the steady state is silence too, which makes
  // `wrangler tail` useless for the one question an operator actually asks
  // ("is it working?"). sweepPurgeTerminalHistory already set the precedent
  // by logging what it purged. A console line costs nothing against
  // cron/budget.ts's ledger, which counts D1 statements and subrequests.
  const counts = { inserted: 0, patched: 0, deleted: 0, relinked: 0 };

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
        counts.patched += 1;
      } else if (result.kind === 'missing') {
        // Someone deleted our copy from inside Google, which is an entirely
        // reasonable thing to do. Drop the stale link so the next tick treats
        // this as a fresh insert rather than patching an id that is gone.
        await env.DB.prepare(`DELETE FROM google_event_links WHERE id = ?`).bind(existing.id).run();
        counts.relinked += 1;
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
      counts.inserted += 1;
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
      counts.deleted += 1;
    } else if (result.kind === 'unauthorized') {
      await markUnauthorized(env, row.user_id, 'Google access was revoked. Reconnect to resume syncing.');
      return;
    }
  }

  // Only when something actually changed. A healthy connection with a settled
  // calendar does nothing on most ticks, and saying so every fifteen minutes
  // would bury the ticks that matter -- the same reason the purge sweep logs
  // only when it purges.
  if (counts.inserted || counts.patched || counts.deleted || counts.relinked) {
    console.log(
      `Google sync for ${row.user_id}: ${counts.inserted} added, ${counts.patched} updated, ` +
        `${counts.deleted} removed, ${counts.relinked} re-linked (${desired.length} occurrence(s) in window).`,
    );
  }

  // Stamped BEFORE the pull half runs, and the order is load-bearing.
  //
  // This statement clears last_error, which is correct for the push half it
  // reports on -- that half just succeeded. But refreshBusyCache can record an
  // error of its own (a chosen calendar that no longer exists), and running
  // this afterwards erased it immediately: reading would switch itself off and
  // the user would never learn why. Found by a test asserting the message
  // survives, which it did not.
  await env.DB.prepare(
    `UPDATE google_calendar_connections SET last_synced_at = ?, last_error = NULL, updated_at = ? WHERE user_id = ?`,
  )
    .bind(now, now, row.user_id)
    .run();

  await refreshBusyCache(env, row, accessToken, budget, now);
}

// The pull half: one freebusy.query against the ONE calendar this person
// chose, cached for lib/freeBusy.ts to merge into the scheduling assistant.
//
// Runs inside the same hourly slot as the push, deliberately -- it is the same
// connection, the same access token, and the same "a mirror within the hour is
// fine" latency argument. A separate schedule would double the fixed cost for
// no benefit.
//
// Does nothing at all unless read_calendar_id is set, which it is not for
// anyone by default. Connecting to push never starts a pull.
async function refreshBusyCache(
  env: Env,
  row: GoogleConnectionRow,
  accessToken: string,
  budget: TickBudget,
  now: number,
): Promise<void> {
  if (!row.read_calendar_id) return;
  // One subrequest plus the single UPDATE below -- exactly the shape
  // tryCalendarWrite prices.
  if (!budget.tryCalendarWrite()) return;

  const result = await queryFreeBusy(accessToken, row.read_calendar_id, now, now + BUSY_CACHE_WINDOW_MS);

  if (!result.ok) {
    if (result.kind === 'unauthorized') {
      await markUnauthorized(env, row.user_id, 'Google access was revoked. Reconnect to resume syncing.');
      return;
    }
    if (result.kind === 'missing') {
      // The calendar is gone, or was never readable. Switch reading off and
      // say why, rather than leaving a stale cache to answer for a calendar
      // that no longer exists. Note this clears read_calendar_id: the person
      // has to pick again, which is the honest outcome of "the thing you
      // chose isn't there".
      await env.DB.prepare(
        `UPDATE google_calendar_connections
         SET read_calendar_id = NULL, busy_blocks = NULL, busy_cached_at = NULL,
             busy_window_end_at = NULL, last_error = ?, updated_at = ?
         WHERE user_id = ?`,
      )
        .bind(result.message, now, row.user_id)
        .run();
      console.warn(`Google busy cache disabled for ${row.user_id}: ${result.message}`);
      return;
    }
    // Transient. The existing cache is deliberately left in place: stale busy
    // time is the safe direction to be wrong in, and dropping it would report
    // someone as free when we simply could not ask.
    console.warn(`Google busy refresh deferred for ${row.user_id}: ${result.message}`);
    return;
  }

  const blocks = result.value
    .filter((b) => b.endAt > b.startAt)
    .sort((a, b) => a.startAt - b.startAt)
    .slice(0, MAX_CACHED_BUSY_BLOCKS)
    .map((b) => [b.startAt, b.endAt]);

  await env.DB.prepare(
    `UPDATE google_calendar_connections
     SET busy_blocks = ?, busy_cached_at = ?, busy_window_end_at = ?, updated_at = ?
     WHERE user_id = ?`,
  )
    .bind(JSON.stringify(blocks), now, now + BUSY_CACHE_WINDOW_MS, now, row.user_id)
    .run();

  if (blocks.length > 0) {
    console.log(`Google busy cache for ${row.user_id}: ${blocks.length} interval(s) over the next 62 days.`);
  }
}

// Whether any connection is due this tick, answered before the tick's budget
// is spent on anything else.
//
// This exists so runReminderSweep can put the calendar sweep FIRST on the one
// tick an hour it actually has work, and skip it entirely on the other three
// — rather than running it last every tick, where the notification sweeps have
// always already spent everything it needs (see SYNC_INTERVAL_MS).
//
// Uncharged, like every other discovery read in this codebase, and it costs
// literally nothing on a deployment with Google switched off: isGoogleConfigured
// short-circuits before the query.
export async function googleSyncDue(env: Env): Promise<boolean> {
  if (!isGoogleConfigured(env)) return false;
  const row = await env.DB.prepare(
    `SELECT 1 FROM google_calendar_connections
     WHERE status = 'disconnecting'
        OR (sync_enabled = 1 AND status = 'active'
            AND (last_synced_at IS NULL OR last_synced_at < ?))
     LIMIT 1`,
  )
    .bind(Date.now() - SYNC_INTERVAL_MS)
    .first();
  return row != null;
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
     WHERE status = 'disconnecting'
        OR (sync_enabled = 1 AND status = 'active'
            AND (last_synced_at IS NULL OR last_synced_at < ?))
     ORDER BY status DESC, last_synced_at ASC
     LIMIT ?`,
  )
    .bind(Date.now() - SYNC_INTERVAL_MS, MAX_CONNECTIONS_PER_TICK)
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
