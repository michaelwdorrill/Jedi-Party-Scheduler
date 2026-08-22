import { useState } from 'react';
import { DateTime } from 'luxon';
import { formatTimeRange, isValidRange } from '../lib/datetime';
import InviteePicker from './InviteePicker';
import type { ChangeRequestView, EventDetail, Friend, PollVote } from '../types';
import { buttonClass, cardClass, controlClass } from './ui';

// Invitee change requests (docs/specs/0003-event-change-requests.md): lets an
// invitee ask the organizer to move the event or invite someone else,
// without ever writing the event themselves. See EventDetailPage.tsx for how
// this section's data is loaded and its handlers wired to the API.

const VOTE_LABEL: Record<PollVote, string> = { yes: "I'm in", maybe: 'Maybe', no: "Can't make it" };

function requesterName(r: ChangeRequestView): string {
  return r.requesterGlobalName ?? r.requesterUsername;
}

function MoveRequestForm({
  event,
  occurrenceDate,
  onSubmit,
  onCancel,
}: {
  event: EventDetail;
  occurrenceDate: string | null;
  onSubmit: (input: { proposedStartAt: number; proposedEndAt: number; occurrenceDate?: string; message: string | null }) => Promise<void>;
  onCancel: () => void;
}) {
  const zone = event.timezone;
  const seedStart = event.startAt ? DateTime.fromMillis(event.startAt).setZone(zone) : DateTime.now().setZone(zone);
  const seedEnd = event.endAt ? DateTime.fromMillis(event.endAt).setZone(zone) : seedStart.plus({ hours: 1 });
  const [date, setDate] = useState(seedStart.toFormat('yyyy-MM-dd'));
  const [startTime, setStartTime] = useState(seedStart.toFormat('HH:mm'));
  const [endDate, setEndDate] = useState(seedEnd.toFormat('yyyy-MM-dd'));
  const [endTime, setEndTime] = useState(seedEnd.toFormat('HH:mm'));
  const [occDate, setOccDate] = useState(occurrenceDate ?? '');
  const [message, setMessage] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const rangeValid = isValidRange(date, startTime, endDate, endTime, zone);
  const canSubmit = rangeValid && (!event.isRecurring || occDate.length > 0) && !submitting;

  const submit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      await onSubmit({
        proposedStartAt: DateTime.fromISO(`${date}T${startTime}`, { zone }).toMillis(),
        proposedEndAt: DateTime.fromISO(`${endDate}T${endTime}`, { zone }).toMillis(),
        occurrenceDate: event.isRecurring ? occDate : undefined,
        message: message.trim() || null,
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-3 rounded-md border border-edge-strong bg-raised/60 p-3">
      {event.isRecurring && (
        <div>
          <label className="mb-1 block text-xs text-muted">Which occurrence?</label>
          <input
            type="date"
            value={occDate}
            onChange={(e) => setOccDate(e.target.value)}
            className={controlClass('lg', 'w-full')}
          />
        </div>
      )}
      <div className="flex flex-wrap gap-3">
        <div className="flex-1 min-w-[8rem]">
          <label className="mb-1 block text-xs text-muted">Proposed start</label>
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className={controlClass('lg', 'w-full')}
          />
        </div>
        <div className="w-24">
          <label className="mb-1 block text-xs text-muted">at</label>
          <input
            type="time"
            value={startTime}
            onChange={(e) => setStartTime(e.target.value)}
            className={controlClass('lg', 'w-full')}
          />
        </div>
        <div className="flex-1 min-w-[8rem]">
          <label className="mb-1 block text-xs text-muted">Proposed end</label>
          <input
            type="date"
            value={endDate}
            onChange={(e) => setEndDate(e.target.value)}
            className={controlClass('lg', 'w-full')}
          />
        </div>
        <div className="w-24">
          <label className="mb-1 block text-xs text-muted">at</label>
          <input
            type="time"
            value={endTime}
            onChange={(e) => setEndTime(e.target.value)}
            className={controlClass('lg', 'w-full')}
          />
        </div>
      </div>
      {!rangeValid && <p className="text-xs text-red-400">End must be after the start.</p>}
      <textarea
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        placeholder="Note to the organizer (optional)"
        rows={2}
        className={controlClass('lg', 'w-full')}
      />
      <div className="flex gap-2">
        <button
          onClick={submit}
          disabled={!canSubmit}
          className={buttonClass()}
        >
          Send request
        </button>
        <button onClick={onCancel} className={buttonClass('secondary')}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function InviteRequestForm({
  friends,
  onSubmit,
  onCancel,
}: {
  friends: Friend[];
  onSubmit: (input: { targetUserId: string; message: string | null }) => Promise<void>;
  onCancel: () => void;
}) {
  const [targetUserId, setTargetUserId] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    if (!targetUserId || submitting) return;
    setSubmitting(true);
    try {
      await onSubmit({ targetUserId, message: message.trim() || null });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-3 rounded-md border border-edge-strong bg-raised/60 p-3">
      <InviteePicker
        friends={friends}
        selectedUserIds={targetUserId ? [targetUserId] : []}
        onToggleUser={(id) => setTargetUserId((prev) => (prev === id ? null : id))}
      />
      <textarea
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        placeholder="Note to the organizer (optional)"
        rows={2}
        className={controlClass('lg', 'w-full')}
      />
      <div className="flex gap-2">
        <button
          onClick={submit}
          disabled={!targetUserId || submitting}
          className={buttonClass()}
        >
          Send request
        </button>
        <button onClick={onCancel} className={buttonClass('secondary')}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function Tally({ tally }: { tally: { yes: number; no: number; maybe: number } }) {
  return (
    <span className="text-xs text-muted">
      {tally.yes} in · {tally.maybe} maybe · {tally.no} out
    </span>
  );
}

export default function ChangeRequestSection({
  event,
  userId,
  isOrganizer,
  isInvitee,
  requests,
  occurrenceDate,
  loadFriends,
  onFileTimeChange,
  onFileAddInvitee,
  onVote,
  onAccept,
  onDecline,
  onWithdraw,
}: {
  event: EventDetail;
  userId: string;
  isOrganizer: boolean;
  isInvitee: boolean;
  requests: ChangeRequestView[];
  occurrenceDate: string | null;
  loadFriends: () => Promise<Friend[]>;
  onFileTimeChange: (input: { proposedStartAt: number; proposedEndAt: number; occurrenceDate?: string; message: string | null }) => Promise<void>;
  onFileAddInvitee: (input: { targetUserId: string; message: string | null }) => Promise<void>;
  onVote: (requestId: string, vote: PollVote) => Promise<void>;
  onAccept: (requestId: string) => Promise<void>;
  onDecline: (requestId: string) => Promise<void>;
  onWithdraw: (requestId: string) => Promise<void>;
}) {
  const [openForm, setOpenForm] = useState<'move' | 'invite' | null>(null);
  const [friends, setFriends] = useState<Friend[] | null>(null);

  if (!isInvitee && !isOrganizer) return null;
  if (requests.length === 0 && !isInvitee) return null;

  const myRequests = requests.filter((r) => r.requesterId === userId);
  // Voting is invitee-only (the spec: "every current invitee" votes; the
  // organizer has Accept/Decline instead) -- gated on isInvitee, not merely
  // "not the requester", so the organizer never sees vote buttons on their
  // own event even though the GET response includes this row for them too.
  const votable = isInvitee
    ? requests.filter((r) => r.kind === 'time_change' && r.status === 'pending' && r.requesterId !== userId)
    : [];
  const organizerPending = isOrganizer ? requests.filter((r) => r.status === 'pending') : [];

  const openInviteForm = async () => {
    if (!friends) setFriends(await loadFriends());
    setOpenForm('invite');
  };

  return (
    <div className={cardClass('md', 'space-y-4')}>
      <h2 className="font-semibold">Change requests</h2>

      {isInvitee && event.status === 'active' && (
        <div className="space-y-2">
          <div className="flex flex-wrap gap-2">
            {event.eventType === 'single' && openForm !== 'move' && (
              <button
                onClick={() => setOpenForm('move')}
                className={buttonClass('secondary')}
              >
                Ask to move this
              </button>
            )}
            {openForm !== 'invite' && (
              <button
                onClick={openInviteForm}
                className={buttonClass('secondary')}
              >
                Suggest someone
              </button>
            )}
          </div>
          {openForm === 'move' && (
            <MoveRequestForm
              event={event}
              occurrenceDate={occurrenceDate}
              onCancel={() => setOpenForm(null)}
              onSubmit={async (input) => {
                await onFileTimeChange(input);
                setOpenForm(null);
              }}
            />
          )}
          {openForm === 'invite' && friends && (
            <InviteRequestForm
              friends={friends}
              onCancel={() => setOpenForm(null)}
              onSubmit={async (input) => {
                await onFileAddInvitee(input);
                setOpenForm(null);
              }}
            />
          )}
        </div>
      )}

      {votable.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-sm font-medium text-ink-dim">Open for your vote</h3>
          {votable.map((r) => (
            <div key={r.id} className="rounded-md border border-edge-strong bg-raised/40 p-3 text-sm">
              <p>
                {requesterName(r)} proposed moving this to{' '}
                {r.proposedStartAt && r.proposedEndAt && formatTimeRange(r.proposedStartAt, r.proposedEndAt, event.timezone)}
                {r.message && <span className="text-muted"> — “{r.message}”</span>}
              </p>
              <div className="mt-2 flex items-center gap-2">
                {(['yes', 'maybe', 'no'] as PollVote[]).map((v) => (
                  <button
                    key={v}
                    onClick={() => onVote(r.id, v)}
                    className={`rounded-md border px-2 py-1 text-xs ${
                      r.myVote === v ? 'border-accent-hover bg-accent text-white' : 'border-edge-strong text-ink-dim hover:bg-raised'
                    }`}
                  >
                    {VOTE_LABEL[v]}
                  </button>
                ))}
                {r.tally && <Tally tally={r.tally} />}
              </div>
            </div>
          ))}
        </div>
      )}

      {myRequests.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-sm font-medium text-ink-dim">My requests</h3>
          {myRequests.map((r) => (
            <div key={r.id} className="flex items-start justify-between rounded-md border border-edge p-2 text-sm">
              <div>
                <p>
                  {r.kind === 'time_change'
                    ? r.proposedStartAt && r.proposedEndAt
                      ? `Move to ${formatTimeRange(r.proposedStartAt, r.proposedEndAt, event.timezone)}`
                      : 'Move request'
                    : `Invite ${r.targetGlobalName ?? r.targetUsername ?? 'someone'}`}
                </p>
                <p className="text-xs text-faint">
                  {r.status}
                  {r.kind === 'time_change' && r.tally && r.status === 'pending' && <> — <Tally tally={r.tally} /></>}
                  {r.decisionNote && ` — ${r.decisionNote}`}
                </p>
              </div>
              {r.status === 'pending' && (
                <button onClick={() => onWithdraw(r.id)} className="text-xs text-muted hover:text-red-400">
                  Withdraw
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {isOrganizer && organizerPending.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-sm font-medium text-ink-dim">Pending requests</h3>
          {organizerPending.map((r) => (
            <div key={r.id} className="space-y-2 rounded-md border border-edge-strong bg-raised/40 p-3 text-sm">
              <p>
                {requesterName(r)}{' '}
                {r.kind === 'time_change'
                  ? r.proposedStartAt && r.proposedEndAt
                    ? `asked to move this to ${formatTimeRange(r.proposedStartAt, r.proposedEndAt, event.timezone)}`
                    : 'asked to move this'
                  : `asked to invite ${r.targetGlobalName ?? r.targetUsername ?? 'someone'}`}
              </p>
              {r.message && <p className="text-muted">“{r.message}”</p>}
              {r.stale && (
                <p className="text-xs text-amber-400">
                  This event has changed since the request was made — re-check before accepting.
                </p>
              )}
              <div className="flex items-center gap-2">
                <button
                  onClick={() => onAccept(r.id)}
                  className="rounded-md border border-emerald-800 px-2 py-1 text-xs text-emerald-400 hover:bg-emerald-950"
                >
                  Accept
                </button>
                <button
                  onClick={() => onDecline(r.id)}
                  className="rounded-md border border-red-800 px-2 py-1 text-xs text-red-400 hover:bg-red-950"
                >
                  Decline
                </button>
                {r.kind === 'time_change' && r.tally && <Tally tally={r.tally} />}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
