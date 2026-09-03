// IDEAS item 54: minimum_attendees resolves once at a deadline instead of
// reacting to every decline in real time. Non-recurring events get an
// absolute deadline; recurring events get an "hours before" offset applied
// fresh to each occurrence. Worked example (Michael, Sept 2026): three
// occurrences each with a minimum of 4 -- A has 3 confirmed, B has 5, C has
// 4 -- only A gets cancelled.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runReminderSweep } from '../src/cron/reminders';
import {
  countRows,
  DM_CHANNEL_RULE,
  dmSendRule,
  HOUR_MS,
  membershipRule,
  seedAttendance,
  seedEvent,
  seedGuild,
  seedInvite,
  seedMembership,
  seedUser,
  setup,
  stubFetch,
  type FetchStub,
} from './helpers';
import type { ShimDatabase } from './d1shim';

let fetchStub: FetchStub | null = null;
afterEach(() => {
  fetchStub?.restore();
  fetchStub = null;
  vi.useRealTimers();
});

async function seedPeople(db: ShimDatabase, ids: string[]): Promise<void> {
  await seedGuild(db);
  for (const id of ids) {
    await seedUser(db, id);
    await seedMembership(db, id, 'guild-1');
  }
}

function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

async function isOccurrenceCancelled(db: ShimDatabase, eventId: string, date: string): Promise<boolean> {
  const row = await db
    .prepare(`SELECT is_cancelled FROM event_occurrence_overrides WHERE event_id = ? AND occurrence_date = ?`)
    .bind(eventId, date)
    .first<{ is_cancelled: number }>();
  return !!row?.is_cancelled;
}

