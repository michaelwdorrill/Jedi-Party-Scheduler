import { DateTime } from 'luxon';
import type { WindowSubmission } from '../types';

const STEP_MINUTES = 15;

function fmt(ms: number, zone: string) {
  return DateTime.fromMillis(ms).setZone(zone).toFormat('h:mm a');
}

export default function WindowAvailabilityPicker({
  windowStartAt,
  windowEndAt,
  blockMinutes,
  value,
  onChange,
  zone,
  otherSubmissions = [],
  bestCandidate,
}: {
  windowStartAt: number;
  windowEndAt: number;
  blockMinutes: number;
  value: { startAt: number; endAt: number };
  onChange: (value: { startAt: number; endAt: number }) => void;
  zone: string;
  otherSubmissions?: WindowSubmission[];
  bestCandidate?: { startAt: number; endAt: number; count: number } | null;
}) {
  const totalMinutes = Math.round((windowEndAt - windowStartAt) / 60000);
  const startMin = Math.round((value.startAt - windowStartAt) / 60000);
  const endMin = Math.round((value.endAt - windowStartAt) / 60000);
  const pct = (min: number) => (min / totalMinutes) * 100;

  const setStartMin = (min: number) => {
    const clamped = Math.min(min, endMin - blockMinutes);
    onChange({ startAt: windowStartAt + clamped * 60000, endAt: value.endAt });
  };
  const setEndMin = (min: number) => {
    const clamped = Math.max(min, startMin + blockMinutes);
    onChange({ startAt: value.startAt, endAt: windowStartAt + clamped * 60000 });
  };

  return (
    <div className="space-y-2">
      <div className="flex justify-between text-xs text-slate-500">
        <span>{fmt(windowStartAt, zone)}</span>
        <span>{fmt(windowEndAt, zone)}</span>
      </div>

      <div className="relative h-6 rounded bg-slate-800">
        {otherSubmissions.map((s) => (
          <div
            key={s.userId}
            className="absolute top-0 h-2 rounded bg-slate-600"
            style={{
              left: `${pct(Math.round((s.startAt - windowStartAt) / 60000))}%`,
              width: `${pct(Math.round((s.endAt - s.startAt) / 60000))}%`,
            }}
            title={`${s.globalName ?? s.username}: ${fmt(s.startAt, zone)}–${fmt(s.endAt, zone)}`}
          />
        ))}
        {bestCandidate && bestCandidate.count > 0 && (
          <div
            className="absolute bottom-0 h-2 rounded bg-emerald-700/70"
            style={{
              left: `${pct(Math.round((bestCandidate.startAt - windowStartAt) / 60000))}%`,
              width: `${pct(Math.round((bestCandidate.endAt - bestCandidate.startAt) / 60000))}%`,
            }}
            title={`Best so far: ${fmt(bestCandidate.startAt, zone)}–${fmt(bestCandidate.endAt, zone)} (${bestCandidate.count} in)`}
          />
        )}
        <div
          className="absolute inset-y-0 rounded bg-indigo-600/70"
          style={{ left: `${pct(startMin)}%`, width: `${pct(endMin - startMin)}%` }}
        />
      </div>

      <div>
        <label className="mb-1 block text-xs text-slate-500">
          Earliest you could start — {fmt(value.startAt, zone)}
        </label>
        <input
          type="range"
          min={0}
          max={totalMinutes}
          step={STEP_MINUTES}
          value={startMin}
          onChange={(e) => setStartMin(Number(e.target.value))}
          className="w-full"
        />
      </div>
      <div>
        <label className="mb-1 block text-xs text-slate-500">
          Latest you could go until — {fmt(value.endAt, zone)}
        </label>
        <input
          type="range"
          min={0}
          max={totalMinutes}
          step={STEP_MINUTES}
          value={endMin}
          onChange={(e) => setEndMin(Number(e.target.value))}
          className="w-full"
        />
      </div>
      <p className="text-xs text-slate-500">
        Needs to cover at least a {(blockMinutes / 60).toFixed(1).replace(/\.0$/, '')}-hour block.
      </p>
    </div>
  );
}
