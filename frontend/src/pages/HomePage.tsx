import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { DateTime } from 'luxon';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { useGuild } from '../auth/GuildContext';
import { formatTimeRange, gridWindow, horizonWindow, monthWindow } from '../lib/datetime';
import { getView, setView, type CalendarView } from '../lib/view';
import { useAsync } from '../lib/async';
import MonthCalendarGrid from '../components/MonthCalendarGrid';
import AgendaList from '../components/AgendaList';
import EventChip from '../components/EventChip';
import {
  Button,
  Card,
  EmptyState,
  ErrorState,
  InlineError,
  Loading,
  buttonClass,
  cardClass,
  controlClass,
} from '../components/ui';
import type { EventOccurrence } from '../types';

// The merged landing page (idea 20, spec 0009).
//
// The Dashboard and the Calendar were two tabs answering one question. Since
// v0.3 they have also called the same endpoint -- the Dashboard asked for
// now→+60d and took the first eight, the Calendar asked for the visible range
// -- which is what made this a pure layout change rather than a data one.
//
// It used to be one fetch for both views. Spec 0009 assumed the "anchored to
// now" rail would cost a second, smaller query, and it did not -- because
// `fullWindow` covered this month and next, and idea 22's two-month ceiling
// meant there was no further data to ask for.
//
// Removing that ceiling makes the spec's prediction come true. The grid can
// now be any month, and a grid showing next March has nothing to say about
// what is on this week, so the rail gets the second query 0009 expected. The
// two are deliberately independent: paging the calendar does not re-fetch the
// horizon, and a horizon that fails does not take the calendar down with it.

type Filter = 'all' | 'personal' | 'games' | { guildId: string };

function matchesFilter(occ: EventOccurrence, filter: Filter): boolean {
  if (filter === 'all') return true;
  if (filter === 'personal') return occ.isPersonal;
  if (filter === 'games') return !occ.isPersonal;
  return occ.guildId === filter.guildId;
}

