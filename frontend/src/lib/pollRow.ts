// Whether a multi-winner poll's row still takes an answer.
//
// A day that became its own event always does: answering on its row answers
// that event, which outlives the poll (item 99). Any other day closes when the
// poll is no longer active -- Pass 24's P24-04, seen on the 10 November
// walkthrough, where a cancelled poll still offered buttons whose presses were
// saved and shown while deciding nothing -- or, as before, when it is
// unconfirmed and the deadline has passed.
export function pollRowVotingClosed(
  option: { confirmedAt: number | null; sessionEventId?: string | null },
  pollStatus: string,
  deadlinePassed: boolean,
): boolean {
  if (option.sessionEventId) return false;
  if (pollStatus !== 'active') return true;
  return !option.confirmedAt && deadlinePassed;
}
