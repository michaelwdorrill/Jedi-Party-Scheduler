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
