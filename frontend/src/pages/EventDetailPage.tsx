import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { formatTimeRange } from '../lib/datetime';
import PollOptionRow from '../components/PollOptionRow';
import RsvpButtons from '../components/RsvpButtons';
import WindowAvailabilityPicker from '../components/WindowAvailabilityPicker';
import type { EventDetail, PollVote, RsvpStatus, WindowInfo } from '../types';

export default function EventDetailPage() {
  const { eventId } = useParams();
  const [searchParams] = useSearchParams();
  const occurrenceDate = searchParams.get('occurrence');
  const { user } = useAuth();
  const navigate = useNavigate();
  const [event, setEvent] = useState<EventDetail | null>(null);
  const [windowInfo, setWindowInfo] = useState<WindowInfo | null>(null);
  const [windowDraft, setWindowDraft] = useState<{ startAt: number; endAt: number } | null>(null);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    if (!eventId) return;
    setLoading(true);
    try {
      const ev = await api.get<EventDetail>(`/events/${eventId}`);
      setEvent(ev);
      if (ev.eventType === 'poll' && ev.pollMode === 'window') {
        const w = await api.get<WindowInfo>(`/events/${eventId}/window`);
        setWindowInfo(w);
        setWindowDraft((prev) => prev ?? w.mySubmission ?? defaultWindowDraft(w));
      }
    } finally {
      setLoading(false);
    }
  };

  function defaultWindowDraft(w: WindowInfo): { startAt: number; endAt: number } | null {
    if (w.windowStartAt == null || w.windowEndAt == null || w.windowBlockMinutes == null) return null;
    return { startAt: w.windowStartAt, endAt: Math.min(w.windowEndAt, w.windowStartAt + w.windowBlockMinutes * 60000) };
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventId]);

  if (loading) return <p className="text-slate-400">Loading…</p>;
  if (!event) return <p className="text-slate-400">Event not found.</p>;

  const isOrganizer = event.organizerId === user?.id;
  const zone = user?.timezone ?? event.timezone;
  const deadlinePassed = !!event.pollDeadlineAt && Date.now() > event.pollDeadlineAt;
  const isMultiWinner = event.pollResolutionMode === 'multi_winner';

  const handleRsvp = async (status: RsvpStatus) => {
    await api.post(`/events/${event.eventId}/rsvp`, { status });
    await load();
  };

  const handleVote = async (optionId: string, vote: PollVote) => {
    await api.post(`/events/${event.eventId}/poll/vote`, { optionId, vote });
    await load();
  };

  const handleSubmitWindow = async () => {
    if (!windowDraft) return;
    await api.post(`/events/${event.eventId}/window`, windowDraft);
    await load();
  };

  const handleCancelEvent = async () => {
    if (!confirm('Cancel this event for everyone?')) return;
    await api.delete(`/events/${event.eventId}`);
    await load();
  };

  const handleCancelOccurrence = async () => {
    if (!occurrenceDate) return;
    if (!confirm(`Cancel just the ${occurrenceDate} occurrence?`)) return;
    await api.post(`/events/${event.eventId}/occurrences/${occurrenceDate}/cancel`, {});
    navigate('/calendar');
  };

  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold">{event.title}</h1>
          {event.game && <p className="text-slate-400">{event.game}</p>}
          <p className="text-sm text-slate-500">
            Organized by {isOrganizer ? 'you' : event.organizerGlobalName ?? event.organizerUsername ?? 'someone no longer in this server'}
          </p>
        </div>
        {isOrganizer && event.status !== 'cancelled' && (
          <div className="flex gap-2">
            {event.status === 'active' && (
              <Link
                to={`/events/${event.eventId}/edit`}
                className="rounded-md border border-slate-700 px-3 py-1.5 text-sm hover:bg-slate-800"
              >
                Edit
              </Link>
            )}
            {event.status === 'active' && event.isRecurring && occurrenceDate && (
              <button
                onClick={handleCancelOccurrence}
                className="rounded-md border border-amber-800 px-3 py-1.5 text-sm text-amber-400 hover:bg-amber-950"
              >
                Cancel this occurrence
              </button>
            )}
            <button
              onClick={handleCancelEvent}
              className="rounded-md border border-red-800 px-3 py-1.5 text-sm text-red-400 hover:bg-red-950"
            >
              Cancel event
            </button>
          </div>
        )}
      </div>

      {event.status === 'cancelled' && (
        <p className="rounded-md bg-slate-800 px-3 py-2 text-sm text-slate-400">
          This event has been cancelled.
        </p>
      )}

      {event.description && <p className="text-slate-300">{event.description}</p>}

      {event.voiceChannelId && (
        <p className="text-sm text-slate-400">
          Voice channel:{' '}
          <a
            href={`https://discord.com/channels/${event.guildId}/${event.voiceChannelId}`}
            target="_blank"
            rel="noreferrer"
            className="text-indigo-400 hover:underline"
          >
            {event.voiceChannelName}
          </a>{' '}
          — confirmed attendees get a reminder DM shortly before start.
        </p>
      )}

      {event.eventType === 'single' && event.startAt && event.endAt && (
        <div className="rounded-lg border border-slate-800 bg-slate-900 p-4">
          <p className="mb-3 font-medium">{formatTimeRange(event.startAt, event.endAt, zone)}</p>
          {event.status === 'active' && (
            <RsvpButtons current={event.myRsvpStatus} onChange={handleRsvp} />
          )}
        </div>
      )}

      {event.eventType === 'poll' && event.pollMode === 'options' && !isMultiWinner && event.status === 'active' && event.pollOptions && (
        <div className="space-y-2">
          <p className="text-sm text-slate-400">
            {event.pollStrategy === 'threshold'
              ? `Confirms once ${event.pollThresholdCount} people say they're in, otherwise by the deadline.`
              : "Whichever time slot has the most votes wins at the deadline."}
            {event.pollDeadlineAt && (
              <> Voting closes {formatTimeRange(event.pollDeadlineAt, event.pollDeadlineAt, zone).split(' –')[0]}.</>
            )}
          </p>
          {event.pollOptions.map((opt) => (
            <PollOptionRow
              key={opt.id}
              option={opt}
              zone={zone}
              onVote={(vote) => handleVote(opt.id, vote)}
            />
          ))}
        </div>
      )}

      {event.eventType === 'poll' && isMultiWinner && event.pollOptions && (
        <div className="space-y-2">
          <p className="text-sm text-slate-400">
            Each day is confirmed independently once {event.pollThresholdCount} people say they're in — any that
            qualify all happen. You can still vote (or join a confirmed day) any time before it starts.
          </p>
          {event.pollOptions.map((opt) => (
            <PollOptionRow
              key={opt.id}
              option={opt}
              zone={zone}
              onVote={(vote) => handleVote(opt.id, vote)}
              votingDisabled={!opt.confirmedAt && deadlinePassed}
            />
          ))}
        </div>
      )}

      {event.eventType === 'poll' &&
        event.pollMode === 'window' &&
        event.status === 'active' &&
        windowInfo &&
        windowInfo.windowStartAt != null &&
        windowInfo.windowEndAt != null &&
        windowInfo.windowBlockMinutes != null && (
          <div className="space-y-3 rounded-lg border border-slate-800 bg-slate-900 p-4">
            <p className="text-sm text-slate-400">
              {event.pollStrategy === 'threshold'
                ? `Confirms once ${event.pollThresholdCount} people can commit to the same block, otherwise by the deadline.`
                : 'The best-overlapping block wins at the deadline.'}
              {event.pollDeadlineAt && (
                <> Voting closes {formatTimeRange(event.pollDeadlineAt, event.pollDeadlineAt, zone).split(' –')[0]}.</>
              )}
            </p>
            {windowDraft && (
              <WindowAvailabilityPicker
                windowStartAt={windowInfo.windowStartAt}
                windowEndAt={windowInfo.windowEndAt}
                blockMinutes={windowInfo.windowBlockMinutes}
                value={windowDraft}
                onChange={setWindowDraft}
                zone={zone}
                otherSubmissions={windowInfo.submissions.filter((s) => s.userId !== user?.id)}
                bestCandidate={windowInfo.bestCandidate}
              />
            )}
            <button
              onClick={handleSubmitWindow}
              className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-500"
            >
              {windowInfo.mySubmission ? 'Update my availability' : 'Submit my availability'}
            </button>
          </div>
        )}

      {event.eventType === 'poll' && event.status === 'resolved' && event.startAt && event.endAt && (
        <div className="rounded-lg border border-emerald-900 bg-emerald-950/40 p-4">
          <p className="mb-1 text-sm text-emerald-400">This session is confirmed.</p>
          <p className="font-medium">{formatTimeRange(event.startAt, event.endAt, zone)}</p>
        </div>
      )}

      <div className="rounded-lg border border-slate-800 bg-slate-900 p-4">
        <h2 className="mb-2 font-semibold">Invited</h2>
        <ul className="space-y-1 text-sm">
          {event.invites.map((inv) => (
            <li key={inv.userId} className="flex items-center justify-between">
              <span>{inv.globalName ?? inv.username}</span>
              <span className="text-slate-400">
                {event.eventType === 'single' ? inv.rsvpStatus : ''}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
