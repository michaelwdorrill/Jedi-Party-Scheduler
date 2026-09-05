// New idea captured alongside IDEAS item 54 (Sept 2026): the organizer hears
// about every invitee's RSVP, for every event they organize.
import { afterEach, describe, expect, it } from 'vitest';
import { runReminderSweep } from '../src/cron/reminders';
import { recordRsvp } from '../src/lib/attendance';
import {
  countRows,
  DM_CHANNEL_RULE,
  dmSendRule,
  membershipRule,
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
});

async function organizerNoticeContent(db: Awaited<ReturnType<typeof setup>>['db'], eventId: string): Promise<string | null> {
  const row = await db
    .prepare(`SELECT content FROM organizer_rsvp_notice_log WHERE event_id = ? ORDER BY sent_at DESC LIMIT 1`)
    .bind(eventId)
    .first<{ content: string }>();
  return row?.content ?? null;
}

describe('the organizer hears about every RSVP', () => {
  it('notifies the organizer when an invitee answers, naming who and what', async () => {
    const { db, env } = setup();
    await seedGuild(db);
    await seedUser(db, 'organizer');
    await seedUser(db, 'alice');
    await seedMembership(db, 'organizer', 'guild-1');
    await seedMembership(db, 'alice', 'guild-1');
    await seedEvent(db, { id: 'e1', organizerId: 'organizer', title: 'Game night' });
    await seedInvite(db, 'e1', 'alice');

    fetchStub = stubFetch([DM_CHANNEL_RULE, dmSendRule(200), membershipRule(200)]);
    await recordRsvp(env, 'alice', 'e1', '', 'accepted');
    await runReminderSweep(env);

    expect(
      await countRows(db, 'organizer_rsvp_notice_log', `organizer_id = 'organizer' AND event_id = 'e1' AND responder_id = 'alice'`),
    ).toBe(1);
    const content = await organizerNoticeContent(db, 'e1');
    expect(content).toContain('alice');
    expect(content).toContain('is in');
  });

  it('sends a second notice for a changed answer, not just the first', async () => {
    const { db, env } = setup();
    await seedGuild(db);
    await seedUser(db, 'organizer');
    await seedUser(db, 'alice');
    await seedMembership(db, 'organizer', 'guild-1');
    await seedMembership(db, 'alice', 'guild-1');
    await seedEvent(db, { id: 'e1', organizerId: 'organizer' });
    await seedInvite(db, 'e1', 'alice');

    fetchStub = stubFetch([DM_CHANNEL_RULE, dmSendRule(200), membershipRule(200)]);
    await recordRsvp(env, 'alice', 'e1', '', 'accepted');
    await runReminderSweep(env);
    await recordRsvp(env, 'alice', 'e1', '', 'declined');
    await runReminderSweep(env);

    expect(
      await countRows(db, 'organizer_rsvp_notice_log', `organizer_id = 'organizer' AND event_id = 'e1' AND responder_id = 'alice'`),
    ).toBe(2);
    const content = await organizerNoticeContent(db, 'e1');
    expect(content).toContain("can't make it");
  });

  it('does not notify the organizer about their own RSVP', async () => {
    const { db, env } = setup();
    await seedGuild(db);
    await seedUser(db, 'organizer');
    await seedMembership(db, 'organizer', 'guild-1');
    await seedEvent(db, { id: 'e1', organizerId: 'organizer' });

    fetchStub = stubFetch([]);
    await recordRsvp(env, 'organizer', 'e1', '', 'tentative');
    await runReminderSweep(env);

    expect(await countRows(db, 'organizer_rsvp_notice_log', `event_id = 'e1'`)).toBe(0);
  });

  it('does not repeat the same unanswered-to-answered notice on a later tick', async () => {
    const { db, env } = setup();
    await seedGuild(db);
    await seedUser(db, 'organizer');
    await seedUser(db, 'alice');
    await seedMembership(db, 'organizer', 'guild-1');
    await seedMembership(db, 'alice', 'guild-1');
    await seedEvent(db, { id: 'e1', organizerId: 'organizer' });
    await seedInvite(db, 'e1', 'alice');

    fetchStub = stubFetch([DM_CHANNEL_RULE, dmSendRule(200), membershipRule(200)]);
    await recordRsvp(env, 'alice', 'e1', '', 'accepted');
    await runReminderSweep(env);
    await runReminderSweep(env);
    await runReminderSweep(env);

    expect(
      await countRows(db, 'organizer_rsvp_notice_log', `organizer_id = 'organizer' AND event_id = 'e1' AND responder_id = 'alice'`),
    ).toBe(1);
  });
});
