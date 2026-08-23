import { DateTime } from 'luxon';
import type { WindowSubmission } from '../types';

const STEP_MINUTES = 15;

// Time-only reads fine when the whole window fits in one day, but idea 6
// let a window span multiple days -- without the date, "6:00 PM" doesn't
// say which of the window's days it falls on. Mirrors formatTimeRange's own
// hasSame(..., 'day') check in lib/datetime.ts, applied here to whether the
// window's own start and end share a day, not the two points being formatted.
function fmt(ms: number, zone: string, includeDate: boolean) {
  const dt = DateTime.fromMillis(ms).setZone(zone);
  return includeDate ? dt.toFormat('ccc, LLL d, h:mm a') : dt.toFormat('h:mm a');
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
  const spansMultipleDays = !DateTime.fromMillis(windowStartAt)
    .setZone(zone)
    .hasSame(DateTime.fromMillis(windowEndAt).setZone(zone), 'day');
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
      <div className="flex justify-between text-xs text-faint">
        <span>{fmt(windowStartAt, zone, spansMultipleDays)}</span>
        <span>{fmt(windowEndAt, zone, spansMultipleDays)}</span>
      </div>

      <div className="relative h-6 rounded bg-raised">
        {otherSubmissions.map((s) => (
          <div
            key={s.userId}
            className="absolute top-0 h-2 rounded bg-raised-hi"
            style={{
              left: `${pct(Math.round((s.startAt - windowStartAt) / 60000))}%`,
              width: `${pct(Math.round((s.endAt - s.startAt) / 60000))}%`,
            }}
            title={`${s.globalName ?? s.username}: ${fmt(s.startAt, zone, spansMultipleDays)}–${fmt(s.endAt, zone, spansMultipleDays)}`}
          />
        ))}
        {bestCandidate && bestCandidate.count > 0 && (
          <div
            className="absolute bottom-0 h-2 rounded bg-success/70"
            style={{
              left: `${pct(Math.round((bestCandidate.startAt - windowStartAt) / 60000))}%`,
              width: `${pct(Math.round((bestCandidate.endAt - bestCandidate.startAt) / 60000))}%`,
            }}
            title={`Best so far: ${fmt(bestCandidate.startAt, zone, spansMultipleDays)}–${fmt(bestCandidate.endAt, zone, spansMultipleDays)} (${bestCandidate.count} in)`}
          />
        )}
        <div
          className="absolute inset-y-0 rounded bg-accent/70"
          style={{ left: `${pct(startMin)}%`, width: `${pct(endMin - startMin)}%` }}
        />
      </div>

      <div>
        <label className="mb-1 block text-xs text-faint">
          Earliest you could start — {fmt(value.startAt, zone, spansMultipleDays)}
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
        <label className="mb-1 block text-xs text-faint">
          Latest you could go until — {fmt(value.endAt, zone, spansMultipleDays)}
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
      <p className="text-xs text-faint">
        Needs to cover at least a {(blockMinutes / 60).toFixed(1).replace(/\.0$/, '')}-hour block.
      </p>
    </div>
  );
}
