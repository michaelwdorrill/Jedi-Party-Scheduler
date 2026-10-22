import { DateTime } from 'luxon';
import { isValidRange } from './datetime';

// One definition of how a typed start-and-end becomes timestamps, in the
// event's own timezone. Shared by the invitee's change-request form and the
// organizer's Move this occurrence (IDEAS 94), which both propose a new time
// for one session -- so the two cannot drift into converting the same typed
// "7pm" into different instants.
//
// Extracted from ChangeRequestSection's MoveRequestForm unchanged: the seed's
// fallbacks (now, and an hour after the start) and the conversion are what
// that form already did inline.

export interface TimeRangeDraft {
  date: string; // yyyy-MM-dd
  startTime: string; // HH:mm
  endDate: string;
  endTime: string;
}

export function seedTimeRangeDraft(
  startAt: number | null,
  endAt: number | null,
  zone: string,
  now: number = Date.now(),
): TimeRangeDraft {
  const start = DateTime.fromMillis(startAt ?? now).setZone(zone);
  const end = endAt ? DateTime.fromMillis(endAt).setZone(zone) : start.plus({ hours: 1 });
  return {
    date: start.toFormat('yyyy-MM-dd'),
    startTime: start.toFormat('HH:mm'),
    endDate: end.toFormat('yyyy-MM-dd'),
    endTime: end.toFormat('HH:mm'),
  };
}

// False only when both ends parse and the end is not after the start --
// isValidRange's own rule, which deliberately leaves incomplete input alone.
export function timeRangeDraftOrdered(draft: TimeRangeDraft, zone: string): boolean {
  return isValidRange(draft.date, draft.startTime, draft.endDate, draft.endTime, zone);
}

// Every field filled with something that parses. timeRangeDraftOrdered does
// not ask this, by design, so a form that must not send a half-typed time asks
// both.
export function timeRangeDraftComplete(draft: TimeRangeDraft, zone: string): boolean {
  return (
    DateTime.fromISO(`${draft.date}T${draft.startTime}`, { zone }).isValid &&
    DateTime.fromISO(`${draft.endDate}T${draft.endTime}`, { zone }).isValid
  );
}

export function timeRangeDraftToMillis(draft: TimeRangeDraft, zone: string): { startAt: number; endAt: number } {
  return {
    startAt: DateTime.fromISO(`${draft.date}T${draft.startTime}`, { zone }).toMillis(),
    endAt: DateTime.fromISO(`${draft.endDate}T${draft.endTime}`, { zone }).toMillis(),
  };
}

// Moving the start takes the end with it, keeping the length -- asked for on
// the first browser walkthrough ("when I change a start date, the end date
// moves the same amount automatically") and applied to every start/end picker
// in the app, so they all behave one way: the event form's own times and each
// poll option row, a personal time block, and both "new time" forms.
//
// The length is ELAPSED time, so a 7pm-11pm session dragged across a DST
// change still lasts four hours (its end may read an hour different on the
// clock). That is what a calendar does, and the alternative -- keeping wall
// times -- makes a session spanning the change quietly gain or lose an hour.
//
// When the range as it stands has no positive length -- half-typed, or the end
// before the start -- there is no length to keep. The end then only moves as
// far as the old date-level nudge every form already had (an end DATE before
// the new start date is brought up to it), so a form someone is midway through
// typing is never rewritten under them beyond what it already did.
export function endFollowingStart(
  current: TimeRangeDraft,
  nextStart: { date: string; startTime: string },
  zone: string,
): { endDate: string; endTime: string } {
  const oldStart = DateTime.fromISO(`${current.date}T${current.startTime}`, { zone });
  const oldEnd = DateTime.fromISO(`${current.endDate}T${current.endTime}`, { zone });
  const newStart = DateTime.fromISO(`${nextStart.date}T${nextStart.startTime}`, { zone });
  const length = oldStart.isValid && oldEnd.isValid ? oldEnd.toMillis() - oldStart.toMillis() : 0;

  if (!newStart.isValid || length <= 0) {
    return {
      endDate: current.endDate < nextStart.date ? nextStart.date : current.endDate,
      endTime: current.endTime,
    };
  }
  const newEnd = newStart.plus({ milliseconds: length });
  return { endDate: newEnd.toFormat('yyyy-MM-dd'), endTime: newEnd.toFormat('HH:mm') };
}
