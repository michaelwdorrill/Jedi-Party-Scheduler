import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import { useGuild } from '../auth/GuildContext';
import { useAsync } from '../lib/async';
import Avatar from '../components/ui/Avatar';
import { cardClass, controlClass, EmptyState, ErrorState, Loading, PageHeader } from '../components/ui';
import type { NoticeboardOccurrence } from '../types';

// IDEAS item 5 (second half) / docs/specs/0007: what's on in a server.
//
// The counterpart to what v0.3 did. That release made servers stop mattering
// for viewing *your own* schedule -- the calendar spans all of them and the
// switcher went away. This makes a server mean something again in the opposite
// direction: not a mode the app is in, but a place you can look at.
//
// Deliberately a separate page from the calendar rather than a filter on it.
// The calendar answers "what am I committed to"; this answers "what is going
// on that I'm not part of", and merging them would blur a distinction the
// whole privacy model rests on.

const DAY_MS = 24 * 60 * 60 * 1000;
// Matches the Worker's MAX_NOTICEBOARD_RANGE_MS. Asking for more earns a 422
// rather than a truncated answer, so the UI simply doesn't ask.
const WINDOW_MS = 60 * DAY_MS;

function formatWhen(startAt: number, endAt: number): string {
  const start = new Date(startAt);
  const end = new Date(endAt);
  const sameDay = start.toDateString() === end.toDateString();
  const date = start.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  const from = start.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const to = end.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return sameDay ? `${date}, ${from} – ${to}` : `${date}, ${from} – ${end.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${to}`;
}

const RSVP_LABEL: Record<string, string> = {
  accepted: 'in',
  declined: 'out',
  tentative: 'maybe',
};

export default function NoticeboardPage() {
  const { guilds, loading: guildsLoading, error: guildsError } = useGuild();
  const [guildId, setGuildId] = useState<string>('');
  const effectiveGuildId = guildId || guilds[0]?.id || '';

  const board = useAsync(
    () =>
      effectiveGuildId
        ? api.get<NoticeboardOccurrence[]>(
            `/guilds/${effectiveGuildId}/noticeboard?from=${Date.now()}&to=${Date.now() + WINDOW_MS}`,
          )
        : Promise.resolve([]),
    [effectiveGuildId],
  );

  if (guildsLoading) return <Loading />;
  if (guildsError) return <ErrorState message={guildsError} />;
  if (guilds.length === 0) {
    return (
      <EmptyState title="No servers yet">
        You don't share any allow-listed Discord servers with this app yet.
      </EmptyState>
    );
  }

  return (
    <div className="space-y-4">
      <PageHeader title="What's on">
        Sessions happening on a server you're in, whether or not you're invited. An organiser can
        keep an event off the board.
      </PageHeader>

      {guilds.length > 1 && (
        <select
          value={effectiveGuildId}
          onChange={(e) => setGuildId(e.target.value)}
          className={controlClass('lg', 'w-full max-w-sm')}
          aria-label="Server"
        >
          {guilds.map((g: { id: string; name: string }) => (
            <option key={g.id} value={g.id}>
              {g.name}
            </option>
          ))}
        </select>
      )}

      {board.loading && <Loading />}
      {board.error && <ErrorState message={board.error} onRetry={board.reload} />}

      {!board.loading && !board.error && (board.data?.length ?? 0) === 0 && (
        <EmptyState title="Nothing on the board">
          No one has anything scheduled on this server in the next couple of months — or what is
          scheduled has been kept private.
        </EmptyState>
      )}

      <div className="space-y-3">
        {(board.data ?? []).map((occ) => (
          <div key={occ.occurrenceId} className={cardClass('md', 'space-y-2')}>
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              {/* Links through to the event, which enforces its own visibility
                  check independently -- someone not invited gets the same 403
                  they always would. The noticeboard shows more than the event
                  page will, and that is the intended asymmetry. */}
              <Link to={`/events/${occ.eventId}`} className="font-semibold text-accent-text hover:underline">
                {occ.title}
              </Link>
              <span className="text-sm text-muted">{formatWhen(occ.startAt, occ.endAt)}</span>
            </div>
            {occ.game && <p className="text-xs text-faint">{occ.game}</p>}
            <div className="flex flex-wrap items-center gap-2">
              {occ.attendees.map((a) => (
                <span
                  key={a.userId}
                  className="flex items-center gap-1.5 rounded-full bg-surface-2 px-2 py-0.5 text-xs text-ink-dim"
                  title={a.rsvpStatus ? `${a.globalName ?? a.username} — ${RSVP_LABEL[a.rsvpStatus]}` : (a.globalName ?? a.username)}
                >
                  <Avatar userId={a.userId} avatarHash={a.avatarHash} name={a.globalName ?? a.username} size="sm" />
                  <span className={a.rsvpStatus === 'declined' ? 'line-through opacity-60' : undefined}>
                    {a.globalName ?? a.username}
                  </span>
                  {a.rsvpStatus && a.rsvpStatus !== 'declined' && (
                    <span className="text-faint">{RSVP_LABEL[a.rsvpStatus]}</span>
                  )}
                </span>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
