import { afterEach, describe, expect, it } from 'vitest';
import { runReminderSweep } from '../src/cron/reminders';
import { createSession } from '../src/lib/sessions';
import { signJwt } from '../src/lib/jwt';
import { buildApp } from '../src/router';
import type { Env } from '../src/env';
import type { ShimDatabase } from './d1shim';
import { DM_CHANNEL_RULE, dmSendRule, HOUR_MS, membershipRule, seedEvent, seedGuild, seedInvite, seedMembership, seedUser, setup, stubFetch, type FetchStub } from './helpers';

// The 1.0 launch announcement (Michael, 9 Nov 2026). LAUNCH-ONLY: this file
// goes with the feature in 1.1 (docs/IDEAS.md item 105).
//
// A DM with the "We've hit 1.0!" picture to everyone with notifications on who
// is still in an allow-listed server, once; and a pop-up the first time each
// account opens the app, also once.

const TEXT = 'Uncle Owen and Aunt Beru are proud to announce that we are feature complete! Feel free to use Uncle Owen for all your scheduling needs!';

let fetchStub: FetchStub | null = null;
afterEach(() => {
  fetchStub?.restore();
  fetchStub = null;
});

function announcementSends(stub: FetchStub): { payload: Record<string, unknown>; form: FormData }[] {
  return stub.forms.flatMap((form, i) =>
    form && stub.calls[i].endsWith('/messages') ? [{ payload: JSON.parse(stub.bodies[i]!) as Record<string, unknown>, form }] : [],
  );
}

async function seedPeople(db: ShimDatabase) {
  await seedGuild(db);
  for (const id of ['on', 'off', 'left']) await seedUser(db, id);
  await seedMembership(db, 'on', 'guild-1');
  await seedMembership(db, 'off', 'guild-1');
  await seedMembership(db, 'left', 'guild-1', { isMember: 0 });
  await db.prepare(`UPDATE users SET notifications_enabled = 0 WHERE id = 'off'`).run();
}

function launchEnv(env: Env): Env {
  return { ...env, LAUNCH_ANNOUNCEMENT: '1.0' };
}

describe('the 1.0 launch DM', () => {
  it('goes once, with the picture attached, to members with notifications on -- and to nobody else', async () => {
    const { db, env } = setup();
    await seedPeople(db);
    fetchStub = stubFetch([DM_CHANNEL_RULE, dmSendRule(200), membershipRule(200)]);

    await runReminderSweep(launchEnv(env));
    await runReminderSweep(launchEnv(env));

    const sends = announcementSends(fetchStub);
    expect(sends, 'exactly one announcement DM, across two ticks').toHaveLength(1);
    expect(sends[0].payload.content).toBe(TEXT);
    expect(sends[0].payload.allowed_mentions).toEqual({ parse: [] });
    expect(sends[0].payload.attachments).toEqual([{ id: 0, filename: 'uncle-owen-1.0.webp' }]);
    const file = sends[0].form.get('files[0]') as File;
    expect(file.type).toBe('image/webp');
    expect(new TextDecoder().decode((await file.arrayBuffer()).slice(8, 12)), 'a real WebP file').toBe('WEBP');

    const rows = await db.prepare(`SELECT user_id, delivered_at FROM announcement_log`).all<{ user_id: string; delivered_at: number | null }>();
    expect(rows.results.map((r) => r.user_id)).toEqual(['on']);
    expect(rows.results[0].delivered_at).not.toBeNull();
  });

  it('records that it is finished, and then costs a tick nothing', async () => {
    const { db, env } = setup();
    await seedPeople(db);
    fetchStub = stubFetch([DM_CHANNEL_RULE, dmSendRule(200), membershipRule(200)]);

    await runReminderSweep(launchEnv(env));
    await runReminderSweep(launchEnv(env));
    const done = await db.prepare(`SELECT cursor_key FROM cron_cursors WHERE name = 'launch_announcement'`).first<{ cursor_key: string }>();
    expect(done?.cursor_key).toBe('1.0');

    db.resetQueryCount();
    await runReminderSweep(launchEnv(env));
    const withAnnouncement = db.queryCount;
    db.resetQueryCount();
    await runReminderSweep(env);
    expect(withAnnouncement, 'a finished announcement adds no query').toBe(db.queryCount);
  });

  it('is not marked finished while a failed send is still backing off', async () => {
    const { db, env } = setup();
    await seedPeople(db);
    fetchStub = stubFetch([DM_CHANNEL_RULE, dmSendRule(500), membershipRule(200)]);
    await runReminderSweep(launchEnv(env));
    await runReminderSweep(launchEnv(env));
    const done = await db.prepare(`SELECT cursor_key FROM cron_cursors WHERE name = 'launch_announcement'`).first<{ cursor_key: string | null }>();
    expect(done?.cursor_key ?? null).toBeNull();

    // Due again: it goes.
    await db.prepare(`UPDATE announcement_log SET next_attempt_at = 0`).run();
    fetchStub.restore();
    fetchStub = stubFetch([DM_CHANNEL_RULE, dmSendRule(200), membershipRule(200)]);
    await runReminderSweep(launchEnv(env));
    expect(announcementSends(fetchStub)).toHaveLength(1);
  });

  it('sends nothing at all when no announcement is live', async () => {
    const { db, env } = setup();
    await seedPeople(db);
    fetchStub = stubFetch([DM_CHANNEL_RULE, dmSendRule(200), membershipRule(200)]);
    await runReminderSweep(env);
    expect(announcementSends(fetchStub)).toHaveLength(0);
    expect(await db.prepare(`SELECT COUNT(*) AS n FROM announcement_log`).first<{ n: number }>()).toEqual({ n: 0 });
  });
});

