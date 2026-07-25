import type { RsvpStatus } from '../types';

const OPTIONS: { value: RsvpStatus; label: string }[] = [
  { value: 'accepted', label: "I'm in" },
  { value: 'tentative', label: 'Maybe' },
  { value: 'declined', label: "Can't make it" },
];

export default function RsvpButtons({
  current,
  onChange,
}: {
  current: RsvpStatus | null;
  onChange: (status: RsvpStatus) => void;
}) {
  return (
    <div className="flex gap-2">
      {OPTIONS.map((opt) => (
        <button
          key={opt.value}
          onClick={() => onChange(opt.value)}
          className={`rounded-md border px-3 py-1.5 text-sm ${
            current === opt.value
              ? 'border-indigo-500 bg-indigo-600 text-white'
              : 'border-slate-700 text-slate-300 hover:bg-slate-800'
          }`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
