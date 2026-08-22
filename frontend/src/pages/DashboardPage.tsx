import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { DateTime } from 'luxon';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { useGuild } from '../auth/GuildContext';
import { formatTimeRange } from '../lib/datetime';
import type { EventOccurrence } from '../types';

export default function DashboardPage() {
  const { user } = useAuth();
  const { guilds } = useGuild();
  const [upcoming, setUpcoming] = useState<EventOccurrence[]>([]);
  const [loading, setLoading] = useState(true);
  const zone = user?.timezone ?? 'America/New_York';

  // Across every server, not one at a time (spec 0006). "What's coming up"
  // was never a per-server question.
  useEffect(() => {
    setLoading(true);
    const now = DateTime.now().setZone(zone);
    const from = now.toMillis();
    const to = now.plus({ days: 60 }).toMillis();
    api
      .get<EventOccurrence[]>(`/me/events?from=${from}&to=${to}`)
      .then((all) =>
        setUpcoming(
          all
            .filter((o) => o.status !== 'cancelled')
            .sort((a, b) => (a.startAt ?? Infinity) - (b.startAt ?? Infinity))
            .slice(0, 8),
        ),
      )
      .finally(() => setLoading(false));
  }, [zone]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">
          Welcome back{user ? `, ${user.globalName ?? user.username}` : ''}
        </h1>
        <div className="flex gap-2">
          <Link
            to="/personal/new"
            className="rounded-md border border-slate-700 px-3 py-1.5 text-sm hover:bg-slate-800"
          >
            + Personal time
          </Link>
          <Link
            to="/events/new"
            className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-500"
          >
            + New Event
          </Link>
        </div>
      </div>

      {guilds.length === 0 ? (
        <p className="text-slate-400">
          You don't share any allow-listed Discord servers with this app yet. Ask the owner to
          add your server to the allow-list.
        </p>
      ) : (
        <div className="rounded-lg border border-slate-800 bg-slate-900 p-4">
          <h2 className="mb-3 font-semibold">Upcoming sessions</h2>
          {loading ? (
            <p className="text-slate-400">Loading…</p>
          ) : upcoming.length === 0 ? (
            <p className="text-slate-400">
              Nothing on the calendar yet. <Link to="/calendar" className="text-indigo-400 underline">Create an event</Link>.
            </p>
          ) : (
            <ul className="space-y-2">
              {upcoming.map((occ) => (
                <li key={occ.occurrenceId}>
                  <Link
                    to={occ.isPersonal ? `/personal/${occ.eventId}` : `/events/${occ.eventId}`}
                    className="flex items-center justify-between rounded px-2 py-1.5 hover:bg-slate-800"
                  >
                    <span>{occ.title}</span>
                    <span className="text-sm text-slate-400">
                      {occ.startAt && occ.endAt
                        ? formatTimeRange(occ.startAt, occ.endAt, zone)
                        : 'Poll open'}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
