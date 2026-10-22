import { useState } from 'react';
import { DateTime } from 'luxon';
import {
  seedTimeRangeDraft,
  timeRangeDraftComplete,
  timeRangeDraftOrdered,
  timeRangeDraftToMillis,
  type TimeRangeDraft,
} from '../lib/timeRange';
import TimeRangeFields from './TimeRangeFields';
import { buttonClass } from './ui';

// IDEAS 94: the organizer moves one occurrence of their own series. Before
// this, only an invitee could get a single date moved -- by asking, and having
// the organizer accept.
//
// The form says what the move does and does not do, because each part is a
// reasonable thing to assume the other way (release-bar clause 4: no silence
// about consequences). All three are true of the server's write, which is the
// same one an accepted change request uses -- see writeOccurrenceMove.

export default function MoveOccurrenceForm({
  startAt,
  endAt,
  occurrenceDate,
  eventZone,
  viewerZone,
  onSubmit,
  onClose,
}: {
  startAt: number;
  endAt: number;
  occurrenceDate: string;
  eventZone: string;
  viewerZone: string;
  onSubmit: (range: { startAt: number; endAt: number }) => Promise<unknown>;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<TimeRangeDraft>(() => seedTimeRangeDraft(startAt, endAt, eventZone));
  const [submitting, setSubmitting] = useState(false);

  const ordered = timeRangeDraftOrdered(draft, eventZone);
  const canSubmit = ordered && timeRangeDraftComplete(draft, eventZone) && !submitting;
  const dayLabel = DateTime.fromISO(occurrenceDate).toLocaleString({ weekday: 'long', month: 'long', day: 'numeric' });

  const submit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      await onSubmit(timeRangeDraftToMillis(draft, eventZone));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-3 rounded-md border border-edge-strong bg-raised/60 p-3">
      <div>
        <h2 className="text-sm font-semibold">Move the {dayLabel} session</h2>
        <p className="mt-1 text-xs text-muted">
          Only this date changes; the rest of the series stays as it is. Everyone&rsquo;s answers for this date
          carry over. Nobody is sent a message about the move, so tell people yourself if it matters &mdash;
          reminders that haven&rsquo;t gone out yet will show the new time.
        </p>
      </div>
      <TimeRangeFields
        draft={draft}
        onChange={setDraft}
        startLabel="New start"
        endLabel="New end"
        idPrefix="move-occurrence"
        zone={eventZone}
      />
      {eventZone !== viewerZone && (
        <p className="text-xs text-muted">Times here are in the event&rsquo;s time zone, {eventZone}.</p>
      )}
      {!ordered && <p className="text-xs text-danger-text">End must be after the start.</p>}
      <div className="flex gap-2">
        <button onClick={submit} disabled={!canSubmit} className={buttonClass()}>
          {submitting ? 'Moving…' : 'Move this date'}
        </button>
        <button onClick={onClose} className={buttonClass('secondary')}>
          Close
        </button>
      </div>
    </div>
  );
}
