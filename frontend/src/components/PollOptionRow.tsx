import { formatTimeRange } from '../lib/datetime';
import type { PollOption, PollVote, PollVoter } from '../types';

const VOTE_LABEL: Record<PollVote, string> = { yes: "I'm in", maybe: 'Maybe', no: "Can't make it" };

// IDEAS item 49: what to show for one voter -- their vote if there's
// nothing to override it with, or the overriding RSVP if there is
// (item 51's rule: an RSVP recorded since outranks the vote it disagrees
// with). Distinguishing the two rather than just picking one is the whole
// point -- "voted yes, now says can't make it" is the fact this display
// exists to surface.
function voterLabel(voter: PollVoter): string {
  const name = voter.globalName ?? voter.username;
  if (voter.currentRsvpStatus == null || voter.currentRsvpStatus === 'accepted') {
    return `${name} (${VOTE_LABEL[voter.vote]})`;
  }
  const override = voter.currentRsvpStatus === 'declined' ? "can't make it now" : 'maybe now';
  return `${name} (voted ${VOTE_LABEL[voter.vote]}, ${override})`;
}

export default function PollOptionRow({
  option,
  zone,
  onVote,
  votingDisabled,
}: {
  option: PollOption;
  zone: string;
  onVote: (vote: PollVote) => void;
  votingDisabled?: boolean;
}) {
  const total = option.tally.yes + option.tally.no + option.tally.maybe;
  const yesPct = total ? (option.tally.yes / total) * 100 : 0;

  return (
    <div
      className={`rounded-md border p-3 ${
        option.confirmedAt ? 'border-success/60 bg-success-surface/50' : 'border-edge bg-surface'
      }`}
    >
      <div className="flex items-center justify-between">
        <span className="font-medium">{formatTimeRange(option.startAt, option.endAt, zone)}</span>
        <span className="text-sm text-muted">
          {option.confirmedAt ? <span className="text-success-text">Confirmed</span> : `${option.tally.yes} in`}
        </span>
      </div>
      <div className="my-2 h-1.5 rounded-full bg-raised">
        <div className="h-1.5 rounded-full bg-success" style={{ width: `${yesPct}%` }} />
      </div>
      {option.confirmedAt && option.confirmedUsers.length > 0 && (
        <p className="mb-2 text-xs text-muted">
          Going: {option.confirmedUsers.map((u) => u.globalName ?? u.username).join(', ')}
        </p>
      )}
      {/* IDEAS item 49: everyone's answer, visible whether or not the poll
          has resolved -- the same thing a fixed-time event's invitee list
          and a window poll's submissions already show. */}
      {option.voters.length > 0 && (
        <p className="mb-2 text-xs text-faint">{option.voters.map(voterLabel).join(', ')}</p>
      )}
      {votingDisabled ? (
        <p className="text-xs text-faint">Voting for this day has closed.</p>
      ) : (
        <div className="flex gap-2">
          {(['yes', 'maybe', 'no'] as PollVote[]).map((v) => (
            <button
              key={v}
              onClick={() => onVote(v)}
              className={`rounded-md border px-2 py-1 text-xs ${
                option.myVote === v
                  ? 'border-accent-hover bg-accent text-on-accent'
                  : 'border-edge-strong text-ink-dim hover:bg-raised'
              }`}
            >
              {VOTE_LABEL[v]}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
