import type { Env } from '../env';
import { MEMBERSHIP_GRACE_MS } from './db';
import type { EventRow } from './events';
import {
  loadConfirmedOptionsForEvents,
  loadPendingOptionsForEvents,
  loadMyAttendanceForEvents,
  loadOverridesForEvents,
  loadPrimaryGroupForEvents,
  mapOccurrence,
} from './events';
import { expandPersonalOccurrences } from './personalEvents';
import { expandOccurrencesForEvent, loadRecurrenceRulesForEvents } from './recurrence';

// Building one person's calendar, for a date range.
//
// Extracted from GET /guilds/:guildId/events so that GET /me/events can be
// the same code with the guild filter removed (docs/specs/0006). The logic is
// not trivial -- resolved and unresolved polls, multi-winner options,
// recurring expansion and overrides all land here -- and having two copies of
// it drift apart is exactly the kind of bug that only shows up as "the
// calendar disagrees with itself depending on which view you opened".
//
// The important scaling property, which is counterintuitive: the cross-guild
// query is *cheaper* than the per-guild one, not more expensive. Both are
// bounded by what the caller is personally attached to -- events they
// organize or are invited to -- rather than by how much exists in a guild.
// The per-guild version simply adds a filter on top of that. What would be
// expensive is "every event in every guild I'm in", which is a different
// feature (browsing a server's schedule) and keeps its own bounds.

export interface CalendarScope {
  // Restrict to a single guild. Omitted for the cross-guild personal
  // calendar, which spans every guild the caller is still an active member of.
  guildId?: string;
  // Whether to fold in the caller's own personal (non-guild) time blocks.
  // Always their own -- never anyone else's, under any scope.
  includePersonal?: boolean;
}

// The guild each event belongs to, so a cross-guild calendar can label and
// colour by server. Loaded from the events themselves rather than a second
// membership query: the event rows already carry guild_id, and the WHERE
// clause has already established the caller may see them.
async function loadGuildNames(env: Env, guildIds: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(guildIds)];
  if (unique.length === 0) return new Map();
  const { results } = await env.DB.prepare(
    `SELECT id, name FROM guilds WHERE id IN (${unique.map(() => '?').join(',')})`,
  )
    .bind(...unique)
    .all<{ id: string; name: string }>();
  return new Map(results.map((g) => [g.id, g.name]));
}