export default function HomePage() {
  const { user } = useAuth();
  const { guilds, error: guildsError, refreshGuilds } = useGuild();
  const navigate = useNavigate();
  const [view, setViewState] = useState<CalendarView>(getView);
  // Months from now: 0 is this month, negative is the past. Unbounded in both
  // directions (IDEAS item 22).
  const [monthOffset, setMonthOffset] = useState(0);
  const [filter, setFilter] = useState<Filter>('all');
  const zone = user?.timezone ?? 'America/New_York';

  const monthStart = useMemo(() => monthWindow(monthOffset, zone).start, [monthOffset, zone]);

  // This call is the one idea 24 was found on: with no `.catch`, a 404 from a
  // Worker without `/me/events` rendered as "nothing scheduled".
  //
  // Re-runs on every month change. useAsync guards against a slow earlier
  // request landing after a newer one, which matters far more now than it did
  // when there were two tabs: holding the next-month button issues a request
  // per click and they are not ordered.
  const {
    data,
    error,
    loading,
    reload,
  } = useAsync<EventOccurrence[]>(() => {
    const { from, to } = gridWindow(monthStart);
    return api.get<EventOccurrence[]>(`/me/events?from=${from.toMillis()}&to=${to.toMillis()}`);
  }, [zone, monthStart.toMillis()]);

  // The rail's own data, anchored to now and unaffected by paging.
  const horizon = useAsync<EventOccurrence[]>(() => {
    const { from, to } = horizonWindow(zone);
    return api.get<EventOccurrence[]>(`/me/events?from=${from.toMillis()}&to=${to.toMillis()}`);
  }, [zone]);

  const occurrences = useMemo(() => data ?? [], [data]);

  const visible = useMemo(
    () => occurrences.filter((occ) => matchesFilter(occ, filter)),
    [occurrences, filter],
  );

  // The rail is anchored to now rather than to the month on screen, so paging
  // to December does not empty it. Cancelled sessions are dropped: the rail
  // answers "what is coming up", and a cancelled one is not.
  const upNext = useMemo(() => {
    const now = Date.now();
    return (horizon.data ?? [])
      .filter((occ) => matchesFilter(occ, filter))
      .filter((o) => o.status !== 'cancelled' && o.startAt != null && o.startAt >= now)
      .sort((a, b) => a.startAt! - b.startAt!)
      .slice(0, 6);
  }, [horizon.data, filter]);

  // Both lists, so paging to a quiet month does not make servers disappear
  // from the filter -- which would look like losing access to them.
  const guildsWithEvents = useMemo(() => {
    const present = new Set(
      [...occurrences, ...(horizon.data ?? [])].map((o) => o.guildId).filter(Boolean),
    );
    return guilds.filter((g) => present.has(g.id));
  }, [occurrences, horizon.data, guilds]);

  const filterValue = typeof filter === 'object' ? filter.guildId : filter;

  // `guilds` being empty means one of two very different things, and only one
  // of them is safe to say out loud: telling someone they share no allow-listed
  // servers, when really the request for that list failed, is a false statement
  // about their standing with the app (idea 24).
  const noServers = guilds.length === 0 && !guildsError;
  const emptyBody = noServers
    ? "You don't share any allow-listed Discord servers with this app yet. Ask the owner to add your server."
    : 'No sessions scheduled in this window.';

  function choose(next: CalendarView) {
    setView(next);
    setViewState(next);
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex overflow-hidden rounded-md border border-edge-strong">
            {(
              [
                ['month', 'Month'],
                ['agenda', 'Agenda'],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                aria-pressed={view === value}
                onClick={() => choose(value)}
                className={`px-3 py-1.5 font-display text-sm uppercase tracking-wide ${
                  view === value ? 'bg-accent text-on-accent' : 'text-ink-dim hover:bg-raised'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {/* Any month, in either direction (IDEAS item 22). The pager applies
              to both views: the agenda lists whatever month is on screen, so
              a control that only appeared on the grid would leave the agenda
              stuck on this month with no way to say so. */}
          <div className="flex items-center gap-1">
            <div className="flex overflow-hidden rounded-md border border-edge-strong">
              <button
                type="button"
                aria-label="Previous month"
                onClick={() => setMonthOffset((m) => m - 1)}
                className="px-3 py-1.5 font-display text-sm text-ink-dim hover:bg-raised"
              >
                ‹
              </button>
              {/* aria-live so a screen reader hears the month change: the
                  buttons keep focus, and without this the only thing that
                  moved is silent. */}
              <span
                aria-live="polite"
                className="min-w-[9.5rem] px-3 py-1.5 text-center font-display text-sm uppercase tracking-wide text-ink"
              >
                {monthStart.toFormat('LLLL yyyy')}
              </span>
              <button
                type="button"
                aria-label="Next month"
                onClick={() => setMonthOffset((m) => m + 1)}
                className="px-3 py-1.5 font-display text-sm text-ink-dim hover:bg-raised"
              >
                ›
              </button>
            </div>
            {/* Only when it would do something. A permanent "Today" that is
                already today is a control that lies about being available. */}
            {monthOffset !== 0 && (
              <button
                type="button"
                onClick={() => setMonthOffset(0)}
                className="rounded-md border border-edge-strong px-3 py-1.5 font-display text-sm uppercase tracking-wide text-ink-dim hover:bg-raised"
              >
                Today
              </button>
            )}
          </div>

          <select
            value={filterValue}
            onChange={(e) => {
              const v = e.target.value;
              setFilter(v === 'all' || v === 'personal' || v === 'games' ? v : { guildId: v });
            }}
            className={controlClass('md')}
          >
            <option value="all">Everything</option>
            <option value="games">Game sessions only</option>
            <option value="personal">My personal time only</option>
            {guildsWithEvents.length > 0 && (
              <optgroup label="One server">
                {guildsWithEvents.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
        </div>

        <div className="flex gap-2">
          <Button to="/personal/new" variant="secondary">
            + Personal time
          </Button>
          <Button to="/events/new">+ New Event</Button>
        </div>
      </div>

      {/* A failed server list does not stop the calendar drawing -- the events
          are already here and carry their own guild ids. It only means the
          filter and the labels are incomplete, which is worth saying without
          taking the page away. */}
      {guildsError && !error && (
        <InlineError
          message={`Couldn't load your server list, so the filter may be incomplete. ${guildsError}`}
          onRetry={() => void refreshGuilds()}
        />
      )}

      {loading ? (
        <Loading />
      ) : error ? (
        // Before the empty state, never instead of it: an empty calendar and a
        // calendar that failed to load are different facts about the day.
        <Card padding="md">
          <ErrorState message={error} onRetry={reload} />
        </Card>
      ) : view === 'agenda' ? (
        <Card padding="md">
          {visible.length === 0 ? (
            <EmptyState
              title={`Nothing in ${monthStart.toFormat('LLLL')}`}
              action={!noServers ? <Button to="/events/new">+ New Event</Button> : undefined}
            >
              {emptyBody}
            </EmptyState>
          ) : (
            <AgendaList occurrences={visible} zone={zone} />
          )}
        </Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
          <MonthCalendarGrid
            monthStart={monthStart}
            occurrences={visible}
            zone={zone}
            onDayClick={(day: DateTime) => navigate(`/events/new?date=${day.toISODate()}`)}
          />

          <aside className={cardClass('md')}>
            <h2 className="mb-3 flex items-baseline gap-2 text-base">
              On the horizon
              <span className="font-mono text-[10px] font-normal uppercase tracking-widest text-faint">
                from today
              </span>
            </h2>

            {/* Idea 24's rule applied to the second query: a rail that failed
                to load and a horizon with nothing on it are different facts,
                and only one of them should be said out loud. The calendar
                beside it is unaffected either way. */}
            {horizon.error ? (
              <InlineError message={horizon.error} onRetry={horizon.reload} />
            ) : horizon.loading ? (
              <Loading />
            ) : upNext.length === 0 ? (
              <EmptyState
                title="Nothing on the horizon"
                className="py-2"
                action={
                  !noServers ? (
                    <a href="/events/new" className={buttonClass('secondary', 'md')}>
                      + New Event
                    </a>
                  ) : undefined
                }
              >
                {emptyBody}
              </EmptyState>
            ) : (
              <ul className="space-y-2">
                {upNext.map((occ) => (
                  <li key={occ.occurrenceId} className="space-y-1">
                    <div className="font-mono text-[10px] uppercase tracking-widest text-faint">
                      {occ.startAt && occ.endAt
                        ? formatTimeRange(occ.startAt, occ.endAt, zone)
                        : 'Poll open'}
                    </div>
                    <EventChip occurrence={occ} zone={zone} />
                  </li>
                ))}
              </ul>
            )}
          </aside>
        </div>
      )}
    </div>
  );
}
