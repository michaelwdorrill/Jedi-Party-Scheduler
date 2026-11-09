import { describe, expect, it } from 'vitest';
import { DateTime } from 'luxon';
import { scheduleFieldsFromRecurrence } from '../src/lib/recurrenceFields';

// R24 and R25 from the Pass-11 security review.
//
// Both event editors resend the four date/time fields as the complete
// recurrence rule on every save, so whatever those fields are hydrated from
// becomes the series. Hydrating them from anything but the rule itself
// rewrites the schedule as a side effect of editing something unrelated -- a
// title, a description, a privacy checkbox.
//
// These tests are on the shared derivation rather than on the components,
// because that is where the bug actually was: both pages read the right value
// for the start and the wrong one (or none) for the end.
describe('scheduleFieldsFromRecurrence', () => {
  // The R25 scenario: a recurring one-hour block that began a week ago. The
  // start was restored and the end was not, so it kept the form default of
  // 17:00 today -- and saving recomputed the duration between those two
  // unrelated points as seven days plus change. The reviewer measured the
  // result the worker actually stored: duration_minutes = 10560.
  it('derives the end from the start and the stored duration', () => {
    const fields = scheduleFieldsFromRecurrence(
      { startDate: '2026-09-03', startTime: '09:00', durationMinutes: 60 },
      'UTC',
    );

    expect(fields).toEqual({
      date: '2026-09-03',
      startTime: '09:00',
      endDate: '2026-09-03',
      endTime: '10:00',
    });
  });

  // The property that matters, stated directly: feeding these fields back
  // through the same arithmetic the save path uses has to return the duration
  // it started with. That is what makes an unrelated edit a no-op against the
  // schedule, and it is exactly what failed before.
  it('round-trips the duration the save path recomputes', () => {
    for (const durationMinutes of [30, 60, 240, 24 * 60, 3 * 24 * 60]) {
      const rule = { startDate: '2026-09-03', startTime: '19:30', durationMinutes };
      const f = scheduleFieldsFromRecurrence(rule, 'UTC');

      // Precisely the expression in EventFormPage and PersonalEventPage.
      const recomputed = DateTime.fromISO(`${f.endDate}T${f.endTime}`)
        .diff(DateTime.fromISO(`${f.date}T${f.startTime}`), 'minutes').minutes;

      expect(recomputed).toBe(durationMinutes);
    }
  });

  // A session that runs past midnight has to keep its own end date rather
  // than collapsing onto the start's.
  it('carries an overnight block onto the following day', () => {
    const fields = scheduleFieldsFromRecurrence(
      { startDate: '2026-09-03', startTime: '23:00', durationMinutes: 180 },
      'UTC',
    );
    expect(fields.endDate).toBe('2026-09-04');
    expect(fields.endTime).toBe('02:00');
  });

  // The R24 scenario, as far as this function can speak to it: the fields
  // describe the series' own anchor, not whichever occurrence happens to be
  // next. A weekly series that began in August must still say August, months
  // later -- resending today's date is what truncated the earlier occurrences
  // and restarted after_count.
  it('reports the series anchor, not a later occurrence', () => {
    const fields = scheduleFieldsFromRecurrence(
      { startDate: '2026-08-06', startTime: '19:00', durationMinutes: 120 },
      'America/New_York',
    );
    expect(fields.date).toBe('2026-08-06');
    expect(fields.startTime).toBe('19:00');
  });
});
