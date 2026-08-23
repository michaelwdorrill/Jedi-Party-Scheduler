import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { DateTime } from 'luxon';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { useGuild } from '../auth/GuildContext';
import { formatTimeRange, fullWindow, monthWindow } from '../lib/datetime';
import { getView, setView, type CalendarView } from '../lib/view';
import MonthCalendarGrid from '../components/MonthCalendarGrid';
import AgendaList from '../components/AgendaList';
import EventChip from '../components/EventChip';
import { Button, Card, EmptyState, Loading, buttonClass, cardClass, controlClass } from '../components/ui';
import type { EventOccurrence } from '../types';

// The merged landing page (idea 20, spec 0009).
//
// The Dashboard and the Calendar were two tabs answering one question. Since
// v0.3 they have also called the same endpoint -- the Dashboard asked for
// now→+60d and took the first eight, the Calendar asked for the visible range
// -- which is what made this a pure layout change rather than a data one.
//
// One fetch serves both views. The spec assumed the "anchored to now" rail
// would cost a second, smaller query; it does not, because `fullWindow` already
// covers this month and next, and idea 22's two-month ceiling means there is no
// further data to ask for. The rail is that same list filtered to what is still
// ahead.

type Filter = 'all' | 'personal' | 'games' | { guildId: string };

function matchesFilter(occ: EventOccurrence, filter: Filter): boolean {
  if (filter === 'all') return true;
  if (filter === 'personal') return occ.isPersonal;
  if (filter === 'games') return !occ.isPersonal;
  return occ.guildId === filter.guildId;
}

export default function HomePage() {
  const { user } = useAuth();
  const { guilds } = useGuild();
  const navigate = useNavigate();
  const [view, setViewState] = useState<CalendarView>(getView);
  const [tab, setTab] = useState<0 | 1>(0);
  const [filter, setFilter] = useState<Filter>('all');
  const [occurrences, setOccurrences] = useState<EventOccurrence[]>([]);
  const [loading, setLoading] = useState(true);
  const zone = user?.timezone ?? 'America/New_York';

  useEffect(() => {
    setLoading(true);
    const { from, to } = fullWindow(zone);
    api
      .get<EventOccurrence[]>(`/me/events?from=${from.toMillis()}&to=${to.toMillis()}`)
      .then(setOccurrences)
      .finally(() => setLoading(false));
  }, [zone]);

  const visible = useMemo(
    () => occurrences.filter((occ) => matchesFilter(occ, filter)),
    [occurrences, filter],
  );

  // The rail is anchored to now rather than to the month on screen, so paging
  // to next month does not empty it. Cancelled sessions are dropped: the rail
  // answers "what is coming up", and a cancelled one is not.
  const upNext = useMemo(() => {
    const now = Date.now();
    return visible
      .filter((o) => o.status !== 'cancelled' && o.startAt != null && o.startAt >= now)
      .sort((a, b) => a.startAt! - b.startAt!)
      .slice(0, 6);
  }, [visible]);

  const monthStart = monthWindow(tab, zone).start;

  const guildsWithEvents = useMemo(() => {
    const present = new Set(occurrences.map((o) => o.guildId).filter(Boolean));
    return guilds.filter((g) => present.has(g.id));
  }, [occurrences, guilds]);

  const filterValue = typeof filter === 'object' ? filter.guildId : filter;

  const noServers = guilds.length === 0;
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

          {view === 'month' && (
            <div className="flex overflow-hidden rounded-md border border-edge-strong">
              {(['This month', 'Next month'] as const).map((label, i) => (
                <button
                  key={label}
                  type="button"
                  aria-pressed={tab === i}
                  onClick={() => setTab(i as 0 | 1)}
                  className={`px-3 py-1.5 font-display text-sm uppercase tracking-wide ${
                    tab === i ? 'bg-raised-hi text-ink' : 'text-ink-dim hover:bg-raised'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          )}

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

      {loading ? (
        <Loading />
      ) : view === 'agenda' ? (
        <Card padding="md">
          {upNext.length === 0 ? (
            <EmptyState
              title="Nothing on the horizon"
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

            {upNext.length === 0 ? (
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
