import { afterEach, describe, expect, it } from 'vitest';
import { runReminderSweep } from '../src/cron/reminders';
import { createSession } from '../src/lib/sessions';
import { signJwt } from '../src/lib/jwt';
import { buildApp } from '../src/router';
import type { Env } from '../src/env';
import type { ShimDatabase } from './d1shim';
import { DM_CHANNEL_RULE, dmSendRule, membershipRule, seedGuild, seedMembership, seedUser, setup, stubFetch, type FetchStub } from './helpers';

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
