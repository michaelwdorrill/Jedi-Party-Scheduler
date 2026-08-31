import { afterEach, describe, expect, it } from 'vitest';
import { runReminderSweep } from '../src/cron/reminders';
import {
  DAY_MS,
  DM_CHANNEL_RULE,
  dmSendRule,
  HOUR_MS,
  membershipRule,
  seedEvent,
  seedGuild,
  seedInvite,
  seedMembership,
  seedUser,
  setup,
  stubFetch,
  type FetchRule,
  type FetchStub,
} from './helpers';
import type { ShimDatabase } from './d1shim';

let fetchStub: FetchStub | null = null;
afterEach(() => {
  fetchStub?.restore();
  fetchStub = null;
});

// specs/0010's edit-on-resolve: the DM that asked for a vote should stop
// offering one once the poll has an answer.

// A PATCH to a specific message, which is the call under test. Matched
// separately from the POST that sends a new DM -- both live under /messages.
function edits(stub: FetchStub): { url: string; body: Record<string, unknown>; text: string }[] {
  return stub.calls
    .map((url, i) => ({ url, body: stub.bodies[i] }))
    .filter((c) => /\/messages\/[^/]+$/.test(c.url) && c.body)
    .map((c) => {
      const body = JSON.parse(c.body!) as Record<string, unknown>;
      // Since v0.5.1 an edit that keeps controls carries its words in an
      // embed and blanks `content`; one that strips them puts the words back.
      const embeds = body.embeds as { description?: string }[] | undefined;
      return { url: c.url, body, text: embeds?.[0]?.description ?? (body.content as string) };
    });
}

function editRule(status: number): FetchRule {
  return { match: '/messages/msg-', status, body: {} };
}

async function seedResolvingPoll(
  db: ShimDatabase,
  { status = 'resolved', messageId = 'msg-1' }: { status?: string; messageId?: string | null } = {},
): Promise<void> {
  await seedGuild(db);
  await seedUser(db, 'organizer');
  await seedUser(db, 'voter');
  await seedMembership(db, 'organizer', 'guild-1');
  await seedMembership(db, 'voter', 'guild-1');
  await db.prepare(`UPDATE users SET dm_channel_id = 'dm-1' WHERE id = 'voter'`).run();

  const start = Date.now() + 5 * DAY_MS;
  await seedEvent(db, {
    id: 'p1',
    organizerId: 'organizer',
    title: 'Which night?',
    eventType: 'poll',
    startAt: status === 'resolved' ? start : null,
    endAt: status === 'resolved' ? start + 3 * HOUR_MS : null,
    status,
  });
  await seedInvite(db, 'p1', 'voter');

  // The invite DM that carried the vote select, delivered, with the id
  // migration 0022 records.
  await db
    .prepare(
      `INSERT INTO notification_log (id, user_id, event_id, notification_type, occurrence_date,
         sent_at, delivered_at, attempt_count, content, message_id)
       VALUES ('nl-1', 'voter', 'p1', 'invite', '', ?, ?, 1, 'You have been invited to vote', ?)`,
    )
    .bind(Date.now() - HOUR_MS, Date.now() - HOUR_MS, messageId)
    .run();
}

describe('when a poll resolves', () => {
  it('rewrites the vote DM with the settled time and the RSVP buttons', async () => {
    const { db, env } = setup();
    await seedResolvingPoll(db);
    fetchStub = stubFetch([DM_CHANNEL_RULE, editRule(200), dmSendRule(200), membershipRule(200)]);

    await runReminderSweep(env);

    const [edit] = edits(fetchStub);
    expect(edit).toBeDefined();
    expect(edit.url).toContain('/channels/dm-1/messages/msg-1');
    expect(edit.text).toContain('is settled');
    // The rewritten message keeps its controls, so its words move into the
    // embed exactly as a freshly sent one's would.
    expect((edit.body.embeds as { description?: string }[])[0].description).toContain('is settled');
    expect(edit.body.content).toBe('');
    const row = (edit.body.components as { components: { custom_id?: string }[] }[])[0];
    expect(row.components.map((c) => c.custom_id)).toEqual([
      'uo:v1:rsvp:accepted:p1',
      'uo:v1:rsvp:tentative:p1',
      'uo:v1:rsvp:declined:p1',
    ]);
  });

  it('does it once, not every tick for as long as the poll stays warm', async () => {
    const { db, env } = setup();
    await seedResolvingPoll(db);
    fetchStub = stubFetch([DM_CHANNEL_RULE, editRule(200), dmSendRule(200), membershipRule(200)]);

    await runReminderSweep(env);
    await runReminderSweep(env);
    await runReminderSweep(env);

    expect(edits(fetchStub)).toHaveLength(1);
    const row = await db
      .prepare(`SELECT message_edited_at FROM notification_log WHERE id = 'nl-1'`)
      .first<{ message_edited_at: number | null }>();
    expect(row?.message_edited_at).toBeTypeOf('number');
  });

  it('strips the controls from a cancelled poll rather than offering an RSVP', async () => {
    const { db, env } = setup();
    await seedResolvingPoll(db, { status: 'cancelled' });
    fetchStub = stubFetch([DM_CHANNEL_RULE, editRule(200), dmSendRule(200), membershipRule(200)]);

    await runReminderSweep(env);

    const [edit] = edits(fetchStub);
    expect(edit.text).toContain('was cancelled');
    // [] rather than omitted: an empty array is how Discord is told to remove
    // the controls, which is the point of the edit.
    expect(edit.body.components).toEqual([]);
    // And the embed goes with them (v0.5.1). An edit that left the embed
    // behind would strand the old text inside it while the new text sat in
    // `content` -- the message would then say two different things at once,
    // which is a worse failure than the stale controls this edit exists to
    // remove.
    expect(edit.body.embeds).toEqual([]);
    expect(edit.body.content).toContain('was cancelled');
  });

  it('leaves a delivery that predates the message id alone', async () => {
    const { db, env } = setup();
    await seedResolvingPoll(db, { messageId: null });
    fetchStub = stubFetch([DM_CHANNEL_RULE, editRule(200), dmSendRule(200), membershipRule(200)]);

    await runReminderSweep(env);

    expect(edits(fetchStub)).toHaveLength(0);
  });

  it('gives up on a 403 -- the wrong application can never edit that message', async () => {
    const { db, env } = setup();
    await seedResolvingPoll(db);
    fetchStub = stubFetch([DM_CHANNEL_RULE, editRule(403), dmSendRule(200), membershipRule(200)]);

    await runReminderSweep(env);
    await runReminderSweep(env);

    // Attempted once and recorded, rather than re-attempted every tick for as
    // long as the poll stays in the sweep's window.
    expect(edits(fetchStub)).toHaveLength(1);
    const row = await db
      .prepare(`SELECT message_edited_at FROM notification_log WHERE id = 'nl-1'`)
      .first<{ message_edited_at: number | null }>();
    expect(row?.message_edited_at).toBeTypeOf('number');
  });

  it('tries again after a 500, because that one might work next time', async () => {
    const { db, env } = setup();
    await seedResolvingPoll(db);
    fetchStub = stubFetch([DM_CHANNEL_RULE, editRule(500), dmSendRule(200), membershipRule(200)]);

    await runReminderSweep(env);
    await runReminderSweep(env);

    expect(edits(fetchStub).length).toBeGreaterThan(1);
    const row = await db
      .prepare(`SELECT message_edited_at FROM notification_log WHERE id = 'nl-1'`)
      .first<{ message_edited_at: number | null }>();
    expect(row?.message_edited_at).toBeNull();
  });
});
