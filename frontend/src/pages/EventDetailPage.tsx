import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { formatTimeRange } from '../lib/datetime';
import ChangeRequestSection from '../components/ChangeRequestSection';
import PollOptionRow from '../components/PollOptionRow';
import RsvpButtons from '../components/RsvpButtons';
import WindowAvailabilityPicker from '../components/WindowAvailabilityPicker';
import type { ChangeRequestView, EventDetail, Friend, PollVote, RsvpStatus, WindowInfo } from '../types';
import { useAction, useAsync } from '../lib/async';
import { ErrorState, InlineError, Loading, buttonClass, cardClass } from '../components/ui';

type WindowDraft = { startAt: number; endAt: number };

// Hoisted out of the component so the draft-sync effect below can depend on
// `windowInfo` alone rather than on a closure rebuilt every render.
function defaultWindowDraft(w: WindowInfo): WindowDraft | null {
  if (w.windowStartAt == null || w.windowEndAt == null || w.windowBlockMinutes == null) return null;
  return {
    startAt: w.windowStartAt,
    endAt: Math.min(w.windowEndAt, w.windowStartAt + w.windowBlockMinutes * 60000),
  };
}

// The three requests this page needs, as one unit -- a page drawn from the
// event but without its change requests would be quietly wrong, so they
// succeed or fail together (idea 24).
interface EventBundle {
  event: EventDetail;
  windowInfo: WindowInfo | null;
  changeRequests: ChangeRequestView[];
}

