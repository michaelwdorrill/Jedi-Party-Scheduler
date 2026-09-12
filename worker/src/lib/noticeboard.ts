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

// How many events one noticeboard request will read. A guild is capped at
// MAX_ACTIVE_EVENTS_PER_GUILD (300) active events, so this is a real cut, and
// it is ordered by start time -- the soonest hundred is the useful hundred.
const MAX_NOTICEBOARD_EVENTS = 100;

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
): Promise<NoticeboardOccurrence[]> {
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
  // Pass-17 review (P17-07). `is_recurring = 1` used to admit EVERY active
  // series with no reference to the window at all, and a recurring event has a
  // NULL start_at, so `ORDER BY COALESCE(start_at, from)` sorts them all to the
  // front. The hundred-event cut was then applied before anything expanded.
  //
  // A hundred series that finished last month therefore filled the page,
  // expanded to nothing, and left an event happening tomorrow outside it --
  // measured as a noticeboard returning ZERO occurrences while the same user's
  // personal calendar showed the event. The later expanded-occurrence ceiling
  // cannot catch that, because the event was excluded before expansion, and
  // the response carries no cursor or truncation flag, so the frontend renders
  // it as "nothing scheduled".
  //
  // What this clause does is narrow, and the limit of it matters as much as
  // the fix: a series is excluded only when its RULE cannot overlap the
  // window -- it ended before the window opened, or begins after it closes.
  // That is provable from stored dates and closes the demonstrated case.
  //
  // What it does NOT do is establish completeness. A hundred *currently
  // active* series with no occurrence in a narrow window still fill the page,
  // because deciding that needs the expander, not SQL. Paging bounded
  // candidates until enough eligible results are found, and signalling
  // overflow when the budget cannot prove completeness, is the rest of the
  // fix; IDEAS item 79 carries it. Raising MAX_NOTICEBOARD_EVENTS is not the
  // fix -- it moves the threshold and weakens the bound the limit exists for.
  //
  // The dates are compared as ISO text, which sorts chronologically, and both
  // bounds are widened by a day because the rule's dates are local to the
  // event's timezone while the window is epoch milliseconds. Widening can only
  // admit a series that turns out to have nothing in range, never exclude one
  // that does.
  const windowStartDate = new Date(from - DAY_MS).toISOString().slice(0, 10);
  const windowEndDate = new Date(to + DAY_MS).toISOString().slice(0, 10);
  const { results: events } = await env.DB.prepare(
    `SELECT * FROM events
     WHERE guild_id = ?
       AND is_private = 0
       AND status IN ('active','resolved')
       AND (
         (is_recurring = 1 AND EXISTS (
            SELECT 1 FROM event_recurrence_rules r
            WHERE r.event_id = events.id
              AND (r.end_date IS NULL OR r.end_date >= ?)
              AND r.start_date <= ?
          ))
         OR (start_at IS NOT NULL AND start_at <= ? AND COALESCE(end_at, start_at) >= ?)
       )
       AND NOT (event_type = 'poll' AND status != 'resolved')
     ORDER BY COALESCE(start_at, ?) ASC
     LIMIT ?`,
  )
    .bind(guildId, windowStartDate, windowEndDate, to, from, from, MAX_NOTICEBOARD_EVENTS)
    .all<EventRow>();

  if (events.length === 0) return [];

  const eventIds = events.map((e) => e.id);
  const recurringIds = events.filter((e) => e.is_recurring).map((e) => e.id);
  const overridesByEvent = await loadOverridesForEvents(env, recurringIds);
  const recurrenceRulesByEvent = await loadRecurrenceRulesForEvents(env, recurringIds);

  // Every invitee of every visible event, in chunked bulk rather than per
  // event. The attendee list is the point of the noticeboard, so this is not
  // optional detail that could be lazily loaded.
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

  let budget = MAX_NOTICEBOARD_OCCURRENCES;
  const spend = (n: number): void => {
    // Refuses rather than truncating, the same call lib/freeBusy.ts makes: a
    // silently shortened noticeboard is indistinguishable from a quiet server,
    // and "ask for a shorter window" is recoverable advice.
    if (n > budget) throw new NoticeboardTooLargeError();
    budget -= n;
  };

  const out: NoticeboardOccurrence[] = [];

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

  for (const event of events) {
    if (!event.is_recurring) {
      if (event.start_at == null) continue;
      spend(1);
      out.push({
        occurrenceId: event.id,
        eventId: event.id,
        title: event.title,
        game: event.game,
        startAt: event.start_at,
        endAt: event.end_at ?? event.start_at,
        isRecurring: false,
        organizerId: event.organizer_id,
        attendees: attendeesFor(event, ''),
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
    spend(expanded.length);
    for (const occ of expanded) {
      out.push({
        occurrenceId: `${event.id}::${occ.date}`,
        eventId: event.id,
        title: event.title,
        game: event.game,
        startAt: occ.startAt,
        endAt: occ.endAt,
        isRecurring: true,
        organizerId: event.organizer_id,
        attendees: attendeesFor(event, occ.date),
      });
    }
  }

  out.sort((a, b) => a.startAt - b.startAt);
  return out;
}
