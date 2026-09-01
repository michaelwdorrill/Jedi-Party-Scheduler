import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/router';
import { signJwt } from '../src/lib/jwt';
import { createSession } from '../src/lib/sessions';
import { createEventWithInvites, updateEvent } from '../src/lib/eventWrites';
import { getConfirmedAttendeeIds, recordRsvp } from '../src/lib/attendance';
import { createChangeRequest } from '../src/lib/changeRequests';
import { runReminderSweep } from '../src/cron/reminders';
import { applyMigration } from './d1shim';
import {
  DAY_MS,
  DM_CHANNEL_RULE,
  HOUR_MS,
  dmSendRule,
  loadEventRow,
  membershipRule,
  seedGuild,
  seedMembership,
  seedUser,
  setup,
  stubFetch,
  type FetchStub,
} from './helpers';
import type { Env } from '../src/env';
import type { EventRow } from '../src/lib/events';
import type { ShimDatabase } from './d1shim';

let fetchStub: FetchStub | null = null;
afterEach(() => {
  fetchStub?.restore();
  fetchStub = null;
});

const app = buildApp();

const BACKFILL = '0019_organizer_invite_rows.sql';

async function authFor(env: Env, userId: string): Promise<Record<string, string>> {
  const { id: sessionId } = await createSession(env, userId);
  return { Authorization: `Bearer ${await signJwt(userId, sessionId, env.JWT_SIGNING_KEY)}` };
}

const baseInput = {
  title: 'Game night',
  description: null,
  game: null,
  eventType: 'single' as const,
  timezone: 'America/New_York',
  isRecurring: false,
  startAt: Date.now() + DAY_MS,
  endAt: Date.now() + DAY_MS + HOUR_MS,
  // The bare case idea 26 is about: an organizer who invited nobody at all.
  invites: { userIds: [] as string[], groupIds: [] as string[] },
};

async function seedPeople(db: ShimDatabase, ...userIds: string[]) {
  await seedGuild(db);
  for (const id of userIds) {
    await seedUser(db, id);
    await seedMembership(db, id, 'guild-1');
  }
}

async function invitesFor(db: ShimDatabase, eventId: string) {
  const { results } = await db
    .prepare(`SELECT user_id, rsvp_status, invited_via FROM event_invites WHERE event_id = ? ORDER BY user_id`)
    .bind(eventId)
    .all<{ user_id: string; rsvp_status: string; invited_via: string }>();
  return results;
}

