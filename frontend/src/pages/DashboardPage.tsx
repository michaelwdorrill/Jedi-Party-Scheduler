import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { DateTime } from 'luxon';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { useGuild } from '../auth/GuildContext';
import { formatTimeRange } from '../lib/datetime';
import type { EventOccurrence } from '../types';
import { Button, Card, PageHeader } from '../components/ui';

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
      <PageHeader title={`Welcome back${user ? `, ${user.globalName ?? user.username}` : ''}`}>
        <Button to="/personal/new" variant="secondary">
          + Personal time
        </Button>
        <Button to="/events/new">+ New Event</Button>
      </PageHeader>

      {guilds.length === 0 ? (
        <p className="text-muted">
          You don't share any allow-listed Discord servers with this app yet. Ask the owner to
          add your server to the allow-list.
        </p>
      ) : (
        <Card title="Upcoming sessions">
          {loading ? (
            <p className="text-muted">Loading…</p>
          ) : upcoming.length === 0 ? (
            <p className="text-muted">
              Nothing on the calendar yet. <Link to="/calendar" className="text-accent-text underline">Create an event</Link>.
            </p>
          ) : (
            <ul className="space-y-2">
              {upcoming.map((occ) => (
                <li key={occ.occurrenceId}>
                  <Link
                    to={occ.isPersonal ? `/personal/${occ.eventId}` : `/events/${occ.eventId}`}
                    className="flex items-center justify-between rounded px-2 py-1.5 hover:bg-raised"
                  >
                    <span>{occ.title}</span>
                    <span className="text-sm text-muted">
                      {occ.startAt && occ.endAt
                        ? formatTimeRange(occ.startAt, occ.endAt, zone)
                        : 'Poll open'}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}
    </div>
  );
}
