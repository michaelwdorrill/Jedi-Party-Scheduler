// IDEAS item 5 (second half) / docs/specs/0007: what is on in one server.
//
// Deliberately NOT a widened buildCalendarOccurrences, which specs/0007's
// blocker 3 called out before this was written. That function is bounded by
// what the *caller* is personally attached to -- their own organiser and
// invite rows -- and 0006's whole cost argument rests on that bound. This
// query is scoped by guild membership instead, so the bound is gone: a busy
// server's entire event list is in scope, for anyone who can see it.
//
// So it gets its own limits rather than inheriting ones that were reasoned
// about for a different shape:
//
//   - the range is capped at ~2 months, not the calendar's year. A
//     noticeboard answers "what's on soon", and a year of a 300-event server
//     is not a question anyone is really asking.
//   - the event list is capped and ordered by start time, so a server past
//     the cap shows the soonest events rather than an arbitrary slice.
//   - recurring expansion draws on one shared occurrence ceiling, the same
//     technique lib/freeBusy.ts uses, so no combination of series can
//     multiply into unbounded work.

import type { Env } from '../env';
import { chunkIds, placeholders } from './d1';
import type { EventRow } from './events';
import { loadOverridesForEvents } from './events';
import { expandOccurrencesForEvent, loadRecurrenceRulesForEvents } from './recurrence';
import { NoticeboardTooLargeError } from './validate';

// How many events one noticeboard request will RETURN. A guild is capped at
// MAX_ACTIVE_EVENTS_PER_GUILD (300) active events, so this is a real cut, and
// it is ordered by start time -- the soonest hundred is the useful hundred.
//
// Since IDEAS item 79 this counts events that actually have an occurrence in
// the window, not candidate rows read from the table. The difference is the
// whole of P17-07, P18-02 and P19-01: three separate ways for a page of
// candidates that expand to NOTHING to spend this budget and push a real
// event out of a board that then reports itself as empty.
const MAX_NOTICEBOARD_EVENTS = 100;

// How many candidate rows the scan will read before it gives up and says so.
// This is what keeps the work bounded now that the event cap no longer does:
// the event cap counts events that survive expansion, so on its own it would
// let a guild whose candidates all expand to nothing read the entire table.
//
// 500 is the cap on rows read in the single candidate statement. It bounds the
// two chunked loaders below far more than it bounds that statement -- see the
// guard in test/pass19.test.ts, which exists because this path runs inside a
// request and D1's Free plan allows 50 statements per invocation.
const MAX_CANDIDATES_SCANNED = 500;

// The ceiling on expanded occurrences across every event in one request.
// Smaller than free/busy's, because this returns titles and attendee lists
// rather than opaque ranges, so each occurrence carries far more payload.
const MAX_NOTICEBOARD_OCCURRENCES = 1_000;

// One day, for widening the candidate window's date bounds (P17-07 below).
const DAY_MS = 24 * 60 * 60 * 1000;

export interface NoticeboardAttendee {
  userId: string;
  username: string;
  globalName: string | null;
  avatarHash: string | null;
  rsvpStatus: 'accepted' | 'declined' | 'tentative' | null;
}

// What the board came back with, and whether it is the whole answer.
//
// The flag is the half of IDEAS item 79 that SQL cannot supply. Deciding
// whether a series has an occurrence in a narrow window needs the expander,
// so a bounded scan can run out of allowance with candidates left unexamined.
// Before this existed the response could not say so, and the frontend
// rendered "nothing scheduled" over a server that had plenty scheduled --
// which is exactly what made P17-07 and P19-01 so hard to see.
//
// `complete: false` means "this is what we found before the budget ran out",
// never "this is everything". It is deliberately conservative: stopping
// because the event cap filled on the last available candidate also reports
// incomplete, because proving otherwise would cost another query to learn
// nothing actionable.
export interface NoticeboardResult {
  occurrences: NoticeboardOccurrence[];
  complete: boolean;
}

export interface NoticeboardOccurrence {
  occurrenceId: string;
  eventId: string;
  title: string;
  game: string | null;
  startAt: number;
  endAt: number;
  isRecurring: boolean;
  organizerId: string;
  attendees: NoticeboardAttendee[];
}

interface InviteRow {
  event_id: string;
  user_id: string;
  username: string;
  global_name: string | null;
  avatar_hash: string | null;
}

interface AttendanceRow {
  event_id: string;
  occurrence_date: string;
  user_id: string;
  rsvp_status: 'accepted' | 'declined' | 'tentative';
}

