import { afterEach, describe, expect, it, vi } from 'vitest';
import { acceptChangeRequest, resolvePastDeadlineChangeRequests } from '../src/lib/changeRequests';
import { buildApp } from '../src/router';
import { signJwt } from '../src/lib/jwt';
import { createSession } from '../src/lib/sessions';
import type { Env } from '../src/env';
import type { EventRow } from '../src/lib/events';
import type { ShimDatabase } from './d1shim';
import {
  countRows,
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

// Pass 16 review (September 2026). One P1 and eight P2, and the P1 was mine:
// the Pass-15 recovery arm replayed accepted-but-unstamped effects, which is
// safe against a world that has not changed and a privacy failure against one
// that has.
//
// The fix is a removal, so most of these tests guard an absence. That makes
// them the most important kind to write down clearly: nothing in the code
// points at them, and the next person to think "we should recover those rows"
// will not find the reasoning unless it is here.

let fetchStub: FetchStub | null = null;
afterEach(() => {
  fetchStub?.restore();
  fetchStub = null;
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// P16-01 (P1)
// ---------------------------------------------------------------------------

async function seedStrandedInvite(db: ShimDatabase): Promise<void> {
  await seedGuild(db, 'guild-1');
  for (const id of ['organizer', 'asker', 'guest']) {
    await seedUser(db, id);
    await seedMembership(db, id, 'guild-1');
  }
  const start = Date.now() + 5 * DAY_MS;
  await seedEvent(db, { id: 'ev-1', organizerId: 'organizer', startAt: start, endAt: start + 2 * HOUR_MS });
  await seedInvite(db, 'ev-1', 'asker');
  // The acceptance applied -- the invite exists -- and only its completion
  // record was lost. This is the likelier half of the window, and the half
  // that made replay look safe.
  await seedInvite(db, 'ev-1', 'guest');
  await db
    .prepare(
      `INSERT INTO event_change_requests
         (id, event_id, requester_id, kind, target_user_id, occurrence_date, status, event_revision,
          message, created_at, decided_at, decided_by, applied_at)
       VALUES ('cr-1', 'ev-1', 'asker', 'add_invitee', 'guest', '', 'accepted', 0, NULL, ?, ?, 'organizer', NULL)`,
    )
    .bind(Date.now() - DAY_MS, Date.now() - HOUR_MS)
    .run();
}

describe('a stranded acceptance is never replayed over a later decision (P16-01)', () => {
  it('does not re-admit a guest the organizer has since removed', async () => {
    const { db, env } = setup('paid');
    await seedStrandedInvite(db);

    // The organizer changes their mind.
    await db.prepare(`DELETE FROM event_invites WHERE event_id = 'ev-1' AND user_id = 'guest'`).run();
    // ...and then edits the event, so anything that re-admits them hands over
    // content written after their access ended.
    await db
      .prepare(`UPDATE events SET title = 'Raid on the Vault -- private', description = 'meet at mine' WHERE id = 'ev-1'`)
      .run();

    await resolvePastDeadlineChangeRequests(env);

    expect(
      await countRows(db, 'event_invites', `event_id = 'ev-1' AND user_id = 'guest'`),
      'a removed guest was re-admitted by recovery, to an event edited after their removal',
    ).toBe(0);
  });

  it('does not un-cancel an occurrence the organizer has since cancelled', async () => {
    const { db, env } = setup('paid');
    await seedGuild(db, 'guild-1');
    for (const id of ['organizer', 'asker']) {
      await seedUser(db, id);
      await seedMembership(db, id, 'guild-1');
    }
    await seedEvent(db, { id: 'ev-1', organizerId: 'organizer', startAt: null, endAt: null, isRecurring: 1 });
    await seedInvite(db, 'ev-1', 'asker');
    const start = Date.now() + 5 * DAY_MS;
    await db
      .prepare(
        `INSERT INTO event_change_requests
           (id, event_id, requester_id, kind, target_user_id, occurrence_date, status, event_revision,
            proposed_start_at, proposed_end_at, message, created_at, decided_at, decided_by, applied_at)
         VALUES ('cr-1', 'ev-1', 'asker', 'time_change', NULL, '2030-03-14', 'accepted', 0, ?, ?, NULL, ?, ?, 'organizer', NULL)`,
      )
      .bind(start, start + HOUR_MS, Date.now() - DAY_MS, Date.now() - HOUR_MS)
      .run();
    await db
      .prepare(
        `INSERT INTO event_occurrence_overrides (id, event_id, occurrence_date, is_cancelled)
         VALUES ('ovr-1', 'ev-1', '2030-03-14', 1)`,
      )
      .run();

    await resolvePastDeadlineChangeRequests(env);

    const override = await db
      .prepare(`SELECT is_cancelled FROM event_occurrence_overrides WHERE id = 'ovr-1'`)
      .first<{ is_cancelled: number }>();
    expect(
      override!.is_cancelled,
      'a cancelled occurrence was brought back to life by replaying an old acceptance',
    ).toBe(1);
  });

  it('leaves the stranded row alone rather than declining it', async () => {
    const { db, env } = setup('paid');
    await seedStrandedInvite(db);

    await resolvePastDeadlineChangeRequests(env);

    const row = await db
      .prepare(`SELECT status, applied_at FROM event_change_requests WHERE id = 'cr-1'`)
      .first<{ status: string; applied_at: number | null }>();
    // Untouched: 'accepted' with no stamp is exactly the state that needs
    // human or future reconciliation, and guessing at it is what caused the P1.
    expect(row!.status).toBe('accepted');
    expect(row!.applied_at).toBeNull();
  });

  // An invariant guard, not a reproduction: it passes on the unfixed tree too,
  // because P16-03's starvation needed the stranded row to ERROR -- it was at
  // the invite cap -- and this fixture's row simply replayed successfully.
  // Kept because removing the recovery arm is what makes the starvation
  // structurally impossible, and this is the assertion that would notice if a
  // future arm brought it back.
  it('still resolves ordinary pending deadline work alongside it', async () => {
    const { db, env } = setup('paid');
    await seedStrandedInvite(db);
    // A second, healthy request whose deadline has passed. P16-03 was about a
    // stranded row starving exactly this.
    await db
      .prepare(
        `INSERT INTO event_change_requests
           (id, event_id, requester_id, kind, target_user_id, occurrence_date, status, event_revision,
            proposed_start_at, proposed_end_at, message, created_at, vote_deadline_at)
         VALUES ('cr-2', 'ev-1', 'asker', 'time_change', NULL, '', 'pending', 0, ?, ?, NULL, ?, ?)`,
      )
      .bind(Date.now() + 9 * DAY_MS, Date.now() + 9 * DAY_MS + HOUR_MS, Date.now(), Date.now() - HOUR_MS)
      .run();

    const resolved = await resolvePastDeadlineChangeRequests(env);

    expect(resolved, 'a stranded acceptance stopped unrelated deadline work from resolving').toContain('cr-2');
  });
});

// ---------------------------------------------------------------------------
// P16-02
// ---------------------------------------------------------------------------

// The completion stamp used to live inside the same try as the event mutation,
// so failing to RECORD an application was handled as failing TO apply: the
// compensating release ran and the request went back to pending over an event
// that had already moved.
describe('a failed completion record does not undo the change (P16-02)', () => {
  it('leaves the request accepted when only the stamp fails', async () => {
    const { db, env } = setup('paid');
    await seedGuild(db, 'guild-1');
    for (const id of ['organizer', 'asker']) {
      await seedUser(db, id);
      await seedMembership(db, id, 'guild-1');
    }
    const start = Date.now() + 5 * DAY_MS;
    await seedEvent(db, { id: 'ev-1', organizerId: 'organizer', startAt: start, endAt: start + 2 * HOUR_MS });
    await seedInvite(db, 'ev-1', 'asker');
    const proposedStart = start + 3 * HOUR_MS;
    await db
      .prepare(
        `INSERT INTO event_change_requests
           (id, event_id, requester_id, kind, target_user_id, occurrence_date, status, event_revision,
            proposed_start_at, proposed_end_at, message, created_at)
         VALUES ('cr-1', 'ev-1', 'asker', 'time_change', NULL, '', 'pending', 0, ?, ?, NULL, ?)`,
      )
      .bind(proposedStart, proposedStart + 2 * HOUR_MS, Date.now())
      .run();
    const event = await db.prepare(`SELECT * FROM events WHERE id = 'ev-1'`).first<EventRow>();
    const request = await db.prepare(`SELECT * FROM event_change_requests WHERE id = 'cr-1'`).first();

    // Only the completion stamp fails -- the mutation before it commits.
    const failing = new Proxy(env.DB, {
      get(target, prop, receiver) {
        if (prop === 'prepare') {
          return (sql: string) => {
            const stmt = Reflect.get(target, prop, receiver).call(target, sql);
            if (sql.includes('SET applied_at = ?')) {
              return { bind: () => ({ run: async () => { throw new Error('injected stamp failure'); } }) };
            }
            return stmt;
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });

    // Through the exported entry point rather than the internal helper: the
    // P14-09 lesson is that a test which reaches past the real caller can pass
    // for reasons the real caller would not reproduce.
    // Swallowed so the unfixed symptom arrives as an ASSERTION rather than a
    // raw throw: on the old tree the catch released the claim and then
    // rethrew, and "test errored" says much less than "status was pending".
    await acceptChangeRequest({ ...env, DB: failing } as Env, event as never, request as never, 'organizer').catch(
      () => undefined,
    );

    const row = await db
      .prepare(`SELECT status, applied_at FROM event_change_requests WHERE id = 'cr-1'`)
      .first<{ status: string; applied_at: number | null }>();
    const after = await db.prepare(`SELECT start_at FROM events WHERE id = 'ev-1'`).first<{ start_at: number }>();

    expect(after!.start_at, 'the change did not apply, so this test is not about what it claims').toBe(proposedStart);
    expect(
      row!.status,
      'a change that had already applied was released back to pending, where a stale revision declines it',
    ).toBe('accepted');
    expect(row!.applied_at, 'the stamp is expected to be missing -- that is the contained cost').toBeNull();
  });
});

// ---------------------------------------------------------------------------
// P16-04
// ---------------------------------------------------------------------------

// F-44 asked the refusal path to revoke the token it had just exchanged. That
// is grant-level at Google, so for a user reconnecting an account they already
// have connected, a transient identity outage revoked the grant their WORKING
// connection depends on.
describe('a refused reconnect does not revoke the connection the user already has (P16-04)', () => {
  const app = buildApp();

  async function beginConnect(env: Env, userId: string): Promise<{ cookie: string; state: string }> {
    const { id: sessionId } = await createSession(env, userId);
    const auth = await signJwt(userId, sessionId, env.JWT_SIGNING_KEY);
    const urlRes = await app.request(
      'https://worker.test/google/connect-url',
      { method: 'POST', headers: { Authorization: `Bearer ${auth}` } },
      env,
    );
    const { startUrl } = await urlRes.json<{ startUrl: string }>();
    const startRes = await app.request(
      `https://worker.test/google/start${new URL(startUrl).search}`,
      { redirect: 'manual' },
      env,
    );
    const raw = startRes.headers.get('set-cookie');
    if (!raw) throw new Error('test fixture: no Set-Cookie on /google/start');
    return { cookie: raw.split(';')[0], state: new URL(startRes.headers.get('location')!).searchParams.get('state')! };
  }

  it('refuses without touching the grant', async () => {
    const { db, env: base } = setup();
    const env: Env = {
      ...base,
      GOOGLE_SYNC_MODE: 'live',
      GOOGLE_CLIENT_ID: 'google-client-id',
      GOOGLE_CLIENT_SECRET: 'google-client-secret',
      GOOGLE_TOKEN_ENCRYPTION_KEY: 'test-google-encryption-key-at-least-32-chars',
    };
    await seedGuild(db, 'guild-1');
    await seedUser(db, 'u1');
    await seedMembership(db, 'u1', 'guild-1');

    const { cookie, state } = await beginConnect(env, 'u1');
    fetchStub = stubFetch([
      {
        match: 'oauth2.googleapis.com/token',
        status: 200,
        body: { access_token: 'at', refresh_token: 'same-account-refresh', expires_in: 3600 },
      },
      { match: 'oauth2.googleapis.com/revoke', status: 200, body: {} },
      // The identity lookup has an outage -- the only precondition needed.
      { match: 'users/me/calendarList', status: 503, body: {} },
    ]);

    const res = await app.request(
      `https://worker.test/google/callback?code=abc&state=${encodeURIComponent(state)}`,
      { headers: { Cookie: cookie }, redirect: 'manual' },
      env,
    );

    expect(res.headers.get('location')).toContain('google=account_unverified');
    expect(
      fetchStub.calls.filter((u) => u.includes('/revoke')),
      "the refusal revoked a grant that the user's existing connection may share",
    ).toHaveLength(0);
  });
});
