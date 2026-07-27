import { useEffect, useState } from 'react';
import { DateTime } from 'luxon';
import { api } from '../api/client';
import type { FreeBusyEntry } from '../types';

// Outlook-style free/busy strip. Every bar is deliberately anonymous: the API
// only ever returns time ranges for other people, so there is nothing here to
// reveal what someone is doing or who with -- just whether they're open.
export default function SchedulingAssistant({
  guildId,
  userIds,
  date,
  zone,
  proposedStart,
  proposedEnd,
  dayStartHour = 8,
  dayEndHour = 26, // 2am next day, since sessions routinely run past midnight
}: {
  guildId: string;
  userIds: string[];
  date: string; // ISO date
  zone: string;
  proposedStart?: number | null;
  proposedEnd?: number | null;
  dayStartHour?: number;
  dayEndHour?: number;
}) {
  const [entries, setEntries] = useState<FreeBusyEntry[]>([]);
  const [loading, setLoading] = useState(false);

  const dayStart = DateTime.fromISO(date, { zone }).startOf('day').plus({ hours: dayStartHour });
  const dayEnd = DateTime.fromISO(date, { zone }).startOf('day').plus({ hours: dayEndHour });
  const spanMs = dayEnd.toMillis() - dayStart.toMillis();

  useEffect(() => {
    if (!guildId || userIds.length === 0) {
      setEntries([]);
      return;
    }
    setLoading(true);
    api
      .get<FreeBusyEntry[]>(
        `/guilds/${guildId}/free-busy?from=${dayStart.toMillis()}&to=${dayEnd.toMillis()}&user_ids=${userIds.join(',')}`,
      )
      .then(setEntries)
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [guildId, userIds.join(','), date, zone]);

  if (userIds.length === 0) {
    return (
      <p className="text-sm text-slate-500">
        Pick some people above to see when they're already busy.
      </p>
    );
  }

  const pct = (ms: number) => Math.max(0, Math.min(100, ((ms - dayStart.toMillis()) / spanMs) * 100));

  const hourTicks: DateTime[] = [];
  for (let h = dayStartHour; h <= dayEndHour; h += 2) {
    hourTicks.push(DateTime.fromISO(date, { zone }).startOf('day').plus({ hours: h }));
  }

  // Anyone whose visible busy time collides with the slot being proposed.
  const conflicting = entries.filter(
    (e) =>
      proposedStart != null &&
      proposedEnd != null &&
      e.visible &&
      e.busy.some((b) => b.startAt < proposedEnd && b.endAt > proposedStart),
  );

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between text-xs text-slate-500">
        <span>{dayStart.toFormat('ccc d LLL')}</span>
        {loading && <span>Checking availability…</span>}
      </div>

      <div className="flex text-[10px] text-slate-600">
        <div className="w-28 shrink-0" />
        <div className="relative h-4 flex-1">
          {hourTicks.map((t) => (
            <span
              key={t.toISO()}
              className="absolute -translate-x-1/2"
              style={{ left: `${pct(t.toMillis())}%` }}
            >
              {t.toFormat('ha')}
            </span>
          ))}
        </div>
      </div>

      <div className="space-y-1">
        {entries.map((entry) => (
          <div key={entry.userId} className="flex items-center gap-2">
            <span className="w-28 shrink-0 truncate text-xs text-slate-300" title={entry.globalName ?? entry.username}>
              {entry.globalName ?? entry.username}
            </span>
            <div className="relative h-5 flex-1 overflow-hidden rounded bg-slate-800">
              {!entry.visible ? (
                <span className="absolute inset-0 flex items-center justify-center text-[10px] text-slate-500">
                  availability hidden
                </span>
              ) : (
                <>
                  {proposedStart != null && proposedEnd != null && (
                    <div
                      className="absolute inset-y-0 border-x border-indigo-400/70 bg-indigo-500/20"
                      style={{
                        left: `${pct(proposedStart)}%`,
                        width: `${pct(proposedEnd) - pct(proposedStart)}%`,
                      }}
                    />
                  )}
                  {entry.busy.map((b, i) => (
                    <div
                      key={i}
                      className="absolute inset-y-0 bg-rose-700/80"
                      style={{ left: `${pct(b.startAt)}%`, width: `${Math.max(1, pct(b.endAt) - pct(b.startAt))}%` }}
                      title="Busy"
                    />
                  ))}
                </>
              )}
            </div>
          </div>
        ))}
      </div>

      {conflicting.length > 0 && (
        <p className="text-xs text-amber-400">
          Busy at the time you've picked: {conflicting.map((e) => e.globalName ?? e.username).join(', ')}
        </p>
      )}
      {conflicting.length === 0 && proposedStart != null && entries.some((e) => e.visible) && (
        <p className="text-xs text-emerald-400">Everyone with visible availability is free then.</p>
      )}
    </div>
  );
}
