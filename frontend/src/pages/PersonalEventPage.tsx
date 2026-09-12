import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { DateTime } from 'luxon';
import { scheduleFieldsFromRecurrence } from '../lib/recurrenceFields';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import RecurrenceForm, { RecurrenceFormValue } from '../components/RecurrenceForm';
import TimezoneSelect from '../components/TimezoneSelect';
import type { PersonalEvent, PersonalAvailability } from '../types';
import { describeError, editTargetReady, latestOnly } from '../lib/async';
import { ErrorState, InlineError, Loading, buttonClass, cardClass, controlClass } from '../components/ui';

// Personal time: private to you, never shown to anyone else, and (unless you
// untick "show me as busy") it makes you look unavailable in other people's
// scheduling assistant without revealing what it is.
// Hoisted out of useState so the loader can restore it (P21-01). A fixed block
// loaded after a recurring one has to put this back, or it inherits the
// previous block's rule and gets saved with it.
const DEFAULT_RECURRENCE: RecurrenceFormValue = {
  freq: 'WEEKLY',
  interval: 1,
  byWeekday: [],
  byMonthDay: null,
  endType: 'never',
  endDate: '',
  endCount: 10,
};

export default function PersonalEventPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const { personalEventId } = useParams();
  const isEdit = !!personalEventId && personalEventId !== 'new';

  const today = DateTime.now().toISODate()!;
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [timezone, setTimezone] = useState(user?.timezone ?? 'America/New_York');
  const [availability, setAvailability] = useState<PersonalAvailability>('busy');
  const [date, setDate] = useState(today);
  const [endDate, setEndDate] = useState(today);
  const [startTime, setStartTime] = useState('09:00');
  const [endTime, setEndTime] = useState('17:00');
  const [isRecurring, setIsRecurring] = useState(false);
  const [recurrence, setRecurrence] = useState<RecurrenceFormValue>(DEFAULT_RECURRENCE);
  const [loading, setLoading] = useState(isEdit);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Distinct from `error`, which is the save/validation message shown beside
  // the form. This one means the form was never filled in from the server, so
  // there is nothing safe to show at all.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadNonce, setLoadNonce] = useState(0);
  // 0.8.1 v2: true for a row cron/googleSync.ts imported from a connected
  // Google calendar. The worker refuses to save or delete one of these
  // (409, "can only be changed there") -- disabled here so that shows up as
  // a read-only form, not a failed save after someone filled the whole thing
  // in.
  const [importedFromGoogle, setImportedFromGoogle] = useState(false);

  // Pass-21 review (P21-01). Two defects in one loader, and the first is the
  // worse of the two because it needs no race at all.
  //
  // `if (pe.recurrence) { setIsRecurring(true); ... }` had no else. Load a
  // recurring block, then load a fixed one, and Repeats stayed ticked with the
  // PREVIOUS block's rule still in state -- so renaming the fixed block saved
  // it as recurring. Measured: a one-off became three daily occurrences on the
  // owner's own calendar, from an ordinary sequence with nothing held back and
  // nothing failing.
  //
  // The rule this file was missing: a loader must write EVERY field it owns,
  // for every record, including the fields the new record does not have. A
  // conditional set leaves the previous record's value behind, and the longer
  // the form the likelier that is.
  //
  // The second is the obsolete-response gap that P19-03 and P20-01 already
  // fixed in EventFormPage -- this is its third instance, in a file nobody had
  // touched. `latestOnly` and `editTargetReady` are the same shared primitives
  // rather than a third hand-rolled copy, which is the entire point of having
  // extracted them.
  const loadGate = useRef(latestOnly());
  const [loadedId, setLoadedId] = useState<string | null>(null);

  useEffect(() => {
    // Gate first, then the early return -- the same ordering EventFormPage
    // needed for P21-02 and this file did not get at the time. Remounting by
    // route identity (App.tsx) is what actually resets the draft; this makes
    // sure a response in flight when the mode changes cannot write either way.
    const isCurrent = loadGate.current.begin();
    if (!isEdit) {
      setLoadedId(null);
      return;
    }
    setLoadedId(null);
    setLoading(true);
    setLoadError(null);
    api
      .get<PersonalEvent>(`/personal-events/${personalEventId}`)
      .then((pe) => {
        if (!isCurrent()) return;
        setTitle(pe.title);
        setDescription(pe.description ?? '');
        setTimezone(pe.timezone);
        setAvailability(pe.availability);
        setImportedFromGoogle(pe.importedFromGoogle);
        if (pe.startAt) {
          const s = DateTime.fromMillis(pe.startAt).setZone(pe.timezone);
          setDate(s.toISODate()!);
          setStartTime(s.toFormat('HH:mm'));
        }
        if (pe.endAt) {
          const e = DateTime.fromMillis(pe.endAt).setZone(pe.timezone);
          setEndDate(e.toISODate()!);
          setEndTime(e.toFormat('HH:mm'));
        }
        if (!pe.recurrence) {
          // The else this loader never had. Without it a fixed block inherited
          // the previously loaded block's schedule wholesale.
          setIsRecurring(false);
          setRecurrence(DEFAULT_RECURRENCE);
        }
        if (pe.recurrence) {
          setIsRecurring(true);
          setRecurrence({
            freq: pe.recurrence.freq,
            interval: pe.recurrence.interval,
            byWeekday: pe.recurrence.byWeekday ?? [],
            byMonthDay: pe.recurrence.byMonthDay,
            endType: pe.recurrence.endType,
            endDate: pe.recurrence.endDate ?? '',
            endCount: pe.recurrence.endCount ?? 10,
          });
          // Pass-11 review (R25). The start was restored from the rule and the
          // *end* was not, so it kept the form's own defaults -- today's date
          // at 17:00 -- while the start jumped back to whenever the series
          // began. Saving then recomputed durationMinutes from those two
          // unrelated points: a recurring one-hour block that started a week
          // ago came back as a duration of seven days plus the span to 17:00,
          // so every weekly occurrence covered more than a week and its owner
          // showed as continuously busy. A block starting in the future could
          // produce a negative duration instead, and one more than 366 days
          // old failed validation outright. None of that needed the schedule
          // to be touched: renaming the block was enough.
          //
          // A recurring personal event has null startAt/endAt by design, so
          // the rule is the only description of when it happens -- both ends
          // of it have to be read from there.
          if (pe.recurrence.startDate && pe.recurrence.startTime) {
            const fields = scheduleFieldsFromRecurrence(pe.recurrence, pe.timezone);
            setDate(fields.date);
            setStartTime(fields.startTime);
            setEndDate(fields.endDate);
            setEndTime(fields.endTime);
          }
        }
        setLoadedId(personalEventId ?? null);
      })
      .catch((e: unknown) => {
        if (!isCurrent()) return;
        // Silently failing here is worse than a wrong empty state: the form
        // would sit at its blank defaults, and saving it would overwrite the
        // real block with them (idea 24).
        setLoadError(describeError(e));
      })
      .finally(() => {
        if (isCurrent()) setLoading(false);
      });
  }, [isEdit, personalEventId, loadNonce]);

  // Same rule as the event form: these fields belong to a record, and Save
  // must not write them to a different one.
  const targetReady = editTargetReady({ isEdit, loadedId, targetId: personalEventId });

  const toUtc = (d: string, t: string) => DateTime.fromISO(`${d}T${t}`, { zone: timezone }).toMillis();

  const handleStartDateChange = (next: string) => {
    setDate(next);
    if (endDate < next) setEndDate(next);
  };

  const handleSubmit = async () => {
    setError(null);
    if (!title.trim()) {
      setError('Give it a name so you know what it is on your calendar.');
      return;
    }
    setSaving(true);
    try {
      // These fields belong to the record the loader filled them from, and
      // Save targets whatever the route currently names (P21-01 / P20-01).
      if (!targetReady) {
        throw new Error('Still loading this block — give it a moment before saving.');
      }
      const body: Record<string, unknown> = {
        title: title.trim(),
        description: description.trim() || null,
        timezone,
        availability,
        isRecurring,
      };
      if (isRecurring) {
        body.recurrence = {
          freq: recurrence.freq,
          interval: recurrence.interval,
          byWeekday: recurrence.freq === 'WEEKLY' ? recurrence.byWeekday : null,
          byMonthDay: recurrence.freq === 'MONTHLY' ? DateTime.fromISO(date).day : null,
          startDate: date,
          startTime,
          durationMinutes: DateTime.fromISO(`${endDate}T${endTime}`).diff(
            DateTime.fromISO(`${date}T${startTime}`),
            'minutes',
          ).minutes,
          endType: recurrence.endType,
          endDate: recurrence.endType === 'on_date' ? recurrence.endDate : null,
          endCount: recurrence.endType === 'after_count' ? recurrence.endCount : null,
        };
      } else {
        body.startAt = toUtc(date, startTime);
        body.endAt = toUtc(endDate, endTime);
      }

      if (isEdit) {
        await api.patch(`/personal-events/${personalEventId}`, body);
      } else {
        await api.post('/personal-events', body);
      }
      navigate('/calendar');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save.');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!confirm('Delete this personal time block?')) return;
    setError(null);
    try {
      await api.delete(`/personal-events/${personalEventId}`);
    } catch (e) {
      // Navigating regardless made a refused delete look like a done one.
      setError(describeError(e));
      return;
    }
    navigate('/calendar');
  };

  if (loading) return <Loading />;
  if (loadError) {
    return (
      <ErrorState
        title="Couldn't open that block"
        message={loadError}
        onRetry={() => setLoadNonce((n) => n + 1)}
      />
    );
  }

  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <div className="flex items-start justify-between">
        <h1 className="text-2xl font-semibold">{isEdit ? 'Edit personal time' : 'Block personal time'}</h1>
        {isEdit && (
          <button
            onClick={handleDelete}
            disabled={importedFromGoogle}
            title={importedFromGoogle ? 'Imported entries can only be removed on the Google side.' : undefined}
            className="rounded-md border border-danger/60 px-3 py-1.5 text-sm text-danger-text hover:bg-danger-surface disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
          >
            Delete
          </button>
        )}
      </div>

      {importedFromGoogle ? (
        <p className="rounded-md border border-edge bg-surface px-3 py-2 text-sm text-muted">
          Imported from your connected Google calendar, and read-only here — change the time, title
          or description on the Google side and it'll update on the next sync. Only you can see this;
          others just see that you're unavailable, never the name or details.
        </p>
      ) : (
        <p className="rounded-md border border-edge bg-surface px-3 py-2 text-sm text-muted">
          Only you can see this. Others just see that you're unavailable — never the name or details.
        </p>
      )}

      <fieldset disabled={importedFromGoogle} className="space-y-5">
      <div className="space-y-3">
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="What is it? (e.g. Work, Travel, Dinner)"
          className={controlClass('lg-base', 'w-full')}
        />
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Notes (optional)"
          className={controlClass('lg', 'w-full')}
          rows={2}
        />
        <div>
          <label className="mb-1 block text-sm text-muted">Timezone</label>
          <TimezoneSelect value={timezone} onChange={setTimezone} />
        </div>
      </div>

      <div className={cardClass('md', 'space-y-3')}>
        <div className="flex flex-wrap gap-3">
          <div className="flex-1 min-w-[8rem]">
            <label className="mb-1 block text-sm text-muted">Starts</label>
            <input
              type="date"
              value={date}
              onChange={(e) => handleStartDateChange(e.target.value)}
              className={controlClass('lg', 'w-full')}
            />
          </div>
          <div className="w-28">
            <label className="mb-1 block text-sm text-muted">at</label>
            <input
              type="time"
              value={startTime}
              onChange={(e) => setStartTime(e.target.value)}
              className={controlClass('lg', 'w-full')}
            />
          </div>
          <div className="flex-1 min-w-[8rem]">
            <label className="mb-1 block text-sm text-muted">Ends</label>
            <input
              type="date"
              value={endDate}
              min={date}
              onChange={(e) => setEndDate(e.target.value)}
              className={controlClass('lg', 'w-full')}
            />
          </div>
          <div className="w-28">
            <label className="mb-1 block text-sm text-muted">at</label>
            <input
              type="time"
              value={endTime}
              onChange={(e) => setEndTime(e.target.value)}
              className={controlClass('lg', 'w-full')}
            />
          </div>
        </div>
        {endDate !== date && (
          <p className="text-xs text-faint">
            Blocks {DateTime.fromISO(endDate).diff(DateTime.fromISO(date), 'days').days + 1} days.
          </p>
        )}

        <label className="flex items-center gap-2 text-sm text-ink-dim">
          <input type="checkbox" checked={isRecurring} onChange={(e) => setIsRecurring(e.target.checked)} />
          Repeats
        </label>
        {isRecurring && <RecurrenceForm value={recurrence} onChange={setRecurrence} />}

        <div className="space-y-2">
          <label className="flex items-start gap-2 text-sm text-ink-dim">
            <input
              type="radio"
              name="availability"
              checked={availability === 'busy'}
              onChange={() => setAvailability('busy')}
              className="mt-0.5"
            />
            <span>
              <strong>Busy</strong> — others see an opaque block here and won't schedule over it.
            </span>
          </label>
          <label className="flex items-start gap-2 text-sm text-ink-dim">
            <input
              type="radio"
              name="availability"
              checked={availability === 'considering'}
              onChange={() => setAvailability('considering')}
              className="mt-0.5"
            />
            <span>
              <strong>Considering</strong> — you haven't committed, and could still play. Doesn't block
              this time slot in the scheduling assistant.
            </span>
          </label>
          <label className="flex items-start gap-2 text-sm text-ink-dim">
            <input
              type="radio"
              name="availability"
              checked={availability === 'free'}
              onChange={() => setAvailability('free')}
              className="mt-0.5"
            />
            <span>
              <strong>Free</strong> — just a personal note on your own calendar; never blocks your
              availability.
            </span>
          </label>
        </div>
      </div>
      </fieldset>

      {error && <InlineError message={error} onDismiss={() => setError(null)} />}

      <div className="flex justify-end gap-2">
        <button
          onClick={() => navigate(-1)}
          className={buttonClass('secondary', 'lg')}
        >
          {importedFromGoogle ? 'Close' : 'Cancel'}
        </button>
        {!importedFromGoogle && (
          <button
            disabled={saving || !targetReady}
            onClick={handleSubmit}
            className={buttonClass('primary', 'lg')}
          >
            {saving ? 'Saving…' : !targetReady ? 'Loading…' : isEdit ? 'Save changes' : 'Block this time'}
          </button>
        )}
      </div>
    </div>
  );
}