describe('recurring minimum-attendees resolves per occurrence at its own deadline', () => {
  it("cancels only the occurrence below its minimum (Michael's A/B/C example)", async () => {
    const { db, env } = setup();
    const base = Date.now();
    vi.useFakeTimers();
    vi.setSystemTime(base);

    await seedPeople(db, ['organizer', 'bob', 'carol', 'dave', 'erin']);

    // DAILY, starting ~25h from now so the first occurrence's own deadline
    // (start - 1h) is 24h from now -- comfortably scannable but not yet due.
    const firstStart = base + 25 * HOUR_MS;
    const seriesStart = new Date(firstStart);
    const startDate = seriesStart.toISOString().slice(0, 10);
    const startTime = `${String(seriesStart.getUTCHours()).padStart(2, '0')}:${String(seriesStart.getUTCMinutes()).padStart(2, '0')}`;

    await seedEvent(db, { id: 'e1', organizerId: 'organizer', isRecurring: 1, startAt: null, endAt: null, title: 'Raid' });
    await db.prepare(`UPDATE events SET timezone = 'UTC' WHERE id = 'e1'`).run();
    await db
      .prepare(
        `UPDATE events SET minimum_attendees = 4, auto_cancel_below_minimum = 1, minimum_attendees_deadline_hours_before = 1 WHERE id = 'e1'`,
      )
      .run();
    await db
      .prepare(
        `INSERT INTO event_recurrence_rules (event_id, freq, interval, start_date, start_time, duration_minutes, end_type)
         VALUES ('e1', 'DAILY', 1, ?, ?, 60, 'never')`,
      )
      .bind(startDate, startTime)
      .run();
    for (const id of ['bob', 'carol', 'dave', 'erin']) await seedInvite(db, 'e1', id);

    const dateA = isoDate(firstStart);
    const dateB = isoDate(firstStart + 24 * HOUR_MS);
    const dateC = isoDate(firstStart + 48 * HOUR_MS);

    // A: organizer (implicit) + bob + carol accepted, dave + erin declined -> 3 confirmed.
    await seedAttendance(db, 'e1', 'bob', 'accepted', dateA);
    await seedAttendance(db, 'e1', 'carol', 'accepted', dateA);
    await seedAttendance(db, 'e1', 'dave', 'declined', dateA);
    await seedAttendance(db, 'e1', 'erin', 'declined', dateA);
    // B: everyone accepts -> organizer + 4 = 5 confirmed.
    for (const id of ['bob', 'carol', 'dave', 'erin']) await seedAttendance(db, 'e1', id, 'accepted', dateB);
    // C: three accept, one declines -> organizer + 3 = 4 confirmed (exactly the minimum).
    await seedAttendance(db, 'e1', 'bob', 'accepted', dateC);
    await seedAttendance(db, 'e1', 'carol', 'accepted', dateC);
    await seedAttendance(db, 'e1', 'dave', 'accepted', dateC);
    await seedAttendance(db, 'e1', 'erin', 'declined', dateC);

    fetchStub = stubFetch([DM_CHANNEL_RULE, dmSendRule(200), membershipRule(200)]);

    // Step 1: 24h + 1 minute from now -- only A's deadline (firstStart - 1h)
    // has passed. B and C's have not.
    vi.setSystemTime(base + 24 * HOUR_MS + 60_000);
    for (let i = 0; i < 3; i++) await runReminderSweep(env);
    expect(await isOccurrenceCancelled(db, 'e1', dateA)).toBe(true);
    expect(await isOccurrenceCancelled(db, 'e1', dateB)).toBe(false);
    expect(await isOccurrenceCancelled(db, 'e1', dateC)).toBe(false);

    // Step 2: 48h + 1 minute -- B's deadline has now passed too. It stays
    // uncancelled, since 5 >= 4.
    vi.setSystemTime(base + 48 * HOUR_MS + 60_000);
    for (let i = 0; i < 3; i++) await runReminderSweep(env);
    expect(await isOccurrenceCancelled(db, 'e1', dateB)).toBe(false);
    expect(await isOccurrenceCancelled(db, 'e1', dateC)).toBe(false);

    // Step 3: 72h + 1 minute -- C's deadline has passed. It stays
    // uncancelled too: 4 confirmed meets a minimum of 4 exactly ("below"
    // means strictly less than, matching the non-recurring cascade's own
    // >= comparison).
    vi.setSystemTime(base + 72 * HOUR_MS + 60_000);
    for (let i = 0; i < 3; i++) await runReminderSweep(env);
    expect(await isOccurrenceCancelled(db, 'e1', dateC)).toBe(false);

    // The series itself is untouched throughout -- only the one occurrence
    // was ever cancelled, never the whole event.
    const series = await db.prepare(`SELECT status FROM events WHERE id = 'e1'`).first<{ status: string }>();
    expect(series?.status).toBe('active');

    // Everyone still confirmed for A got the cancelled-below-minimum notice,
    // scoped to that occurrence's date.
    expect(
      await countRows(
        db,
        'notification_log',
        `event_id = 'e1' AND notification_type = 'event_cancelled_below_minimum' AND occurrence_date = ?`,
        dateA,
      ),
    ).toBeGreaterThan(0);
    expect(
      await countRows(
        db,
        'notification_log',
        `event_id = 'e1' AND notification_type = 'event_cancelled_below_minimum' AND occurrence_date = ?`,
        dateB,
      ),
    ).toBe(0);
  });

  it('sends the organizer a T-24h warning when an occurrence is still short, once', async () => {
    const { db, env } = setup();
    const base = Date.now();
    vi.useFakeTimers();
    vi.setSystemTime(base);

    await seedPeople(db, ['organizer', 'bob']);
    const firstStart = base + 30 * HOUR_MS; // deadline (hoursBefore=6) at +24h -- inside the 24h warning window now
    const seriesStart = new Date(firstStart);
    const startDate = seriesStart.toISOString().slice(0, 10);
    const startTime = `${String(seriesStart.getUTCHours()).padStart(2, '0')}:${String(seriesStart.getUTCMinutes()).padStart(2, '0')}`;

    await seedEvent(db, { id: 'e1', organizerId: 'organizer', isRecurring: 1, startAt: null, endAt: null });
    await db.prepare(`UPDATE events SET timezone = 'UTC' WHERE id = 'e1'`).run();
    await db
      .prepare(
        `UPDATE events SET minimum_attendees = 3, auto_cancel_below_minimum = 0, minimum_attendees_deadline_hours_before = 6 WHERE id = 'e1'`,
      )
      .run();
    await db
      .prepare(
        `INSERT INTO event_recurrence_rules (event_id, freq, interval, start_date, start_time, duration_minutes, end_type)
         VALUES ('e1', 'DAILY', 1, ?, ?, 60, 'never')`,
      )
      .bind(startDate, startTime)
      .run();
    await seedInvite(db, 'e1', 'bob');
    // Only organizer + bob = 2, below the minimum of 3.
    await seedAttendance(db, 'e1', 'bob', 'accepted', isoDate(firstStart));

    fetchStub = stubFetch([DM_CHANNEL_RULE, dmSendRule(200), membershipRule(200)]);
    for (let i = 0; i < 3; i++) await runReminderSweep(env);

    expect(
      await countRows(
        db,
        'notification_log',
        `event_id = 'e1' AND notification_type = 'minimum_attendees_deadline_warning' AND user_id = 'organizer'`,
      ),
    ).toBe(1);

    // A further tick does not repeat it.
    for (let i = 0; i < 3; i++) await runReminderSweep(env);
    expect(
      await countRows(
        db,
        'notification_log',
        `event_id = 'e1' AND notification_type = 'minimum_attendees_deadline_warning'`,
      ),
    ).toBe(1);
  });
});

