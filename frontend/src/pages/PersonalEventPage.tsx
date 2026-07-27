import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { DateTime } from 'luxon';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import RecurrenceForm, { RecurrenceFormValue } from '../components/RecurrenceForm';
import TimezoneSelect from '../components/TimezoneSelect';
import type { PersonalEvent } from '../types';

// Personal time: private to you, never shown to anyone else, and (unless you
// untick "show me as busy") it makes you look unavailable in other people's
// scheduling assistant without revealing what it is.
export default function PersonalEventPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const { personalEventId } = useParams();
  const isEdit = !!personalEventId && personalEventId !== 'new';

  const today = DateTime.now().toISODate()!;
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [timezone, setTimezone] = useState(user?.timezone ?? 'America/New_York');
  const [busy, setBusy] = useState(true);
  const [date, setDate] = useState(today);
  const [endDate, setEndDate] = useState(today);
  const [startTime, setStartTime] = useState('09:00');
  const [endTime, setEndTime] = useState('17:00');
  const [isRecurring, setIsRecurring] = useState(false);
  const [recurrence, setRecurrence] = useState<RecurrenceFormValue>({
    freq: 'WEEKLY',
    interval: 1,
    byWeekday: [],
    byMonthDay: null,
    endType: 'never',
    endDate: '',
    endCount: 10,
  });
  const [loading, setLoading] = useState(isEdit);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isEdit) return;
    api
      .get<PersonalEvent>(`/personal-events/${personalEventId}`)
      .then((pe) => {
        setTitle(pe.title);
        setDescription(pe.description ?? '');
        setTimezone(pe.timezone);
        setBusy(pe.busy);
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
          if (pe.recurrence.startDate) setDate(pe.recurrence.startDate);
          if (pe.recurrence.startTime) setStartTime(pe.recurrence.startTime);
        }
      })
      .finally(() => setLoading(false));
  }, [isEdit, personalEventId]);

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
      const body: Record<string, unknown> = {
        title: title.trim(),
        description: description.trim() || null,
        timezone,
        busy,
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
    await api.delete(`/personal-events/${personalEventId}`);
    navigate('/calendar');
  };

  if (loading) return <p className="text-slate-400">Loading…</p>;

  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <div className="flex items-start justify-between">
        <h1 className="text-2xl font-semibold">{isEdit ? 'Edit personal time' : 'Block personal time'}</h1>
        {isEdit && (
          <button
            onClick={handleDelete}
            className="rounded-md border border-red-800 px-3 py-1.5 text-sm text-red-400 hover:bg-red-950"
          >
            Delete
          </button>
        )}
      </div>

      <p className="rounded-md border border-slate-800 bg-slate-900 px-3 py-2 text-sm text-slate-400">
        Only you can see this. Others just see that you're unavailable — never the name or details.
      </p>

      <div className="space-y-3">
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="What is it? (e.g. Work, Travel, Dinner)"
          className="w-full rounded-md border border-slate-700 bg-slate-800 px-3 py-2"
        />
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Notes (optional)"
          className="w-full rounded-md border border-slate-700 bg-slate-800 px-3 py-2 text-sm"
          rows={2}
        />
        <div>
          <label className="mb-1 block text-sm text-slate-400">Timezone</label>
          <TimezoneSelect value={timezone} onChange={setTimezone} />
        </div>
      </div>

      <div className="space-y-3 rounded-lg border border-slate-800 bg-slate-900 p-4">
        <div className="flex flex-wrap gap-3">
          <div className="flex-1 min-w-[8rem]">
            <label className="mb-1 block text-sm text-slate-400">Starts</label>
            <input
              type="date"
              value={date}
              onChange={(e) => handleStartDateChange(e.target.value)}
              className="w-full rounded-md border border-slate-700 bg-slate-800 px-3 py-2 text-sm"
            />
          </div>
          <div className="w-28">
            <label className="mb-1 block text-sm text-slate-400">at</label>
            <input
              type="time"
              value={startTime}
              onChange={(e) => setStartTime(e.target.value)}
              className="w-full rounded-md border border-slate-700 bg-slate-800 px-3 py-2 text-sm"
            />
          </div>
          <div className="flex-1 min-w-[8rem]">
            <label className="mb-1 block text-sm text-slate-400">Ends</label>
            <input
              type="date"
              value={endDate}
              min={date}
              onChange={(e) => setEndDate(e.target.value)}
              className="w-full rounded-md border border-slate-700 bg-slate-800 px-3 py-2 text-sm"
            />
          </div>
          <div className="w-28">
            <label className="mb-1 block text-sm text-slate-400">at</label>
            <input
              type="time"
              value={endTime}
              onChange={(e) => setEndTime(e.target.value)}
              className="w-full rounded-md border border-slate-700 bg-slate-800 px-3 py-2 text-sm"
            />
          </div>
        </div>
        {endDate !== date && (
          <p className="text-xs text-slate-500">
            Blocks {DateTime.fromISO(endDate).diff(DateTime.fromISO(date), 'days').days + 1} days.
          </p>
        )}

        <label className="flex items-center gap-2 text-sm text-slate-300">
          <input type="checkbox" checked={isRecurring} onChange={(e) => setIsRecurring(e.target.checked)} />
          Repeats
        </label>
        {isRecurring && <RecurrenceForm value={recurrence} onChange={setRecurrence} />}

        <label className="flex items-start gap-2 text-sm text-slate-300">
          <input
            type="checkbox"
            checked={busy}
            onChange={(e) => setBusy(e.target.checked)}
            className="mt-0.5"
          />
          <span>
            Show me as busy — others see an opaque block here and won't schedule over it. Untick for
            something you want on your own calendar without blocking your availability.
          </span>
        </label>
      </div>

      {error && <p className="text-sm text-red-400">{error}</p>}

      <div className="flex justify-end gap-2">
        <button
          onClick={() => navigate(-1)}
          className="rounded-md border border-slate-700 px-4 py-2 text-sm hover:bg-slate-800"
        >
          Cancel
        </button>
        <button
          disabled={saving}
          onClick={handleSubmit}
          className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
        >
          {saving ? 'Saving…' : isEdit ? 'Save changes' : 'Block this time'}
        </button>
      </div>
    </div>
  );
}