// B10 on the sandbox (9 Nov 2026): the announcement ran near the end of the
// tick, and a temporary per-step trace showed every tick reaching it with
// nothing left -- five ticks, no DM. "Last in line" can mean "never" on a busy
// install. It now goes near the front, capped per tick, so it always makes
// progress without crowding everything else out.
describe('the 1.0 launch DM on a busy tick', () => {
  it('goes out on the first tick even when a backlog would use the whole budget, a few at a time, and leaves room for the rest', async () => {
    const { db, env } = setup();
    await seedGuild(db);
    await seedUser(db, 'organizer');
    await seedMembership(db, 'organizer', 'guild-1');
    await seedEvent(db, { id: 'busy', organizerId: 'organizer', title: 'busy', startAt: Date.now() + 48 * HOUR_MS, endAt: Date.now() + 50 * HOUR_MS });
    for (let i = 0; i < 30; i++) {
      const id = `u${String(i).padStart(2, '0')}`;
      await seedUser(db, id);
      await seedMembership(db, id, 'guild-1');
      await db.prepare(`UPDATE users SET dm_channel_id = ? WHERE id = ?`).bind(`dm-${id}`, id).run();
      await seedInvite(db, 'busy', id);
    }
    fetchStub = stubFetch([DM_CHANNEL_RULE, dmSendRule(200), membershipRule(200)]);

    await runReminderSweep(launchEnv(env));
    const first = announcementSends(fetchStub).length;
    expect(first, 'some announcements went out on the first tick').toBeGreaterThan(0);
    expect(first, 'capped, so the rest of the tick keeps flowing').toBeLessThanOrEqual(4);
    const invites = await db.prepare(`SELECT COUNT(*) AS n FROM notification_log WHERE notification_type = 'invite' AND delivered_at IS NOT NULL`).first<{ n: number }>();
    expect(invites!.n, 'invites still went out on the same tick').toBeGreaterThan(0);

    for (let tick = 0; tick < 12; tick++) await runReminderSweep(launchEnv(env));
    const delivered = await db.prepare(`SELECT COUNT(*) AS n FROM announcement_log WHERE delivered_at IS NOT NULL`).first<{ n: number }>();
    expect(delivered!.n, 'everyone, the organizer included, within 13 ticks').toBe(31);
  });
});

describe('the 1.0 pop-up', () => {
  async function me(env: Env, token: string) {
    const res = await buildApp().request('https://worker.test/me', { headers: { Authorization: `Bearer ${token}` } }, env);
    return (await res.json()) as { unseenAnnouncement: string | null };
  }

  it('is offered once per account, whether or not that account gets DMs', async () => {
    const { db, env } = setup();
    await seedPeople(db);
    const live = launchEnv(env);
    const { id } = await createSession(live, 'off');
    const token = await signJwt('off', id, env.JWT_SIGNING_KEY);

    expect((await me(live, token)).unseenAnnouncement).toBe('1.0');
    const res = await buildApp().request(
      'https://worker.test/me/announcement-seen',
      { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ id: '1.0' }) },
      live,
    );
    expect(res.status).toBe(200);
    expect((await me(live, token)).unseenAnnouncement).toBeNull();
  });

  it('is not offered when no announcement is live, and a stale id records nothing', async () => {
    const { db, env } = setup();
    await seedPeople(db);
    const { id } = await createSession(env, 'on');
    const token = await signJwt('on', id, env.JWT_SIGNING_KEY);
    expect((await me(env, token)).unseenAnnouncement).toBeNull();

    const live = launchEnv(env);
    await buildApp().request(
      'https://worker.test/me/announcement-seen',
      { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ id: '0.9' }) },
      live,
    );
    expect((await me(live, token)).unseenAnnouncement).toBe('1.0');
  });
});
