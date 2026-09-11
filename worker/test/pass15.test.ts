import { afterEach, describe, expect, it, vi } from 'vitest';
import { sweepGoogleCalendar } from '../src/cron/googleSync';
import { TickBudget } from '../src/cron/budget';
import { seal } from '../src/lib/crypto';
import type { Env } from '../src/env';
import type { ShimDatabase } from './d1shim';
import {
  DAY_MS,
  HOUR_MS,
  seedEvent,
  seedGuild,
  seedInvite,
  seedMembership,
  seedUser,
  setup,
  stubFetch,
  type FetchStub,
} from './helpers';

// Pass 15 review (September 2026). Two reviewers, eleven findings, and almost
// no overlap between the two reports: A found the Google destination
// regressions this file opens with, B found the rotation tests that the
// coalescing floor had quietly hollowed out.
//
// One describe() per finding, finding id in the title.

const GOOGLE_ENCRYPTION_KEY = 'test-google-encryption-key-at-least-32-chars';

function googleEnv(base: Env): Env {
  return {
    ...base,
    GOOGLE_SYNC_MODE: 'live',
    GOOGLE_CLIENT_ID: 'google-client-id',
    GOOGLE_CLIENT_SECRET: 'google-client-secret',
    GOOGLE_TOKEN_ENCRYPTION_KEY: GOOGLE_ENCRYPTION_KEY,
  };
}

async function seedConnection(db: ShimDatabase, userId: string, calendarId: string): Promise<void> {
  const sealed = await seal('stored-refresh-token', GOOGLE_ENCRYPTION_KEY);
  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO google_calendar_connections
         (user_id, refresh_token_ciphertext, refresh_token_iv, access_token_ciphertext, access_token_iv,
          access_token_expires_at, google_account_email, calendar_id, read_calendar_id, sync_enabled, status,
          last_synced_at, disconnect_attempts, connected_at, updated_at)
       VALUES (?, ?, ?, NULL, NULL, NULL, ?, ?, NULL, 1, 'active', NULL, 0, ?, ?)`,
    )
    .bind(userId, sealed.ciphertext, sealed.iv, `${userId}@gmail.com`, calendarId, now, now)
    .run();
}

async function seedLink(
  db: ShimDatabase,
  opts: { eventId: string; calendarId: string | null; title: string; startAt: number; endAt: number },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO google_event_links
         (id, user_id, event_id, occurrence_date, google_event_id, calendar_id,
          synced_title, synced_start_at, synced_end_at, synced_at)
       VALUES ('lnk-1', 'u1', ?, '', 'g-1', ?, ?, ?, ?, ?)`,
    )
    .bind(opts.eventId, opts.calendarId, opts.title, opts.startAt, opts.endAt, Date.now())
    .run();
}

let fetchStub: FetchStub | null = null;
afterEach(() => {
  fetchStub?.restore();
  fetchStub = null;
  vi.useRealTimers();
});

const TOKEN_RULE = {
  match: 'oauth2.googleapis.com/token',
  status: 200,
  body: { access_token: 'at', expires_in: 3600 },
};

function calendarCalls(stub: FetchStub): string[] {
  return stub.calls.filter((u) => u.includes('/calendar/v3/calendars/'));
}

// ---------------------------------------------------------------------------
// P15-01
// ---------------------------------------------------------------------------