export async function buildNoticeboard(
  env: Env,
  guildId: string,
  from: number,
  to: number,
): Promise<NoticeboardResult> {
  // `is_private = 0` is doing the load-bearing work here, and migration 0038
  // is what makes it safe: every event that existed before this feature was
  // backfilled to private, so nothing created under the old Privacy Policy can
  // surface through this query.
  //
  // Polls are excluded outright rather than filtered later. An unresolved poll
  // has no time yet, and its candidate days are maybes -- putting either on a
  // noticeboard would advertise something that may never happen. A poll that
  // has resolved has a real start_at and is picked up by the range test like
  // any other event.
  //
  // Hence `status IN ('active','resolved')` rather than `= 'active'`, which is
  // the form freeBusy.ts already uses. A resolved poll's status *is*
  // 'resolved', so the narrower test silently swallowed every poll that had
  // reached a decision -- and made the poll clause below dead code, since
  // nothing could reach it that 'active' had not already excluded. The
  // unresolved-poll test still passed, for the wrong reason.
  //
  // ---------------------------------------------------------------------
  // The candidate predicate, and the three passes it took to get here.
  //
  // This clause decides which events are worth EXPANDING. It cannot decide
  // which events have an occurrence in the window -- that needs the expander,
  // for reasons the three regressions below each demonstrate -- so its only
  // job is to be cheap and to never exclude something that might qualify.
  //
  // P17-07: `is_recurring = 1` used to admit every active series with no
  // reference to the window at all. Narrowing it to series whose rule can
  // overlap the window closed that.
  //
  // P18-01: that narrowing then EXCLUDED valid occurrences, in two ways. It
  // compared `end_date` as a point when an occurrence is an interval
  // (`duration_minutes` runs to a year), and it read nominal rule dates when
  // an override can move an occurrence anywhere. Hence the duration widening
  // and the override arm.
  //
  // P19-01: the override arm then admitted series holding overrides that no
  // longer belong to their rule -- a whole-series edit can orphan an override
  // without deleting it, and only `isSeriesOccurrence` can tell, in JS, after
  // the walk. Those series expand to nothing.
  //
  // Every one of those three was a defect of the same shape: a candidate set
  // trimmed to a fixed page BEFORE anything expanded, so rows that expand to
  // nothing evict rows that do not. That is why the fix is no longer in this
  // predicate. The predicate stays deliberately generous; the paging below is
  // what bounds the work, and it counts events that survive expansion.
  //
  // The dates are compared as ISO text, which sorts chronologically. Both
  // bounds are widened by a day because the rule's dates are local to the
  // event's timezone while the window is epoch milliseconds, and the end
  // bound is widened again by the rule's duration rounded up to whole days,
  // which also absorbs the `start_time` the comparison ignores.
  const windowStartDate = new Date(from - DAY_MS).toISOString().slice(0, 10);
  const windowEndDate = new Date(to + DAY_MS).toISOString().slice(0, 10);

  const CANDIDATE_SQL = `SELECT * FROM events
     WHERE guild_id = ?
       AND is_private = 0
       AND status IN ('active','resolved')
       AND (
         (is_recurring = 1 AND (
            EXISTS (
              SELECT 1 FROM event_recurrence_rules r
              WHERE r.event_id = events.id
                AND (
                  r.end_date IS NULL
                  OR date(r.end_date, '+' || ((r.duration_minutes + 1439) / 1440) || ' days') >= ?
                )
                AND r.start_date <= ?
            )
            OR EXISTS (
              SELECT 1 FROM event_occurrence_overrides o
              WHERE o.event_id = events.id
                AND o.is_cancelled = 0
                AND o.override_start_at IS NOT NULL
                AND o.override_start_at <= ?
                AND COALESCE(o.override_end_at, o.override_start_at) >= ?
            )
          ))
         OR (start_at IS NOT NULL AND start_at <= ? AND COALESCE(end_at, start_at) >= ?)
       )
       AND NOT (event_type = 'poll' AND status != 'resolved')`;

  // ONE query, one snapshot, no cursor. Pass-20 review (P20-03).
  //
  // The Pass-19 version paged with a cursor of `(COALESCE(start_at, from), id)`
  // -- and `start_at` is editable. An owner moving an event between two page
  // reads could push it behind the cursor (never selected, and the response
  // still claimed `complete: true`) or across it (selected twice, with the same
  // occurrence id in the output twice). Both were demonstrated.
  //
  // The instinct was to fix the cursor: dedupe by id, snapshot the keys,
  // detect edits and retry. Every one of those adds machinery to machinery that
  // exists to bound a scan -- and this file has now produced a regression in
  // three consecutive passes, each one introduced by the fix for the last, and
  // each one bigger than what it replaced. So the pager is gone instead.
  //
  // Reading the whole bounded candidate set in a single statement is smaller
  // than paging, and the entire mutable-key class stops existing rather than
  // being defended against: there is no second read for an edit to land
  // between. The cap is enforced by asking for one row more than we will use,
  // which is also what makes `complete` exact -- with the full candidate list
  // in hand there is nothing left to guess about, so the flag no longer has to
  // be conservative the way the paged version's did.
  //
  // The total order still matters and is still `id`-broken. Not for paging any
  // more, but because a recurring event has a NULL start_at, so every series in
  // a guild ties at `from` -- and an untied cut means "the soonest hundred" was
  // never a true description of what a mostly-recurring guild got back. It is
  // the same undefined ordering that let a P17-01 fixture pass with its defect
  // present.
  const { results: candidates } = await env.DB.prepare(
    `${CANDIDATE_SQL}
     ORDER BY COALESCE(start_at, ?) ASC, id ASC
     LIMIT ?`,
  )
    .bind(guildId, windowStartDate, windowEndDate, to, from, to, from, from, MAX_CANDIDATES_SCANNED + 1)
    .all<EventRow>();

  // More candidates exist than we are willing to read, so whatever we return
  // cannot be claimed as the whole answer however few of them turn out to be
  // eligible.
  let complete = candidates.length <= MAX_CANDIDATES_SCANNED;
  const scanned = complete ? candidates : candidates.slice(0, MAX_CANDIDATES_SCANNED);

  let budget = MAX_NOTICEBOARD_OCCURRENCES;
  const spend = (n: number): void => {
    // Refuses rather than truncating, the same call lib/freeBusy.ts makes: a
    // silently shortened noticeboard is indistinguishable from a quiet server,
    // and "ask for a shorter window" is recoverable advice. Distinct from the
    // `complete` flag, which covers the case where we stopped looking rather
    // than found too much.
    if (n > budget) throw new NoticeboardTooLargeError();
    budget -= n;
  };

  interface Selected {
    event: EventRow;
    occurrences: { date: string; startAt: number; endAt: number }[];
  }

  // Bulk, once, for the whole snapshot rather than per page. These two are the
  // reason the candidate cap is 500 and not larger: they chunk their id lists,
  // so they cost statements in proportion to it. The package comment that said
  // "three statements per page" was wrong and the Pass-20 reviewer corrected
  // it -- a hundred recurring ids split 80 + 20, so it was five. The
  // statement-count guard in test/pass19.test.ts is what actually holds this
  // inside D1's Free ceiling of 50 for a request, not the arithmetic in a
  // comment.
  const recurringIds = scanned.filter((e) => e.is_recurring).map((e) => e.id);
  const overridesByEvent = await loadOverridesForEvents(env, recurringIds);
  const recurrenceRulesByEvent = await loadRecurrenceRulesForEvents(env, recurringIds);

  const selected: Selected[] = [];
  for (let i = 0; i < scanned.length; i++) {
    const event = scanned[i];
    if (selected.length >= MAX_NOTICEBOARD_EVENTS) {
      // The board is full and candidates remain. Unlike the paged version,
      // which had to assume this, we can see the rest of the list.
      complete = false;
      break;
    }

    if (!event.is_recurring) {
      if (event.start_at == null) continue;
      spend(1);
      selected.push({
        event,
        occurrences: [{ date: '', startAt: event.start_at, endAt: event.end_at ?? event.start_at }],
      });
      continue;
    }

    const expanded = await expandOccurrencesForEvent(
      env,
      event,
      from,
      to,
      overridesByEvent.get(event.id) ?? [],
      recurrenceRulesByEvent.get(event.id),
    );
    // The point of counting here rather than in SQL: a series that expands to
    // nothing costs a candidate slot and no event slot. Before this it cost an
    // event slot and evicted something real -- three separate times, wearing
    // three different hats (P17-07, P18-02, P19-01).
    if (expanded.length === 0) continue;
    spend(expanded.length);
    selected.push({ event, occurrences: expanded });
  }

  if (selected.length === 0) return { occurrences: [], complete };

  const events = selected.map((s) => s.event);
  const eventIds = events.map((e) => e.id);

  // Every invitee of every visible event, in chunked bulk rather than per
  // event. The attendee list is the point of the noticeboard, so this is not
  // optional detail that could be lazily loaded. Loaded once, for the events
  // that survived the scan, rather than once per page -- the scan touches up
  // to five times as many candidates as it keeps, and none of the ones it
  // discards needs an attendee list.
  const invitesByEvent = new Map<string, InviteRow[]>();
  for (const chunk of chunkIds(eventIds)) {
    const { results } = await env.DB.prepare(
      `SELECT ei.event_id, u.id AS user_id, u.username, u.global_name, u.avatar_hash
       FROM event_invites ei JOIN users u ON u.id = ei.user_id
       WHERE ei.event_id IN (${placeholders(chunk.length)})`,
    )
      .bind(...chunk)
      .all<InviteRow>();
    for (const row of results) {
      if (!invitesByEvent.has(row.event_id)) invitesByEvent.set(row.event_id, []);
      invitesByEvent.get(row.event_id)!.push(row);
    }
  }

  // Answers, keyed per occurrence since specs/0014 -- so a recurring series
  // shows who is coming to *that night*, not a series-wide average that would
  // be wrong for every individual date.
  const attendanceByKey = new Map<string, Map<string, AttendanceRow['rsvp_status']>>();
  for (const chunk of chunkIds(eventIds)) {
    const { results } = await env.DB.prepare(
      `SELECT event_id, occurrence_date, user_id, rsvp_status
       FROM event_attendance WHERE event_id IN (${placeholders(chunk.length)})`,
    )
      .bind(...chunk)
      .all<AttendanceRow>();
    for (const row of results) {
      const key = `${row.event_id}::${row.occurrence_date}`;
      if (!attendanceByKey.has(key)) attendanceByKey.set(key, new Map());
      attendanceByKey.get(key)!.set(row.user_id, row.rsvp_status);
    }
  }

  const organizersById = new Map<string, InviteRow>();
  for (const chunk of chunkIds([...new Set(events.map((e) => e.organizer_id))])) {
    const { results } = await env.DB.prepare(
      `SELECT id AS user_id, '' AS event_id, username, global_name, avatar_hash
       FROM users WHERE id IN (${placeholders(chunk.length)})`,
    )
      .bind(...chunk)
      .all<InviteRow>();
    for (const row of results) organizersById.set(row.user_id, row);
  }

  // Decision 1 / attendance.ts's ORGANIZER_UNLESS_DECLINED, which every other
  // read of an occurrence already applies: an organiser who has not answered is
  // running the session, so they are there. Only an explicit decline overturns
  // it -- hence the `??` rather than an unconditional 'accepted'.
  //
  // Without this the board was the one view in the app that called an organiser
  // "no answer" on their own session, while GET /events/:id, myRsvpStatus and
  // the reminder path all called the same person attending. On a board whose
  // entire purpose is "who is going", the disagreement reads as a session
  // nobody has committed to.
  const organiserAnswer = (
    event: EventRow,
    answers: Map<string, AttendanceRow['rsvp_status']> | undefined,
  ): AttendanceRow['rsvp_status'] | null =>
    answers?.get(event.organizer_id) ?? 'accepted';

  const attendeesFor = (event: EventRow, occurrenceDate: string): NoticeboardAttendee[] => {
    const answers = attendanceByKey.get(`${event.id}::${occurrenceDate}`);
    const rows = invitesByEvent.get(event.id) ?? [];
    const list: NoticeboardAttendee[] = rows.map((r) => ({
      userId: r.user_id,
      username: r.username,
      globalName: r.global_name,
      avatarHash: r.avatar_hash,
      rsvpStatus:
        r.user_id === event.organizer_id
          ? organiserAnswer(event, answers)
          : (answers?.get(r.user_id) ?? null),
    }));
    // The organiser belongs on the list whether or not they hold an invite
    // row. Since v0.4.1 they usually do (IDEAS item 26), but an event created
    // before that backfill -- or one whose organiser was never an invitee --
    // would otherwise show a session with nobody running it.
    if (!list.some((a) => a.userId === event.organizer_id)) {
      const org = organizersById.get(event.organizer_id);
      if (org) {
        list.unshift({
          userId: org.user_id,
          username: org.username,
          globalName: org.global_name,
          avatarHash: org.avatar_hash,
          rsvpStatus: organiserAnswer(event, answers),
        });
      }
    }
    return list;
  };

  const out: NoticeboardOccurrence[] = [];
  for (const { event, occurrences } of selected) {
    for (const occ of occurrences) {
      out.push({
        occurrenceId: event.is_recurring ? `${event.id}::${occ.date}` : event.id,
        eventId: event.id,
        title: event.title,
        game: event.game,
        startAt: occ.startAt,
        endAt: occ.endAt,
        isRecurring: !!event.is_recurring,
        organizerId: event.organizer_id,
        attendees: attendeesFor(event, occ.date),
      });
    }
  }

  out.sort((a, b) => a.startAt - b.startAt);
  return { occurrences: out, complete };
}
