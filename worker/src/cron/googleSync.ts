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
import { chunkRows, placeholders } from '../lib/d1';
import {
  accessTokenFor,
  deleteCalendarEvent,
  type GoogleConnectionRow,
  insertCalendarEvent,
  isGoogleConfigured,
  patchCalendarEvent,
  listCalendarEvents,
  readRefreshToken,
  revokeToken,
} from '../lib/googleCalendar';
import { newId } from '../lib/ids';
import { CURRENT_POLICY_VERSION } from '../lib/policy';
import { LIMITS } from '../lib/validate';
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

// How far ahead the imported calendar reaches (the pull half, migration
// 0037, reworked by 0039).
//
// Matched to LIMITS.MAX_FREE_BUSY_RANGE_MS rather than to SYNC_WINDOW_MS,
// because this answers a different question from the push half: it feeds the
// scheduling assistant, whose own request range is capped at the same ~2
// months. Importing further would create rows nobody's availability check
// can reach; importing less would leave a gap inside a range they can.
export const BUSY_CACHE_WINDOW_MS = 62 * 24 * 60 * 60 * 1000;

// A ceiling on how many of the chosen calendar's events get imported per
// sync.
//
// This is a much smaller number than the JSON-blob cache this replaced ever
// needed (that one merged overlapping events into far fewer intervals; this
// keeps one row per event). It exists for two reasons at once: a pathological
// calendar cannot make one sync's D1 batch unbounded, and each import becomes
// a real, visible personal_events row -- someone genuinely logging every
// meeting from a work calendar is a heavier use of this feature than a
// friend-group scheduler's availability check was sized for, and a hard cap
// is the honest way to say so rather than quietly falling over. Exceeding it
// keeps the EARLIEST events, since the assistant is overwhelmingly used for
// the near term.
//
// Sized together with the chunking below: cron/budget.ts's
// tryPersonalEventImport reserves for the exact worst case this produces,
// and the two have to move together if either changes.
const MAX_IMPORTED_EVENTS_PER_SYNC = 40;

// How many bound parameters one imported row costs in the upsert statement
// below: id, user_id, title, description, timezone, start_at, end_at,
// google_event_id, created_at, updated_at.
const IMPORT_PARAMS_PER_ROW = 10;

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
  // Which calendar this entry was actually written to (migration 0043).
  // NULL for rows predating it whose connection has since gone -- treated as
  // "destination unknown", which fails safe.
  calendar_id: string | null;
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
    `SELECT id, event_id, occurrence_date, google_event_id, synced_title, synced_start_at, synced_end_at,
            calendar_id
     FROM google_event_links WHERE user_id = ?`,
  )
    .bind(userId)
    .all<LinkRow>();
  return results;
}

