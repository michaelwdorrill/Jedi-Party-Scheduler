import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { DateTime } from 'luxon';
import { api, ApiError } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { useGuild } from '../auth/GuildContext';
import InviteePicker from '../components/InviteePicker';
import RecurrenceForm, { RecurrenceFormValue } from '../components/RecurrenceForm';
import TimezoneSelect from '../components/TimezoneSelect';
import SchedulingAssistant, { type AssistantSlot } from '../components/SchedulingAssistant';
import { isValidRange, startsInPast } from '../lib/datetime';
import type { EventDetail, Friend, Group, PollStrategy, VoiceChannel } from '../types';
import { describeError } from '../lib/async';
import { ErrorState, InlineError, buttonClass, cardClass, controlClass } from '../components/ui';

// Module scope on purpose: the availability memo below needs this during the
// first render pass, and the component-scoped `toUtcMillis` is a `const`
// declared two hundred lines further down -- reading it from a useMemo that
// runs earlier is a temporal-dead-zone ReferenceError, which TypeScript does
// not catch across a closure and which kills the whole New Event page.
// Verified: the version that read `toUtcMillis` here failed with
// "Cannot access 'nt' before initialization" and rendered nothing.
function localToMillis(date: string, time: string, zone: string): number {
  return DateTime.fromISO(`${date}T${time}`, { zone }).toMillis();
}

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
  // specs/0014 stage 3, decision 4 / IDEAS item 54. '' means "no minimum
  // set", distinct from 0 (which the server rejects anyway). Available on
  // both event shapes now -- which of the two deadline fields below applies
  // is decided by isRecurring, mirroring the server's own
  // assertMinimumAttendeesDeadlineShape.
  const [minimumAttendees, setMinimumAttendees] = useState('');
  const [autoCancelBelowMinimum, setAutoCancelBelowMinimum] = useState(false);
  // Non-recurring: an absolute point, entered the same way the event's own
  // start is (separate date/time fields combined via toUtcMillis below).
  // '' means "no deadline set", which keeps the original v0.6.2 real-time
  // reactive cascade rather than opting into the deadline-based one.
  const [minimumAttendeesDeadlineDate, setMinimumAttendeesDeadlineDate] = useState('');
  const [minimumAttendeesDeadlineTime, setMinimumAttendeesDeadlineTime] = useState('12:00');
  // Recurring: no single date to anchor to, so a relative offset applied
  // fresh to each occurrence instead. Required whenever minimumAttendees is
  // set on a recurring event -- there is no reactive fallback for it.
  const [minimumAttendeesDeadlineHoursBefore, setMinimumAttendeesDeadlineHoursBefore] = useState('24');
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

  // The one field that decides what the candidates above *mean* (specs/0013).
  // Off, each candidate is the session and people vote yes/no/maybe on it.
  // On, each candidate is a window and people say which part of it they can
  // make. There is no second tab any more because there was never a second
  // kind of poll -- a "time window" was one candidate with a minimum.
  const [windowed, setWindowed] = useState(false);
  const [windowBlockHours, setWindowBlockHours] = useState(2.5);

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

  // Every slot being proposed, so the availability strip can show all of them
  // rather than only the first (idea 39). One entry for a fixed-time event,
  // one per candidate for an options poll, one for a window poll's span --
  // which is also the shape windowed candidates want, being a candidate list
  // too.
  const assistantSlots: AssistantSlot[] = useMemo(() => {
    const range = (key: string, sd: string, st: string, ed: string, et: string): AssistantSlot | null => {
      const startAt = localToMillis(sd, st, timezone);
      const endAt = localToMillis(ed, et, timezone);
      return Number.isFinite(startAt) && Number.isFinite(endAt) && endAt > startAt
        ? { key, startAt, endAt }
        : null;
    };
    const keep = (s: AssistantSlot | null): s is AssistantSlot => s !== null;
    if (eventType === 'single') {
      return [range('single', date, startTime, endDate, endTime)].filter(keep);
    }
    return pollSlots.map((slot) => range(slot.key, slot.date, slot.startTime, slot.endDate, slot.endTime)).filter(keep);
  }, [timezone, eventType, date, startTime, endDate, endTime, pollSlots]);

  // Guild-agnostic and unconditional, for both create and edit: who you might
  // invite is no longer scoped to a server picked first (that's the whole
  // point of this ordering -- the server comes *from* who you invite now,
  // not the other way around). GET /me/friends with no guild_id is the same
  // cross-guild shape GroupEditor already uses, each friend carrying their
  // own guildIds so candidateServerIds below can narrow the same way a
  // group's roster does. Groups arrive unfiltered too, including ones with
  // no common server right now -- picking one of those is what surfaces the
  // "these invitees share no server" state below, rather than the group
  // silently never appearing.
  useEffect(() => {
    Promise.all([api.get<Friend[]>('/me/friends'), api.get<Group[]>('/me/groups')]).then(
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
  }, []);

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
      // The organizer's own row (idea 26) is not an invitee choice, so it is
      // not one of the picker's selections either. It is also not in the
      // picker at all -- `listFriends` excludes the caller -- so leaving it in
      // would mean submitting a chip nobody can see or untick, and resubmitting
      // the organizer as a *direct* invitee, which is the one class of invitee
      // that fails the whole edit if their membership cache has gone stale.
      // The server adds them back regardless of what this list says.
      setSelectedUserIds(
        ev.invites
          .filter((i) => i.invitedVia === 'individual' && i.userId !== ev.organizerId)
          .map((i) => i.userId),
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
      if (ev.eventType === 'single') {
        setMinimumAttendees(ev.minimumAttendees != null ? String(ev.minimumAttendees) : '');
        setAutoCancelBelowMinimum(ev.autoCancelBelowMinimum);
        if (ev.minimumAttendeesDeadlineAt != null) {
          const d = DateTime.fromMillis(ev.minimumAttendeesDeadlineAt).setZone(ev.timezone);
          setMinimumAttendeesDeadlineDate(d.toISODate()!);
          setMinimumAttendeesDeadlineTime(d.toFormat('HH:mm'));
        }
        if (ev.minimumAttendeesDeadlineHoursBefore != null) {
          setMinimumAttendeesDeadlineHoursBefore(String(ev.minimumAttendeesDeadlineHoursBefore));
        }
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
        setMultiWinner(ev.pollResolutionMode === 'multi_winner');
        if (ev.pollDeadlineAt) {
          setPollDeadline(DateTime.fromMillis(ev.pollDeadlineAt).setZone(ev.timezone).toISODate()!);
        }
        setWindowed(ev.windowBlockMinutes != null);
        if (ev.windowBlockMinutes) setWindowBlockHours(ev.windowBlockMinutes / 60);
        if (ev.pollOptions) {
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

  // The server field is now derived from who's invited, not the other way
  // around: start from every server you belong to, and narrow it by
  // intersecting with each selected friend's own guildIds and each selected
  // group's commonServers -- the same rule commonServerSet() runs
  // server-side (specs/0011 / IDEAS item 36), just recomputed here as the
  // roster changes rather than only checked on save. A friend fetched
  // without guildIds (shouldn't happen for this call shape, but matches
  // GroupEditor's own fail-open reasoning) is skipped rather than treated as
  // sharing nothing, so a data gap here can't wrongly zero out the set --
  // the server's own check is still what actually enforces this on submit.
  const candidateServerIds = useMemo(() => {
    let ids = new Set(guilds.map((g) => g.id));
    for (const uid of selectedUserIds) {
      const friend = friends.find((f) => f.id === uid);
      if (!friend?.guildIds) continue;
      const shared = new Set(friend.guildIds);
      ids = new Set([...ids].filter((id) => shared.has(id)));
    }
    for (const gid of selectedGroupIds) {
      const group = groups.find((g) => g.id === gid);
      if (!group) continue;
      const shared = new Set(group.commonServers.map((s) => s.id));
      ids = new Set([...ids].filter((id) => shared.has(id)));
    }
    return ids;
  }, [guilds, selectedUserIds, selectedGroupIds, friends, groups]);

  const candidateServers = useMemo(
    () => guilds.filter((g) => candidateServerIds.has(g.id)),
    [guilds, candidateServerIds],
  );
  const hasInvitees = selectedUserIds.length > 0 || selectedGroupIds.length > 0;
  const impossibleRoster = hasInvitees && candidateServerIds.size === 0;

  // A server chosen before the roster narrowed it away has to be let go --
  // otherwise the select would keep showing (and could still submit) a
  // value that's no longer one of its own options.
  useEffect(() => {
    if (isEdit) return;
    if (formGuildId && !candidateServerIds.has(formGuildId)) {
      setFormGuildId('');
      setVoiceChannelId('');
    }
  }, [candidateServerIds, formGuildId, isEdit]);

  const toUtcMillis = (d: string, t: string) => DateTime.fromISO(`${d}T${t}`, { zone: timezone }).toMillis();

  // Resolve the full invitee set (individuals + everyone in the chosen groups)
  // so the scheduling assistant reflects who would actually be asked.
  const inviteeIds = Array.from(
    new Set([
      ...selectedUserIds,
      ...selectedGroupIds.flatMap((gid) => groups.find((g) => g.id === gid)?.members.map((m) => m.id) ?? []),
    ]),
  );

  // Invitees no longer need clearing on a server change -- they're upstream
  // of it now, and the select only ever offers servers the current roster
  // actually has in common. Voice channels are still guild-scoped, so a
  // stale pick from a previous server still has to go.
  const handleGuildChange = (next: string) => {
    setFormGuildId(next);
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
    pollSlots.every((s) => isValidRange(s.date, s.startTime, s.endDate, s.endTime, timezone));
  // A window shorter than the minimum session it demands can never resolve --
  // there is no span inside it long enough to clear the bar. The server
  // rejects it outright; this is the client-side warning that says so before
  // the submit, the same relationship idea 12's range check has.
  const windowsFitTheMinimum = (slot: PollSlotDraft) =>
    !windowed ||
    toUtcMillis(slot.endDate, slot.endTime) - toUtcMillis(slot.date, slot.startTime) >=
      windowBlockHours * 3600_000;
  const windowMinimumsValid = eventType !== 'poll' || pollSlots.every(windowsFitTheMinimum);
  const rangeValid = singleRangeValid && pollSlotsValid && windowMinimumsValid;

  // Idea 28, and note what it is *not*: this never gates `rangeValid`, so it
  // cannot stop a submit. Dating an event in the past is unusual, not
  // incoherent -- it does no operational harm (the cron's reminder queries all
  // bound on `start_at >= now`, so it is simply never picked up) and there are
  // legitimate reasons for it: logging a session that already happened, or
  // correcting a mistyped year on one that has since passed.
  //
  // Timezones make blocking worse still: "tonight at 7" can already be in the
  // past in the organiser's own zone by the time the form is submitted, and a
  // hard stop would reject that with no way forward.
  //
  // Recurring is excluded rather than warned about. Its `date` is the series
  // start, which is *routinely* in the past on any established series, and the
  // warning's own claim -- that no reminders will be sent -- would be false
  // there, since future occurrences still get them.
  const pastStartWarning =
    eventType === 'single' && !isRecurring && startsInPast(date, startTime, timezone);

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
        // Sent explicitly either way (including null), same reasoning as
        // pollOptions' windowBlockMinutes below: absent would mean "leave
        // whatever is stored alone", which on an edit that clears the field
        // would silently keep the old minimum. IDEAS item 54: available on
        // both shapes now: exactly one of the two deadline fields is sent,
        // matching assertMinimumAttendeesDeadlineShape's own rule.
        body.minimumAttendees = minimumAttendees.trim() ? Number(minimumAttendees) : null;
        body.autoCancelBelowMinimum = autoCancelBelowMinimum;
        if (minimumAttendees.trim()) {
          if (isRecurring) {
            body.minimumAttendeesDeadlineHoursBefore = minimumAttendeesDeadlineHoursBefore.trim()
              ? Number(minimumAttendeesDeadlineHoursBefore)
              : null;
            body.minimumAttendeesDeadlineAt = null;
          } else {
            body.minimumAttendeesDeadlineAt = minimumAttendeesDeadlineDate.trim()
              ? toUtcMillis(minimumAttendeesDeadlineDate, minimumAttendeesDeadlineTime)
              : null;
            body.minimumAttendeesDeadlineHoursBefore = null;
          }
        } else {
          body.minimumAttendeesDeadlineAt = null;
          body.minimumAttendeesDeadlineHoursBefore = null;
        }
      } else {
        body.pollStrategy = pollStrategy;
        body.pollThresholdCount = pollStrategy === 'threshold' ? pollThreshold : null;
        body.pollDeadlineAt = DateTime.fromISO(`${pollDeadline}T23:59`, { zone: timezone }).toMillis();
        body.pollResolutionMode = pollStrategy === 'threshold' && multiWinner ? 'multi_winner' : 'single_winner';
        body.pollOptions = pollSlots.map((s) => ({
          startAt: toUtcMillis(s.date, s.startTime),
          endAt: toUtcMillis(s.endDate, s.endTime),
        }));
        // Sent explicitly either way, including the null. Absent means "leave
        // whatever is stored alone", which on an edit that unticks the box
        // would silently keep the poll windowed.
        body.windowBlockMinutes = windowed ? Math.round(windowBlockHours * 60) : null;
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
            className={`rounded px-3 py-1 font-display text-sm uppercase tracking-wide ${eventType === 'poll' ? 'bg-accent text-on-accent' : 'text-ink-dim'}`}
          >
            Potential Options
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
            <div className="flex-1 min-w-[7rem]">
              <label className="mb-1 block text-sm text-muted">Starts</label>
              <input
                type="date"
                value={date}
                onChange={(e) => handleStartDateChange(e.target.value)}
                className={controlClass('lg', 'w-full')}
              />
            </div>
            <div className="w-36">
              <label className="mb-1 block text-sm text-muted">at</label>
              <input
                type="time"
                value={startTime}
                onChange={(e) => setStartTime(e.target.value)}
                className={controlClass('lg', 'w-full')}
              />
            </div>
            <div className="flex-1 min-w-[7rem]">
              <label className="mb-1 block text-sm text-muted">Ends</label>
              <input
                type="date"
                value={endDate}
                min={date}
                onChange={(e) => setEndDate(e.target.value)}
                className={controlClass('lg', 'w-full')}
              />
            </div>
            <div className="w-36">
              <label className="mb-1 block text-sm text-muted">at</label>
              <input
                type="time"
                value={endTime}
                onChange={(e) => setEndTime(e.target.value)}
                className={controlClass('lg', 'w-full')}
              />
            </div>
          </div>
          {/* Danger for the incoherent, warning for the merely unusual --
              the two sit next to each other so the difference is visible in
              the code as well as on screen. */}
          {!singleRangeValid ? (
            <p className="text-xs text-danger-text">End must be after the start.</p>
          ) : (
            endDate !== date && (
              <p className="text-xs text-faint">
                Runs overnight / across {DateTime.fromISO(endDate).diff(DateTime.fromISO(date), 'days').days + 1} days.
              </p>
            )
          )}
          {pastStartWarning && (
            <p className="text-xs text-warning-text">
              This starts in the past. That's allowed — it just won't send anyone a reminder.
            </p>
          )}

          <label className="flex items-center gap-2 text-sm text-ink-dim">
            <input type="checkbox" checked={isRecurring} onChange={(e) => setIsRecurring(e.target.checked)} />
            Repeats
          </label>
          {isRecurring && <RecurrenceForm value={recurrence} onChange={setRecurrence} />}

          {/* specs/0014 stage 3, decision 4 / IDEAS item 54. Available while
              repeating now -- a deadline is what makes a recurring
              minimum coherent (per-occurrence, not reactive to every
              decline the moment it happens). */}
          <div className="space-y-2 border-t border-edge pt-3">
            <label className="flex items-center gap-2 text-sm text-ink-dim">
              <span>Minimum attendees</span>
              <input
                type="number"
                min={1}
                placeholder="none"
                value={minimumAttendees}
                onChange={(e) => setMinimumAttendees(e.target.value)}
                className={controlClass('sm')}
                style={{ width: '5rem' }}
              />
            </label>
            {minimumAttendees.trim() && (
              <>
                <label className="flex items-start gap-2 text-sm text-ink-dim">
                  <input
                    type="checkbox"
                    checked={autoCancelBelowMinimum}
                    onChange={(e) => setAutoCancelBelowMinimum(e.target.checked)}
                  />
                  <span>
                    Cancel automatically if attendance is still below this at the deadline. Otherwise you'll get a
                    DM to decide when it happens.
                  </span>
                </label>
                {isRecurring ? (
                  <label className="flex items-center gap-2 text-sm text-ink-dim">
                    <span>Check attendance</span>
                    <input
                      type="number"
                      min={1}
                      value={minimumAttendeesDeadlineHoursBefore}
                      onChange={(e) => setMinimumAttendeesDeadlineHoursBefore(e.target.value)}
                      className={controlClass('sm')}
                      style={{ width: '5rem' }}
                    />
                    <span>hours before each session</span>
                  </label>
                ) : (
                  <div className="flex flex-wrap items-center gap-2 text-sm text-ink-dim">
                    <span>Check attendance by</span>
                    <input
                      type="date"
                      value={minimumAttendeesDeadlineDate}
                      onChange={(e) => setMinimumAttendeesDeadlineDate(e.target.value)}
                      className={controlClass('sm')}
                    />
                    <input
                      type="time"
                      value={minimumAttendeesDeadlineTime}
                      onChange={(e) => setMinimumAttendeesDeadlineTime(e.target.value)}
                      className={controlClass('sm')}
                    />
                    <span className="text-xs text-faint">(leave blank to decide as soon as someone declines)</span>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      ) : (
        <div className={cardClass('md', 'space-y-3')}>
          <div className="space-y-2">
            {pollSlots.map((slot) => {
              const slotValid = isValidRange(slot.date, slot.startTime, slot.endDate, slot.endTime, timezone);
              const longEnough = windowsFitTheMinimum(slot);
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
                  {slotValid && !longEnough && (
                    <p className="mt-1 text-xs text-danger-text">
                      This option is shorter than the {windowBlockHours}-hour minimum, so nothing could ever fit in
                      it.
                    </p>
                  )}
                </div>
              );
            })}
            <button onClick={addPollSlot} className="text-sm text-accent-text hover:underline">
              + Add another option
            </button>
          </div>

          {/* The merge of what used to be two poll modes (specs/0013). A
              "time window" poll was always this poll with one option and a
              minimum, so it is a checkbox on the options rather than a
              separate tab you have to choose between up front -- and ticking
              it changes nothing about the options already entered, only what
              they mean. */}
          <label className="flex items-start gap-2 text-sm text-ink-dim">
            <input
              type="checkbox"
              checked={windowed}
              onChange={(e) => setWindowed(e.target.checked)}
              className="mt-0.5"
            />
            <span>
              These are windows, not fixed times — find any long enough session inside them. Invitees say which part
              of each window they could make, and the longest block the most people can all manage wins.
            </span>
          </label>

          {windowed && (
            <div className="flex flex-wrap items-end gap-3">
              <div>
                <label className="mb-1 block text-sm text-muted">Minimum session length (hours)</label>
                <input
                  type="number"
                  min={0.5}
                  step={0.5}
                  value={windowBlockHours}
                  onChange={(e) => setWindowBlockHours(Math.max(0.5, Number(e.target.value)))}
                  className={controlClass('sm', 'w-24')}
                />
              </div>
              <p className="text-xs text-faint pb-2">
                A floor, not a length. If everyone can stay longer, the session gets longer.
              </p>
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
              {windowed ? 'people can make the same block' : 'people say yes'}
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
              {windowed ? 'Pick the best overlap at the deadline' : 'Pick the most popular slot at the deadline'}
            </label>
          </div>

          {pollStrategy === 'threshold' && (
            <label className="flex items-start gap-2 text-sm text-ink-dim">
              <input
                type="checkbox"
                checked={multiWinner}
                onChange={(e) => setMultiWinner(e.target.checked)}
                className="mt-0.5"
              />
              <span>
                {windowed
                  ? 'Confirm each option independently — every window that enough people can make becomes its own session (instead of picking just one winner).'
                  : 'Confirm each day independently — if multiple days each get enough "I\'m in"s, they all happen (instead of picking just one winner).'}
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

      <div>
        <label className="mb-1 block text-sm text-muted">Server</label>
        {isEdit ? (
          <div className="w-full rounded-md border border-edge bg-surface px-3 py-2 text-sm text-muted">
            {guilds.find((g) => g.id === loadedGuildId)?.name ?? '—'}
          </div>
        ) : impossibleRoster ? (
          <p className="rounded-md border border-danger/60 bg-danger-surface px-3 py-2 text-sm text-danger-text">
            These invitees don't all share a single server — remove someone, or pick a different
            group, before choosing a venue.
          </p>
        ) : (
          <select
            value={formGuildId}
            onChange={(e) => handleGuildChange(e.target.value)}
            className={controlClass('lg', 'w-full')}
          >
            <option value="" disabled>
              {hasInvitees ? 'Choose a server…' : 'Choose a server, or invite someone first…'}
            </option>
            {candidateServers.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
        )}
      </div>

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

      {effectiveGuildId && (
        <div className={cardClass()}>
          <h2 className="mb-1 font-semibold">Availability</h2>
          <p className="mb-3 text-xs text-faint">
            Times only — you can see when someone is busy, never what they're doing.
          </p>
          <SchedulingAssistant
            guildId={effectiveGuildId}
            userIds={inviteeIds}
            slots={assistantSlots}
            zone={timezone}
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
