import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { DateTime } from 'luxon';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { useGuild } from '../auth/GuildContext';
import { fullWindow, monthWindow } from '../lib/datetime';
import MonthCalendarGrid from '../components/MonthCalendarGrid';
import type { EventOccurrence } from '../types';

export default function CalendarPage() {
  const { user } = useAuth();
  const { selectedGuildId } = useGuild();
  const navigate = useNavigate();
  const [tab, setTab] = useState<0 | 1>(0);
  const [occurrences, setOccurrences] = useState<EventOccurrence[]>([]);
  const [loading, setLoading] = useState(true);
  const zone = user?.timezone ?? 'America/New_York';

  useEffect(() => {
    if (!selectedGuildId) return;
    setLoading(true);
    const { from, to } = fullWindow(zone);
    api
      .get<EventOccurrence[]>(
        `/guilds/${selectedGuildId}/events?from=${from.toMillis()}&to=${to.toMillis()}`,
      )
      .then(setOccurrences)
      .finally(() => setLoading(false));
  }, [selectedGuildId, zone]);

  if (!selectedGuildId) {
    return <p className="text-slate-400">You don't share any allow-listed servers yet.</p>;
  }

  const monthStart = monthWindow(tab, zone).start;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex gap-1 rounded-md bg-slate-900 p-1">
          <button
            onClick={() => setTab(0)}
            className={`rounded px-3 py-1 text-sm ${tab === 0 ? 'bg-indigo-600 text-white' : 'text-slate-300'}`}
          >
            This Month
          </button>
          <button
            onClick={() => setTab(1)}
            className={`rounded px-3 py-1 text-sm ${tab === 1 ? 'bg-indigo-600 text-white' : 'text-slate-300'}`}
          >
            Next Month
          </button>
        </div>
        <button
          onClick={() => navigate(`/events/new?guild=${selectedGuildId}`)}
          className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-500"
        >
          + New Event
        </button>
      </div>

      {loading ? (
        <p className="text-slate-400">Loading…</p>
      ) : (
        <MonthCalendarGrid
          monthStart={monthStart}
          occurrences={occurrences}
          zone={zone}
          onDayClick={(day: DateTime) =>
            navigate(`/events/new?guild=${selectedGuildId}&date=${day.toISODate()}`)
          }
        />
      )}
    </div>
  );
}