describe('non-recurring minimum-attendees with an absolute deadline', () => {
  it('does not react in real time to a decline once a deadline is set', async () => {
    const { db, env } = setup();
    await seedPeople(db, ['organizer', 'bob', 'carol']);
    const start = Date.now() + 48 * HOUR_MS;
    await seedEvent(db, { id: 'e1', organizerId: 'organizer', startAt: start, endAt: start + HOUR_MS });
    await db
      .prepare(
        `UPDATE events SET minimum_attendees = 2, auto_cancel_below_minimum = 1, minimum_attendees_deadline_at = ? WHERE id = 'e1'`,
      )
      .bind(start - HOUR_MS)
      .run();
    await seedInvite(db, 'e1', 'bob');
    await seedInvite(db, 'e1', 'carol');
    await seedAttendance(db, 'e1', 'bob', 'accepted', '');

    fetchStub = stubFetch([]);
    // A decline that would have synchronously cancelled the old (no-deadline)
    // event must not do so here -- the deadline hasn't arrived yet.
    const { recordRsvp } = await import('../src/lib/attendance');
    await recordRsvp(env, 'carol', 'e1', '', 'declined');

    const row = await db.prepare(`SELECT status FROM events WHERE id = 'e1'`).first<{ status: string }>();
    expect(row?.status).toBe('active');
  });

  it('cancels at the deadline if still below minimum', async () => {
    const { db, env } = setup();
    await seedPeople(db, ['organizer', 'bob', 'carol']);
    const start = Date.now() + HOUR_MS;
    await seedEvent(db, { id: 'e1', organizerId: 'organizer', startAt: start, endAt: start + HOUR_MS, title: 'Session' });
    await db
      .prepare(
        `UPDATE events SET minimum_attendees = 2, auto_cancel_below_minimum = 1, minimum_attendees_deadline_at = ? WHERE id = 'e1'`,
      )
      .bind(Date.now() - 1000) // already due
      .run();
    await seedInvite(db, 'e1', 'bob');
    await seedInvite(db, 'e1', 'carol');
    await seedAttendance(db, 'e1', 'bob', 'declined', '');
    await seedAttendance(db, 'e1', 'carol', 'declined', '');
    // organizer alone = 1, below the minimum of 2.

    fetchStub = stubFetch([DM_CHANNEL_RULE, dmSendRule(200), membershipRule(200)]);
    for (let i = 0; i < 3; i++) await runReminderSweep(env);

    const row = await db.prepare(`SELECT status FROM events WHERE id = 'e1'`).first<{ status: string }>();
    expect(row?.status).toBe('cancelled');
  });
});
