import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { DateTime } from 'luxon';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { useGuild } from '../auth/GuildContext';
import { fullWindow, monthWindow } from '../lib/datetime';
import MonthCalendarGrid from '../components/MonthCalendarGrid';
import type { EventOccurrence } from '../types';
import { Button, EmptyState, Loading, buttonClass, controlClass } from '../components/ui';

// Calendar-first (docs/specs/0006). This loads GET /me/events -- everything
// across every server you're in, plus your own personal time -- rather than
// one server's calendar. A server is a *filter* here, not a mode: the default
// is everything, and narrowing is something you opt into.
//
// The previous version early-returned when no guild was selected, which is
// what made "just show me my calendar" impossible to express at all.

type Filter = 'all' | 'personal' | 'games' | { guildId: string };

function matchesFilter(occ: EventOccurrence, filter: Filter): boolean {
  if (filter === 'all') return true;
  if (filter === 'personal') return occ.isPersonal;
  if (filter === 'games') return !occ.isPersonal;
  return occ.guildId === filter.guildId;
}

export default function CalendarPage() {
  const { user } = useAuth();
  const { guilds } = useGuild();
  const navigate = useNavigate();
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

  const monthStart = monthWindow(tab, zone).start;

  // Only offer a per-server filter for servers that actually have something
  // on this calendar -- a dropdown listing servers with nothing in them is
  // just a way to reach an empty view.
  const guildsWithEvents = useMemo(() => {
    const present = new Set(occurrences.map((o) => o.guildId).filter(Boolean));
    return guilds.filter((g) => present.has(g.id));
  }, [occurrences, guilds]);

  const filterValue = typeof filter === 'object' ? filter.guildId : filter;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex gap-1 rounded-md bg-surface p-1">
            <button
              onClick={() => setTab(0)}
              className={`rounded px-3 py-1 font-display text-sm uppercase tracking-wide ${tab === 0 ? 'bg-accent text-on-accent' : 'text-ink-dim'}`}
            >
              This Month
            </button>
            <button
              onClick={() => setTab(1)}
              className={`rounded px-3 py-1 font-display text-sm uppercase tracking-wide ${tab === 1 ? 'bg-accent text-on-accent' : 'text-ink-dim'}`}
            >
              Next Month
            </button>
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

        <button
          onClick={() => navigate('/events/new')}
          className={buttonClass()}
        >
          + New Event
        </button>
      </div>

      {loading ? (
        <Loading />
      ) : (
        <>
          <MonthCalendarGrid
            monthStart={monthStart}
            occurrences={visible}
            zone={zone}
            // No guild in the query string any more: the New Event form has
            // carried its own server picker since Phase 0 (idea 7), so the
            // calendar no longer has to decide which server you meant.
            onDayClick={(day: DateTime) => navigate(`/events/new?date=${day.toISODate()}`)}
          />
          {occurrences.length === 0 && (
            <EmptyState
              title="Nothing on the horizon"
              action={
                guilds.length > 0 ? (
                  <Button onClick={() => navigate('/events/new')}>+ New Event</Button>
                ) : undefined
              }
            >
              {guilds.length === 0
                ? "You don't share any allow-listed servers with this app yet. Ask the owner to add your server."
                : 'No sessions scheduled in this window.'}
            </EmptyState>
          )}
        </>
      )}
    </div>
  );
}
