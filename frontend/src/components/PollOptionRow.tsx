import { Link } from 'react-router-dom';
import { voteCallsOffDay } from '../lib/callOff';
import { formatTimeRange } from '../lib/datetime';
import type { PollOption, PollVote, PollVoter, RsvpStatus } from '../types';

const VOTE_LABEL: Record<PollVote, string> = { yes: "I'm in", maybe: 'Maybe', no: "Can't make it" };

// IDEAS item 49: what to show for one voter -- their vote if there's
// nothing to override it with, or the overriding RSVP if there is
// (item 51's rule: an RSVP recorded since outranks the vote it disagrees
// with). Distinguishing the two rather than just picking one is the whole
// point -- "voted yes, now says can't make it" is the fact this display
// exists to surface.
//
// IDEAS 97 widened "disagrees" to an accept as well: once a confirmed day has
// its own event, someone who voted no on the poll can say they're in there.
const RSVP_AS_VOTE: Record<RsvpStatus, PollVote> = { accepted: 'yes', declined: 'no', tentative: 'maybe' };
const NOW_LABEL: Record<RsvpStatus, string> = { accepted: 'in now', declined: "can't make it now", tentative: 'maybe now' };
function voterLabel(voter: PollVoter): string {
  const name = voter.globalName ?? voter.username;
  if (voter.currentRsvpStatus == null || RSVP_AS_VOTE[voter.currentRsvpStatus] === voter.vote) {
    return `${name} (${VOTE_LABEL[voter.vote]})`;
  }
  return `${name} (voted ${VOTE_LABEL[voter.vote]}, ${NOW_LABEL[voter.currentRsvpStatus]})`;
}

export default function PollOptionRow({
  option,
  zone,
  onVote,
  votingDisabled,
  threshold = null,
}: {
  option: PollOption;
  zone: string;
  onVote: (vote: PollVote) => void;
  votingDisabled?: boolean;
  // Multi-winner only: how many must stay in for a confirmed day to stay on.
  threshold?: number | null;
}) {
  const total = option.tally.yes + option.tally.no + option.tally.maybe;
  const yesPct = total ? (option.tally.yes / total) * 100 : 0;
  // IDEAS 97: a confirmed day that dropped below the threshold after becoming
  // its own event. It stays visible -- people were told it was on -- but it
  // takes no answers, because the server refuses them.
  const calledOff = option.sessionStatus === 'cancelled';
  const when = formatTimeRange(option.startAt, option.endAt, zone);

  const press = (vote: PollVote) => {
    if (
      voteCallsOffDay(option, threshold, vote) &&
      !confirm(
        `This day needs ${threshold} people in, and saying you can't make it leaves ${option.confirmedUsers.length - 1}. ` +
          `It will be called off for everyone, and the people still coming will be told. It can't be put back on afterwards.`,
      )
    ) {
      return;
    }
    onVote(vote);
  };

  return (
    <div
      className={`rounded-md border p-3 ${
        option.confirmedAt && !calledOff ? 'border-success/60 bg-success-surface/50' : 'border-edge bg-surface'
      }`}
    >
      <div className="flex items-center justify-between">
        <span className={`font-medium ${calledOff ? 'text-muted line-through' : ''}`}>{when}</span>
        <span className="text-sm text-muted">
          {calledOff ? (
            <span className="text-danger-text">Called off</span>
          ) : option.confirmedAt ? (
            <span className="text-success-text">Confirmed</span>
          ) : (
            `${option.tally.yes} in`
          )}
        </span>
      </div>
      <div className="my-2 h-1.5 rounded-full bg-raised">
        <div className="h-1.5 rounded-full bg-success" style={{ width: `${yesPct}%` }} />
      </div>
      {option.confirmedAt && !calledOff && option.confirmedUsers.length > 0 && (
        <p className="mb-2 text-xs text-muted">
          Going: {option.confirmedUsers.map((u) => u.globalName ?? u.username).join(', ')}
        </p>
      )}
      {option.sessionEventId && !calledOff && (
        <p className="mb-2 text-xs text-muted">
          This day is now its own event &mdash;{' '}
          <Link to={`/events/${option.sessionEventId}`} className="text-accent-text hover:underline">
            open it
          </Link>
          . Answering here answers there.
        </p>
      )}
      {/* IDEAS item 49: everyone's answer, visible whether or not the poll
          has resolved -- the same thing a fixed-time event's invitee list
          and a window poll's submissions already show. */}
      {option.voters.length > 0 && (
        <p className="mb-2 text-xs text-faint">{option.voters.map(voterLabel).join(', ')}</p>
      )}
      {calledOff ? (
        <p className="text-xs text-faint">
          Fewer than {threshold ?? 'enough'} people were still in, so this day was called off.
        </p>
      ) : votingDisabled ? (
        <p className="text-xs text-faint">Voting for this day has closed.</p>
      ) : (
        <div className="flex gap-2">
          {(['yes', 'maybe', 'no'] as PollVote[]).map((v) => (
            <button
              key={v}
              onClick={() => press(v)}
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
