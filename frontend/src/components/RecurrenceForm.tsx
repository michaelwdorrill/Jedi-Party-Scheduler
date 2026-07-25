import type { RecurrenceEndType, RecurrenceFreq } from '../types';

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

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
    <div className="space-y-3 rounded-md border border-slate-700 bg-slate-800/50 p-3">
      <div className="flex items-center gap-2">
        <span className="text-sm text-slate-400">Repeats</span>
        <select
          value={value.freq}
          onChange={(e) => set({ freq: e.target.value as RecurrenceFreq })}
          className="rounded-md border border-slate-700 bg-slate-800 px-2 py-1 text-sm"
        >
          <option value="DAILY">Daily</option>
          <option value="WEEKLY">Weekly</option>
          <option value="MONTHLY">Monthly</option>
        </select>
        <span className="text-sm text-slate-400">every</span>
        <input
          type="number"
          min={1}
          value={value.interval}
          onChange={(e) => set({ interval: Math.max(1, Number(e.target.value)) })}
          className="w-16 rounded-md border border-slate-700 bg-slate-800 px-2 py-1 text-sm"
        />
        <span className="text-sm text-slate-400">
          {value.freq === 'DAILY' ? 'day(s)' : value.freq === 'WEEKLY' ? 'week(s)' : 'month(s)'}
        </span>
      </div>

      {value.freq === 'WEEKLY' && (
        <div className="flex gap-1">
          {WEEKDAYS.map((label, i) => (
            <button
              type="button"
              key={label}
              onClick={() => toggleWeekday(i)}
              className={`h-8 w-8 rounded-full text-xs ${
                value.byWeekday.includes(i)
                  ? 'bg-indigo-600 text-white'
                  : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
              }`}
            >
              {label[0]}
            </button>
          ))}
        </div>
      )}

      <div className="flex items-center gap-3 text-sm text-slate-400">
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
            className="rounded-md border border-slate-700 bg-slate-800 px-2 py-1 text-xs disabled:opacity-50"
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
            className="w-16 rounded-md border border-slate-700 bg-slate-800 px-2 py-1 text-xs disabled:opacity-50"
          />
          occurrences
        </label>
      </div>
    </div>
  );
}
