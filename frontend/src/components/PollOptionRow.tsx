import { formatTimeRange } from '../lib/datetime';
import type { PollOption, PollVote } from '../types';

const VOTE_LABEL: Record<PollVote, string> = { yes: "I'm in", maybe: 'Maybe', no: "Can't make it" };

export default function PollOptionRow({
  option,
  zone,
  onVote,
}: {
  option: PollOption;
  zone: string;
  onVote: (vote: PollVote) => void;
}) {
  const total = option.tally.yes + option.tally.no + option.tally.maybe;
  const yesPct = total ? (option.tally.yes / total) * 100 : 0;

  return (
    <div className="rounded-md border border-slate-800 bg-slate-900 p-3">
      <div className="flex items-center justify-between">
        <span className="font-medium">{formatTimeRange(option.startAt, option.endAt, zone)}</span>
        <span className="text-sm text-slate-400">{option.tally.yes} in</span>
      </div>
      <div className="my-2 h-1.5 rounded-full bg-slate-800">
        <div
          className="h-1.5 rounded-full bg-emerald-500"
          style={{ width: `${yesPct}%` }}
        />
      </div>
      <div className="flex gap-2">
        {(['yes', 'maybe', 'no'] as PollVote[]).map((v) => (
          <button
            key={v}
            onClick={() => onVote(v)}
            className={`rounded-md border px-2 py-1 text-xs ${
              option.myVote === v
                ? 'border-indigo-500 bg-indigo-600 text-white'
                : 'border-slate-700 text-slate-300 hover:bg-slate-800'
            }`}
          >
            {VOTE_LABEL[v]}
          </button>
        ))}
      </div>
    </div>
  );
}
