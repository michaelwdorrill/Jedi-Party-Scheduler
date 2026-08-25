import { DateTime } from 'luxon';
import { Link } from 'react-router-dom';
import type { EventOccurrence } from '../types';
import { groupColor, PERSONAL_COLOR, UNGROUPED_COLOR } from '../lib/colors';

// The agenda: what is next, grouped by day.
//
// Most weeks in this app hold zero to three sessions, so a seven-column grid
// spends most of its pixels on empty cells. This is the same data with the
// emptiness removed -- and it is the view a phone gets, because it needs no
// second layout to work in one column.

function dayLabel(day: DateTime, today: DateTime): string {
  const diff = day.diff(today, 'days').days;
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  return day.toFormat('cccc');
}

export default function AgendaList({
  occurrences,
  zone,
}: {
  occurrences: EventOccurrence[];
  zone: string;
}) {
  const today = DateTime.now().setZone(zone).startOf('day');

  // Only what is still ahead, in order. The grid shows the whole window; the
  // agenda is explicitly the "from here on" reading of the same data.
  const upcoming = occurrences
    .filter((o) => o.startAt != null && o.startAt >= today.toMillis())
    .sort((a, b) => a.startAt! - b.startAt!);

  const byDay = new Map<string, EventOccurrence[]>();
  for (const occ of upcoming) {
    const key = DateTime.fromMillis(occ.startAt!).setZone(zone).toISODate()!;
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key)!.push(occ);
  }

  return (
    <div className="space-y-5">
      {[...byDay.entries()].map(([key, dayEvents]) => {
        const day = DateTime.fromISO(key, { zone });
        return (
          <div key={key}>
            <h3 className="no-stencil mb-2 flex items-baseline gap-3 border-b border-edge pb-1.5 text-base">
              {dayLabel(day, today)}
              <span className="font-mono text-[10px] font-normal uppercase tracking-widest text-faint">
                {day.toFormat('d LLL')}
              </span>
            </h3>
            <ul className="space-y-1.5">
              {dayEvents.map((occ) => {
                const palette = occ.isPersonal
                  ? PERSONAL_COLOR
                  : occ.groupId
                    ? groupColor(occ.groupId)
                    : UNGROUPED_COLOR;
                const cancelled = occ.status === 'cancelled';
                // A candidate day on a poll that has not resolved (idea 41).
                // The month grid says this with a dashed outline; here the row
                // is a full-width card, so it gets a dashed edge and the word
                // -- an agenda entry that reads exactly like a confirmed one
                // is the version of this bug that matters most, since the
                // agenda is what a phone shows by default.
                const provisional = !cancelled && occ.isProvisional === true;
                return (
                  <li key={occ.occurrenceId}>
                    <Link
                      to={occ.isPersonal ? `/personal/${occ.eventId}` : `/events/${occ.eventId}`}
                      className={`grid grid-cols-[4.5rem_1fr_auto] items-center gap-3 rounded border px-3 py-2 hover:bg-raised/70 ${
                        provisional
                          ? 'border-dashed border-edge-strong bg-surface/40'
                          : 'border-edge bg-surface/70'
                      } ${cancelled ? 'opacity-60' : ''}`}
                    >
                      <span
                        // palette.border, not ring.replace('ring-','border-'):
                        // Tailwind generates CSS by scanning source text, so a
                        // class built at runtime is never emitted and this
                        // gutter had silently never taken its group's colour.
                        className={`border-l-2 pl-2 font-mono text-xs tabular-nums text-muted ${palette.border} ${
                          provisional ? 'border-dashed' : ''
                        }`}
                      >
                        {occ.startAt
                          ? DateTime.fromMillis(occ.startAt).setZone(zone).toFormat('HH:mm')
                          : 'poll'}
                      </span>
                      <span className={`font-medium ${cancelled ? 'line-through' : ''}`}>
                        {provisional && (
                          <span className="mr-1.5 rounded bg-raised px-1.5 py-0.5 text-[10px] font-normal uppercase tracking-wide text-muted">
                            Maybe
                          </span>
                        )}
                        {occ.title}
                      </span>
                      <span className="whitespace-nowrap text-xs text-faint">
                        {occ.isPersonal ? 'personal' : (occ.guildName ?? '')}
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </div>
  );
}
