import { afterEach, describe, expect, it, vi } from 'vitest';
import { runReminderSweep } from '../src/cron/reminders';
import { createEventWithInvites, updateEvent, type EventWriteInput } from '../src/lib/eventWrites';
import { ConflictError, LIMITS, ValidationError } from '../src/lib/validate';
import { D1_FREE_PLAN_QUERY_BUDGET, type ShimDatabase } from './d1shim';
import {
  DAY_MS,
  DM_CHANNEL_RULE,
  dmSendRule,
  HOUR_MS,
  ids,
  loadEventRow,
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

let fetchStub: FetchStub | null = null;
afterEach(() => {
  fetchStub?.restore();
  fetchStub = null;
  vi.useRealTimers();
});

const CRON_INTERVAL_MS = 15 * 60 * 1000;

// F-04-H2 from the Pass 10 review: a retryable Discord failure sets
// next_attempt_at and clears the lease, but every sweep above finds its
// recipients by re-asking its own source query -- "starts in the next hour"
// for reminders. An event that starts 5 minutes after one tick has already
// started by the next tick 15 minutes later, so it drops out of that window
// before its retry becomes due, and nothing else ever looks at the row
// again. Reproduced here at the exact N=1 scale from the report: one event,
// one recipient, one retryable send.
describe('a stranded delivery retry is still reachable once its source leaves the scan window (F-04-H2)', () => {
  it('delivers a reminder whose retry becomes due after the event has already started', async () => {
    const { db, env } = setup();
    const base = Date.now();
    vi.useFakeTimers();
    vi.setSystemTime(base);

    await seedGuild(db);
    await seedUser(db, 'organizer');
    await seedMembership(db, 'organizer', 'guild-1');
    await seedEvent(db, {
      id: 'event-1',
      organizerId: 'organizer',
      startAt: base + 5 * 60_000,
      endAt: base + 5 * 60_000 + HOUR_MS,
    });

    // Tick 1: the event starts in 5 minutes, so it's inside the ladder_accepted_1h
    // window. The send itself fails with a retryable 500.
    fetchStub = stubFetch([DM_CHANNEL_RULE, dmSendRule(500)]);
    await runReminderSweep(env);
    fetchStub.restore();
    fetchStub = null;

    const afterTick1 = await db
      .prepare(
        `SELECT delivered_at, next_attempt_at, content FROM notification_log
         WHERE event_id = 'event-1' AND user_id = 'organizer' AND notification_type = 'ladder_accepted_1h'`,
      )
      .first<{ delivered_at: number | null; next_attempt_at: number | null; content: string | null }>();
    expect(afterTick1?.delivered_at).toBeNull();
    expect(afterTick1?.next_attempt_at).not.toBeNull();
    expect(afterTick1?.content).toBeTruthy();

    // Tick 2, one cron interval later: the event started 10 minutes ago, so
    // it no longer matches sweepReminders' own `start_at >= now` window --
    // the source sweep has nothing left to say about it. The retry is due
    // (next_attempt_at was base + 5 minutes) and this time the send succeeds.
    vi.setSystemTime(base + CRON_INTERVAL_MS);
    fetchStub = stubFetch([DM_CHANNEL_RULE, dmSendRule(200)]);
    await runReminderSweep(env);

    const afterTick2 = await db
      .prepare(
        `SELECT delivered_at FROM notification_log
         WHERE event_id = 'event-1' AND user_id = 'organizer' AND notification_type = 'ladder_accepted_1h'`,
      )
      .first<{ delivered_at: number | null }>();
    expect(afterTick2?.delivered_at).not.toBeNull();
  });
});

// F-08-A from the Pass 10 review: a PATCH carrying only `pollOptions` (e.g.
// re-ordering or replacing the candidate slots) went through the same
// UPDATE that also rewrites poll_strategy/poll_threshold_count/
// poll_deadline_at, and that UPDATE used `input.field ?? null` for all
// three -- so "the caller didn't mention this field" and "the caller wants
// it cleared" were indistinguishable, and every options-only edit silently
// nulled all three. Reproduced with the report's exact shape: a threshold
// poll edited with nothing but a replacement option list.
describe('a pollOptions-only PATCH preserves the poll fields it did not mention (F-08-A)', () => {
  it('keeps poll_strategy, poll_threshold_count and poll_deadline_at after replacing only the options', async () => {
    const { db, env } = setup();
    await seedGuild(db);
    await seedUser(db, 'organizer');
    await seedMembership(db, 'organizer', 'guild-1');

    const deadline = Date.now() + 24 * HOUR_MS;
    const now = Date.now();
    await db.prepare(
      `INSERT INTO events (id, guild_id, organizer_id, title, event_type, timezone, status,
         poll_mode, poll_resolution_mode, poll_strategy, poll_threshold_count, poll_deadline_at,
         is_recurring, created_at, updated_at)
       VALUES ('poll-1', 'guild-1', 'organizer', 'Threshold poll', 'poll', 'UTC', 'active',
         'options', 'single_winner', 'threshold', 3, ?, 0, ?, ?)`,
    )
      .bind(deadline, now, now)
      .run();
    await db.prepare(
      `INSERT INTO event_poll_options (id, event_id, start_at, end_at, display_order)
       VALUES ('poll-1-opt0', 'poll-1', ?, ?, 0)`,
    )
      .bind(now + 7 * 24 * HOUR_MS, now + 7 * 24 * HOUR_MS + HOUR_MS, )
      .run();

    const stored = await loadEventRow(db, 'poll-1');
    await updateEvent(
      env,
      'poll-1',
      'guild-1',
      {
        pollOptions: [
          { startAt: now + 8 * 24 * HOUR_MS, endAt: now + 8 * 24 * HOUR_MS + HOUR_MS },
        ],
      } as Partial<EventWriteInput>,
      stored,
    );

    const after = await db
      .prepare(
        `SELECT poll_strategy, poll_threshold_count, poll_deadline_at FROM events WHERE id = 'poll-1'`,
      )
      .first<{ poll_strategy: string | null; poll_threshold_count: number | null; poll_deadline_at: number | null }>();
    expect(after?.poll_strategy).toBe('threshold');
    expect(after?.poll_threshold_count).toBe(3);
    expect(after?.poll_deadline_at).toBe(deadline);
  });
});

// F-08-B from the Pass 10 review: the server enforces optimistic concurrency
// internally (the guarded UPDATE's `revision = ?`), but the route re-read
// the event fresh immediately before calling updateEvent and used *that*
// read as the value to guard against -- so the guard always compared "the
// row's current revision" to itself and could never detect a client working
// from a stale one. Reproduced with the report's exact shape: two sequential
// edits built from the same original read, exactly what two browser tabs
// (or one tab someone forgot they had open) would produce.
describe("a stale client-observed revision is refused, not silently overwritten (F-08-B)", () => {
  it('rejects the second of two sequential edits built from the same original revision', async () => {
    const { db, env } = setup();
    await seedGuild(db);
    await seedUser(db, 'organizer');
    await seedMembership(db, 'organizer', 'guild-1');
    await seedEvent(db, { id: 'target', organizerId: 'organizer', title: 'Original' });

    // Both edits are built from the same original read, as two sequential
    // requests from a client that never re-fetched in between would be.
    const originalRead = await loadEventRow(db, 'target');
    const originalRevision = originalRead.revision ?? 0;

    // First edit: applies cleanly and advances the revision.
    await updateEvent(
      env,
      'target',
      'guild-1',
      { title: 'First edit', revision: originalRevision } as Partial<EventWriteInput>,
      originalRead,
    );
    const afterFirst = await db
      .prepare(`SELECT title, revision FROM events WHERE id = 'target'`)
      .first<{ title: string; revision: number }>();
    expect(afterFirst?.title).toBe('First edit');
    expect(afterFirst?.revision).toBe(originalRevision + 1);

    // Second edit: still claims the *original* revision -- it was never told
    // about the first edit -- so it must be refused rather than clobbering
    // "First edit". The route always passes a freshly-read `stored` (for
    // authorization), which is what's exercised here too: `stored` reflects
    // the post-first-edit row, but the client-claimed `revision` in the body
    // is what actually has to disagree with it.
    const freshlyReadForAuth = await loadEventRow(db, 'target');
    await expect(
      updateEvent(
        env,
        'target',
        'guild-1',
        { title: 'Second edit (stale)', revision: originalRevision } as Partial<EventWriteInput>,
        freshlyReadForAuth,
      ),
    ).rejects.toThrow(ConflictError);

    const afterSecond = await db
      .prepare(`SELECT title, revision FROM events WHERE id = 'target'`)
      .first<{ title: string; revision: number }>();
    expect(afterSecond?.title).toBe('First edit');
    expect(afterSecond?.revision).toBe(originalRevision + 1);
  });
});

// The whole-tick/whole-route maximum-state test PRIVATE_FREE_PROFILE's
// comment in validate.ts promises: proving the platform-budget invariant
// holds when a guild is actually at the values the product now supports,
// all at once, rather than only ever exercising one maxed-out dimension at a
// time against an otherwise-empty database.
describe('a whole cron tick fits the Free-plan budget at the supported 25-user guild profile', () => {
  it('stays inside the D1 ceiling with a full-population guild, a maxed reminder, a maxed poll and every idle group due at once', async () => {
    const { db, env } = setup();
    await seedGuild(db);

    // The guild's whole supported active population (SUPPORTED_ACTIVE_USERS_PER_GUILD).
    const userIds = ids('member', LIMITS.SUPPORTED_ACTIVE_USERS_PER_GUILD);
    for (const id of userIds) {
      await seedUser(db, id);
      await seedMembership(db, id, 'guild-1');
    }
    const organizerId = userIds[0];

    // A single event at MAX_INVITEES, starting soon -- the reminder sweep's
    // own worst case, now sized to what the guild can actually offer rather
    // than a population many times larger than the guild itself.
    await seedEvent(db, {
      id: 'reminder-event',
      organizerId,
      startAt: Date.now() + 30 * 60_000,
      endAt: Date.now() + 90 * 60_000,
    });
    for (const id of userIds) await seedInvite(db, 'reminder-event', id);

    // A poll at MAX_POLL_OPTIONS with its deadline due right now, so the
    // poll-deadline-reminder sweep and the poll-resolution sweep both have
    // real work this tick, not an empty scan.
    const now = Date.now();
    await db.prepare(
      `INSERT INTO events (id, guild_id, organizer_id, title, event_type, timezone, status,
         poll_mode, poll_resolution_mode, poll_strategy, poll_deadline_at, is_recurring, created_at, updated_at)
       VALUES ('poll-event', 'guild-1', ?, 'Max poll', 'poll', 'UTC', 'active',
         'options', 'multi_winner', 'most_votes', ?, 0, ?, ?)`,
    )
      .bind(organizerId, now - 60_000, now, now)
      .run();
    for (let i = 0; i < LIMITS.MAX_POLL_OPTIONS; i++) {
      await db.prepare(
        `INSERT INTO event_poll_options (id, event_id, start_at, end_at, display_order)
         VALUES (?, 'poll-event', ?, ?, ?)`,
      )
        .bind(`poll-event-opt${i}`, now + 7 * DAY_MS + i * HOUR_MS, now + 7 * DAY_MS + (i + 1) * HOUR_MS, i)
        .run();
    }
    for (const id of userIds) await seedInvite(db, 'poll-event', id);

    // MAX_GROUP_IDS groups at MAX_GROUP_MEMBERS, every one of them idle and
    // due for a nudge -- reusing the same 25 users across groups, which is
    // the only way to reach MAX_GROUP_MEMBERS at all once the guild's whole
    // population is capped at the same number (see MAX_GROUP_MEMBERS's
    // comment in validate.ts).
    for (const groupId of ids('group', LIMITS.MAX_GROUP_IDS)) {
      await db.prepare(
        `INSERT INTO groups (id, name, idle_reminder_days, created_by, created_at)
         VALUES (?, ?, 1, ?, ?)`,
      )
        .bind(groupId, groupId, organizerId, now)
        .run();
      for (const id of userIds.slice(0, LIMITS.MAX_GROUP_MEMBERS)) {
        await db.prepare(`INSERT INTO group_members (group_id, user_id, added_at) VALUES (?, ?, ?)`)
          .bind(groupId, id, now)
          .run();
      }
      // A past, already-finished event is what makes a group "idle" rather
      // than "new" -- sweepIdleGroups treats a group with no event history
      // at all as not-yet-idle, not overdue.
      const pastEventId = `${groupId}-past`;
      await seedEvent(db, {
        id: pastEventId,
        organizerId,
        startAt: now - 30 * DAY_MS,
        endAt: now - 30 * DAY_MS + HOUR_MS,
        status: 'active',
      });
      await db.prepare(
        `INSERT INTO event_invites (id, event_id, user_id, invited_via, source_group_id, rsvp_status, invited_at)
         VALUES (?, ?, ?, 'group', ?, 'accepted', ?)`,
      )
        .bind(`inv-${pastEventId}`, pastEventId, organizerId, groupId, now)
        .run();
    }

    fetchStub = stubFetch([DM_CHANNEL_RULE, dmSendRule(200), membershipRule(200)]);
    db.resetQueryCount();
    await runReminderSweep(env);

    expect(db.queryCount).toBeLessThanOrEqual(D1_FREE_PLAN_QUERY_BUDGET);
  });

  // specs/0014 stage 2: the variant above only ever exercises the unanswered
  // bucket, since every invitee it seeds has no attendance row at all. The
  // ladder's recipient query is built to answer all three status buckets
  // (unanswered/tentative/accepted) with one query per occurrence rather than
  // one per bucket -- this is what actually proves that, by putting a single
  // maxed-population event 30 minutes from start (inside the accepted 1h
  // rung, and therefore also inside tentative's 24h and unanswered's 48h
  // rungs at once) with its invitees split across all three statuses.
  it('stays within the Free-plan budget when a single maxed event has all three ladder buckets due at once', async () => {
    const { db, env } = setup();
    await seedGuild(db);

    const userIds = ids('member', LIMITS.SUPPORTED_ACTIVE_USERS_PER_GUILD);
    for (const id of userIds) {
      await seedUser(db, id);
      await seedMembership(db, id, 'guild-1');
    }
    const organizerId = userIds[0];

    await seedEvent(db, {
      id: 'reminder-event',
      organizerId,
      startAt: Date.now() + 30 * 60_000,
      endAt: Date.now() + 90 * 60_000,
    });
    for (const id of userIds) await seedInvite(db, 'reminder-event', id);
    // Pre-mark every invite as already delivered so sweepNewInvites (which
    // runs before sweepReminders in the same tick) has nothing left to do --
    // the point of this test is the ladder recipient query's own budget,
    // not the invite sweep's, and 24 fresh invite DMs would exhaust the
    // tick before the reminders sweep is ever reached.
    for (const id of userIds) {
      await db.prepare(
        `INSERT INTO notification_log (id, user_id, event_id, notification_type, occurrence_date, sent_at, delivered_at)
         VALUES (?, ?, 'reminder-event', 'invite', '', ?, ?)`,
      )
        .bind(`invite-preseed-${id}`, id, Date.now(), Date.now())
        .run();
    }

    // Split the population roughly into thirds across the three ladder
    // buckets. The organizer (userIds[0]) is left with no attendance row --
    // decision 1 reads that as implicitly accepted, so it lands in the
    // accepted bucket alongside the explicit accepted rows.
    const third = Math.floor(userIds.length / 3);
    const acceptedIds = userIds.slice(1, third);
    const tentativeIds = userIds.slice(third, third * 2);
    const unansweredIds = userIds.slice(third * 2);
    for (const id of acceptedIds) await seedAttendance(db, 'reminder-event', id, 'accepted', '');
    for (const id of tentativeIds) await seedAttendance(db, 'reminder-event', id, 'tentative', '');
    // unansweredIds are left unanswered on purpose (no attendance row).

    // The recipient *query* has to walk the whole 25-person candidate set
    // regardless of how many of them still need a fresh send, so the query
    // cost stays realistic at this population. Delivery cost is a separate
    // concern, capped by the tick's own budget: sweepLadderOccurrence sends
    // one bucket's DMs at a time in a fixed unanswered/tentative/accepted
    // order, so with 24 genuinely-pending recipients the accepted bucket
    // (sent last) would be starved before the tick ever reached it, purely
    // an artefact of bucket ordering rather than anything this test is
    // meant to exercise. Pre-marking most of each bucket as already
    // delivered leaves only a couple of live recipients per bucket, so all
    // three buckets' sends fit in one tick's delivery budget while the
    // query still runs at the full candidate-set cost.
    // Leave the organizer (implicitly accepted) as one live recipient, plus
    // one explicit member per bucket; pre-deliver the rest of each bucket.
    const alreadyDelivered: [string, string][] = [
      ...acceptedIds.slice(1).map((id): [string, string] => [id, 'ladder_accepted_1h']),
      ...tentativeIds.slice(1).map((id): [string, string] => [id, 'ladder_maybe_24h']),
      ...unansweredIds.slice(1).map((id): [string, string] => [id, 'ladder_unanswered_48h']),
    ];
    for (const [id, type] of alreadyDelivered) {
      await db.prepare(
        `INSERT INTO notification_log (id, user_id, event_id, notification_type, occurrence_date, sent_at, delivered_at)
         VALUES (?, ?, 'reminder-event', ?, '', ?, ?)`,
      )
        .bind(`ladder-preseed-${id}`, id, type, Date.now(), Date.now())
        .run();
    }

    fetchStub = stubFetch([DM_CHANNEL_RULE, dmSendRule(200), membershipRule(200)]);
    db.resetQueryCount();
    await runReminderSweep(env);

    expect(db.queryCount).toBeLessThanOrEqual(D1_FREE_PLAN_QUERY_BUDGET);

    const { results: kinds } = await db
      .prepare(`SELECT DISTINCT notification_type FROM notification_log WHERE event_id = 'reminder-event' AND notification_type LIKE 'ladder_%'`)
      .all<{ notification_type: string }>();
    const types = kinds.map((r) => r.notification_type).sort();
    expect(types).toEqual(['ladder_accepted_1h', 'ladder_maybe_24h', 'ladder_unanswered_48h']);
  });
});

// Over-limit rejection tests (Pass 10 review): MAX_POLL_OPTIONS and the
// threshold bound already had coverage in validation.test.ts, but
// MAX_INVITEES and MAX_GROUP_IDS -- both changed by the Pass 10 scope
// reduction -- did not have a dedicated "one over the limit is refused"
// test of their own.
describe('requests over the private-profile limits are rejected before any write (Pass 10)', () => {
  async function seedOrganizer(db: ShimDatabase): Promise<void> {
    await seedGuild(db);
    await seedUser(db, 'organizer');
    await seedMembership(db, 'organizer', 'guild-1');
  }

  const baseInput = {
    title: 'Game night',
    description: null,
    game: null,
    eventType: 'single' as const,
    timezone: 'America/New_York',
    isRecurring: false,
    startAt: Date.now() + DAY_MS,
    endAt: Date.now() + DAY_MS + 3600_000,
  };

  it('rejects one more than MAX_INVITEES direct invitees', async () => {
    const { db, env } = setup();
    await seedOrganizer(db);
    const userIds = ids('u', LIMITS.MAX_INVITEES + 1);

    await expect(
      createEventWithInvites(env, 'guild-1', 'organizer', {
        ...baseInput,
        invites: { userIds, groupIds: [] },
      }),
    ).rejects.toBeInstanceOf(ValidationError);

    expect(await db.prepare(`SELECT COUNT(*) AS n FROM events`).first<{ n: number }>()).toEqual({ n: 0 });
  });

  it('rejects one more than MAX_GROUP_IDS group ids', async () => {
    const { db, env } = setup();
    await seedOrganizer(db);
    const groupIds = ids('g', LIMITS.MAX_GROUP_IDS + 1);

    await expect(
      createEventWithInvites(env, 'guild-1', 'organizer', {
        ...baseInput,
        invites: { userIds: [], groupIds },
      }),
    ).rejects.toBeInstanceOf(ValidationError);

    expect(await db.prepare(`SELECT COUNT(*) AS n FROM events`).first<{ n: number }>()).toEqual({ n: 0 });
  });
});