export async function buildCalendarOccurrences(
  env: Env,
  userId: string,
  from: number,
  to: number,
  scope: CalendarScope = {},
) {
  // Only events the user is the organizer of, or is individually/group-invited
  // to -- and only ones that could possibly land in the requested window.
  // Without that second filter this loaded every event the user had ever been
  // part of on every calendar view, then discarded almost all of them after
  // expansion, so the cost of viewing one month grew with the guild's entire
  // history. Recurring events are unfiltered because whether they fall in the
  // window isn't a property of a stored timestamp -- a series has to be
  // expanded to find out.
  //
  // Polls used to get the same unconditional pass as recurring events, on
  // the theory that an open poll's eventual date is unknown ahead of time.
  // That's true for a poll that hasn't resolved yet, but a poll that HAS
  // resolved (single_winner) already has a real start_at and belongs under
  // the ordinary date-range branch below, not a blanket "load every poll
  // ever created" exemption -- a guild's entire history of old, resolved,
  // and cancelled polls was otherwise reloaded and discarded on every single
  // calendar view, forever, regardless of how old they were. So:
  //   - a still-open (non-multi_winner) poll is included only if its
  //     deadline actually falls in the requested window;
  //   - a multi_winner poll is included only if it's still open, or has a
  //     confirmed day landing in the window (`mw` below); and
  //   - a resolved single_winner poll falls through to the ordinary
  //     start_at-range branch, exactly like a fixed-time event.
  //
  // The guild predicate is the only difference between the two callers. With
  // a guildId the caller has already been authorized against that one guild.
  // Without one, the join to user_guild_membership/guilds is what keeps the
  // result to servers the caller is *still* an active member of -- leaving a
  // server has to remove its events from your calendar, and the same
  // MEMBERSHIP_GRACE_MS freshness bound the cron's recipient queries use
  // applies here rather than trusting a row of unbounded age.
  const scoped = scope.guildId
    ? { sql: 'e.guild_id = ?', binds: [scope.guildId] as unknown[] }
    : {
        sql: `EXISTS (
                SELECT 1 FROM user_guild_membership m
                JOIN guilds g ON g.id = m.guild_id AND g.is_active = 1
                WHERE m.guild_id = e.guild_id AND m.user_id = ? AND m.is_member = 1 AND m.verified_at >= ?
              )`,
        binds: [userId, Date.now() - MEMBERSHIP_GRACE_MS] as unknown[],
      };

  const { results: events } = await env.DB.prepare(
    `SELECT DISTINCT e.* FROM events e
     LEFT JOIN event_invites i ON i.event_id = e.id AND i.user_id = ?
     LEFT JOIN event_poll_options mw
       ON mw.event_id = e.id AND mw.confirmed_at IS NOT NULL AND mw.start_at <= ? AND mw.end_at >= ?
     LEFT JOIN event_poll_options pend
       ON pend.event_id = e.id AND pend.confirmed_at IS NULL AND pend.start_at <= ? AND pend.end_at >= ?
     WHERE ${scoped.sql} AND (e.organizer_id = ? OR i.user_id IS NOT NULL)
       AND (
         -- Only *active* recurring series. A cancelled series has no
         -- occurrences to show, but this branch used to admit it before any
         -- status check, so every cancelled recurring event a guild had ever
         -- created was reloaded and re-expanded on every calendar view until
         -- the 90-day purge eventually reached it -- and cancelled rows are
         -- exempt from the active-event quota, so they could be created far
         -- faster than they were purged.
         (e.is_recurring = 1 AND e.status = 'active')
         OR (e.event_type = 'poll' AND e.poll_resolution_mode = 'multi_winner' AND (e.status = 'active' OR mw.id IS NOT NULL))
         OR (
           e.event_type = 'poll' AND e.poll_resolution_mode != 'multi_winner' AND e.status != 'resolved'
           AND e.poll_deadline_at IS NOT NULL AND e.poll_deadline_at BETWEEN ? AND ?
         )
         -- A poll is also worth loading when the days it is *proposing* fall
         -- in range, not only when its deadline does (idea 41). Without this
         -- an unresolved poll appeared on the calendar once, on the day
         -- voting closed, and the candidate days -- the entire content of the
         -- poll -- appeared nowhere at all.
         OR (e.event_type = 'poll' AND e.status = 'active' AND pend.id IS NOT NULL)
         OR (e.start_at IS NOT NULL AND e.start_at <= ? AND COALESCE(e.end_at, e.start_at) >= ?)
       )`,
  )
    .bind(userId, to, from, to, from, ...scoped.binds, userId, from, to, to, from)
    .all<EventRow>();

  const eventIds = events.map((e) => e.id);
  const overridesByEvent = await loadOverridesForEvents(env, eventIds);
  const attendanceByEvent = await loadMyAttendanceForEvents(env, eventIds, userId);
  const groupByEvent = await loadPrimaryGroupForEvents(env, eventIds);
  const guildNames = await loadGuildNames(env, events.map((e) => e.guild_id));
  // Both bulk-loaded once for the whole visible list rather than once per
  // recurring event / per multi-winner poll -- previously the two largest
  // contributors to this route's query count scaling with how many events a
  // user could see, instead of staying roughly fixed per request.
  const recurrenceRulesByEvent = await loadRecurrenceRulesForEvents(
    env,
    events.filter((e) => e.is_recurring).map((e) => e.id),
  );
  const confirmedOptionsByEvent = await loadConfirmedOptionsForEvents(
    env,
    events.filter((e) => e.event_type === 'poll' && e.poll_resolution_mode === 'multi_winner').map((e) => e.id),
  );
  // The candidate days of every still-open poll, so they can be drawn as
  // provisional (idea 41). One bulk query for the whole visible list, same
  // shape as the confirmed loader above and for the same reason.
  const pendingOptionsByEvent = await loadPendingOptionsForEvents(
    env,
    events.filter((e) => e.event_type === 'poll' && e.status === 'active').map((e) => e.id),
    from,
    to,
  );

  // How many candidate days one poll may contribute to the calendar.
  // MAX_POLL_OPTIONS is 20 and a month cell shows three chips before
  // collapsing to "+N more", so an unbounded poll could bury a month of real
  // events under its own maybes. The soonest ones are the ones worth seeing.
  const MAX_PROVISIONAL_PER_POLL = 6;

  const withGuild = (event: EventRow, occ: ReturnType<typeof mapOccurrence>) => ({
    ...occ,
    guildId: event.guild_id,
    guildName: guildNames.get(event.guild_id) ?? null,
  });

  const occurrences = [];
  for (const event of events) {
    // Every branch below except the recurring-expansion one has exactly one
    // occurrence, keyed '' (specs/0014's convention -- a poll's candidates
    // and deadline chip, and a non-recurring event, are all "the whole
    // event" as far as attendance is concerned). The recurring branch looks
    // up its own key per occurrence instead of reusing this.
    const rsvp = attendanceByEvent.get(`${event.id}::`) ?? null;
    const group = groupByEvent.get(event.id) ?? null;

    // Candidate days of a poll that has not settled. Emitted for every open
    // poll regardless of resolution mode, before the mode-specific branches
    // below, since "these are the days on offer" means the same thing for
    // both.
    if (event.event_type === 'poll' && event.status === 'active') {
      for (const opt of (pendingOptionsByEvent.get(event.id) ?? []).slice(0, MAX_PROVISIONAL_PER_POLL)) {
        occurrences.push({
          ...withGuild(
            event,
            mapOccurrence(event, `${event.id}::pending:${opt.id}`, opt.start_at, opt.end_at, rsvp, group),
          ),
          isProvisional: true,
        });
      }
    }

    if (event.event_type === 'poll' && event.poll_resolution_mode === 'multi_winner') {
      // Each independently-confirmed day is its own occurrence, and stays on
      // the calendar even after the parent poll stops accepting new votes.
      for (const opt of confirmedOptionsByEvent.get(event.id) ?? []) {
        if (opt.start_at <= to && opt.end_at >= from) {
          occurrences.push(
            withGuild(event, mapOccurrence(event, `${event.id}::opt:${opt.id}`, opt.start_at, opt.end_at, rsvp, group)),
          );
        }
      }
      if (event.status === 'active' && event.poll_deadline_at && event.poll_deadline_at >= from && event.poll_deadline_at <= to) {
        occurrences.push(withGuild(event, mapOccurrence(event, event.id, null, null, rsvp, group)));
      }
      continue;
    }
    if (event.event_type === 'poll' && event.status !== 'resolved') {
      // Unresolved polls show once, at the poll deadline, not per-occurrence.
      if (event.poll_deadline_at && event.poll_deadline_at >= from && event.poll_deadline_at <= to) {
        occurrences.push(withGuild(event, mapOccurrence(event, event.id, null, null, rsvp, group)));
      }
      continue;
    }
    if (!event.is_recurring) {
      if (event.start_at && event.start_at <= to && (event.end_at ?? event.start_at) >= from) {
        occurrences.push(withGuild(event, mapOccurrence(event, event.id, event.start_at, event.end_at, rsvp, group)));
      }
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
    for (const occ of expanded) {
      const occRsvp = attendanceByEvent.get(`${event.id}::${occ.date}`) ?? null;
      occurrences.push(
        withGuild(event, mapOccurrence(event, `${event.id}::${occ.date}`, occ.startAt, occ.endAt, occRsvp, group)),
      );
    }
  }

  // The caller's own personal events ride along -- they aren't guild-scoped,
  // but the point of them is to see your real availability next to your
  // gaming schedule. Never returned for anyone but their owner.
  if (scope.includePersonal !== false) {
    for (const occ of await expandPersonalOccurrences(env, userId, from, to)) {
      occurrences.push({
        occurrenceId: `personal:${occ.occurrenceId}`,
        eventId: occ.event.id,
        title: occ.event.title,
        description: occ.event.description,
        game: null,
        eventType: 'single' as const,
        status: occ.event.status,
        timezone: occ.event.timezone,
        startAt: occ.startAt,
        endAt: occ.endAt,
        isRecurring: !!occ.event.is_recurring,
        isPersonal: true,
        organizerId: occ.event.user_id,
        myRsvpStatus: null,
        pollDeadlineAt: null,
        groupId: null,
        guildId: null,
        guildName: null,
      });
    }
  }

  return occurrences;
}
