import { DateTime } from 'luxon';

// Turning a stored recurrence rule back into the four date/time fields the
// event forms edit (R24 and R25 in the Pass-11 review).
//
// Both editors had the same bug in different halves, and it is worth stating
// once here rather than twice in the pages. A recurring event's real schedule
// lives entirely in its rule: startDate, startTime and durationMinutes. What
// the API's top-level startAt/endAt say is something else -- for a guild event
// they are the *next occurrence*, with any per-occurrence override applied,
// and for a personal event they are null outright.
//
// Both forms then resend whatever is in those fields as the whole rule on
// every save. So hydrating them from anything but the rule rewrites the series
// as a side effect of editing something unrelated:
//
//   * EventFormPage read the resolved next occurrence, so renaming a weekly
//     series re-anchored it to today -- dropping its earlier occurrences out
//     of expansion and restarting after_count from the upcoming one.
//   * PersonalEventPage restored the start from the rule but left the end at
//     the form's defaults (today, 17:00), so saving recomputed the duration
//     between two unrelated points: a weekly one-hour block begun last week
//     came back as over seven days long.
//
// Deriving the end from start + duration is what keeps a save that changed
// nothing about the schedule a genuine no-op.
export interface RecurrenceSchedule {
  startDate: string;
  startTime: string;
  durationMinutes: number;
}

export interface ScheduleFields {
  date: string;
  startTime: string;
  endDate: string;
  endTime: string;
}

export function scheduleFieldsFromRecurrence(
  rule: RecurrenceSchedule,
  timezone: string,
): ScheduleFields {
  const start = DateTime.fromISO(`${rule.startDate}T${rule.startTime}`, { zone: timezone });
  const end = start.plus({ minutes: rule.durationMinutes });
  return {
    date: rule.startDate,
    startTime: rule.startTime,
    endDate: end.toISODate()!,
    endTime: end.toFormat('HH:mm'),
  };
}