// The push half maintained an entry in the calendar the user STOPPED using,
// and the orphan sweep addressed the calendar they moved to. Two branches
// disagreeing about where one event lives.
describe('a destination change moves the entry rather than maintaining the old one (P15-01)', () => {
  async function seedMovedDestination(db: ShimDatabase, env: Env): Promise<number> {
    await seedGuild(db, 'guild-1');
    await seedUser(db, 'u1');
    await seedMembership(db, 'u1', 'guild-1');
    await seedConnection(db, 'u1', 'cal-NEW');
    await db.prepare(`UPDATE users SET accepted_policy_version = 99 WHERE id = 'u1'`).run();

    const start = Date.now() + 3 * DAY_MS;
    await seedEvent(db, {
      id: 'ev-1',
      organizerId: 'u1',
      title: 'Renamed Session',
      startAt: start,
      endAt: start + 2 * HOUR_MS,
    });
    await seedInvite(db, 'ev-1', 'u1');
    // Written back when the destination was cal-OLD, under the old title.
    await seedLink(db, { eventId: 'ev-1', calendarId: 'cal-OLD', title: 'Old Title', startAt: start, endAt: start + 2 * HOUR_MS });
    return start;
  }

  it('creates the occurrence in the calendar the user actually chose', async () => {
    const { db, env: base } = setup('paid');
    const env = googleEnv(base);
    await seedMovedDestination(db, env);

    fetchStub = stubFetch([
      TOKEN_RULE,
      { match: '/calendars/cal-OLD/', status: 200, body: {} },
      { match: '/calendars/cal-NEW/', status: 200, body: { id: 'g-2' } },
    ]);
    await sweepGoogleCalendar(env, new TickBudget('paid'));

    const calls = calendarCalls(fetchStub);
    expect(
      calls.some((u) => u.includes('/calendars/cal-NEW/events')),
      'the newly chosen calendar was never written to',
    ).toBe(true);
    expect(
      calls.some((u) => u.includes('/calendars/cal-OLD/events/g-1')),
      'the entry was left behind in the calendar the user stopped using',
    ).toBe(true);

    const link = await db
      .prepare(`SELECT calendar_id, google_event_id FROM google_event_links WHERE user_id = 'u1'`)
      .first<{ calendar_id: string | null; google_event_id: string }>();
    expect(link!.calendar_id, 'the link still points at the old calendar').toBe('cal-NEW');
    expect(link!.google_event_id).toBe('g-2');
  });

  // An invariant guard, not a reproduction: it passes on the unfixed tree too,
  // for a different reason -- that tree never attempted a removal at all, so
  // "nothing was written to the new calendar" held trivially. It is here
  // because removal-then-insert is the ordering decision this fix rests on,
  // and a later refactor that inserts first would break it silently.
  // Labelled, because an unlabelled guard of exactly this kind is F-42.
  it('keeps the old entry when its removal fails, rather than duplicating it', async () => {
    const { db, env: base } = setup('paid');
    const env = googleEnv(base);
    await seedMovedDestination(db, env);

    fetchStub = stubFetch([
      TOKEN_RULE,
      { match: '/calendars/cal-OLD/', status: 500, body: { error: { message: 'backend error' } } },
      { match: '/calendars/cal-NEW/', status: 200, body: { id: 'g-2' } },
    ]);
    await sweepGoogleCalendar(env, new TickBudget('paid'));

    expect(
      calendarCalls(fetchStub).some((u) => u.includes('/calendars/cal-NEW/')),
      'a copy was created while the original may still exist',
    ).toBe(false);
    const link = await db
      .prepare(`SELECT calendar_id FROM google_event_links WHERE user_id = 'u1'`)
      .first<{ calendar_id: string | null }>();
    expect(link!.calendar_id, 'the pointer to the stranded entry was thrown away').toBe('cal-OLD');
  });

  it('deletes an orphan from the calendar its link records', async () => {
    const { db, env: base } = setup('paid');
    const env = googleEnv(base);
    await seedGuild(db, 'guild-1');
    await seedUser(db, 'u1');
    await seedMembership(db, 'u1', 'guild-1');
    await seedConnection(db, 'u1', 'cal-NEW');
    await db.prepare(`UPDATE users SET accepted_policy_version = 99 WHERE id = 'u1'`).run();

    // A link with no live occurrence behind it any more -- cancelled since --
    // written back when the destination was cal-OLD.
    const start = Date.now() + 3 * DAY_MS;
    await seedEvent(db, { id: 'ev-1', organizerId: 'u1', title: 'Cancelled', startAt: start, endAt: start + HOUR_MS });
    await seedInvite(db, 'ev-1', 'u1');
    await db.prepare(`UPDATE events SET status = 'cancelled' WHERE id = 'ev-1'`).run();
    await seedLink(db, { eventId: 'ev-1', calendarId: 'cal-OLD', title: 'Cancelled', startAt: start, endAt: start + HOUR_MS });

    fetchStub = stubFetch([
      TOKEN_RULE,
      { match: '/calendars/cal-OLD/', status: 200, body: {} },
      { match: '/calendars/cal-NEW/', status: 200, body: {} },
    ]);
    await sweepGoogleCalendar(env, new TickBudget('paid'));

    const calls = calendarCalls(fetchStub);
    expect(
      calls.some((u) => u.includes('/calendars/cal-OLD/events/g-1')),
      'the cancellation was sent to a calendar the entry was never in',
    ).toBe(true);
    expect(calls.some((u) => u.includes('/calendars/cal-NEW/events/g-1'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// P15-03
// ---------------------------------------------------------------------------

// A NULL destination can never equal the connection's calendar, so the
// `unchanged` test never held and the row was re-verified on every tick --
// spending a calendar write each time and starving genuinely new events.
describe('a verified legacy link records what it verified (P15-03)', () => {
  it('goes quiet after one verification instead of re-verifying forever', async () => {
    const { db, env: base } = setup('paid');
    const env = googleEnv(base);
    await seedGuild(db, 'guild-1');
    await seedUser(db, 'u1');
    await seedMembership(db, 'u1', 'guild-1');
    await seedConnection(db, 'u1', 'primary');
    await db.prepare(`UPDATE users SET accepted_policy_version = 99 WHERE id = 'u1'`).run();

    const start = Date.now() + 3 * DAY_MS;
    await seedEvent(db, {
      id: 'ev-1',
      organizerId: 'u1',
      title: 'Steady Session',
      startAt: start,
      endAt: start + 2 * HOUR_MS,
    });
    await seedInvite(db, 'ev-1', 'u1');
    // Legacy row: provenance never recorded, title and times already correct.
    await seedLink(db, { eventId: 'ev-1', calendarId: null, title: 'Steady Session', startAt: start, endAt: start + 2 * HOUR_MS });

    fetchStub = stubFetch([TOKEN_RULE, { match: '/calendar/v3/calendars/', status: 200, body: { id: 'g-1' } }]);

    const perTick: number[] = [];
    for (let tick = 0; tick < 3; tick++) {
      const before = calendarCalls(fetchStub).length;
      await db.prepare(`UPDATE google_calendar_connections SET last_synced_at = NULL WHERE user_id = 'u1'`).run();
      await sweepGoogleCalendar(env, new TickBudget('paid'));
      perTick.push(calendarCalls(fetchStub).length - before);
    }

    expect(perTick[0], 'the legacy row was never verified at all').toBe(1);
    expect(
      perTick.slice(1),
      'a settled legacy row kept spending a calendar write on every tick',
    ).toEqual([0, 0]);

    const link = await db
      .prepare(`SELECT calendar_id FROM google_event_links WHERE user_id = 'u1'`)
      .first<{ calendar_id: string | null }>();
    expect(link!.calendar_id, 'the verified destination was not recorded').toBe('primary');
  });
});