// IDEAS.md item 26. On an event you organised, "I'm in / Maybe / Can't make
// it" rendered and did nothing: POST /events/:id/rsvp updates event_invites by
// (event_id, user_id) and 403s when nothing matched, and an organizer had no
// row. It struck only *non-group* events -- a group event whose organizer is
// in the invited group gets a row through ordinary group resolution -- which
// is why it looked arbitrary rather than structural.
describe('the organizer of an event is on its invite list', () => {
  it('writes an accepted row for an organizer who invited nobody', async () => {
    const { db, env } = setup();
    await seedPeople(db, 'organizer');
    fetchStub = stubFetch([]);

    const eventId = await createEventWithInvites(env, 'guild-1', 'organizer', baseInput);

    expect(await invitesFor(db, eventId)).toEqual([
      { user_id: 'organizer', rsvp_status: 'accepted', invited_via: 'individual' },
    ]);
  });

  it('lets the organizer RSVP to their own event instead of 403ing them', async () => {
    const { db, env } = setup();
    await seedPeople(db, 'organizer');
    fetchStub = stubFetch([membershipRule(200)]);

    const eventId = await createEventWithInvites(env, 'guild-1', 'organizer', baseInput);

    const res = await app.request(
      `/events/${eventId}/rsvp`,
      { method: 'POST', body: JSON.stringify({ status: 'declined' }), headers: await authFor(env, 'organizer') },
      env,
    );

    expect(res.status).toBe(200);
    // specs/0014: the answer lands in event_attendance now, keyed '' for
    // this non-recurring event -- not the vestigial event_invites column.
    const row = await db
      .prepare(`SELECT rsvp_status FROM event_attendance WHERE event_id = ? AND occurrence_date = '' AND user_id = 'organizer'`)
      .bind(eventId)
      .first<{ rsvp_status: string }>();
    expect(row?.rsvp_status).toBe('declined');
  });

  it('does not duplicate or downgrade a row for an organizer who invited themselves', async () => {
    const { db, env } = setup();
    await seedPeople(db, 'organizer', 'friend');
    fetchStub = stubFetch([]);

    const eventId = await createEventWithInvites(env, 'guild-1', 'organizer', {
      ...baseInput,
      invites: { userIds: ['organizer', 'friend'], groupIds: [] },
    });

    // Explicitly naming yourself is an ordinary invite and stays 'pending':
    // the organizer default only fills a gap, it does not overwrite a choice.
    expect(await invitesFor(db, eventId)).toEqual([
      { user_id: 'friend', rsvp_status: 'pending', invited_via: 'individual' },
      { user_id: 'organizer', rsvp_status: 'pending', invited_via: 'individual' },
    ]);
  });

  // The case that always worked, and must keep working unchanged: group
  // resolution already produced the row, so nothing organizer-specific runs.
  it('leaves a group event alone when the organizer is in the invited group', async () => {
    const { db, env } = setup();
    await seedPeople(db, 'organizer', 'friend');
    fetchStub = stubFetch([]);
    const now = Date.now();
    await db
      .prepare(`INSERT INTO groups (id, guild_id, name, created_by, created_at) VALUES ('grp', 'guild-1', 'Crew', 'organizer', ?)`)
      .bind(now)
      .run();
    for (const userId of ['organizer', 'friend']) {
      await db.prepare(`INSERT INTO group_members (group_id, user_id, added_at) VALUES ('grp', ?, ?)`).bind(userId, now).run();
    }

    const eventId = await createEventWithInvites(env, 'guild-1', 'organizer', {
      ...baseInput,
      invites: { userIds: [], groupIds: ['grp'] },
    });

    expect(await invitesFor(db, eventId)).toEqual([
      { user_id: 'friend', rsvp_status: 'pending', invited_via: 'group' },
      { user_id: 'organizer', rsvp_status: 'pending', invited_via: 'group' },
    ]);
  });

  // updateEvent's replaceInviteStatements deletes every row absent from the
  // list it is handed, so an edit is the one place the fix could quietly undo
  // itself and put the 403 straight back.
  it('keeps the organizer through an edit that replaces the whole invite list', async () => {
    const { db, env } = setup();
    await seedPeople(db, 'organizer', 'friend', 'other');
    fetchStub = stubFetch([]);

    const eventId = await createEventWithInvites(env, 'guild-1', 'organizer', {
      ...baseInput,
      invites: { userIds: ['friend'], groupIds: [] },
    });
    await updateEvent(
      env,
      eventId,
      'guild-1',
      { invites: { userIds: ['other'], groupIds: [] } },
      await loadEventRow(db, eventId),
    );

    expect((await invitesFor(db, eventId)).map((r) => r.user_id)).toEqual(['organizer', 'other']);
  });

  it('does not re-accept an organizer who declined, on a later edit', async () => {
    const { db, env } = setup();
    await seedPeople(db, 'organizer', 'friend');
    fetchStub = stubFetch([]);

    const eventId = await createEventWithInvites(env, 'guild-1', 'organizer', baseInput);
    // specs/0014: the real answer is an event_attendance row now.
    // updateEvent's invite-list replacement never touches event_attendance
    // for anyone who stays invited (only for someone actually removed), so
    // this is what "does not re-accept" means under the new model.
    await recordRsvp(env, 'organizer', eventId, '', 'declined');

    await updateEvent(
      env,
      eventId,
      'guild-1',
      { invites: { userIds: ['friend'], groupIds: [] } },
      await loadEventRow(db, eventId),
    );

    const row = await db
      .prepare(`SELECT rsvp_status FROM event_attendance WHERE event_id = ? AND occurrence_date = '' AND user_id = 'organizer'`)
      .bind(eventId)
      .first<{ rsvp_status: string }>();
    expect(row?.rsvp_status).toBe('declined');
  });
});

