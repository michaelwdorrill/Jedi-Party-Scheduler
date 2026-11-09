import { DateTime } from 'luxon';

// The first and last calendar days an occurrence is drawn on, in `zone`.
//
// The end is exclusive. A session from 8 PM to midnight is over the instant
// Monday begins, and drawing it on Monday as well (walkthrough R94, 10 Nov
// 2026) said it happened then. Using the last instant before the end keeps it
// on Sunday, while a session to 1:30 AM still spans both days. Zero-length and
// open-ended items sit on their start day.
export function dayRange(startAt: number, endAt: number | null, zone: string): { first: DateTime; last: DateTime } {
  const first = DateTime.fromMillis(startAt).setZone(zone).startOf('day');
  const lastInstant = endAt != null && endAt > startAt ? endAt - 1 : startAt;
  return { first, last: DateTime.fromMillis(lastInstant).setZone(zone).startOf('day') };
}
