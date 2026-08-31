import { afterEach, describe, expect, it } from 'vitest';
import { runReminderSweep } from '../src/cron/reminders';
import { getConfirmedAttendeeIds } from '../src/lib/attendance';
import {
  DAY_MS,
  DM_CHANNEL_RULE,
  dmSendRule,
  HOUR_MS,
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
import type { ShimDatabase } from './d1shim';

let fetchStub: FetchStub | null = null;
afterEach(() => {
  fetchStub?.restore();
  fetchStub = null;
});

// v0.5.1: the two ways a poll's DM and the state behind it could disagree.
// IDEAS items 50 (a settled poll still invites people to vote) and 51 (a
// resolved poll's RSVP is recorded but never read).

const START = Date.now() + 5 * DAY_MS;

async function seedResolvedPoll(
  db: ShimDatabase,
  { windowed = false }: { windowed?: boolean } = {},
): Promise<void> {
  await seedGuild(db);
  for (const id of ['organizer', 'yes-voter', 'decliner', 'maybe', 'late-yes']) {
    await seedUser(db, id);
    await seedMembership(db, id, 'guild-1');
    await db.prepare(`UPDATE users SET dm_channel_id = ? WHERE id = ?`).bind(`dm-${id}`, id).run();
  }

  await seedEvent(db, {
    id: 'p1',
    organizerId: 'organizer',
    title: 'Which night?',
    eventType: 'poll',
    startAt: START,
    endAt: START + 3 * HOUR_MS,
    status: 'resolved',
  });
  await db
    .prepare(`UPDATE events SET resolved_option_id = 'opt-1', window_block_minutes = ? WHERE id = 'p1'`)
    .bind(windowed ? 180 : null)
    .run();
  await db
    .prepare(
      `INSERT INTO event_poll_options (id, event_id, start_at, end_at, display_order)
       VALUES ('opt-1', 'p1', ?, ?, 0)`,
    )
    .bind(START, START + 3 * HOUR_MS)
    .run();

  for (const id of ['yes-voter', 'decliner', 'maybe', 'late-yes']) {
    await seedInvite(db, 'p1', id);
  }

  // Everyone except late-yes said the night worked, in whichever form this
  // poll shape records: a yes vote, or availability covering the span.
  for (const id of ['yes-voter', 'decliner', 'maybe']) {
    if (windowed) {
      await db
        .prepare(
          `INSERT INTO event_window_availability (option_id, event_id, user_id, avail_start_at, avail_end_at, submitted_at)
           VALUES ('opt-1', 'p1', ?, ?, ?, ?)`,
        )
        .bind(id, START - HOUR_MS, START + 4 * HOUR_MS, Date.now())
        .run();
    } else {
      await db
        .prepare(
          `INSERT INTO event_poll_votes (option_id, user_id, vote, voted_at) VALUES ('opt-1', ?, 'yes', ?)`,
        )
        .bind(id, Date.now())
        .run();
    }
  }
}

async function confirmed(db: ShimDatabase, env: Parameters<typeof getConfirmedAttendeeIds>[0]): Promise<string[]> {
  const event = await loadEventRow(db, 'p1');
  const rows = await getConfirmedAttendeeIds(env, event, 'opt-1', '', {
    notificationType: 'voice_channel_invite',
    occurrenceDate: '',
    limit: 50,
  });
  return rows.map((r) => r.id).sort();
}

// Item 51. v0.5 gave a resolved poll RSVP buttons; nothing read what they
// wrote, so a vote cast a week ago outranked an answer given a minute ago.
describe("a resolved poll's RSVP overrides the vote behind it", () => {
  it('still counts a yes-voter who has not pressed anything', async () => {
    const { db, env } = setup();
    await seedResolvedPoll(db);
    // The fallback is what makes this safe to ship: an unanswered poll must
    // behave exactly as it did before, or the fix empties every confirmed set
    // in the database.
    expect(await confirmed(db, env)).toEqual(['decliner', 'maybe', 'organizer', 'yes-voter']);
  });

  it("drops a yes-voter who then pressed Can't make it", async () => {
    const { db, env } = setup();
    await seedResolvedPoll(db);
    // specs/0014: the RSVP override is an event_attendance row now, not an
    // event_invites one -- occurrence_date '' since a poll has no
    // occurrences of its own until stage 3's fan-out.
    await seedAttendance(db, 'p1', 'decliner', 'declined');

    expect(await confirmed(db, env)).not.toContain('decliner');
  });

  it('drops a yes-voter who then pressed Maybe', async () => {
    const { db, env } = setup();
    await seedResolvedPoll(db);
    await seedAttendance(db, 'p1', 'maybe', 'tentative');

    // Not a judgement about maybes -- the same reading a fixed-time event
    // already gives them, where the confirmed query is `= 'accepted'`.
    expect(await confirmed(db, env)).not.toContain('maybe');
  });

  it("adds someone who never voted but pressed I'm in", async () => {
    const { db, env } = setup();
    await seedResolvedPoll(db);
    await seedAttendance(db, 'p1', 'late-yes', 'accepted');

    expect(await confirmed(db, env)).toContain('late-yes');
  });

  it('applies the same rule to a window poll, where availability is the vote', async () => {
    const { db, env } = setup();
    await seedResolvedPoll(db, { windowed: true });
    await seedAttendance(db, 'p1', 'decliner', 'declined');

    const event = await loadEventRow(db, 'p1');
    const rows = await getConfirmedAttendeeIds(env, event, null, '', {
      notificationType: 'voice_channel_invite',
      occurrenceDate: '',
      limit: 50,
    });
    const ids = rows.map((r) => r.id).sort();
    expect(ids).toContain('yes-voter');
    expect(ids).not.toContain('decliner');
  });

  it('leaves the organizer rule alone', async () => {
    const { db, env } = setup();
    await seedResolvedPoll(db);
    // The organizer has no vote to read and no event_attendance row here,
    // which is the ordinary default for an organizer who hasn't pressed
    // anything -- ORGANIZER_UNLESS_DECLINED counts them regardless.
    expect(await confirmed(db, env)).toContain('organizer');
  });
});

// Item 50. `sweepNewInvites` filtered on `status != 'cancelled'` and nothing
// else, so a settled poll was still a poll people got DM'd an invitation to
// vote on -- and since v0.5 that DM carries a select whose only possible
// reply is "Voting is closed for this event".
describe('a poll that has already settled stops inviting people to vote', () => {
  async function invitesSent(db: ShimDatabase): Promise<number> {
    const row = await db
      .prepare(`SELECT COUNT(*) AS n FROM notification_log WHERE event_id = 'e1' AND notification_type = 'invite'`)
      .first<{ n: number }>();
    return row?.n ?? 0;
  }

  async function seedPollInvite(db: ShimDatabase, status: string, eventType = 'poll'): Promise<void> {
    await seedGuild(db);
    await seedUser(db, 'organizer');
    await seedUser(db, 'invitee');
    await seedMembership(db, 'organizer', 'guild-1');
    await seedMembership(db, 'invitee', 'guild-1');
    await seedEvent(db, {
      id: 'e1',
      organizerId: 'organizer',
      title: 'Which night?',
      eventType,
      startAt: status === 'active' && eventType === 'poll' ? null : START,
      endAt: status === 'active' && eventType === 'poll' ? null : START + 3 * HOUR_MS,
      status,
    });
    await seedInvite(db, 'e1', 'invitee');
  }

  it('does not DM an invitation to vote on a resolved poll', async () => {
    const { db, env } = setup();
    await seedPollInvite(db, 'resolved');
    fetchStub = stubFetch([DM_CHANNEL_RULE, dmSendRule(200), membershipRule(200)]);

    await runReminderSweep(env);
    expect(await invitesSent(db)).toBe(0);
  });

  it('still DMs an invitation to vote on a poll that is open', async () => {
    const { db, env } = setup();
    await seedPollInvite(db, 'active');
    fetchStub = stubFetch([DM_CHANNEL_RULE, dmSendRule(200), membershipRule(200)]);

    await runReminderSweep(env);
    expect(await invitesSent(db)).toBe(1);
  });

  it('still DMs an invitation to a resolved fixed-time event', async () => {
    const { db, env } = setup();
    await seedPollInvite(db, 'resolved', 'single');
    fetchStub = stubFetch([DM_CHANNEL_RULE, dmSendRule(200), membershipRule(200)]);

    // The old predicate was right for this case and the new one must not
    // catch it: "you're invited to this thing on Thursday" is true whatever
    // the event's status.
    await runReminderSweep(env);
    expect(await invitesSent(db)).toBe(1);
  });
});
