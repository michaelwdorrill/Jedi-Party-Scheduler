import { useEffect, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { DateTime } from 'luxon';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import InviteePicker from '../components/InviteePicker';
import RecurrenceForm, { RecurrenceFormValue } from '../components/RecurrenceForm';
import TimezoneSelect from '../components/TimezoneSelect';
import type { EventDetail, Friend, Group, PollMode, PollStrategy } from '../types';

interface PollSlotDraft {
  key: string;
  date: string;
  startTime: string;
  endTime: string;
}

export default function EventFormPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const { eventId } = useParams();
  const [searchParams] = useSearchParams();
  const isEdit = !!eventId;

  const guildId = searchParams.get('guild') ?? '';
  const prefillDate = searchParams.get('date') ?? DateTime.now().toISODate()!;

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [game, setGame] = useState('');
  const [timezone, setTimezone] = useState(user?.timezone ?? 'America/New_York');
  const [eventType, setEventType] = useState<'single' | 'poll'>('single');

  // Single-event fields
  const [date, setDate] = useState(prefillDate);
  const [startTime, setStartTime] = useState('13:00');
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

  // Poll fields (shared)
  const [pollMode, setPollMode] = useState<PollMode>('options');
  const [pollStrategy, setPollStrategy] = useState<PollStrategy>('threshold');
  const [pollThreshold, setPollThreshold] = useState(3);
  const [pollDeadline, setPollDeadline] = useState(
    DateTime.fromISO(prefillDate).minus({ days: 1 }).toISODate()!,
  );

  // Poll fields ('options' mode)
  const [pollSlots, setPollSlots] = useState<PollSlotDraft[]>([
    { key: crypto.randomUUID(), date: prefillDate, startTime: '13:00', endTime: '17:00' },
  ]);
  const [multiWinner, setMultiWinner] = useState(false);

  // Poll fields ('window' mode)
  const [windowDate, setWindowDate] = useState(prefillDate);
  const [windowStartTime, setWindowStartTime] = useState('12:00');
  const [windowEndTime, setWindowEndTime] = useState('18:00');
  const [windowBlockHours, setWindowBlockHours] = useState(3);

  const [friends, setFriends] = useState<Friend[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [selectedUserIds, setSelectedUserIds] = useState<string[]>([]);
  const [selectedGroupIds, setSelectedGroupIds] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!guildId) return;
    Promise.all([
      api.get<Friend[]>(`/me/friends?guild_id=${guildId}`),
      api.get<Group[]>(`/guilds/${guildId}/groups`),
    ]).then(([f, g]) => {
      setFriends(f);
      setGroups(g);
    });
  }, [guildId]);

  useEffect(() => {
    if (!isEdit || !eventId) return;
    api.get<EventDetail>(`/events/${eventId}`).then((ev) => {
      setTitle(ev.title);
      setDescription(ev.description ?? '');
      setGame(ev.game ?? '');
      setTimezone(ev.timezone);
      setEventType(ev.eventType);
      setSelectedUserIds(
        ev.invites.filter((i) => i.invitedVia === 'individual').map((i) => i.userId),
      );
      setSelectedGroupIds(
        Array.from(new Set(ev.invites.map((i) => i.sourceGroupId).filter(Boolean))) as string[],
      );
      if (ev.eventType === 'single' && ev.startAt && ev.endAt) {
        const s = DateTime.fromMillis(ev.startAt).setZone(ev.timezone);
        const e = DateTime.fromMillis(ev.endAt).setZone(ev.timezone);
        setDate(s.toISODate()!);
        setStartTime(s.toFormat('HH:mm'));
        setEndTime(e.toFormat('HH:mm'));
      }
      if (ev.recurrence) {
        setIsRecurring(true);
        setRecurrence({
          freq: ev.recurrence.freq,
          interval: ev.recurrence.interval,
          byWeekday: ev.recurrence.byWeekday ?? [],
          byMonthDay: ev.recurrence.byMonthDay,
          endType: ev.recurrence.endType,
          endDate: ev.recurrence.endDate ?? '',
          endCount: ev.recurrence.endCount ?? 10,
        });
      }
      if (ev.eventType === 'poll') {
        setPollStrategy(ev.pollStrategy ?? 'threshold');
        setPollThreshold(ev.pollThresholdCount ?? 3);
        setPollMode(ev.pollMode ?? 'options');
        setMultiWinner(ev.pollResolutionMode === 'multi_winner');
        if (ev.pollDeadlineAt) {
          setPollDeadline(DateTime.fromMillis(ev.pollDeadlineAt).setZone(ev.timezone).toISODate()!);
        }
        if (ev.pollMode === 'window') {
          if (ev.windowStartAt) {
            const s = DateTime.fromMillis(ev.windowStartAt).setZone(ev.timezone);
            setWindowDate(s.toISODate()!);
            setWindowStartTime(s.toFormat('HH:mm'));
          }
          if (ev.windowEndAt) {
            setWindowEndTime(DateTime.fromMillis(ev.windowEndAt).setZone(ev.timezone).toFormat('HH:mm'));
          }
          if (ev.windowBlockMinutes) setWindowBlockHours(ev.windowBlockMinutes / 60);
        } else if (ev.pollOptions) {
          setPollSlots(
            ev.pollOptions.map((o) => {
              const s = DateTime.fromMillis(o.startAt).setZone(ev.timezone);
              const e = DateTime.fromMillis(o.endAt).setZone(ev.timezone);
              return {
                key: o.id,
                date: s.toISODate()!,
                startTime: s.toFormat('HH:mm'),
                endTime: e.toFormat('HH:mm'),
              };
            }),
          );
        }
      }
    });
  }, [isEdit, eventId]);

  const addPollSlot = () =>
    setPollSlots((prev) => [
      ...prev,
      { key: crypto.randomUUID(), date: prefillDate, startTime: '13:00', endTime: '17:00' },
    ]);

  const removePollSlot = (key: string) =>
    setPollSlots((prev) => prev.filter((s) => s.key !== key));

  const toggleUser = (id: string) =>
    setSelectedUserIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  const toggleGroup = (id: string) => {
    const alreadySelected = selectedGroupIds.includes(id);
    setSelectedGroupIds((prev) => (alreadySelected ? prev.filter((x) => x !== id) : [...prev, id]));
    // Pre-fill the game field from the group's default, but only when adding
    // a group and only if the organizer hasn't already typed something in.
    if (!alreadySelected && !game.trim()) {
      const groupGame = groups.find((g) => g.id === id)?.game;
      if (groupGame) setGame(groupGame);
    }
  };

  const toUtcMillis = (d: string, t: string) => DateTime.fromISO(`${d}T${t}`, { zone: timezone }).toMillis();

  const handleSubmit = async () => {
    setError(null);
    if (!title.trim()) {
      setError('Title is required.');
      return;
    }
    setSaving(true);
    try {
      const body: Record<string, unknown> = {
        title: title.trim(),
        description: description.trim() || null,
        game: game.trim() || null,
        eventType,
        timezone,
        invites: { userIds: selectedUserIds, groupIds: selectedGroupIds },
      };

      if (eventType === 'single') {
        body.isRecurring = isRecurring;
        if (isRecurring) {
          body.recurrence = {
            freq: recurrence.freq,
            interval: recurrence.interval,
            byWeekday: recurrence.freq === 'WEEKLY' ? recurrence.byWeekday : null,
            byMonthDay: recurrence.freq === 'MONTHLY' ? DateTime.fromISO(date).day : null,
            startDate: date,
            startTime,
            durationMinutes: DateTime.fromISO(`${date}T${endTime}`).diff(
              DateTime.fromISO(`${date}T${startTime}`),
              'minutes',
            ).minutes,
            endType: recurrence.endType,
            endDate: recurrence.endType === 'on_date' ? recurrence.endDate : null,
            endCount: recurrence.endType === 'after_count' ? recurrence.endCount : null,
          };
        } else {
          body.startAt = toUtcMillis(date, startTime);
          body.endAt = toUtcMillis(date, endTime);
        }
      } else {
        body.pollStrategy = pollStrategy;
        body.pollThresholdCount = pollStrategy === 'threshold' ? pollThreshold : null;
        body.pollDeadlineAt = DateTime.fromISO(`${pollDeadline}T23:59`, { zone: timezone }).toMillis();
        body.pollMode = pollMode;

        if (pollMode === 'window') {
          body.windowStartAt = toUtcMillis(windowDate, windowStartTime);
          body.windowEndAt = toUtcMillis(windowDate, windowEndTime);
          body.windowBlockMinutes = windowBlockHours * 60;
        } else {
          body.pollResolutionMode = pollStrategy === 'threshold' && multiWinner ? 'multi_winner' : 'single_winner';
          body.pollOptions = pollSlots.map((s) => ({
            startAt: toUtcMillis(s.date, s.startTime),
            endAt: toUtcMillis(s.date, s.endTime),
          }));
        }
      }

      if (isEdit) {
        await api.patch(`/events/${eventId}`, body);
        navigate(`/events/${eventId}`);
      } else {
        const created = await api.post<{ id: string }>(`/guilds/${guildId}/events`, body);
        navigate(`/events/${created.id}`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save event.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <h1 className="text-2xl font-semibold">{isEdit ? 'Edit Event' : 'New Event'}</h1>

      {!isEdit && (
        <div className="flex gap-1 rounded-md bg-slate-900 p-1 w-fit">
          <button
            onClick={() => setEventType('single')}
            className={`rounded px-3 py-1 text-sm ${eventType === 'single' ? 'bg-indigo-600 text-white' : 'text-slate-300'}`}
          >
            Fixed time
          </button>
          <button
            onClick={() => setEventType('poll')}
            className={`rounded px-3 py-1 text-sm ${eventType === 'poll' ? 'bg-indigo-600 text-white' : 'text-slate-300'}`}
          >
            Potential invite (poll)
          </button>
        </div>
      )}

      <div className="space-y-3">
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Title (e.g. Raid night)"
          className="w-full rounded-md border border-slate-700 bg-slate-800 px-3 py-2"
        />
        <input
          value={game}
          onChange={(e) => setGame(e.target.value)}
          placeholder="Game (optional)"
          className="w-full rounded-md border border-slate-700 bg-slate-800 px-3 py-2 text-sm"
        />
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Description (optional)"
          className="w-full rounded-md border border-slate-700 bg-slate-800 px-3 py-2 text-sm"
          rows={2}
        />
        <div>
          <label className="mb-1 block text-sm text-slate-400">Timezone</label>
          <TimezoneSelect value={timezone} onChange={setTimezone} />
        </div>
      </div>

      {eventType === 'single' ? (
        <div className="space-y-3 rounded-lg border border-slate-800 bg-slate-900 p-4">
          <div className="flex gap-3">
            <div className="flex-1">
              <label className="mb-1 block text-sm text-slate-400">Date</label>
              <input
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                className="w-full rounded-md border border-slate-700 bg-slate-800 px-3 py-2 text-sm"
              />
            </div>
            <div className="flex-1">
              <label className="mb-1 block text-sm text-slate-400">Start</label>
              <input
                type="time"
                value={startTime}
                onChange={(e) => setStartTime(e.target.value)}
                className="w-full rounded-md border border-slate-700 bg-slate-800 px-3 py-2 text-sm"
              />
            </div>
            <div className="flex-1">
              <label className="mb-1 block text-sm text-slate-400">End</label>
              <input
                type="time"
                value={endTime}
                onChange={(e) => setEndTime(e.target.value)}
                className="w-full rounded-md border border-slate-700 bg-slate-800 px-3 py-2 text-sm"
              />
            </div>
          </div>

          <label className="flex items-center gap-2 text-sm text-slate-300">
            <input type="checkbox" checked={isRecurring} onChange={(e) => setIsRecurring(e.target.checked)} />
            Repeats
          </label>
          {isRecurring && <RecurrenceForm value={recurrence} onChange={setRecurrence} />}
        </div>
      ) : (
        <div className="space-y-3 rounded-lg border border-slate-800 bg-slate-900 p-4">
          {!isEdit && (
            <div className="flex gap-1 rounded-md bg-slate-800 p-1 w-fit">
              <button
                onClick={() => setPollMode('options')}
                className={`rounded px-3 py-1 text-xs ${pollMode === 'options' ? 'bg-indigo-600 text-white' : 'text-slate-300'}`}
              >
                Candidate days/times
              </button>
              <button
                onClick={() => setPollMode('window')}
                className={`rounded px-3 py-1 text-xs ${pollMode === 'window' ? 'bg-indigo-600 text-white' : 'text-slate-300'}`}
              >
                Time window
              </button>
            </div>
          )}

          {pollMode === 'options' ? (
            <div className="space-y-2">
              {pollSlots.map((slot) => (
                <div key={slot.key} className="flex items-center gap-2">
                  <input
                    type="date"
                    value={slot.date}
                    onChange={(e) =>
                      setPollSlots((prev) =>
                        prev.map((s) => (s.key === slot.key ? { ...s, date: e.target.value } : s)),
                      )
                    }
                    className="rounded-md border border-slate-700 bg-slate-800 px-2 py-1.5 text-sm"
                  />
                  <input
                    type="time"
                    value={slot.startTime}
                    onChange={(e) =>
                      setPollSlots((prev) =>
                        prev.map((s) => (s.key === slot.key ? { ...s, startTime: e.target.value } : s)),
                      )
                    }
                    className="rounded-md border border-slate-700 bg-slate-800 px-2 py-1.5 text-sm"
                  />
                  <span className="text-slate-500">to</span>
                  <input
                    type="time"
                    value={slot.endTime}
                    onChange={(e) =>
                      setPollSlots((prev) =>
                        prev.map((s) => (s.key === slot.key ? { ...s, endTime: e.target.value } : s)),
                      )
                    }
                    className="rounded-md border border-slate-700 bg-slate-800 px-2 py-1.5 text-sm"
                  />
                  {pollSlots.length > 1 && (
                    <button
                      onClick={() => removePollSlot(slot.key)}
                      className="text-xs text-red-400 hover:underline"
                    >
                      Remove
                    </button>
                  )}
                </div>
              ))}
              <button onClick={addPollSlot} className="text-sm text-indigo-400 hover:underline">
                + Add another time slot
              </button>
            </div>
          ) : (
            <div className="space-y-2">
              <p className="text-sm text-slate-400">
                Propose a window of time; invitees mark the range within it they could commit to, and the
                best-overlapping block is picked automatically.
              </p>
              <div className="flex flex-wrap items-end gap-3">
                <div>
                  <label className="mb-1 block text-sm text-slate-400">Date</label>
                  <input
                    type="date"
                    value={windowDate}
                    onChange={(e) => setWindowDate(e.target.value)}
                    className="rounded-md border border-slate-700 bg-slate-800 px-2 py-1.5 text-sm"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-sm text-slate-400">Window start</label>
                  <input
                    type="time"
                    value={windowStartTime}
                    onChange={(e) => setWindowStartTime(e.target.value)}
                    className="rounded-md border border-slate-700 bg-slate-800 px-2 py-1.5 text-sm"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-sm text-slate-400">Window end</label>
                  <input
                    type="time"
                    value={windowEndTime}
                    onChange={(e) => setWindowEndTime(e.target.value)}
                    className="rounded-md border border-slate-700 bg-slate-800 px-2 py-1.5 text-sm"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-sm text-slate-400">Session length (hours)</label>
                  <input
                    type="number"
                    min={0.5}
                    step={0.5}
                    value={windowBlockHours}
                    onChange={(e) => setWindowBlockHours(Math.max(0.5, Number(e.target.value)))}
                    className="w-24 rounded-md border border-slate-700 bg-slate-800 px-2 py-1.5 text-sm"
                  />
                </div>
              </div>
            </div>
          )}

          <div className="flex items-center gap-3">
            <label className="flex items-center gap-1 text-sm">
              <input
                type="radio"
                checked={pollStrategy === 'threshold'}
                onChange={() => setPollStrategy('threshold')}
              />
              Confirm once
              <input
                type="number"
                min={1}
                disabled={pollStrategy !== 'threshold'}
                value={pollThreshold}
                onChange={(e) => setPollThreshold(Math.max(1, Number(e.target.value)))}
                className="w-14 rounded-md border border-slate-700 bg-slate-800 px-2 py-1 text-xs disabled:opacity-50"
              />
              people say yes
            </label>
            <label className="flex items-center gap-1 text-sm">
              <input
                type="radio"
                checked={pollStrategy === 'most_votes'}
                onChange={() => {
                  setPollStrategy('most_votes');
                  setMultiWinner(false);
                }}
              />
              Pick the most popular slot at the deadline
            </label>
          </div>

          {pollMode === 'options' && pollStrategy === 'threshold' && (
            <label className="flex items-start gap-2 text-sm text-slate-300">
              <input
                type="checkbox"
                checked={multiWinner}
                onChange={(e) => setMultiWinner(e.target.checked)}
                className="mt-0.5"
              />
              <span>
                Confirm each day independently — if multiple days each get enough "I'm in"s, they all happen
                (instead of picking just one winner).
              </span>
            </label>
          )}

          <div>
            <label className="mb-1 block text-sm text-slate-400">
              Voting deadline (auto-resolve if the threshold isn't reached)
            </label>
            <input
              type="date"
              value={pollDeadline}
              onChange={(e) => setPollDeadline(e.target.value)}
              className="rounded-md border border-slate-700 bg-slate-800 px-3 py-2 text-sm"
            />
          </div>
        </div>
      )}

      <div className="rounded-lg border border-slate-800 bg-slate-900 p-4">
        <h2 className="mb-2 font-semibold">Invite</h2>
        <InviteePicker
          friends={friends}
          groups={groups}
          selectedUserIds={selectedUserIds}
          selectedGroupIds={selectedGroupIds}
          onToggleUser={toggleUser}
          onToggleGroup={toggleGroup}
        />
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
          {saving ? 'Saving…' : isEdit ? 'Save changes' : 'Create event'}
        </button>
      </div>
    </div>
  );
}
