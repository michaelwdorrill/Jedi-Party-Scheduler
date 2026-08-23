import type { RecurrenceEndType, RecurrenceFreq } from '../types';
import { controlClass } from './ui';

// Displayed Sunday-first to match the calendar grid, but the stored value
// (event_recurrence_rules.by_weekday) is 0=Mon..6=Sun and must not move --
// existing recurring events already encode that, so each chip carries its
// value explicitly rather than being derived from its position in this list.
const WEEKDAYS = [
  { label: 'Sun', value: 6 },
  { label: 'Mon', value: 0 },
  { label: 'Tue', value: 1 },
  { label: 'Wed', value: 2 },
  { label: 'Thu', value: 3 },
  { label: 'Fri', value: 4 },
  { label: 'Sat', value: 5 },
];

export interface RecurrenceFormValue {
  freq: RecurrenceFreq;
  interval: number;
  byWeekday: number[];
  byMonthDay: number | null;
  endType: RecurrenceEndType;
  endDate: string;
  endCount: number;
}

export default function RecurrenceForm({
  value,
  onChange,
}: {
  value: RecurrenceFormValue;
  onChange: (value: RecurrenceFormValue) => void;
}) {
  const set = (patch: Partial<RecurrenceFormValue>) => onChange({ ...value, ...patch });

  const toggleWeekday = (day: number) =>
    set({
      byWeekday: value.byWeekday.includes(day)
        ? value.byWeekday.filter((d) => d !== day)
        : [...value.byWeekday, day].sort(),
    });

  return (
    <div className="space-y-3 rounded-md border border-edge-strong bg-raised/50 p-3">
      <div className="flex items-center gap-2">
        <span className="text-sm text-muted">Repeats</span>
        <select
          value={value.freq}
          onChange={(e) => set({ freq: e.target.value as RecurrenceFreq })}
          className={controlClass('sm-tight')}
        >
          <option value="DAILY">Daily</option>
          <option value="WEEKLY">Weekly</option>
          <option value="MONTHLY">Monthly</option>
        </select>
        <span className="text-sm text-muted">every</span>
        <input
          type="number"
          min={1}
          value={value.interval}
          onChange={(e) => set({ interval: Math.max(1, Number(e.target.value)) })}
          className={controlClass('xs', 'w-16 text-sm')}
        />
        <span className="text-sm text-muted">
          {value.freq === 'DAILY' ? 'day(s)' : value.freq === 'WEEKLY' ? 'week(s)' : 'month(s)'}
        </span>
      </div>

      {value.freq === 'WEEKLY' && (
        <div className="flex gap-1">
          {WEEKDAYS.map(({ label, value: day }) => (
            <button
              type="button"
              key={label}
              onClick={() => toggleWeekday(day)}
              className={`h-8 w-8 rounded-full text-xs ${
                value.byWeekday.includes(day)
                  ? 'bg-accent text-white'
                  : 'bg-raised text-ink-dim hover:bg-raised-hi'
              }`}
            >
              {label[0]}
            </button>
          ))}
        </div>
      )}

      <div className="flex items-center gap-3 text-sm text-muted">
        <span>Ends</span>
        <label className="flex items-center gap-1">
          <input
            type="radio"
            checked={value.endType === 'never'}
            onChange={() => set({ endType: 'never' })}
          />
          Never
        </label>
        <label className="flex items-center gap-1">
          <input
            type="radio"
            checked={value.endType === 'on_date'}
            onChange={() => set({ endType: 'on_date' })}
          />
          On
          <input
            type="date"
            disabled={value.endType !== 'on_date'}
            value={value.endDate}
            onChange={(e) => set({ endDate: e.target.value })}
            className={controlClass('xs')}
          />
        </label>
        <label className="flex items-center gap-1">
          <input
            type="radio"
            checked={value.endType === 'after_count'}
            onChange={() => set({ endType: 'after_count' })}
          />
          After
          <input
            type="number"
            min={1}
            disabled={value.endType !== 'after_count'}
            value={value.endCount}
            onChange={(e) => set({ endCount: Math.max(1, Number(e.target.value)) })}
            className={controlClass('xs', 'w-16')}
          />
          occurrences
        </label>
      </div>
    </div>
  );
}
