import { afterEach, describe, expect, it, vi } from 'vitest';
import { runReminderSweep } from '../src/cron/reminders';
import {
  DAY_MS,
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
  seedWindowAvailability,
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

// specs/0014 stage 2: the reminder ladder. Coverage for the pieces that have
// no equivalent in the pre-ladder suite -- rung mutual exclusion and
// idempotency, a status change moving which rung applies, per-occurrence
// isolation, decision 7's floor, and the window-poll one-shot notice.

async function notificationRows(
  db: ShimDatabase,
  eventId: string,
  userId: string,
): Promise<{ notification_type: string; occurrence_date: string; delivered_at: number | null }[]> {
  const { results } = await db
    .prepare(
      `SELECT notification_type, occurrence_date, delivered_at FROM notification_log
       WHERE event_id = ? AND user_id = ? ORDER BY notification_type`,
    )
    .bind(eventId, userId)
    .all<{ notification_type: string; occurrence_date: string; delivered_at: number | null }>();
  return results;
}

function ladderRows<T extends { notification_type: string }>(rows: T[]): T[] {
  return rows.filter((r) => r.notification_type.startsWith('ladder_'));
}

async function seedUnansweredInvitee(db: ShimDatabase, eventId: string, startAt: number): Promise<void> {
  await seedGuild(db);
  await seedUser(db, 'organizer');
  await seedUser(db, 'invitee');
  await seedMembership(db, 'organizer', 'guild-1');
  await seedMembership(db, 'invitee', 'guild-1');
  await seedEvent(db, {
    id: eventId,
    organizerId: 'organizer',
    title: 'Ladder test event',
    startAt,
    endAt: startAt + HOUR_MS,
  });
  await seedInvite(db, eventId, 'invitee');
}

describe('each rung fires once and is not repeated on a later tick', () => {
  it('sends the due rung once and does not resend it on an idempotent re-sweep', async () => {
    const { db, env } = setup();
    const base = Date.now();
    vi.useFakeTimers();
    vi.setSystemTime(base);

    // 47h out: inside the 48h unanswered rung, nowhere near the 96h one.
    await seedUnansweredInvitee(db, 'e1', base + 47 * HOUR_MS);
    fetchStub = stubFetch([DM_CHANNEL_RULE, dmSendRule(200), membershipRule(200)]);

    await runReminderSweep(env);
    const afterFirst = ladderRows(await notificationRows(db, 'e1', 'invitee'));
    expect(afterFirst.map((r) => r.notification_type)).toEqual(['ladder_unanswered_48h']);
    expect(afterFirst[0].delivered_at).not.toBeNull();
    // The invite DM sent in this same tick also hits /messages, so the
    // baseline includes it -- the dedupe claim is about the *second* tick
    // adding nothing, not about the first tick sending exactly one message.
    const sendsAfterFirst = fetchStub.calls.filter((u) => u.includes('/messages')).length;

    // Same instant, another tick: the rung already has a delivered row, so
    // the dedupe predicate in pendingLadderRecipients must exclude it again.
    await runReminderSweep(env);
    const afterSecond = ladderRows(await notificationRows(db, 'e1', 'invitee'));
    expect(afterSecond).toHaveLength(1);
    expect(fetchStub.calls.filter((u) => u.includes('/messages'))).toHaveLength(sendsAfterFirst);
  });
});

describe('a status change mid-ladder moves to the new rung without repeating the old one', () => {
  it('fires the tentative rung after the unanswered rung already fired, and never re-sends the unanswered one', async () => {
    const { db, env } = setup();
    const base = Date.now();
    vi.useFakeTimers();
    vi.setSystemTime(base);

    await seedUnansweredInvitee(db, 'e1', base + 47 * HOUR_MS);
    fetchStub = stubFetch([DM_CHANNEL_RULE, dmSendRule(200), membershipRule(200)]);

    await runReminderSweep(env);
    expect(ladderRows(await notificationRows(db, 'e1', 'invitee')).map((r) => r.notification_type)).toEqual([
      'ladder_unanswered_48h',
    ]);

    // The invitee answers "maybe" after the unanswered rung already went out.
    await seedAttendance(db, 'e1', 'invitee', 'tentative', '');

    // 20h out: inside the tentative bucket's 24h rung.
    vi.setSystemTime(base + 27 * HOUR_MS);
    await runReminderSweep(env);

    const rows = ladderRows(await notificationRows(db, 'e1', 'invitee')).map((r) => r.notification_type).sort();
    expect(rows).toEqual(['ladder_maybe_24h', 'ladder_unanswered_48h']);
  });
});

describe('an event only seen once inside the 48h band fires that rung, not the farther one', () => {
  it('fires exactly the nearest-due rung the first time the event is scanned', async () => {
    const { db, env } = setup();
    const base = Date.now();
    vi.useFakeTimers();
    vi.setSystemTime(base);

    // 30h out: past the 96h threshold entirely, so nearest-due-wins must
    // pick 48h and never touch 96h at all, not even on the same row.
    await seedUnansweredInvitee(db, 'e1', base + 30 * HOUR_MS);
    fetchStub = stubFetch([DM_CHANNEL_RULE, dmSendRule(200), membershipRule(200)]);

    await runReminderSweep(env);
    expect(ladderRows(await notificationRows(db, 'e1', 'invitee')).map((r) => r.notification_type)).toEqual([
      'ladder_unanswered_48h',
    ]);
  });
});

describe('a decline on one occurrence leaves the next occurrence untouched', () => {
  it('sends the upcoming occurrence its rung even though the previous occurrence was declined', async () => {
    const { db, env } = setup();
    const base = Date.now();
    vi.useFakeTimers();
    vi.setSystemTime(base);

    await seedGuild(db);
    await seedUser(db, 'organizer');
    await seedUser(db, 'invitee');
    await seedMembership(db, 'organizer', 'guild-1');
    await seedMembership(db, 'invitee', 'guild-1');

    // Weekly, one occurrence 96h ago (already past, floor-irrelevant to it)
    // and the next 72h from now -- well inside the 96h scan window.
    const prevStart = base - 96 * HOUR_MS;
    const seriesStart = new Date(prevStart);
    const startDate = seriesStart.toISOString().slice(0, 10);
    const startTime = `${String(seriesStart.getUTCHours()).padStart(2, '0')}:${String(seriesStart.getUTCMinutes()).padStart(2, '0')}`;

    await seedEvent(db, { id: 'e1', organizerId: 'organizer', isRecurring: 1, startAt: null, endAt: null });
    await db.prepare(`UPDATE events SET timezone = 'UTC' WHERE id = 'e1'`).run();
    await db.prepare(
      `INSERT INTO event_recurrence_rules (event_id, freq, interval, start_date, start_time, duration_minutes, end_type)
       VALUES ('e1', 'WEEKLY', 1, ?, ?, 60, 'never')`,
    )
      .bind(startDate, startTime)
      .run();
    await seedInvite(db, 'e1', 'invitee');

    // The previous occurrence's own date, so the decline is scoped to it and
    // not to the series generally.
    await seedAttendance(db, 'e1', 'invitee', 'declined', startDate);

    const nextStart = prevStart + 7 * DAY_MS; // base + 72h
    const nextDate = new Date(nextStart).toISOString().slice(0, 10);

    fetchStub = stubFetch([DM_CHANNEL_RULE, dmSendRule(200), membershipRule(200)]);
    await runReminderSweep(env);

    const rows = await notificationRows(db, 'e1', 'invitee');
    const ladder = ladderRows(rows);
    expect(ladder).toHaveLength(1);
    expect(ladder[0].occurrence_date).toBe(nextDate);
    expect(ladder.some((r) => r.occurrence_date === startDate)).toBe(false);
  });
});

describe("decision 7's floor keeps a frequent recurring event silent until it clears", () => {
  it('sends nothing before the floor and the due rung once the floor clears', async () => {
    const { db, env } = setup();
    // Rounded to a whole minute so the recurrence rule's start_time (which
    // has no seconds of its own) reconstructs exactly the timestamp this
    // test reasons about, rather than drifting by up to 59s.
    const base = Math.floor(Date.now() / 60_000) * 60_000;
    vi.useFakeTimers();
    vi.setSystemTime(base);

    await seedGuild(db);
    await seedUser(db, 'organizer');
    await seedUser(db, 'invitee');
    await seedMembership(db, 'organizer', 'guild-1');
    await seedMembership(db, 'invitee', 'guild-1');

    // Daily, every 2 days, 60-minute duration. D0 started 10h ago (already
    // over); D1 is 38h from now. D1's floor is D0.end + 24h = 15h from now
    // -- well before D1 itself starts, unlike a strict interval=1 daily
    // event where this floor and the next occurrence's end coincide.
    const d0Start = base - 10 * HOUR_MS;
    const seriesStart = new Date(d0Start);
    const startDate = seriesStart.toISOString().slice(0, 10);
    const startTime = `${String(seriesStart.getUTCHours()).padStart(2, '0')}:${String(seriesStart.getUTCMinutes()).padStart(2, '0')}`;

    await seedEvent(db, { id: 'e1', organizerId: 'organizer', isRecurring: 1, startAt: null, endAt: null });
    await db.prepare(`UPDATE events SET timezone = 'UTC' WHERE id = 'e1'`).run();
    await db.prepare(
      `INSERT INTO event_recurrence_rules (event_id, freq, interval, start_date, start_time, duration_minutes, end_type)
       VALUES ('e1', 'DAILY', 2, ?, ?, 60, 'never')`,
    )
      .bind(startDate, startTime)
      .run();
    await seedInvite(db, 'e1', 'invitee');

    fetchStub = stubFetch([DM_CHANNEL_RULE, dmSendRule(200), membershipRule(200)]);

    // Tick 1: floor (base + 15h) has not cleared yet.
    await runReminderSweep(env);
    expect(ladderRows(await notificationRows(db, 'e1', 'invitee'))).toHaveLength(0);

    // Tick 2: one minute past the floor. D1 is still the active occurrence
    // (it doesn't start for another ~23h), so its rung is now due.
    vi.setSystemTime(base + 15 * HOUR_MS + 60_000);
    await runReminderSweep(env);
    const rows = ladderRows(await notificationRows(db, 'e1', 'invitee'));
    expect(rows).toHaveLength(1);
    expect(rows[0].notification_type).toBe('ladder_unanswered_48h');
  });
});

describe('the window-poll "outside your hours" notice fires exactly once', () => {
  it('notifies a submitter whose availability does not cover the resolved span, and does not repeat it', async () => {
    const { db, env } = setup();
    await seedGuild(db);
    await seedUser(db, 'organizer');
    await seedUser(db, 'submitter');
    await seedMembership(db, 'organizer', 'guild-1');
    await seedMembership(db, 'submitter', 'guild-1');

    const start = Date.now() + 5 * DAY_MS;
    await seedEvent(db, {
      id: 'p1',
      organizerId: 'organizer',
      title: 'Which night?',
      eventType: 'poll',
      startAt: start,
      endAt: start + 3 * HOUR_MS,
      status: 'resolved',
    });
    await db
      .prepare(`UPDATE events SET resolved_option_id = 'opt-1', window_block_minutes = 180 WHERE id = 'p1'`)
      .run();
    await db
      .prepare(
        `INSERT INTO event_poll_options (id, event_id, start_at, end_at, display_order)
         VALUES ('opt-1', 'p1', ?, ?, 0)`,
      )
      .bind(start, start + 3 * HOUR_MS)
      .run();
    await seedInvite(db, 'p1', 'submitter');

    // Submitted availability covers only the first hour of the three-hour
    // span that actually won.
    await seedWindowAvailability(db, 'p1', 'opt-1', 'submitter', start, start + HOUR_MS);

    fetchStub = stubFetch([DM_CHANNEL_RULE, dmSendRule(200), membershipRule(200)]);
    await runReminderSweep(env);

    const rows = await notificationRows(db, 'p1', 'submitter');
    const outside = rows.filter((r) => r.notification_type === 'ladder_window_outside_hours');
    expect(outside).toHaveLength(1);
    expect(outside[0].delivered_at).not.toBeNull();

    // A second tick must not repeat the one-shot notice.
    await runReminderSweep(env);
    const rowsAfter = await notificationRows(db, 'p1', 'submitter');
    expect(rowsAfter.filter((r) => r.notification_type === 'ladder_window_outside_hours')).toHaveLength(1);
  });
});