// The risky half of item 26. Every `... UNION SELECT <organizer>` folded the
// organizer in by hand because there was no row to read. With a real row
// present, an unconditional union overrides a decline and reports them
// attending anyway -- which would make the new buttons look like they work
// while changing nothing that matters.
describe('the organizer union no longer overrides a real row', () => {
  async function confirmedFor(env: Env, event: EventRow) {
    const rows = await getConfirmedAttendeeIds(env, event, null, '', {
      notificationType: 'voice_channel_invite',
      occurrenceDate: '',
      limit: 50,
    });
    return rows.map((r) => r.id).sort();
  }

  it('counts an organizer who has not answered', async () => {
    const { db, env } = setup();
    await seedPeople(db, 'organizer', 'friend');
    fetchStub = stubFetch([]);
    const eventId = await createEventWithInvites(env, 'guild-1', 'organizer', {
      ...baseInput,
      invites: { userIds: ['friend'], groupIds: [] },
    });

    expect(await confirmedFor(env, await loadEventRow(db, eventId))).toEqual(['organizer']);
  });

  it('drops an organizer who declined their own session', async () => {
    const { db, env } = setup();
    await seedPeople(db, 'organizer', 'friend');
    fetchStub = stubFetch([]);
    const eventId = await createEventWithInvites(env, 'guild-1', 'organizer', {
      ...baseInput,
      invites: { userIds: ['friend'], groupIds: [] },
    });
    // specs/0014: the real answer lives in event_attendance now.
    await recordRsvp(env, 'organizer', eventId, '', 'declined');
    await recordRsvp(env, 'friend', eventId, '', 'accepted');

    expect(await confirmedFor(env, await loadEventRow(db, eventId))).toEqual(['friend']);
  });

  // Under the old model this covered an event predating migration 0019's
  // backfill, with no organizer event_invites row at all. Under specs/0014,
  // ORGANIZER_UNLESS_DECLINED reads event_attendance exclusively and never
  // looks at event_invites, so "no row" is now the ordinary default for
  // every organizer who hasn't pressed anything -- not a backfill edge case
  // -- and this just confirms the union doesn't secretly depend on
  // event_invites carrying an organizer row at all.
  it('still counts an organizer with no row at all', async () => {
    const { db, env } = setup();
    await seedPeople(db, 'organizer', 'friend');
    fetchStub = stubFetch([]);
    const eventId = await createEventWithInvites(env, 'guild-1', 'organizer', {
      ...baseInput,
      invites: { userIds: ['friend'], groupIds: [] },
    });
    await db.prepare(`DELETE FROM event_invites WHERE event_id = ? AND user_id = 'organizer'`).bind(eventId).run();

    expect(await confirmedFor(env, await loadEventRow(db, eventId))).toEqual(['organizer']);
  });
});

// A time-change request's threshold is a majority of the people who can vote,
// and spec 0003 says the organizer is not one of them: "voters are the event's
// current invitees -- not the organizer, who has the override instead".
describe('the change-request threshold does not count the organizer', () => {
  it('computes a majority of the invitees only', async () => {
    const { db, env } = setup();
    await seedPeople(db, 'organizer', 'a', 'b', 'c');
    fetchStub = stubFetch([membershipRule(200)]);

    const eventId = await createEventWithInvites(env, 'guild-1', 'organizer', {
      ...baseInput,
      invites: { userIds: ['a', 'b', 'c'], groupIds: [] },
    });
    const requestId = await createChangeRequest(env, await loadEventRow(db, eventId), 'a', {
      kind: 'time_change',
      proposedStartAt: baseInput.startAt + HOUR_MS,
      proposedEndAt: baseInput.endAt + HOUR_MS,
      message: null,
    });

    // Three voters, not four: floor(3/2) + 1 = 2.
    const row = await db
      .prepare(`SELECT vote_threshold_count AS n FROM event_change_requests WHERE id = ?`)
      .bind(requestId)
      .first<{ n: number }>();
    expect(row?.n).toBe(2);
  });
});

// Backfilled rows are indistinguishable from real invites to sweepNewInvites,
// which DMs "You've been invited to X" for any row with no settled log entry.
// Without the organizer guard, every organizer would be DM'd once per event
// they have ever run.
describe('the invite sweep never DMs an organizer about their own event', () => {
  it('sends nothing for an event whose only invite row is the organizer', async () => {
    const { db, env } = setup();
    await seedPeople(db, 'organizer');
    const stub = stubFetch([DM_CHANNEL_RULE, dmSendRule(200), membershipRule(200)]);
    fetchStub = stub;

    // Far enough out that no reminder is due either, so the only DM this
    // sweep could possibly send is the invite one under test.
    await createEventWithInvites(env, 'guild-1', 'organizer', {
      ...baseInput,
      startAt: Date.now() + 30 * DAY_MS,
      endAt: Date.now() + 30 * DAY_MS + HOUR_MS,
    });
    await runReminderSweep(env);

    const row = await db
      .prepare(`SELECT COUNT(*) AS n FROM notification_log WHERE notification_type = 'invite'`)
      .first<{ n: number }>();
    expect(row?.n).toBe(0);
    expect(stub.calls.some((url) => url.includes('/messages'))).toBe(false);
  });
});

