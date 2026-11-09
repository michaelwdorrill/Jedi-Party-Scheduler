import { endFollowingStart, type TimeRangeDraft } from '../lib/timeRange';
import { controlClass } from './ui';

// The four inputs of a start-and-end, shared by the invitee's change-request
// form and the organizer's Move this occurrence (IDEAS 94). Markup moved here
// from ChangeRequestSection's MoveRequestForm unchanged, plus the label/id
// pairing it never had.

export default function TimeRangeFields({
  draft,
  onChange,
  startLabel,
  endLabel,
  idPrefix,
  zone,
}: {
  draft: TimeRangeDraft;
  onChange: (next: TimeRangeDraft) => void;
  startLabel: string;
  endLabel: string;
  idPrefix: string;
  // The zone the typed times mean -- needed to know how long the range is, so
  // that moving the start can take the end with it.
  zone: string;
}) {
  const set = (field: keyof TimeRangeDraft) => (e: React.ChangeEvent<HTMLInputElement>) =>
    onChange({ ...draft, [field]: e.target.value });
  // Moving the start takes the end with it (lib/timeRange.ts).
  const setStart = (field: 'date' | 'startTime') => (e: React.ChangeEvent<HTMLInputElement>) => {
    const nextStart = { date: draft.date, startTime: draft.startTime, [field]: e.target.value };
    onChange({ ...draft, ...nextStart, ...endFollowingStart(draft, nextStart, zone) });
  };

  return (
    <div className="flex flex-wrap gap-3">
      <div className="flex-1 min-w-[8rem]">
        <label htmlFor={`${idPrefix}-date`} className="mb-1 block text-xs text-muted">
          {startLabel}
        </label>
        <input
          id={`${idPrefix}-date`}
          type="date"
          value={draft.date}
          onChange={setStart('date')}
          className={controlClass('lg', 'w-full')}
        />
      </div>
      <div className="w-24">
        <label htmlFor={`${idPrefix}-start-time`} className="mb-1 block text-xs text-muted">
          at
        </label>
        <input
          id={`${idPrefix}-start-time`}
          type="time"
          value={draft.startTime}
          onChange={setStart('startTime')}
          className={controlClass('lg', 'w-full')}
        />
      </div>
      <div className="flex-1 min-w-[8rem]">
        <label htmlFor={`${idPrefix}-end-date`} className="mb-1 block text-xs text-muted">
          {endLabel}
        </label>
        <input
          id={`${idPrefix}-end-date`}
          type="date"
          value={draft.endDate}
          onChange={set('endDate')}
          className={controlClass('lg', 'w-full')}
        />
      </div>
      <div className="w-24">
        <label htmlFor={`${idPrefix}-end-time`} className="mb-1 block text-xs text-muted">
          at
        </label>
        <input
          id={`${idPrefix}-end-time`}
          type="time"
          value={draft.endTime}
          onChange={set('endTime')}
          className={controlClass('lg', 'w-full')}
        />
      </div>
    </div>
  );
}
