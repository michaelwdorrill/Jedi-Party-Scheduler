import { useEffect, useMemo, useState } from 'react';
import { DateTime } from 'luxon';
import { api } from '../api/client';
import type { FreeBusyEntry } from '../types';

// Outlook-style free/busy strip. Every bar is deliberately anonymous: the API
// only ever returns time ranges for other people, so there is nothing here to
// reveal what someone is doing or who with -- just whether they're open.
//
// One strip per proposed slot (idea 39). This used to take a single `date`
// and EventFormPage bound it to `pollSlots[0]?.date`, so a poll offering
// three candidate days showed availability for the first and gave no sign the
// others existed -- through the one view whose entire purpose is comparing
// candidates. It also drew a fixed 8am-2am axis, so anyone busy at 7am read
// as free and a slot proposed outside that range had no column to appear in.
//
// Both follow from the same mistake: the view was built around a day rather
// than around what is being proposed. Now each strip's axis comes from its
// own slot.

export interface AssistantSlot {
  key: string;
  startAt: number;
  endAt: number;
}

// Breathing room either side of a proposed slot, so a commitment that ends
// just before it (or starts just after) is visible rather than clipped off
// the edge -- the near misses are exactly what someone is scanning for.
const PAD_MS = 90 * 60 * 1000;