// Pass-13 review (P13-07): takes the row rather than the id, so the write can
// be guarded by the credential the failure actually belongs to. Keyed on
// user_id alone, a stale `invalid_grant` from the old account's in-flight
// refresh disabled the account the user had just connected -- the same defect
// P12-03 fixed for the success path and left on the failure path.
async function markUnauthorized(env: Env, row: GoogleConnectionRow, message: string): Promise<void> {
  // sync_enabled = 0, not just an error message: a dead grant cannot recover
  // on its own, and leaving it enabled means every future tick spends part of
  // its allowance rediscovering that. The user reconnects, which resets both.
  await env.DB.prepare(
    `UPDATE google_calendar_connections SET sync_enabled = 0, last_error = ?, updated_at = ?
     WHERE user_id = ? AND refresh_token_ciphertext = ?`,
  )
    .bind(message, Date.now(), row.user_id, row.refresh_token_ciphertext)
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
  // Pass-13 review (P13-04). Reserved before any work, exactly as
  // syncOneConnection reserves its close-out: tryCalendarWrite draws on the
  // same pool, so a tick that has drained it cannot afford to record that it
  // tried.
  //
  // Without that record this path could not terminate. A disconnect whose
  // deletes are refused makes no progress AND never reached the attempt
  // counter, because the budget return below happened first -- and
  // `status = 'disconnecting'` sorts ahead of every active connection in the
  // candidate query, so it took the single per-tick slot again on every tick,
  // forever. Measured in review: 27 mapped events against a calendar
  // returning 403, six sweeps, 156 refused deletions, zero attempts recorded,
  // zero revocations, and no other user's connection serviced at all.
  if (!budget.trySpend(1)) return;

  const links = await loadLinks(env, row.user_id);
  // Past entries are left alone deliberately. They are a record of something
  // that actually happened, and reaching into someone's calendar history to
  // erase it is a worse default than leaving it there.
  const future = links.filter((l) => (l.synced_end_at ?? 0) >= now);

  let allCleared = true;
  let removed = 0;
  let outOfBudget = false;
  if (accessToken) {
    for (const link of future) {
      if (!budget.tryCalendarWrite()) {
        // Out of allowance, not out of options -- but the bookkeeping below
        // still has to run, so this breaks rather than returning.
        outOfBudget = true;
        break;
      }
      // Deleted from the calendar the LINK names, not the connection's current
      // one (P13-08): after a destination change those differ, and deleting
      // from the current calendar simply misses.
      const result = await deleteCalendarEvent(accessToken, link.calendar_id ?? row.calendar_id, link.google_event_id);
      if (result.ok) {
        await env.DB.prepare(`DELETE FROM google_event_links WHERE id = ?`).bind(link.id).run();
        removed += 1;
      } else {
        allCleared = false;
        if (result.kind === 'unauthorized') break;
      }
    }

    // Pass-19 review (P19-08). Entries this app created in Google that never
    // got a link row, because the mapping guard refused them while the
    // destination or credential was changing under an in-flight insert. They
    // are invisible to the enumeration above -- it reads google_event_links --
    // which is precisely why disconnect used to leave them behind while
    // reporting success, against an unqualified promise in the confirm dialog,
    // the disconnecting state and the Privacy Policy.
    //
    // No date filter here, unlike `future` above. That asymmetry is deliberate
    // and is not a change of policy about history: a link row records a
    // session that really happened and is worth keeping, whereas one of these
    // is a duplicate the user never asked for and cannot see the provenance
    // of. Leaving it as "history" would be leaving litter.
    const { results: orphans } = await env.DB.prepare(
      `SELECT id, google_event_id, calendar_id FROM google_orphaned_inserts WHERE user_id = ?`,
    )
      .bind(row.user_id)
      .all<{ id: string; google_event_id: string; calendar_id: string }>();
    for (const orphan of orphans) {
      if (!budget.tryCalendarWrite()) {
        outOfBudget = true;
        break;
      }
      const result = await deleteCalendarEvent(accessToken, orphan.calendar_id, orphan.google_event_id);
      // `missing` counts as done: someone deleting it by hand inside Google is
      // the outcome we were trying to produce.
      if (result.ok || result.kind === 'missing') {
        await env.DB.prepare(`DELETE FROM google_orphaned_inserts WHERE id = ?`).bind(orphan.id).run();
        removed += 1;
      } else {
        allCleared = false;
        if (result.kind === 'unauthorized') break;
      }
    }
  } else {
    allCleared = false;
  }

  if (outOfBudget) allCleared = false;

  // A tick that removed something is making progress and should not spend an
  // attempt -- a large disconnect legitimately takes several. One that removed
  // nothing must spend one, or a permanently refused delete loops forever.
  // That is the distinction the old unconditional increment could not make,
  // because it was unreachable in exactly the case that needed it.
  const attempts = removed > 0 ? row.disconnect_attempts : row.disconnect_attempts + 1;
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

  // Pass-15 review (P15-07 / P14-08), and the narrowing IDEAS item 71 said was
  // unsafe. It was, when item 71 was written; P15-05 is what changed that.
  //
  // Revoking at Google kills the GRANT, not the token, so a same-account
  // reconnect that lands mid-disconnect had its brand-new credential revoked
  // along with the one being discarded. Item 71 rejected the obvious guard --
  // re-read and skip when the stored credential has changed -- because it
  // would be wrong for a connection whose account was never identified: there,
  // storeConnection does not revoke either, so skipping would leave a live
  // grant nothing would ever tear down, against what the Privacy Policy says.
  //
  // The rule below is that objection made explicit rather than argued away.
  // Skip ONLY when a replacement exists and both sides are conclusively the
  // same account -- the one case where the old token shares the new token's
  // grant and revoking it is purely destructive. Every other shape still
  // revokes: no replacement (an ordinary disconnect), a different account
  // (whose predecessor storeConnection already revoked, so this is
  // belt-and-braces), or any identity that is not known on both sides.
  //
  // This is a narrowing, not a fix. The window is now between this read and
  // the request below rather than the whole multi-tick disconnect, and that
  // is all it is -- the remaining race is in item 71.
  const replacement = await env.DB.prepare(
    `SELECT refresh_token_ciphertext, google_account_email FROM google_calendar_connections WHERE user_id = ?`,
  )
    .bind(row.user_id)
    .first<{ refresh_token_ciphertext: string; google_account_email: string | null }>();
  const replacedBySameAccount =
    !!replacement &&
    replacement.refresh_token_ciphertext !== row.refresh_token_ciphertext &&
    !!replacement.google_account_email &&
    !!row.google_account_email &&
    replacement.google_account_email === row.google_account_email;

  const refreshToken = replacedBySameAccount ? null : await readRefreshToken(env, row);
  const revoked = refreshToken ? await revokeToken(refreshToken) : false;
  if (replacedBySameAccount) {
    console.log(
      `Google disconnect for ${row.user_id}: the same account reconnected while this was running, so the ` +
        'revocation was skipped -- both credentials share one grant, and revoking would have killed the new one.',
    );
  }

  // Pass-13 review (P13-07): every statement here is guarded by the refresh
  // token this disconnect began against, so a connection the user created
  // while the revocation was in flight is not deleted by the tidy-up for the
  // one they were leaving. Same compare-and-swap discipline, and the same
  // version token, as accessTokenFor's write.
  await env.DB.batch([
    env.DB.prepare(
      `DELETE FROM google_event_links WHERE user_id = ?
       AND EXISTS (SELECT 1 FROM google_calendar_connections
                   WHERE user_id = ? AND refresh_token_ciphertext = ?)`,
    ).bind(row.user_id, row.user_id, row.refresh_token_ciphertext),
    // Belt for F-17 / R11: DELETE /google already nulls read_calendar_id and
    // drops these, so a row imported between the request and this sweep should
    // not exist. One statement in a rare path is worth not having to be right
    // about that.
    env.DB.prepare(
      `DELETE FROM personal_events WHERE user_id = ? AND google_event_id IS NOT NULL
       AND EXISTS (SELECT 1 FROM google_calendar_connections
                   WHERE user_id = ? AND refresh_token_ciphertext = ?)`,
    ).bind(row.user_id, row.user_id, row.refresh_token_ciphertext),
    env.DB.prepare(
      `DELETE FROM google_calendar_connections WHERE user_id = ? AND refresh_token_ciphertext = ?`,
    ).bind(row.user_id, row.refresh_token_ciphertext),
  ]);

  // Said separately from the line above, and only when it is true (R12). The
  // previous version logged "token revoked" unconditionally, as part of a
  // sentence describing a successful disconnect, whether or not Google had
  // accepted the revocation -- which is the same thing the Privacy Policy
  // says happens. Local deletion and confirmed remote revocation are
  // different promises and now read differently in the log.
  if (revoked) {
    console.log(`Google disconnect for ${row.user_id}: credential revoked with Google.`);
  } else {
    console.warn(
      `Google disconnect for ${row.user_id}: the credential was deleted here, but Google did not confirm ` +
        'revocation. The grant may still exist in that account and has to be removed from Google account settings.',
    );
  }
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
  //
  // The `+ 2` rather than `+ 1` is the Pass-12 review (P12-07): the second is
  // the closing bookkeeping UPDATE, reserved here so the write loops below
  // cannot spend it. They can, and did -- tryCalendarWrite draws on the same
  // query pool, so running out mid-loop meant returning without the one
  // statement that records this connection was serviced. With
  // MAX_CONNECTIONS_PER_TICK at 1 and candidates ordered by last_synced_at
  // ascending, a connection that never gets stamped wins the single slot again
  // on every subsequent tick, forever: sixteen upcoming events against a
  // calendar that rejects writes were enough to make one user's broken
  // connection the only one this deployment would ever look at again.
  //
  // Reserving it is the only way to hold it. A tick that has run out cannot
  // afford to say so afterwards.
  if (!budget.trySpend(PER_CONNECTION_READ_QUERIES + 2)) {
    console.warn(
      `Google sync skipped for ${row.user_id}: this tick could not afford the calendar read ` +
        `(${PER_CONNECTION_READ_QUERIES + 2} queries needed). Retrying next hour.`,
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
  // Found live: choosing the same Google calendar for both push and pull is
  // never blocked, and nothing was stopping the pull half from reading an
  // event straight back in that the push half in this exact tick just wrote
  // -- three sessions pushed, then imported right back as three "new"
  // personal-time entries, on the very first sync after reconnecting.
  // Every id already in `links` covers everything pushed on a *previous*
  // tick; this set starts there and gains one entry per successful insert
  // below, so an event pushed and read back in the *same* tick -- which is
  // exactly what happened -- is caught too, not just from the second sync
  // onward.
  const pushedGoogleEventIds = new Set(links.map((l) => l.google_event_id));

  // Counted so a tick that did something says so, once, at the end.
  //
  // Without this the sweep is completely silent on its happy path -- and
  // because it is idempotent, the steady state is silence too, which makes
  // `wrangler tail` useless for the one question an operator actually asks
  // ("is it working?"). sweepPurgeTerminalHistory already set the precedent
  // by logging what it purged. A console line costs nothing against
  // cron/budget.ts's ledger, which counts D1 statements and subrequests.
  const counts = { inserted: 0, patched: 0, deleted: 0, relinked: 0 };

  // Pass-11 review (R18). Only `unauthorized` used to end the sync or record
  // anything; every other rejection was dropped on the floor and execution
  // carried on to unconditionally stamp last_synced_at and clear last_error.
  // So a 403 (write access to a shared calendar withdrawn), a malformed
  // calendar id, a rate limit or a transient 5xx produced a Settings page
  // reporting a fresh, successful sync while Google had accepted nothing --
  // and the ordinary interval then delayed the retry as if all were well.
  let writeFailures = 0;
  let firstFailure: string | null = null;
  // Set instead of returning when the calendar-write allowance runs out, so
  // every exit reaches the bookkeeping below (Pass-12 review, P12-07).
  let outOfBudget = false;
  const noteWriteFailure = (message: string) => {
    writeFailures += 1;
    firstFailure ??= message;
  };

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

    // Pass-15 review (P15-01). The entry is in a calendar this connection no
    // longer writes to, because the user picked a different destination since.
    // It has to MOVE: removed from where it actually is, then created where
    // the user asked for it.
    //
    // Pass 14 got half of this right and broke the other half in the same
    // three lines. Before it, a destination change with unchanged details was
    // silently skipped; a destination change WITH edits patched the new
    // calendar using the old entry's id, took the 404, dropped the link and
    // re-inserted into the right place on the next tick. That migration worked
    // by accident, and P14-06 removed the accident while fixing the skip:
    // patching `existing.calendar_id` maintains the entry, with new titles and
    // times, in the calendar the user stopped using -- forever, because the
    // success path never repaired the provenance either. Meanwhile the orphan
    // sweep below still addressed the connection's CURRENT calendar, so
    // cancelling sent a delete to one calendar for an entry living in another,
    // took the 404 as success and dropped the link -- leaving the event in the
    // old calendar with nothing left pointing at it. If that calendar is
    // shared more widely than the new one, edits keep reaching its viewers.
    //
    // Removal first, insertion second, deliberately: if the insert then fails,
    // the occurrence is missing for one tick and the next tick re-creates it
    // from a link row that is gone. Inserting first and failing to delete
    // would strand a duplicate in the old calendar with nothing naming it.
    if (existing && existing.calendar_id && existing.calendar_id !== row.calendar_id) {
      if (!budget.tryCalendarWrite()) {
        outOfBudget = true;
        break;
      }
      // Addressed by the calendar the LINK names -- migration 0043's whole
      // purpose. `deleteCalendarEvent` already folds "already gone" into
      // success, which is the outcome a removal wanted anyway.
      const removal = await deleteCalendarEvent(accessToken, existing.calendar_id, existing.google_event_id);
      if (!removal.ok) {
        if (removal.kind === 'unauthorized') {
          await markUnauthorized(env, row, 'Google access was revoked. Reconnect to resume syncing.');
          return;
        }
        // Leave the link pointing at the old entry so the next tick tries the
        // removal again. Re-creating it elsewhere while the original may still
        // exist is how someone ends up with two of everything.
        noteWriteFailure(removal.message);
        continue;
      }
      await env.DB.prepare(`DELETE FROM google_event_links WHERE id = ?`).bind(existing.id).run();
      counts.relinked += 1;
      // Deliberately NOT `continue`: control falls through to the insert path
      // below, which writes the occurrence to the connection's current
      // calendar and records that destination under the P13-08 guard.
    } else if (existing) {
      // Pass-14 review (P14-06). A link is only evidence of "already synced"
      // if it names the calendar currently being written to. A NULL
      // destination is a legacy row whose provenance is unknown -- migration
      // 0043 says such a row should be re-verified rather than trusted, and
      // trusting it here was the one place that did not.
      //
      // Past this point `existing.calendar_id` is either the current
      // destination or NULL, because the branch above handles every other
      // case -- which is what makes patching `row.calendar_id` correct again.
      const unchanged =
        existing.calendar_id === row.calendar_id &&
        existing.synced_title === occ.title &&
        existing.synced_start_at === occ.startAt &&
        existing.synced_end_at === occ.endAt;
      // The common case by a wide margin: a steady calendar costs nothing per
      // tick beyond the two reads above.
      if (unchanged) continue;

      if (!budget.tryCalendarWrite()) {
        outOfBudget = true;
        break;
      }
      // Patched against the calendar the link names, falling back to the
      // connection's only for a legacy row with no destination recorded. An
      // entry that is not there answers 404, classifies as missing, and is
      // re-inserted fresh against the current destination.
      const result = await patchCalendarEvent(accessToken, row.calendar_id, existing.google_event_id, payload);
      if (result.ok) {
        // Pass-15 review (P15-03). `calendar_id` is written here, not just the
        // title and times, and that is the whole finding: a legacy row with a
        // NULL destination can never satisfy the `unchanged` test above, so
        // leaving the provenance NULL after a SUCCESSFUL verification meant
        // verifying it again on every tick, forever, spending a calendar write
        // each time. Sixteen such rows spent every write a Free-plan tick had
        // and no genuinely new event was ever created. Recording what we just
        // verified is what lets the row go quiet.
        //
        // Guarded like the insert below, and for the same reason: this is a
        // provenance write, so it must not credit a connection that replaced
        // the one this patch was issued under (P13-08, P14-06).
        await env.DB.prepare(
          `UPDATE google_event_links
             SET synced_title = ?, synced_start_at = ?, synced_end_at = ?, synced_at = ?, calendar_id = ?
           WHERE id = ?
             AND EXISTS (SELECT 1 FROM google_calendar_connections
                         WHERE user_id = ? AND calendar_id = ? AND refresh_token_ciphertext = ?
                           AND status = 'active')`,
        )
          .bind(
            occ.title,
            occ.startAt,
            occ.endAt,
            now,
            row.calendar_id,
            existing.id,
            row.user_id,
            row.calendar_id,
            row.refresh_token_ciphertext,
          )
          .run();
        counts.patched += 1;
      } else if (result.kind === 'missing') {
        // Someone deleted our copy from inside Google, which is an entirely
        // reasonable thing to do. Drop the stale link so the next tick treats
        // this as a fresh insert rather than patching an id that is gone.
        await env.DB.prepare(`DELETE FROM google_event_links WHERE id = ?`).bind(existing.id).run();
        counts.relinked += 1;
      } else if (result.kind === 'unauthorized') {
        await markUnauthorized(env, row, 'Google access was revoked. Reconnect to resume syncing.');
        return;
      } else {
        noteWriteFailure(result.message);
      }
      continue;
    }

    if (!budget.tryCalendarWrite()) {
      outOfBudget = true;
      break;
    }
    const result = await insertCalendarEvent(accessToken, row.calendar_id, payload);
    if (result.ok) {
      const mapping = await env.DB.prepare(
        // Pass-13 review (P13-08). Records the destination this entry was
        // actually written to, and refuses to record it at all if that
        // destination is no longer the connection's -- the R10 `stillCurrent`
        // idiom from the import half, applied to the push half.
        //
        // Without the guard, a push already in flight when the destination
        // changed returned afterwards and reinstated a mapping for an event id
        // living in the OLD calendar, defeating the cleanup that had just run.
        // Nothing on the row said which calendar it belonged to, so nothing
        // could tell it was stale.
        `INSERT INTO google_event_links
           (id, user_id, event_id, occurrence_date, google_event_id, synced_title, synced_start_at, synced_end_at,
            synced_at, calendar_id)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
         WHERE EXISTS (SELECT 1 FROM google_calendar_connections
                       WHERE user_id = ? AND calendar_id = ? AND refresh_token_ciphertext = ?
                         AND status = 'active')
         ON CONFLICT(user_id, event_id, occurrence_date) DO UPDATE SET
           google_event_id = excluded.google_event_id,
           synced_title = excluded.synced_title,
           synced_start_at = excluded.synced_start_at,
           synced_end_at = excluded.synced_end_at,
           synced_at = excluded.synced_at,
           calendar_id = excluded.calendar_id`,
      )
        .bind(
          newId(),
          row.user_id,
          occ.eventId,
          occ.occurrenceDate,
          result.value.id,
          occ.title,
          occ.startAt,
          occ.endAt,
          now,
          row.calendar_id,
          row.user_id,
          row.calendar_id,
          // Pass-14 review (P14-06): the CREDENTIAL as well as the calendar
          // string. "primary" is an alias every Google account has, so two
          // accounts' destinations compare equal -- an insert already in
          // flight when the connection was replaced was accepted under the
          // new account because both were called primary. The refresh token
          // is what actually distinguishes them.
          row.refresh_token_ciphertext,
        )
        .run();

      // Pass-19 review (P19-08). The guard above refuses the mapping when the
      // destination or credential moved while this insert was in flight -- and
      // until now, that was the end of it. The event existed in the user's
      // Google calendar and nothing local pointed at it, so the next sweep
      // made a second copy, and DISCONNECT could not remove the first, because
      // disconnect enumerates google_event_links. Three places in the product
      // promise, without qualification, that disconnecting removes the
      // upcoming entries this app added.
      //
      // So a refused mapping is now an obligation rather than a shrug. Try to
      // undo the remote insert straight away, which also removes the duplicate
      // that made this visible; if that cannot happen -- the delete fails, or
      // the calendar-write allowance is spent -- record it so cleanup can.
      //
      // Note the delete targets `row.calendar_id`, the calendar this insert
      // was actually dispatched to, not wherever the connection points now.
      // That is the same lesson P13-08 taught the disconnect sweep.
      if (mapping.meta.changes === 0) {
        const compensated =
          budget.tryCalendarWrite() &&
          (await deleteCalendarEvent(accessToken, row.calendar_id, result.value.id)).ok;
        if (!compensated) {
          await env.DB.prepare(
            `INSERT INTO google_orphaned_inserts (id, user_id, google_event_id, calendar_id, created_at)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(user_id, calendar_id, google_event_id) DO NOTHING`,
          )
            .bind(newId(), row.user_id, result.value.id, row.calendar_id, now)
            .run();
        }
        continue;
      }

      counts.inserted += 1;
      pushedGoogleEventIds.add(result.value.id);
    } else if (result.kind === 'unauthorized') {
      await markUnauthorized(env, row, 'Google access was revoked. Reconnect to resume syncing.');
      return;
    } else {
      noteWriteFailure(result.message);
    }
  }

  // Whatever is left in the map has a link row but no live occurrence any
  // more: cancelled, declined since, edited out of the window, or simply now
  // in the past. Only the first three should actually be removed from Google.
  for (const orphan of outOfBudget ? [] : linkByKey.values()) {
    // A past entry is not an orphan, it is history -- and the window is
    // forward-looking, so everything that has happened falls out of `desired`
    // on the next tick regardless. Deleting on that basis would quietly erase
    // someone's record of every session they have ever played.
    if ((orphan.synced_end_at ?? 0) < now) continue;

    if (!budget.tryCalendarWrite()) {
      outOfBudget = true;
      break;
    }
    // Pass-15 review (P15-01), the other half: addressed by the calendar the
    // link records, not the connection's current one. An orphan created before
    // a destination change lives in the old calendar, and sending its deletion
    // to the new one answers 404 -- which this path reads as "already gone"
    // and drops the link for, leaving the entry in Google with nothing left
    // pointing at it. NULL means a legacy row whose provenance was never
    // recorded; the connection's calendar is the only available guess, and the
    // patch path above now repairs those on first verification.
    const result = await deleteCalendarEvent(accessToken, orphan.calendar_id ?? row.calendar_id, orphan.google_event_id);
    if (result.ok) {
      await env.DB.prepare(`DELETE FROM google_event_links WHERE id = ?`).bind(orphan.id).run();
      counts.deleted += 1;
    } else if (result.kind === 'unauthorized') {
      await markUnauthorized(env, row, 'Google access was revoked. Reconnect to resume syncing.');
      return;
    } else {
      noteWriteFailure(result.message);
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
  // reports on -- that half just succeeded. But syncImportedPersonalEvents can
  // record an error of its own (a chosen calendar that no longer exists), and
  // running this afterwards erased it immediately: reading would switch
  // itself off and the user would never learn why. Found by a test asserting
  // the message survives, which it did not.
  // R18: last_error only clears when the push half really did succeed. A sync
  // that Google rejected part or all of records what happened instead of
  // reporting itself clean -- otherwise Settings shows a fresh "Last synced"
  // for a calendar that received nothing, which is the most misleading state
  // this feature can be in.
  //
  // last_synced_at is still stamped either way, deliberately: it is what
  // paces the retry, and not advancing it would turn a persistently failing
  // connection into a sweep that runs every tick forever, which is the
  // starvation cron/budget.ts exists to prevent. The error is what says the
  // freshness is not the whole story.
  const pushError =
    writeFailures > 0
      ? `${writeFailures} calendar ${writeFailures === 1 ? 'entry' : 'entries'} could not be written to Google` +
        (firstFailure ? `: ${firstFailure}` : '.')
      : outOfBudget
        ? // Not an error in the sense the other messages are -- nothing is
          // broken and nothing needs the user's attention -- but saying
          // nothing would leave a fresh "Last synced" standing for a calendar
          // that only received part of what it was owed, which is R18's
          // "most misleading state this feature can be in".
          'Some entries are still waiting to sync and will be sent on a later run.'
        : null;
  if (pushError) {
    console.warn(`Google sync for ${row.user_id}: ${pushError}`);
  }
  // Reached on every exit from the push half now, including the ones where the
  // calendar-write allowance ran out mid-loop (Pass-12 review, P12-07). The
  // query for it was reserved at the top of this function, so it is affordable
  // even at the moment the loops above found they were not.
  //
  // last_synced_at is what paces the retry AND what orders the candidate
  // query, so stamping it unconditionally is what makes scheduling fair
  // independently of whether the work succeeded -- one connection's bad hour
  // costs it its turn, not everybody else's.
  //
  // Guarded on refresh_token_ciphertext for the same reason markUnauthorized
  // above is (P13-07), which this statement was left out of: if the user
  // disconnects and reconnects -- possibly as a different Google account --
  // while this sync is in flight, keying on user_id alone stamps the
  // replacement's row with the predecessor's outcome. A stale "3 entries could
  // not be written" on a connection that has written nothing yet is cosmetic
  // and clears on the replacement's own first sweep, but it is still a message
  // about a credential the row no longer holds. Not stamping is the right
  // failure here: the row it would have stamped is a new connection, which
  // carries its own last_synced_at from connect and is scheduled on that.
  await env.DB.prepare(
    `UPDATE google_calendar_connections SET last_synced_at = ?, last_error = ?, updated_at = ?
     WHERE user_id = ? AND refresh_token_ciphertext = ?`,
  )
    .bind(now, pushError, now, row.user_id, row.refresh_token_ciphertext)
    .run();

  // Nothing left to read Google with -- the pull half would spend its own
  // reservation check and return anyway, and this says so without the round
  // trip.
  if (outOfBudget) return;
  await syncImportedPersonalEvents(env, row, accessToken, budget, now, pushedGoogleEventIds);
}

// One statement per upsert chunk, plus this one DELETE -- computed once from
// the same two constants tryPersonalEventImport is reserved against, so the
// two can never silently drift apart.
const MAX_UPSERT_STATEMENTS = chunkRows(
  new Array<null>(MAX_IMPORTED_EVENTS_PER_SYNC).fill(null),
  IMPORT_PARAMS_PER_ROW,
).length;
const MAX_IMPORT_STATEMENTS = MAX_UPSERT_STATEMENTS + 1;

// The pull half: one events.list call against the ONE calendar this person
// chose, reconciled into that person's own personal_events rows. Every event
// on it becomes one, regardless of Google's own Busy/Free flag on it -- see
// listCalendarEvents' own comment in googleCalendar.ts for why that's 0.8.1's
// answer, and for why this imports real events rather than caching opaque
// intervals the way the mechanism it replaced did.
//
// Runs inside the same hourly slot as the push, deliberately -- it is the same
// connection, the same access token, and the same "a mirror within the hour is
// fine" latency argument. A separate schedule would double the fixed cost for
// no benefit.
//
// Does nothing at all unless read_calendar_id is set, which it is not for
// anyone by default. Connecting to push never starts a pull.
async function syncImportedPersonalEvents(
  env: Env,
  row: GoogleConnectionRow,
  accessToken: string,
  budget: TickBudget,
  now: number,
  // Every Google event id this connection's own push half has ever written,
  // including anything it wrote earlier in this same tick. Filtered out of
  // the import below so a shared or overlapping read/write calendar can't
  // feed a session back in as a "new" personal-time entry -- see the call
  // site for how this set is built.
  pushedGoogleEventIds: ReadonlySet<string>,
): Promise<void> {
  if (!row.read_calendar_id) return;
  // Reserved for the worst case (every chunked upsert statement plus the
  // DELETE) before the Google call runs at all -- the actual statement count
  // this tick spends can only be less than or equal to what was reserved,
  // never more, which is what keeps `exhausted` meaning what its callers
  // assume regardless of how many events the calendar actually has.
  if (!budget.tryPersonalEventImport(MAX_IMPORT_STATEMENTS)) return;

  const result = await listCalendarEvents(accessToken, row.read_calendar_id, now, now + BUSY_CACHE_WINDOW_MS);

  if (!result.ok) {
    if (result.kind === 'unauthorized') {
      await markUnauthorized(env, row, 'Google access was revoked. Reconnect to resume syncing.');
      return;
    }
    if (result.kind === 'missing') {
      // The calendar is gone, or was never readable. Switch reading off, say
      // why, and remove every row this connection ever imported -- the honest
      // outcome of "the thing you chose isn't there" now that what it
      // produces is real, visible entries rather than an opaque cache nobody
      // but this code ever read. This DELETE is outside the reservation
      // above (which was already spent on the events.list call that just
      // failed): a rare, terminal, once-per-disappearance cost, the same
      // category runDisconnect's own cleanup already sits outside the ledger
      // for.
      // Pass-14 review (P14-09 / F-37). Both statements are guarded by the
      // read calendar this failure actually came from -- the stillCurrent
      // idiom the stale-delete and upsert further down this same function
      // already use through guardBinds, and which this terminal branch was
      // written without.
      //
      // Scoped by user_id alone, a 404 for a calendar the user had just
      // switched away from landed on their NEW selection: it nulled the
      // calendar they had just chosen, wrote "calendar A not found" as the
      // error against it, and deleted the imports the new one had produced.
      // The window is one events.list round trip, but the outcome is the
      // person's fresh choice silently reverted with an error naming a
      // calendar they no longer have.
      //
      // The DELETE runs FIRST so both statements see the pre-null value; a
      // batch is one transaction, so the order inside it is the only thing
      // that decides what the second one can still match on.
      //
      // Pass-15 review (P15-04): the CREDENTIAL as well as the calendar
      // string, for the reason P14-06 gave on the push half and this half did
      // not adopt. A read calendar is a name, and `primary` is a name every
      // Google account has -- so a replacement connection that reselects the
      // same string satisfies a guard that only compares strings, and this
      // failure, belonging to an account that is gone, clears the new
      // account's freshly made choice and deletes what it imported.
      await env.DB.batch([
        env.DB.prepare(
          `DELETE FROM personal_events WHERE user_id = ? AND google_event_id IS NOT NULL
           AND EXISTS (SELECT 1 FROM google_calendar_connections
                       WHERE user_id = ? AND read_calendar_id = ? AND refresh_token_ciphertext = ?)`,
        ).bind(row.user_id, row.user_id, row.read_calendar_id, row.refresh_token_ciphertext),
        env.DB.prepare(
          `UPDATE google_calendar_connections
           SET read_calendar_id = NULL, last_error = ?, updated_at = ?
           WHERE user_id = ? AND read_calendar_id = ? AND refresh_token_ciphertext = ?`,
        ).bind(result.message, now, row.user_id, row.read_calendar_id, row.refresh_token_ciphertext),
      ]);
      console.warn(`Google personal-time import disabled for ${row.user_id}: ${result.message}`);
      return;
    }
    // Transient. Existing imported rows are deliberately left in place: stale
    // busy time is the safe direction to be wrong in, and clearing them would
    // report someone as free when we simply could not ask Google.
    console.warn(`Google personal-time import deferred for ${row.user_id}: ${result.message}`);
    return;
  }

  const { timeZone, events, hasMore } = result.value;
  const candidates = events
    .filter((e) => !pushedGoogleEventIds.has(e.googleEventId))
    .sort((a, b) => a.startAt - b.startAt);
  const imported = candidates.slice(0, MAX_IMPORTED_EVENTS_PER_SYNC);

  // Pass-11 review (R16). Forty-one events over two months is ordinary
  // calendar usage, not a pathological case, and everything past the cap used
  // to be dropped with nothing recorded anywhere: no error, no flag, and
  // last_error left null. The omitted meetings simply never became busy
  // blocks, so the scheduling assistant reported those times as free -- the
  // failure mode where incomplete data is presented as complete.
  //
  // Properly paging this needs a per-connection cursor and a migration, which
  // is deliberately not smuggled in here. What is fixed is the part that
  // actively misleads: the truncation is now visible to its owner, and the
  // reconciliation below stops deleting on the strength of an answer it knows
  // to be partial.
  const truncated = candidates.length > MAX_IMPORTED_EVENTS_PER_SYNC || hasMore;

  const statements = [];

  // Pass-11 review (R10). Everything below is conditioned on the connection
  // still being the one this sync started against.
  //
  // The race is ordinary, not exotic: this function snapshots the connection,
  // awaits listCalendarEvents over the network, and then writes. If the person
  // switches reading off (PATCH /google `readCalendarId: null`) or picks a
  // different calendar while that call is in flight, PATCH correctly deletes
  // the imports and clears the preference -- and then this sweep, holding a
  // snapshot from before, writes them all back. The next sweep returns
  // immediately for a null read calendar, so nothing ever cleans up after it:
  // titles and descriptions from a calendar the person stopped sharing sit
  // there indefinitely, still counted as busy against them.
  //
  // Re-reading the row before the batch would not fix it -- there is still a
  // gap between that read and the write. The guard has to be inside the
  // statements, where D1's batch transaction makes it atomic with them.
  //
  // Pass-15 review (P15-04). `refresh_token_ciphertext` is part of the guard
  // for the same reason it is part of the push half's (P14-06): the calendar
  // string alone does not identify a source. Two Google accounts both have a
  // `primary`, and one shared calendar can legitimately be selected by either
  // -- so without the credential, an import fetched under the account the user
  // just left lands in the account they just connected, and its titles sit
  // there as that person's busy time.
  const stillCurrent = `EXISTS (SELECT 1 FROM google_calendar_connections
       WHERE user_id = ? AND status = 'active' AND sync_enabled = 1 AND read_calendar_id = ?
         AND refresh_token_ciphertext = ?)`;
  const guardBinds = [row.user_id, row.read_calendar_id, row.refresh_token_ciphertext];

  // Anything previously imported that fell inside this window and did not
  // come back this time -- deleted, cancelled, or moved outside the window
  // by being rescheduled. Bounded to the window itself: a past occurrence
  // this sync isn't even asking about is left alone rather than reasoned
  // about from its absence in an answer that was never about it.
  //
  // Skipped entirely when the source answer was truncated (R16): rows missing
  // from a partial response are not evidence of anything, and deleting on
  // that basis would churn genuinely-current entries out of the database
  // every tick.
  if (!truncated) {
    const currentIds = imported.map((e) => e.googleEventId);
    // Pass-11 review (R19): the same overlap predicate the source query uses,
    // not `start_at >= now`. Google's timeMin bounds an event's *end*, so an
    // event that started yesterday and ends tomorrow is inside the range this
    // sync asked about -- but the old predicate could never match it, so
    // deleting or cancelling an in-progress event in Google never removed the
    // app's copy. Its busy time stayed blocked and its title and description
    // stayed imported, permanently, with the local delete route refusing to
    // touch it (409) because it came from Google.
    const overlapsWindow = `end_at > ? AND start_at < ?`;
    const staleSql =
      currentIds.length > 0
        ? `DELETE FROM personal_events
           WHERE user_id = ? AND google_event_id IS NOT NULL
             AND ${overlapsWindow}
             AND google_event_id NOT IN (${placeholders(currentIds.length)})
             AND ${stillCurrent}`
        : `DELETE FROM personal_events
           WHERE user_id = ? AND google_event_id IS NOT NULL
             AND ${overlapsWindow}
             AND ${stillCurrent}`;
    statements.push(
      env.DB.prepare(staleSql).bind(row.user_id, now, now + BUSY_CACHE_WINDOW_MS, ...currentIds, ...guardBinds),
    );
  }

  // status/availability/is_recurring are written as literals, not bound --
  // every imported row is active, counts as busy (per the decision above),
  // and is never itself a recurring series: Google's own singleEvents=true
  // already expanded any recurring source event into individual instances,
  // each with its own googleEventId, before this ever saw it.
  for (const chunk of chunkRows(imported, IMPORT_PARAMS_PER_ROW)) {
    // `SELECT ... WHERE EXISTS` rather than `VALUES`, so the same guard the
    // DELETE carries applies to the rows being written too -- a VALUES clause
    // has nowhere to put a condition. Literals stay literal in the first arm's
    // column aliases; every later arm is positional, the same shape
    // lib/d1.ts's conditionalRowsSql builds for guarded event writes.
    const arms = chunk
      .map((_, i) =>
        i === 0
          ? `SELECT ? AS id, ? AS user_id, ? AS title, ? AS description, ? AS timezone, ? AS start_at, ? AS end_at,
                    'active' AS status, 'busy' AS availability, 0 AS is_recurring, ? AS google_event_id,
                    ? AS created_at, ? AS updated_at`
          : `SELECT ?, ?, ?, ?, ?, ?, ?, 'active', 'busy', 0, ?, ?, ?`,
      )
      .join(' UNION ALL ');
    const params = chunk.flatMap((e) => [
      newId(),
      row.user_id,
      e.title.slice(0, LIMITS.TITLE),
      e.description ? e.description.slice(0, LIMITS.DESCRIPTION) : null,
      timeZone,
      e.startAt,
      e.endAt,
      e.googleEventId,
      now,
      now,
    ]);
    statements.push(
      env.DB.prepare(
        `INSERT INTO personal_events
           (id, user_id, title, description, timezone, start_at, end_at, status, availability, is_recurring,
            google_event_id, created_at, updated_at)
         SELECT * FROM (${arms})
         WHERE ${stillCurrent}
         ON CONFLICT(user_id, google_event_id) DO UPDATE SET
           title = excluded.title, description = excluded.description, timezone = excluded.timezone,
           start_at = excluded.start_at, end_at = excluded.end_at, updated_at = excluded.updated_at`,
      ).bind(...params, ...guardBinds),
    );
  }

  // Said in last_error because that is the field Settings actually shows, and
  // "some of your calendar is missing from this" is exactly the kind of thing
  // its owner has to be able to see. Cleared on a complete import, so it does
  // not outlive the condition -- and deliberately not phrased as a failure,
  // because nothing failed: the import is working and is incomplete, which is
  // a different sentence.
  const truncationNotice = truncated
    ? `Only the first ${MAX_IMPORTED_EVENTS_PER_SYNC} events from this calendar are being read, so times beyond ` +
      'them will not show as busy.'
    : null;
  statements.push(
    env.DB.prepare(
      // P15-04 again: a note about what one account's calendar contained must
      // not be stamped on another account's connection.
      `UPDATE google_calendar_connections SET updated_at = ?, last_error = COALESCE(?, last_error)
       WHERE user_id = ? AND read_calendar_id = ? AND refresh_token_ciphertext = ?`,
    ).bind(now, truncationNotice, row.user_id, row.read_calendar_id, row.refresh_token_ciphertext),
  );

  await env.DB.batch(statements);

  if (imported.length > 0) {
    console.log(`Google personal-time import for ${row.user_id}: ${imported.length} event(s) over the next 62 days.`);
  }
  if (truncated) {
    console.warn(
      `Google personal-time import for ${row.user_id} was truncated at ${MAX_IMPORTED_EVENTS_PER_SYNC} events; ` +
        'the rest of the window is not represented as busy.',
    );
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
    // Same policy-acceptance join as sweepGoogleCalendar's own candidate query
    // (R15). These two predicates have to agree: this one decides whether the
    // tick reorders itself to run the calendar sweep first, and if it said
    // "due" for a connection the sweep then declines to process, the tick
    // would give up its ordering for work that was never going to happen.
    `SELECT 1 FROM google_calendar_connections c
     JOIN users u ON u.id = c.user_id
     WHERE c.status = 'disconnecting'
        OR (c.sync_enabled = 1 AND c.status = 'active'
            AND u.accepted_policy_version >= ?
            AND (c.last_synced_at IS NULL OR c.last_synced_at < ?))
     LIMIT 1`,
  )
    .bind(CURRENT_POLICY_VERSION, Date.now() - SYNC_INTERVAL_MS)
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
  // Pass-11 review (R15). The policy version is joined here because background
  // processing was the one path that never checked it. Every API route runs
  // requirePolicyAcceptance, so a user who has not accepted the current
  // Privacy Policy is refused at the door -- and yet this sweep went on
  // reading their calendar, storing real titles and descriptions, and sending
  // their sessions to Google on their behalf. A policy gate that the person
  // meets on their next request but their data does not is not a gate.
  //
  // It matters most across exactly the change this app just made: lib/policy
  // describes version 4 as opaque busy/free only and version 5 as retaining
  // real titles and descriptions. Bumping the version is what asks for consent
  // to that; without this join, the new behaviour would have started for
  // everyone regardless of whether they gave it.
  //
  // `status = 'disconnecting'` is deliberately outside the check: someone who
  // declines a new policy must still be able to withdraw, and a disconnect
  // that stalled waiting for acceptance would trap the very people most likely
  // to want it. Withdrawal is not processing.
  const { results: connections } = await env.DB.prepare(
    `SELECT c.* FROM google_calendar_connections c
     JOIN users u ON u.id = c.user_id
     WHERE c.status = 'disconnecting'
        OR (c.sync_enabled = 1 AND c.status = 'active'
            AND u.accepted_policy_version >= ?
            AND (c.last_synced_at IS NULL OR c.last_synced_at < ?))
     ORDER BY c.status DESC, c.last_synced_at ASC
     LIMIT ?`,
  )
    .bind(CURRENT_POLICY_VERSION, Date.now() - SYNC_INTERVAL_MS, MAX_CONNECTIONS_PER_TICK)
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
        await markUnauthorized(env, row, token.message);
      } else {
        // Pass-14 review (P14-10). Transient, and now recorded rather than
        // left untouched.
        //
        // "Stays at the front of the queue and is retried first next tick" was
        // the same reasoning P12-07 had to undo on the write path: with
        // MAX_CONNECTIONS_PER_TICK at 1, first is *only*. A connection whose
        // token endpoint keeps answering 503 therefore took the single slot on
        // every tick while other due users -- holding perfectly good cached
        // tokens -- got no calendar calls at all.
        //
        // Stamping last_synced_at costs this connection its turn and gives the
        // next one theirs; the error says the freshness is not the whole
        // story. Charged, and skipped if the tick cannot afford it, in which
        // case the old behaviour applies for one more tick.
        console.warn(`Google sync deferred for ${row.user_id}: ${token.message}`);
        if (budget.trySpend(1)) {
          await env.DB.prepare(
            `UPDATE google_calendar_connections SET last_synced_at = ?, last_error = ?, updated_at = ?
             WHERE user_id = ? AND refresh_token_ciphertext = ?`,
          )
            .bind(Date.now(), token.message, Date.now(), row.user_id, row.refresh_token_ciphertext)
            .run();
        }
      }
      continue;
    }

    await syncOneConnection(env, row, token.accessToken, budget);
  }
}
