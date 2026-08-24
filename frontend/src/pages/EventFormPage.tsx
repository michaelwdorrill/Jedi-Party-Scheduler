import { useEffect, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { DateTime } from 'luxon';
import { api, ApiError } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { useGuild } from '../auth/GuildContext';
import InviteePicker from '../components/InviteePicker';
import RecurrenceForm, { RecurrenceFormValue } from '../components/RecurrenceForm';
import TimezoneSelect from '../components/TimezoneSelect';
import SchedulingAssistant from '../components/SchedulingAssistant';
import { isValidRange } from '../lib/datetime';
import type { EventDetail, Friend, Group, PollMode, PollStrategy, VoiceChannel } from '../types';
import { describeError } from '../lib/async';
import { ErrorState, InlineError, buttonClass, cardClass, controlClass } from '../components/ui';

interface PollSlotDraft {
  key: string;
  date: string;
  startTime: string;
  endDate: string;
  endTime: string;
}

export default function EventFormPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const { eventId } = useParams();
  const [searchParams] = useSearchParams();
  const isEdit = !!eventId;
  const { guilds, selectedGuildId: contextGuildId } = useGuild();

  const prefillDate = searchParams.get('date') ?? DateTime.now().toISODate()!;

  // Which server this event belongs to. Defaults to the ?guild= a calendar
  // day-click or "New Event" button already carries, falling back to the
  // last server you used if that's ever missing -- but the
  // picker below is what actually decides it from here on, not either of
  // those two initial sources. On edit this is never read; loadedGuildId (the
  // event's own guild, set once the event loads) is what's used instead, and
  // the picker renders read-only.
  const [formGuildId, setFormGuildId] = useState(
    () => searchParams.get('guild') || contextGuildId || '',
  );

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [game, setGame] = useState('');
  const [timezone, setTimezone] = useState(user?.timezone ?? 'America/New_York');
  const [eventType, setEventType] = useState<'single' | 'poll'>('single');

  // Single-event fields
  const [date, setDate] = useState(prefillDate);
  const [endDate, setEndDate] = useState(prefillDate);
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
    { key: crypto.randomUUID(), date: prefillDate, startTime: '13:00', endDate: prefillDate, endTime: '17:00' },
  ]);
  const [multiWinner, setMultiWinner] = useState(false);

  // Poll fields ('window' mode)
  const [windowStartDate, setWindowStartDate] = useState(prefillDate);
  const [windowEndDate, setWindowEndDate] = useState(prefillDate);
  const [windowStartTime, setWindowStartTime] = useState('12:00');
  const [windowEndTime, setWindowEndTime] = useState('18:00');
  const [windowBlockHours, setWindowBlockHours] = useState(3);

  const [friends, setFriends] = useState<Friend[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [selectedUserIds, setSelectedUserIds] = useState<string[]>([]);
  const [selectedGroupIds, setSelectedGroupIds] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A failed *load* on the edit route is not the same as a failed save: the
  // form would sit at its blank defaults, and saving it would overwrite the
  // real event with them (idea 24). So it replaces the form rather than
  // appearing beside it.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [inviteesError, setInviteesError] = useState<string | null>(null);

  // The guild whatever's currently loaded/selected actually belongs to: the
  // form picker's choice on create, the loaded event's own guild on edit
  // (read-only there, so there's nothing to reconcile with a picker).
  const [loadedGuildId, setLoadedGuildId] = useState('');
  const effectiveGuildId = isEdit ? loadedGuildId : formGuildId;
  const [voiceChannels, setVoiceChannels] = useState<VoiceChannel[]>([]);
  const [voiceChannelId, setVoiceChannelId] = useState('');

  // The revision this form was loaded at (F-08-B). Sent back unchanged on
  // PATCH so the server can tell this edit apart from one built on top of a
  // since-superseded read, rather than the two of them racing to overwrite
  // each other's changes in whatever order their requests happen to land.
  const [loadedRevision, setLoadedRevision] = useState<number | null>(null);

  useEffect(() => {
    // Keyed on effectiveGuildId, not the raw ?guild= param, so this also runs
    // on edit -- it previously didn't (the edit route carries no ?guild=),
    // which meant InviteePicker had nothing to show when editing an event.
    if (!effectiveGuildId) return;
    Promise.all([
      api.get<Friend[]>(`/me/friends?guild_id=${effectiveGuildId}`),
      api.get<Group[]>(`/guilds/${effectiveGuildId}/groups`),
    ]).then(
      ([f, g]) => {
        setFriends(f);
        setGroups(g);
        setInviteesError(null);
      },
      (e: unknown) => {
        // Not fatal to the form -- an event with no invitees is legal -- but
        // it has to say so, because an empty picker otherwise reads as "there
        // is nobody here to invite".
        setFriends([]);
        setGroups([]);
        setInviteesError(describeError(e));
      },
    );
  }, [effectiveGuildId]);

  useEffect(() => {
    if (!effectiveGuildId) return;
    api
      .get<VoiceChannel[]>(`/guilds/${effectiveGuildId}/voice-channels`)
      .then(setVoiceChannels)
      .catch(() => setVoiceChannels([])); // e.g. bot not yet invited to this server
  }, [effectiveGuildId]);

  useEffect(() => {
    if (!isEdit || !eventId) return;
    api.get<EventDetail>(`/events/${eventId}`).then((ev) => {
      setTitle(ev.title);
      setDescription(ev.description ?? '');
      setGame(ev.game ?? '');
      setTimezone(ev.timezone);
      setEventType(ev.eventType);
      setLoadedGuildId(ev.guildId);
      setLoadedRevision(ev.revision);
      setVoiceChannelId(ev.voiceChannelId ?? '');
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
        setEndDate(e.toISODate()!);
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
            setWindowStartDate(s.toISODate()!);
            setWindowStartTime(s.toFormat('HH:mm'));
          }
          if (ev.windowEndAt) {
            const e = DateTime.fromMillis(ev.windowEndAt).setZone(ev.timezone);
            setWindowEndDate(e.toISODate()!);
            setWindowEndTime(e.toFormat('HH:mm'));
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
                endDate: e.toISODate()!,
                endTime: e.toFormat('HH:mm'),
              };
            }),
          );
        }
      }
    }, (e: unknown) => setLoadError(describeError(e)));
  }, [isEdit, eventId]);

  const addPollSlot = () =>
    setPollSlots((prev) => [
      ...prev,
      { key: crypto.randomUUID(), date: prefillDate, startTime: '13:00', endDate: prefillDate, endTime: '17:00' },
    ]);

  const removePollSlot = (key: string) =>
    setPollSlots((prev) => prev.filter((s) => s.key !== key));

  // Same nudge as handleStartDateChange below, applied per-slot: moving a
  // candidate day's start date forward drags its own end date along if the
  // end would otherwise fall before it.
  const handleSlotStartDateChange = (key: string, next: string) =>
    setPollSlots((prev) =>
      prev.map((s) => (s.key === key ? { ...s, date: next, endDate: s.endDate < next ? next : s.endDate } : s)),
    );

  const handleWindowStartDateChange = (next: string) => {
    setWindowStartDate(next);
    if (windowEndDate < next) setWindowEndDate(next);
  };

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

  // Resolve the full invitee set (individuals + everyone in the chosen groups)
  // so the scheduling assistant reflects who would actually be asked.
  const inviteeIds = Array.from(
    new Set([
      ...selectedUserIds,
      ...selectedGroupIds.flatMap((gid) => groups.find((g) => g.id === gid)?.members.map((m) => m.id) ?? []),
    ]),
  );

  // Friends, groups and voice channels are all scoped to a guild, so
  // switching servers mid-form invalidates whatever was already picked from
  // the old one -- carrying those ids across would submit references the
  // server will reject as not belonging to the new guild.
  const handleGuildChange = (next: string) => {
    setFormGuildId(next);
    setSelectedUserIds([]);
    setSelectedGroupIds([]);
    setVoiceChannelId('');
  };

  // Moving the start forward drags an earlier end along with it, so the form
  // can't sit in a state that would submit a negative-length event.
  const handleStartDateChange = (next: string) => {
    setDate(next);
    if (endDate < next) setEndDate(next);
  };

  // Catches what handleStartDateChange doesn't: two same-day fields where the
  // end *time* (not date) is before the start time, which the date-level
  // nudge above has no way to see. Server-side, worker/src/lib/validate.ts
  // rejects this unconditionally -- this is the client-side warning that was
  // missing (idea 12), not a replacement for that check.
  const singleRangeValid =
    eventType !== 'single' || isValidRange(date, startTime, endDate, endTime, timezone);
  const pollSlotsValid =
    eventType !== 'poll' ||
    pollMode !== 'options' ||
    pollSlots.every((s) => isValidRange(s.date, s.startTime, s.endDate, s.endTime, timezone));
  const windowRangeValid =
    eventType !== 'poll' ||
    pollMode !== 'window' ||
    isValidRange(windowStartDate, windowStartTime, windowEndDate, windowEndTime, timezone);
  const rangeValid = singleRangeValid && pollSlotsValid && windowRangeValid;

  const handleSubmit = async () => {
    setError(null);
    if (!title.trim()) {
      setError('Title is required.');
      return;
    }
    if (!isEdit && !formGuildId) {
      setError('Choose a server.');
      return;
    }
    if (!rangeValid) {
      setError('End must be after the start.');
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
        voiceChannelId: voiceChannelId || null,
        voiceChannelName: voiceChannelId
          ? (voiceChannels.find((vc) => vc.id === voiceChannelId)?.name ?? null)
          : null,
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
            durationMinutes: DateTime.fromISO(`${endDate}T${endTime}`).diff(
              DateTime.fromISO(`${date}T${startTime}`),
              'minutes',
            ).minutes,
            endType: recurrence.endType,
            endDate: recurrence.endType === 'on_date' ? recurrence.endDate : null,
            endCount: recurrence.endType === 'after_count' ? recurrence.endCount : null,
          };
        } else {
          body.startAt = toUtcMillis(date, startTime);
          body.endAt = toUtcMillis(endDate, endTime);
        }
      } else {
        body.pollStrategy = pollStrategy;
        body.pollThresholdCount = pollStrategy === 'threshold' ? pollThreshold : null;
        body.pollDeadlineAt = DateTime.fromISO(`${pollDeadline}T23:59`, { zone: timezone }).toMillis();
        body.pollMode = pollMode;

        if (pollMode === 'window') {
          body.windowStartAt = toUtcMillis(windowStartDate, windowStartTime);
          body.windowEndAt = toUtcMillis(windowEndDate, windowEndTime);
          body.windowBlockMinutes = windowBlockHours * 60;
        } else {
          body.pollResolutionMode = pollStrategy === 'threshold' && multiWinner ? 'multi_winner' : 'single_winner';
          body.pollOptions = pollSlots.map((s) => ({
            startAt: toUtcMillis(s.date, s.startTime),
            endAt: toUtcMillis(s.endDate, s.endTime),
          }));
        }
      }

      if (isEdit) {
        if (loadedRevision != null) body.revision = loadedRevision;
        try {
          await api.patch(`/events/${eventId}`, body);
        } catch (e) {
          if (e instanceof ApiError && e.status === 409) {
            throw new Error('This event was changed elsewhere while you were editing it. Reload the page to see the latest version before saving again.');
          }
          throw e;
        }
        navigate(`/events/${eventId}`);
      } else {
        const created = await api.post<{ id: string }>(`/guilds/${formGuildId}/events`, body);
        navigate(`/events/${created.id}`);
      }
    } catch (e) {
      setError(describeError(e));
    } finally {
      setSaving(false);
    }
  };

  if (loadError) {
    return (
      <ErrorState
        title="Couldn't open that event"
        message={loadError}
        onRetry={() => window.location.reload()}
      />
    );
  }

  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <h1 className="text-2xl font-semibold">{isEdit ? 'Edit Event' : 'New Event'}</h1>

      {inviteesError && (
        <InlineError message={`Couldn't load who you can invite. ${inviteesError}`} />
      )}

      <div>
        <label className="mb-1 block text-sm text-muted">Server</label>
        {isEdit ? (
          <div className="w-full rounded-md border border-edge bg-surface px-3 py-2 text-sm text-muted">
            {guilds.find((g) => g.id === loadedGuildId)?.name ?? '—'}
          </div>
        ) : (
          <select
            value={formGuildId}
            onChange={(e) => handleGuildChange(e.target.value)}
            className={controlClass('lg', 'w-full')}
          >
            <option value="" disabled>
              Choose a server…
            </option>
            {guilds.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
        )}
      </div>

      {!isEdit && (
        <div className="flex gap-1 rounded-md bg-surface p-1 w-fit">
          <button
            onClick={() => setEventType('single')}
            className={`rounded px-3 py-1 font-display text-sm uppercase tracking-wide ${eventType === 'single' ? 'bg-accent text-on-accent' : 'text-ink-dim'}`}
          >
            Fixed time
          </button>
          <button
            onClick={() => setEventType('poll')}
            className={`rounded px-3 py-1 text-sm ${eventType === 'poll' ? 'bg-accent text-on-accent' : 'text-ink-dim'}`}
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
          className={controlClass('lg-base', 'w-full')}
        />
        <input
          value={game}
          onChange={(e) => setGame(e.target.value)}
          placeholder="Game (optional)"
          className={controlClass('lg', 'w-full')}
        />
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Description (optional)"
          className={controlClass('lg', 'w-full')}
          rows={2}
        />
        <div>
          <label className="mb-1 block text-sm text-muted">Timezone</label>
          <TimezoneSelect value={timezone} onChange={setTimezone} />
        </div>
      </div>

      {eventType === 'single' ? (
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
          {!singleRangeValid ? (
            <p className="text-xs text-danger-text">End must be after the start.</p>
          ) : (
            endDate !== date && (
              <p className="text-xs text-faint">
                Runs overnight / across {DateTime.fromISO(endDate).diff(DateTime.fromISO(date), 'days').days + 1} days.
              </p>
            )
          )}

          <label className="flex items-center gap-2 text-sm text-ink-dim">
            <input type="checkbox" checked={isRecurring} onChange={(e) => setIsRecurring(e.target.checked)} />
            Repeats
          </label>
          {isRecurring && <RecurrenceForm value={recurrence} onChange={setRecurrence} />}
        </div>
      ) : (
        <div className={cardClass('md', 'space-y-3')}>
          {!isEdit && (
            <div className="flex gap-1 rounded-md bg-raised p-1 w-fit">
              <button
                onClick={() => setPollMode('options')}
                className={`rounded px-3 py-1 text-xs ${pollMode === 'options' ? 'bg-accent text-on-accent' : 'text-ink-dim'}`}
              >
                Candidate days/times
              </button>
              <button
                onClick={() => setPollMode('window')}
                className={`rounded px-3 py-1 text-xs ${pollMode === 'window' ? 'bg-accent text-on-accent' : 'text-ink-dim'}`}
              >
                Time window
              </button>
            </div>
          )}

          {pollMode === 'options' ? (
            <div className="space-y-2">
              {pollSlots.map((slot) => {
                const slotValid = isValidRange(slot.date, slot.startTime, slot.endDate, slot.endTime, timezone);
                return (
                  <div key={slot.key}>
                    <div className="flex flex-wrap items-center gap-2">
                      <input
                        type="date"
                        value={slot.date}
                        onChange={(e) => handleSlotStartDateChange(slot.key, e.target.value)}
                        className={controlClass('sm')}
                      />
                      <input
                        type="time"
                        value={slot.startTime}
                        onChange={(e) =>
                          setPollSlots((prev) =>
                            prev.map((s) => (s.key === slot.key ? { ...s, startTime: e.target.value } : s)),
                          )
                        }
                        className={controlClass('sm')}
                      />
                      <span className="text-faint">to</span>
                      <input
                        type="date"
                        value={slot.endDate}
                        min={slot.date}
                        onChange={(e) =>
                          setPollSlots((prev) =>
                            prev.map((s) => (s.key === slot.key ? { ...s, endDate: e.target.value } : s)),
                          )
                        }
                        className={controlClass('sm')}
                      />
                      <input
                        type="time"
                        value={slot.endTime}
                        onChange={(e) =>
                          setPollSlots((prev) =>
                            prev.map((s) => (s.key === slot.key ? { ...s, endTime: e.target.value } : s)),
                          )
                        }
                        className={controlClass('sm')}
                      />
                      {pollSlots.length > 1 && (
                        <button
                          onClick={() => removePollSlot(slot.key)}
                          className="text-xs text-danger-text hover:underline"
                        >
                          Remove
                        </button>
                      )}
                    </div>
                    {!slotValid && <p className="mt-1 text-xs text-danger-text">End must be after the start.</p>}
                  </div>
                );
              })}
              <button onClick={addPollSlot} className="text-sm text-accent-text hover:underline">
                + Add another time slot
              </button>
            </div>
          ) : (
            <div className="space-y-2">
              <p className="text-sm text-muted">
                Propose a window of time; invitees mark the range within it they could commit to, and the
                best-overlapping block is picked automatically.
              </p>
              <div className="flex flex-wrap items-end gap-3">
                <div>
                  <label className="mb-1 block text-sm text-muted">Window starts</label>
                  <input
                    type="date"
                    value={windowStartDate}
                    onChange={(e) => handleWindowStartDateChange(e.target.value)}
                    className={controlClass('sm')}
                  />
                </div>
                <div>
                  <label className="mb-1 block text-sm text-muted">at</label>
                  <input
                    type="time"
                    value={windowStartTime}
                    onChange={(e) => setWindowStartTime(e.target.value)}
                    className={controlClass('sm')}
                  />
                </div>
                <div>
                  <label className="mb-1 block text-sm text-muted">Window ends</label>
                  <input
                    type="date"
                    value={windowEndDate}
                    min={windowStartDate}
                    onChange={(e) => setWindowEndDate(e.target.value)}
                    className={controlClass('sm')}
                  />
                </div>
                <div>
                  <label className="mb-1 block text-sm text-muted">at</label>
                  <input
                    type="time"
                    value={windowEndTime}
                    onChange={(e) => setWindowEndTime(e.target.value)}
                    className={controlClass('sm')}
                  />
                </div>
                <div>
                  <label className="mb-1 block text-sm text-muted">Session length (hours)</label>
                  <input
                    type="number"
                    min={0.5}
                    step={0.5}
                    value={windowBlockHours}
                    onChange={(e) => setWindowBlockHours(Math.max(0.5, Number(e.target.value)))}
                    className={controlClass('sm', 'w-24')}
                  />
                </div>
              </div>
              {!windowRangeValid && (
                <p className="text-xs text-danger-text">Window end must be after the window start.</p>
              )}
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
                className={controlClass('xs', 'w-14')}
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
            <label className="flex items-start gap-2 text-sm text-ink-dim">
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
            <label className="mb-1 block text-sm text-muted">
              Voting deadline (auto-resolve if the threshold isn't reached)
            </label>
            <input
              type="date"
              value={pollDeadline}
              onChange={(e) => setPollDeadline(e.target.value)}
              className={controlClass('lg')}
            />
          </div>
        </div>
      )}

      {effectiveGuildId && (
        <div className={cardClass()}>
          <h2 className="mb-1 font-semibold">Voice channel (optional)</h2>
          <p className="mb-3 text-xs text-faint">
            Shortly before start, confirmed attendees get a DM with a link to join this channel. Discord
            doesn't let a bot pull people into voice automatically -- this is just a one-click nudge.
          </p>
          {voiceChannels.length === 0 ? (
            <p className="text-sm text-faint">
              No voice channels found -- make sure the bot has been invited to this server.
            </p>
          ) : (
            <select
              value={voiceChannelId}
              onChange={(e) => setVoiceChannelId(e.target.value)}
              className={controlClass('lg', 'w-full')}
            >
              <option value="">None</option>
              {voiceChannels.map((vc) => (
                <option key={vc.id} value={vc.id}>
                  {vc.name}
                </option>
              ))}
            </select>
          )}
        </div>
      )}

      <div className={cardClass()}>
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

      {effectiveGuildId && (
        <div className={cardClass()}>
          <h2 className="mb-1 font-semibold">Availability</h2>
          <p className="mb-3 text-xs text-faint">
            Times only — you can see when someone is busy, never what they're doing.
          </p>
          <SchedulingAssistant
            guildId={effectiveGuildId}
            userIds={inviteeIds}
            date={eventType === 'single' ? date : pollMode === 'window' ? windowStartDate : (pollSlots[0]?.date ?? date)}
            zone={timezone}
            proposedStart={
              eventType === 'single'
                ? toUtcMillis(date, startTime)
                : pollMode === 'window'
                  ? toUtcMillis(windowStartDate, windowStartTime)
                  : pollSlots[0]
                    ? toUtcMillis(pollSlots[0].date, pollSlots[0].startTime)
                    : null
            }
            proposedEnd={
              eventType === 'single'
                ? toUtcMillis(endDate, endTime)
                : pollMode === 'window'
                  ? toUtcMillis(windowEndDate, windowEndTime)
                  : pollSlots[0]
                    ? toUtcMillis(pollSlots[0].endDate, pollSlots[0].endTime)
                    : null
            }
          />
        </div>
      )}

      {error && <InlineError message={error} onDismiss={() => setError(null)} />}

      <div className="flex justify-end gap-2">
        <button
          onClick={() => navigate(-1)}
          className={buttonClass('secondary', 'lg')}
        >
          Cancel
        </button>
        <button
          disabled={saving || !rangeValid}
          onClick={handleSubmit}
          className={buttonClass('primary', 'lg')}
        >
          {saving ? 'Saving…' : isEdit ? 'Save changes' : 'Create event'}
        </button>
      </div>
    </div>
  );
}