export default function SchedulingAssistant({
  guildId,
  userIds,
  slots,
  zone,
  excludeEventId,
}: {
  guildId: string;
  userIds: string[];
  slots: AssistantSlot[];
  zone: string;
  // The event being edited, if any -- every invitee holds a non-declined
  // invite to it, so without this its own slot always shows everyone busy
  // during it, indistinguishable from a real conflict.
  excludeEventId?: string;
}) {
  const [entries, setEntries] = useState<FreeBusyEntry[]>([]);
  const [loading, setLoading] = useState(false);
  // A failed lookup must never fall through to rendering the previous
  // answer. Everything this strip shows is "who is free", so stale or empty
  // bars read as "everyone is available" -- the one wrong thing it can say.
  const [error, setError] = useState<string | null>(null);

  // One request spanning every slot, not one per slot. MAX_POLL_OPTIONS is
  // 20, and twenty round trips on every keystroke in the event form is not a
  // thing to ship; the server's own range ceiling (MAX_FREE_BUSY_RANGE_MS,
  // ~2 months) is generous enough that any realistic poll fits in one, and a
  // poll that doesn't gets the server's refusal rendered as an error rather
  // than a partial answer.
  const range = useMemo(() => {
    if (slots.length === 0) return null;
    return {
      from: Math.min(...slots.map((s) => s.startAt)) - PAD_MS,
      to: Math.max(...slots.map((s) => s.endAt)) + PAD_MS,
    };
  }, [slots]);

  const rangeKey = range ? `${range.from}-${range.to}` : '';

  useEffect(() => {
    if (!guildId || userIds.length === 0 || !range) {
      setEntries([]);
      return;
    }
    setLoading(true);
    setError(null);
    api
      .get<FreeBusyEntry[]>(
        `/guilds/${guildId}/free-busy?from=${range.from}&to=${range.to}&user_ids=${userIds.join(',')}` +
          (excludeEventId ? `&exclude_event_id=${excludeEventId}` : ''),
      )
      .then((next) => {
        setEntries(next);
        setError(null);
      })
      .catch((err: unknown) => {
        // The server refuses rather than answering partially when a request
        // covers too much to expand accurately, so say so instead of
        // silently showing nothing.
        setEntries([]);
        setError(err instanceof Error ? err.message : 'Could not load availability.');
      })
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [guildId, userIds.join(','), rangeKey, excludeEventId]);

  if (userIds.length === 0) {
    return <p className="text-sm text-faint">Pick some people above to see when they're already busy.</p>;
  }

  if (slots.length === 0) {
    return <p className="text-sm text-faint">Add a time to see who's free then.</p>;
  }

  if (error) {
    return (
      <div className="rounded border border-warning/50 bg-warning-surface/60 p-3 text-sm text-warning-text">
        <p className="font-medium">Couldn't check availability</p>
        <p className="mt-1 text-warning-text/90">{error}</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {loading && <p className="text-xs text-faint">Checking availability…</p>}
      {slots.map((slot) => (
        <SlotStrip key={slot.key} slot={slot} entries={entries} zone={zone} />
      ))}
    </div>
  );
}

// One proposed slot, with its own axis. Kept separate so each slot's scale is
// derived from that slot rather than from a constant shared across all of
// them -- a 7:30-10pm candidate and a 1-11pm candidate want different rulers.
function SlotStrip({ slot, entries, zone }: { slot: AssistantSlot; entries: FreeBusyEntry[]; zone: string }) {
  const axisStart = slot.startAt - PAD_MS;
  const axisEnd = slot.endAt + PAD_MS;
  const spanMs = axisEnd - axisStart;
  const pct = (ms: number) => Math.max(0, Math.min(100, ((ms - axisStart) / spanMs) * 100));

  // Roughly six ticks whatever the span, rounded to a sensible unit, so a
  // three-hour candidate and a ten-hour one are both readable. A fixed
  // two-hour tick was fine only because the axis used to be a fixed length.
  const ticks = useMemo(() => {
    const stepCandidatesMs = [30, 60, 120, 180, 240, 360, 720].map((m) => m * 60 * 1000);
    const step = stepCandidatesMs.find((s) => spanMs / s <= 7) ?? stepCandidatesMs[stepCandidatesMs.length - 1];
    const first = Math.ceil(axisStart / step) * step;
    const out: number[] = [];
    for (let t = first; t <= axisEnd; t += step) out.push(t);
    return out;
  }, [axisStart, axisEnd, spanMs]);

  const conflicting = entries.filter(
    (e) => e.visible && e.busy.some((b) => b.startAt < slot.endAt && b.endAt > slot.startAt),
  );

  const start = DateTime.fromMillis(slot.startAt).setZone(zone);
  const end = DateTime.fromMillis(slot.endAt).setZone(zone);

  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between text-xs">
        <span className="font-medium text-ink-dim">{start.toFormat('ccc d LLL')}</span>
        <span className="text-faint">
          {start.toFormat('h:mm a')} – {end.toFormat(end.hasSame(start, 'day') ? 'h:mm a' : 'ccc h:mm a')}
        </span>
      </div>

      <div className="flex text-[10px] text-fainter">
        <div className="w-28 shrink-0" />
        <div className="relative h-4 flex-1">
          {ticks.map((t) => (
            <span key={t} className="absolute -translate-x-1/2" style={{ left: `${pct(t)}%` }}>
              {DateTime.fromMillis(t).setZone(zone).toFormat('ha')}
            </span>
          ))}
        </div>
      </div>

      <div className="space-y-1">
        {entries.map((entry) => (
          <div key={entry.userId} className="flex items-center gap-2">
            <span
              className="w-28 shrink-0 truncate text-xs text-ink-dim"
              title={entry.globalName ?? entry.username}
            >
              {entry.globalName ?? entry.username}
            </span>
            <div className="relative h-5 flex-1 overflow-hidden rounded bg-raised">
              {!entry.visible ? (
                <span className="absolute inset-0 flex items-center justify-center text-[10px] text-faint">
                  availability hidden
                </span>
              ) : (
                <>
                  <div
                    className="absolute inset-y-0 border-x border-accent-text/70 bg-accent-hover/20"
                    style={{
                      left: `${pct(slot.startAt)}%`,
                      width: `${pct(slot.endAt) - pct(slot.startAt)}%`,
                    }}
                  />
                  {entry.busy
                    .filter((b) => b.endAt > axisStart && b.startAt < axisEnd)
                    .map((b, i) => (
                      <div
                        key={i}
                        className="absolute inset-y-0 bg-rose-700/80"
                        style={{
                          left: `${pct(b.startAt)}%`,
                          width: `${Math.max(1, pct(b.endAt) - pct(b.startAt))}%`,
                        }}
                        title="Busy"
                      />
                    ))}
                </>
              )}
            </div>
          </div>
        ))}
      </div>

      {conflicting.length > 0 ? (
        <p className="text-xs text-warning-text">
          Busy then: {conflicting.map((e) => e.globalName ?? e.username).join(', ')}
        </p>
      ) : (
        entries.some((e) => e.visible) && (
          <p className="text-xs text-success-text">Everyone with visible availability is free then.</p>
        )
      )}
    </div>
  );
}