export default function EventDetailPage() {
  const { eventId } = useParams();
  const [searchParams] = useSearchParams();
  const occurrenceDate = searchParams.get('occurrence');
  const { user } = useAuth();
  const navigate = useNavigate();
  const [windowDraft, setWindowDraft] = useState<WindowDraft | null>(null);
  const [linkCopied, setLinkCopied] = useState(false);

  const { data, error, loading, reload } = useAsync<EventBundle | null>(async () => {
    if (!eventId) return null;
    const ev = await api.get<EventDetail>(`/events/${eventId}`);
    const windowInfo =
      ev.eventType === 'poll' && ev.pollMode === 'window'
        ? await api.get<WindowInfo>(`/events/${eventId}/window`)
        : null;
    const changeRequests =
      ev.status === 'active'
        ? await api.get<ChangeRequestView[]>(`/events/${eventId}/change-requests`)
        : [];
    return { event: ev, windowInfo, changeRequests };
  }, [eventId]);

  // Every mutation on this page was `await api.post(...); await load();` with
  // no catch, so a refused request became an unhandled rejection and the
  // button that made it appeared inert. That is what made idea 26's organiser
  // 403 so hard to read: the buttons did nothing, rather than saying no.
  const action = useAction();

  const event = data?.event ?? null;
  const windowInfo = data?.windowInfo ?? null;
  const changeRequests = data?.changeRequests ?? [];

  // Seeds the draft from the server's copy once, then leaves it alone -- a
  // reload after voting must not throw away a selection in progress.
  useEffect(() => {
    if (!windowInfo) return;
    setWindowDraft((prev) => prev ?? windowInfo.mySubmission ?? defaultWindowDraft(windowInfo));
  }, [windowInfo]);

  if (loading) return <Loading />;
  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (!event) return <p className="text-muted">Event not found.</p>;

  const isOrganizer = event.organizerId === user?.id;
  const zone = user?.timezone ?? event.timezone;
  const deadlinePassed = !!event.pollDeadlineAt && Date.now() > event.pollDeadlineAt;
  const isMultiWinner = event.pollResolutionMode === 'multi_winner';

  const handleRsvp = (status: RsvpStatus) =>
    action.run(async () => {
      await api.post(`/events/${event.eventId}/rsvp`, { status });
      reload();
    });

  const handleVote = (optionId: string, vote: PollVote) =>
    action.run(async () => {
      await api.post(`/events/${event.eventId}/poll/vote`, { optionId, vote });
      reload();
    });

  const handleSubmitWindow = async () => {
    if (!windowDraft) return;
    await action.run(async () => {
      await api.post(`/events/${event.eventId}/window`, windowDraft);
      reload();
    });
  };

  const handleCancelEvent = async () => {
    if (!confirm('Cancel this event for everyone?')) return;
    await action.run(async () => {
      await api.delete(`/events/${event.eventId}`);
      reload();
    });
  };

  const loadFriends = () => api.get<Friend[]>(`/me/friends?guild_id=${event.guildId}`);

  const handleFileTimeChange = async (input: {
    proposedStartAt: number;
    proposedEndAt: number;
    occurrenceDate?: string;
    message: string | null;
  }) => {
    await action.run(async () => {
      await api.post(`/events/${event.eventId}/change-requests`, { kind: 'time_change', ...input });
      reload();
    });
  };

  const handleFileAddInvitee = async (input: { targetUserId: string; message: string | null }) => {
    await action.run(async () => {
      await api.post(`/events/${event.eventId}/change-requests`, { kind: 'add_invitee', ...input });
      reload();
    });
  };

  const handleVoteChangeRequest = async (requestId: string, vote: PollVote) => {
    await action.run(async () => {
      await api.post(`/events/${event.eventId}/change-requests/${requestId}/vote`, { vote });
      reload();
    });
  };

  const handleAcceptChangeRequest = async (requestId: string) => {
    await action.run(async () => {
      await api.post(`/events/${event.eventId}/change-requests/${requestId}/accept`);
      reload();
    });
  };

  const handleDeclineChangeRequest = async (requestId: string) => {
    await action.run(async () => {
      await api.post(`/events/${event.eventId}/change-requests/${requestId}/decline`);
      reload();
    });
  };

  const handleWithdrawChangeRequest = async (requestId: string) => {
    await action.run(async () => {
      await api.delete(`/events/${event.eventId}/change-requests/${requestId}`);
      reload();
    });
  };

  const handleCancelOccurrence = async () => {
    if (!occurrenceDate) return;
    if (!confirm(`Cancel just the ${occurrenceDate} occurrence?`)) return;
    // Only navigates away if the cancel actually took -- the old version left
    // for the calendar regardless, so a refused cancel looked like a done one.
    if (await action.run(() => api.post(`/events/${event.eventId}/occurrences/${occurrenceDate}/cancel`, {}))) {
      navigate('/calendar');
    }
  };

  // Reconstructed rather than location.href verbatim, so a copied link never
  // carries the page's own transient view state (?occurrence=<date> on a
  // recurring event's day view) into a link meant to mean "this event," not
  // "this specific occurrence I happened to be looking at" (spec 0005).
  const handleCopyInviteLink = async () => {
    const link = `${location.origin}${location.pathname}#/events/${event.eventId}`;
    // `writeText` rejects when the document isn't focused or the permission is
    // refused, which would otherwise show "Copied!" over an empty clipboard.
    if (!(await action.run(() => navigator.clipboard.writeText(link)))) return;
    setLinkCopied(true);
    setTimeout(() => setLinkCopied(false), 4000);
  };

  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold">{event.title}</h1>
          {event.game && <p className="text-muted">{event.game}</p>}
          <p className="text-sm text-faint">
            Organized by {isOrganizer ? 'you' : event.organizerGlobalName ?? event.organizerUsername ?? 'someone no longer in this server'}
          </p>
        </div>
        {isOrganizer && event.status !== 'cancelled' && (
          <div className="flex gap-2">
            <button
              onClick={handleCopyInviteLink}
              className={buttonClass('secondary')}
            >
              {linkCopied ? 'Copied!' : 'Copy invite link'}
            </button>
            {event.status === 'active' && (
              <Link
                to={`/events/${event.eventId}/edit`}
                className={buttonClass('secondary')}
              >
                Edit
              </Link>
            )}
            {event.status === 'active' && event.isRecurring && occurrenceDate && (
              <button
                onClick={handleCancelOccurrence}
                className="rounded-md border border-warning/60 px-3 py-1.5 text-sm text-warning-text hover:bg-warning-surface"
              >
                Cancel this occurrence
              </button>
            )}
            <button
              onClick={handleCancelEvent}
              className="rounded-md border border-danger/60 px-3 py-1.5 text-sm text-danger-text hover:bg-danger-surface"
            >
              Cancel event
            </button>
          </div>
        )}
      </div>

      {action.error && <InlineError message={action.error} onDismiss={action.clearError} />}

      {linkCopied && (
        <p className="-mt-3 text-xs text-faint">
          Link copied — whoever you send it to will need to log in with Discord and be a member of this
          server to see it.
        </p>
      )}

      {event.status === 'cancelled' && (
        <p className="rounded-md bg-raised px-3 py-2 text-sm text-muted">
          This event has been cancelled.
        </p>
      )}

      {event.description && <p className="text-ink-dim">{event.description}</p>}

      {event.voiceChannelId && (
        <p className="text-sm text-muted">
          Voice channel:{' '}
          <a
            href={`https://discord.com/channels/${event.guildId}/${event.voiceChannelId}`}
            target="_blank"
            rel="noreferrer"
            className="text-accent-text hover:underline"
          >
            {event.voiceChannelName}
          </a>{' '}
          — confirmed attendees get a reminder DM shortly before start.
        </p>
      )}

      {event.eventType === 'single' && event.startAt && event.endAt && (
        <div className={cardClass()}>
          <p className="mb-3 font-medium">{formatTimeRange(event.startAt, event.endAt, zone)}</p>
          {event.status === 'active' && (
            <RsvpButtons current={event.myRsvpStatus} onChange={handleRsvp} />
          )}
        </div>
      )}

      {event.eventType === 'poll' && event.pollMode === 'options' && !isMultiWinner && event.status === 'active' && event.pollOptions && (
        <div className="space-y-2">
          <p className="text-sm text-muted">
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
          <p className="text-sm text-muted">
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
          <div className={cardClass('md', 'space-y-3')}>
            <p className="text-sm text-muted">
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
              className={buttonClass()}
            >
              {windowInfo.mySubmission ? 'Update my availability' : 'Submit my availability'}
            </button>
          </div>
        )}

      {event.eventType === 'poll' && event.status === 'resolved' && event.startAt && event.endAt && (
        <div className="rounded-lg border border-success/50 bg-success-surface/60 p-4">
          <p className="mb-1 text-sm text-success-text">This session is confirmed.</p>
          <p className="font-medium">{formatTimeRange(event.startAt, event.endAt, zone)}</p>
        </div>
      )}

      {user && (
        <ChangeRequestSection
          event={event}
          userId={user.id}
          isOrganizer={isOrganizer}
          isInvitee={event.invites.some((inv) => inv.userId === user.id)}
          requests={changeRequests}
          occurrenceDate={occurrenceDate}
          loadFriends={loadFriends}
          onFileTimeChange={handleFileTimeChange}
          onFileAddInvitee={handleFileAddInvitee}
          onVote={handleVoteChangeRequest}
          onAccept={handleAcceptChangeRequest}
          onDecline={handleDeclineChangeRequest}
          onWithdraw={handleWithdrawChangeRequest}
        />
      )}

      <div className={cardClass()}>
        <h2 className="mb-2 font-semibold">Invited</h2>
        <ul className="space-y-1 text-sm">
          {event.invites.map((inv) => (
            <li key={inv.userId} className="flex items-center justify-between">
              <span>{inv.globalName ?? inv.username}</span>
              <span className="text-muted">
                {event.eventType === 'single' ? inv.rsvpStatus : ''}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
