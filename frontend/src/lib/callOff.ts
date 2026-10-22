import type { EventDetail, PollOption, PollVote, RsvpStatus } from '../types';

// IDEAS 97: an answer that calls a day off for everyone is a destructive
// action, so it is confirmed first and the confirmation says what it does not
// undo (release-bar clause 4). These decide whether a given press is that
// answer. The server decides for real -- recordRsvp's minimum-attendees
// cascade -- so these only have to agree with it, not replace it.

// A confirmed multi-winner poll day that has its own event. Only "Can't make
// it" calls a day off, because only a decline runs the cascade; a maybe takes
// you out of the count without deciding anything.
export function voteCallsOffDay(option: PollOption, threshold: number | null, answer: PollVote): boolean {
  if (answer !== 'no' || threshold == null) return false;
  if (!option.sessionEventId || option.sessionStatus !== 'active') return false;
  if (option.myVote !== 'yes') return false;
  return option.confirmedUsers.length - 1 < threshold;
}

// The same question asked on the day's own event page -- or any one-off event
// with a minimum and auto-cancel on and no deadline, which is the reactive
// path recordRsvp takes. Counted the way the server counts: accepted
// invitees, plus the organizer unless they declined.
export function rsvpCallsOffEvent(event: EventDetail, myUserId: string | undefined, answer: RsvpStatus): boolean {
  if (answer !== 'declined' || !myUserId) return false;
  if (event.eventType !== 'single' || event.isRecurring || event.status !== 'active') return false;
  if (event.minimumAttendees == null || !event.autoCancelBelowMinimum) return false;
  if (event.minimumAttendeesDeadlineAt != null || event.minimumAttendeesDeadlineHoursBefore != null) return false;

  const going = new Set(event.invites.filter((i) => i.rsvpStatus === 'accepted').map((i) => i.userId));
  const organizerAnswer = event.invites.find((i) => i.userId === event.organizerId)?.rsvpStatus;
  if (organizerAnswer !== 'declined') going.add(event.organizerId);
  if (!going.has(myUserId)) return false;
  return going.size - 1 < event.minimumAttendees;
}