// The backfill (migration 0019) runs before the Worker that guards against it
// is deployed, so it writes its own settled notification_log rows rather than
// betting on a cron tick not landing in that window.
describe('the 0019 backfill', () => {
  it('adds an accepted organizer row to an event that predates it, and suppresses its invite DM', async () => {
    const { db } = setup();
    const now = Date.now();
    await db.prepare(`INSERT INTO guilds (id, name, is_active, added_at) VALUES ('g', 'G', 1, ?)`).bind(now).run();
    await db
      .prepare(
        `INSERT INTO users (id, username, global_name, avatar_hash, timezone, notifications_enabled, created_at, updated_at)
         VALUES ('old-organizer', 'old', NULL, NULL, 'UTC', 1, ?, ?)`,
      )
      .bind(now, now)
      .run();
    await db
      .prepare(
        `INSERT INTO events (id, guild_id, organizer_id, title, event_type, timezone, start_at, end_at, status,
           poll_mode, poll_resolution_mode, is_recurring, created_at, updated_at)
         VALUES ('legacy', 'g', 'old-organizer', 'Old one', 'single', 'UTC', ?, ?, 'active', 'options', 'single_winner', 0, ?, ?)`,
      )
      .bind(now + DAY_MS, now + DAY_MS + HOUR_MS, now - DAY_MS, now)
      .run();

    applyMigration(db.raw, BACKFILL);

    const invite = await db
      .prepare(`SELECT rsvp_status, invited_at FROM event_invites WHERE event_id = 'legacy' AND user_id = 'old-organizer'`)
      .first<{ rsvp_status: string; invited_at: number }>();
    expect(invite?.rsvp_status).toBe('accepted');
    // Dated from the event, not from the migration: they have been on this
    // event since it existed.
    expect(invite?.invited_at).toBe(now - DAY_MS);

    const log = await db
      .prepare(
        `SELECT delivered_at FROM notification_log
         WHERE event_id = 'legacy' AND user_id = 'old-organizer' AND notification_type = 'invite'`,
      )
      .first<{ delivered_at: number | null }>();
    expect(log?.delivered_at).not.toBeNull();
  });

  it('is idempotent, and leaves an organizer who already declined alone', async () => {
    const { db } = setup();
    const now = Date.now();
    await db.prepare(`INSERT INTO guilds (id, name, is_active, added_at) VALUES ('g', 'G', 1, ?)`).bind(now).run();
    await db
      .prepare(
        `INSERT INTO users (id, username, global_name, avatar_hash, timezone, notifications_enabled, created_at, updated_at)
         VALUES ('org', 'org', NULL, NULL, 'UTC', 1, ?, ?)`,
      )
      .bind(now, now)
      .run();
    await db
      .prepare(
        `INSERT INTO events (id, guild_id, organizer_id, title, event_type, timezone, start_at, end_at, status,
           poll_mode, poll_resolution_mode, is_recurring, created_at, updated_at)
         VALUES ('e', 'g', 'org', 'One', 'single', 'UTC', ?, ?, 'active', 'options', 'single_winner', 0, ?, ?)`,
      )
      .bind(now + DAY_MS, now + DAY_MS + HOUR_MS, now, now)
      .run();
    await db
      .prepare(
        `INSERT INTO event_invites (id, event_id, user_id, invited_via, rsvp_status, invited_at)
         VALUES ('i1', 'e', 'org', 'individual', 'declined', ?)`,
      )
      .bind(now)
      .run();

    // Twice: `d1 migrations apply` is not the only way this file can be run,
    // and a backfill that is not idempotent is a backfill that cannot be
    // safely re-run against a database someone is unsure about.
    applyMigration(db.raw, BACKFILL);
    applyMigration(db.raw, BACKFILL);

    const rows = await db
      .prepare(`SELECT rsvp_status FROM event_invites WHERE event_id = 'e' AND user_id = 'org'`)
      .all<{ rsvp_status: string }>();
    expect(rows.results).toEqual([{ rsvp_status: 'declined' }]);
  });
});
