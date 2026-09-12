import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/router';
import { signToken } from '../src/lib/signedToken';
import { seedEvent, seedGuild, seedMembership, seedUser, setup, stubFetch, type FetchStub } from './helpers';
import { storePendingConnection } from '../src/lib/googleCalendar';
import { signJwt } from '../src/lib/jwt';
import { createSession } from '../src/lib/sessions';
import type { Env } from '../src/env';
import type { ShimDatabase } from './d1shim';

// Pass 21 was the first whole-application review rather than a review of the
// diff, and it is the pass that found things eight diff-scoped passes could
// not: both findings are in original code, neither is in a recent change, and
// both were found by reading a flow end to end.
//
// F-59. `/auth/callback` and `/guild-requests/callback` compared `?state=`
// against a cookie the same client sets, so one unauthenticated request
// reached `exchangeCodeForToken` -- a POST to Discord's token endpoint
// carrying this app's client secret, against a per-client rate limit, with no
// session and no database write in the way.
//
// Nothing is disclosed and no account is touched, which is exactly why the
// release bar's first two clauses could not see it. The bar has a third clause
// now.
let fetchStub: FetchStub | null = null;
afterEach(() => {
  fetchStub?.restore();
  fetchStub = null;
});

const app = buildApp();

async function authFor(env: Env, userId: string): Promise<string> {
  const { id: sessionId } = await createSession(env, userId);
  return signJwt(userId, sessionId, env.JWT_SIGNING_KEY);
}

function tokenEndpointCalls(stub: FetchStub): string[] {
  return stub.calls.filter((u) => u.includes('/oauth2/token'));
}

describe('a forged OAuth callback costs no Discord token exchange (F-59)', () => {
  it('refuses a self-minted login state before reaching Discord', async () => {
    const { env } = setup();
    fetchStub = stubFetch([
      { match: '/oauth2/token', status: 200, body: { access_token: 'a', token_type: 'Bearer' } },
    ]);

    // Exactly the reviewer's request. No /auth/login first: the attacker
    // supplies both halves of the comparison.
    const res = await app.request(
      'https://worker.test/auth/callback?code=anything&state=X',
      { headers: { Cookie: 'oauth_state=X:anything' } },
      env,
    );

    expect(res.status).toBe(400);
    expect(
      tokenEndpointCalls(fetchStub),
      'one unauthenticated request spent a call to Discord\'s token endpoint',
    ).toEqual([]);
  });

  it('refuses a self-minted guild-request state before reaching Discord', async () => {
    const { env } = setup();
    fetchStub = stubFetch([
      { match: '/oauth2/token', status: 200, body: { access_token: 'a', token_type: 'Bearer' } },
    ]);

    const res = await app.request(
      'https://worker.test/guild-requests/callback?code=anything&state=X',
      { headers: { Cookie: 'guild_verify_state=X' } },
      env,
    );

    expect(res.status).toBe(400);
    expect(tokenEndpointCalls(fetchStub)).toEqual([]);
  });

  // The next three are invariant guards, not reproductions: all three pass on
  // the unfixed tree too, because the old cookie comparison already refused a
  // wrong-purpose token (it is not the cookie value) and a missing cookie, and
  // ordinary login obviously worked. They are here because signing a state is
  // the kind of change that breaks login for everyone, and because a purpose
  // check omitted from a signature guard would pass both reproductions above
  // while being worth much less.
  //
  // The state is signed with THIS app's key for THIS purpose. A token the app
  // really issued, for something else, must not be reusable here -- that is
  // what the purpose field in signedToken is for, and a guard without it would
  // pass every test above while being worth much less.
  it('refuses a validly signed token issued for a different purpose', async () => {
    const { env } = setup();
    fetchStub = stubFetch([
      { match: '/oauth2/token', status: 200, body: { access_token: 'a', token_type: 'Bearer' } },
    ]);

    const wrongPurpose = await signToken('google_connect', { nonce: 'X' }, env.JWT_SIGNING_KEY, 300);
    const res = await app.request(
      `https://worker.test/auth/callback?code=anything&state=${encodeURIComponent(wrongPurpose)}`,
      { headers: { Cookie: 'oauth_state=X:anything' } },
      env,
    );

    expect(res.status).toBe(400);
    expect(tokenEndpointCalls(fetchStub)).toEqual([]);
  });

  // The cookie half is the CSRF binding and must still be load-bearing: a
  // signed state proves we issued it, not that this browser asked for it. An
  // attacker who captures a real state from their OWN login and redirects a
  // victim into it must still fail.
  it('still refuses a genuinely signed state that this browser did not start', async () => {
    const { env } = setup();
    fetchStub = stubFetch([
      { match: '/oauth2/token', status: 200, body: { access_token: 'a', token_type: 'Bearer' } },
    ]);

    const realState = await signToken('discord_oauth_state', { nonce: 'attacker-nonce' }, env.JWT_SIGNING_KEY, 300);
    const res = await app.request(
      `https://worker.test/auth/callback?code=anything&state=${encodeURIComponent(realState)}`,
      // The victim's browser has no matching cookie.
      {},
      env,
    );

    expect(res.status).toBe(400);
    expect(tokenEndpointCalls(fetchStub)).toEqual([]);
  });

  // The control that matters most: an ordinary login must still work. /login
  // issues the state and sets the cookie; the callback must accept that pair.
  it('still completes an ordinary login started at /auth/login', async () => {
    const { db, env } = setup();
    await seedGuild(db as ShimDatabase, 'guild-1');
    fetchStub = stubFetch([
      { match: '/oauth2/token', status: 200, body: { access_token: 'a', token_type: 'Bearer' } },
      { match: '/users/@me/guilds', status: 200, body: [{ id: 'guild-1' }] },
      { match: '/users/@me', status: 200, body: { id: 'u1', username: 'u1', global_name: 'U One', avatar: null } },
    ]);

    const challenge = 'a'.repeat(43);
    const start = await app.request(`https://worker.test/auth/login?challenge=${challenge}`, {}, env);
    expect(start.status).toBe(302);

    const authorizeUrl = new URL(start.headers.get('location')!);
    const state = authorizeUrl.searchParams.get('state')!;
    const cookie = start.headers.get('set-cookie')!.split(';')[0];

    const res = await app.request(
      `https://worker.test/auth/callback?code=abc&state=${encodeURIComponent(state)}`,
      { headers: { Cookie: cookie } },
      env,
    );

    expect(
      res.status,
      'signing the state broke ordinary login, which is far worse than the finding',
    ).not.toBe(400);
    expect(tokenEndpointCalls(fetchStub).length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// F-60. Connecting a different Google account while one is active was a
// disconnect that skipped everything disconnect promises. `storeConnection`'s
// switch branch revoked the old grant FIRST, then dropped every mapping, and
// its own comment called the abandoned calendar entries unavoidable -- true
// only because the revoke three statements earlier had thrown away the
// authority that could have removed them.
//
// The Privacy Policy and the disconnect dialog both promise that removal
// without qualification, so this is inside clause 2 of the release bar by the
// same reading that made P19-08 blocking.
describe('a Google account switch cannot skip the disconnect promise (F-60)', () => {
  const ENCRYPTION_KEY = 'test-google-encryption-key-at-least-32-chars';

  function googleEnv(base: Env): Env {
    return {
      ...base,
      GOOGLE_SYNC_MODE: 'live',
      GOOGLE_CLIENT_ID: 'google-client-id',
      GOOGLE_CLIENT_SECRET: 'google-client-secret',
      GOOGLE_TOKEN_ENCRYPTION_KEY: ENCRYPTION_KEY,
    };
  }

  async function seedActiveConnection(db: ShimDatabase, email: string): Promise<void> {
    const now = Date.now();
    await db
      .prepare(
        `INSERT INTO google_calendar_connections
           (user_id, refresh_token_ciphertext, refresh_token_iv, access_token_ciphertext, access_token_iv,
            access_token_expires_at, google_account_email, calendar_id, sync_enabled, status,
            last_synced_at, disconnect_attempts, connected_at, updated_at)
         VALUES ('u1', 'ct', 'iv', NULL, NULL, NULL, ?, 'primary', 1, 'active', NULL, 0, ?, ?)`,
      )
      .bind(email, now, now)
      .run();
  }

  async function seedSyncedEntry(db: ShimDatabase): Promise<void> {
    await seedEvent(db, {
      id: 'evt-1',
      organizerId: 'u1',
      startAt: Date.now() + 2 * 86400000,
      endAt: Date.now() + 2 * 86400000 + 3600000,
    });
    await db
      .prepare(
        `INSERT INTO google_event_links
           (id, user_id, event_id, occurrence_date, google_event_id, synced_title, synced_start_at,
            synced_end_at, synced_at, calendar_id)
         VALUES ('lnk-1', 'u1', 'evt-1', '', 'g-1', 'Session', ?, ?, ?, 'primary')`,
      )
      .bind(Date.now() + 2 * 86400000, Date.now() + 2 * 86400000 + 3600000, Date.now())
      .run();
  }

  async function finalize(env: Env, pendingId: string): Promise<Response> {
    const auth = await authFor(env, 'u1');
    return app.request(
      'https://worker.test/google/finalize',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${auth}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ pendingId }),
      },
      env,
    );
  }

  it('refuses finalize for a different account while one is connected', async () => {
    const { db, env: base } = setup();
    const env = googleEnv(base);
    await seedGuild(db, 'guild-1');
    await seedUser(db, 'u1');
    await seedMembership(db, 'u1', 'guild-1');
    await seedActiveConnection(db, 'first@gmail.com');
    await seedSyncedEntry(db);

    fetchStub = stubFetch([{ match: 'oauth2.googleapis.com/revoke', status: 200, body: {} }]);
    const pendingId = await storePendingConnection(env, 'u1', 'new-refresh', 'new-access', 3600, 'second@gmail.com');

    const res = await finalize(env, pendingId);

    expect(res.status, 'the switch was allowed and silently abandoned the old calendar').toBe(409);

    // The destructive branch never ran: the mapping is still there, so the
    // entry in the old calendar is still reachable, and the grant that can
    // reach it is still active.
    const links = await db
      .prepare(`SELECT COUNT(*) AS n FROM google_event_links WHERE user_id = 'u1'`)
      .first<{ n: number }>();
    expect(links!.n, 'the mapping was dropped, so nothing can find the entry in the old calendar').toBe(1);

    const conn = await db
      .prepare(`SELECT google_account_email, status FROM google_calendar_connections WHERE user_id = 'u1'`)
      .first<{ google_account_email: string; status: string }>();
    expect(conn!.google_account_email).toBe('first@gmail.com');
    expect(conn!.status).toBe('active');
  });

  it('does not leave the refused grant lying around', async () => {
    const { db, env: base } = setup();
    const env = googleEnv(base);
    await seedGuild(db, 'guild-1');
    await seedUser(db, 'u1');
    await seedMembership(db, 'u1', 'guild-1');
    await seedActiveConnection(db, 'first@gmail.com');

    fetchStub = stubFetch([{ match: 'oauth2.googleapis.com/revoke', status: 200, body: {} }]);
    const pendingId = await storePendingConnection(env, 'u1', 'new-refresh', 'new-access', 3600, 'second@gmail.com');

    await finalize(env, pendingId);

    // The user is not getting this connection, so the credential for it is not
    // kept -- same discipline as the wrong-owner branch beside it.
    expect(fetchStub.calls.some((u) => u.includes('/revoke'))).toBe(true);
    const pending = await db
      .prepare(`SELECT COUNT(*) AS n FROM google_pending_connections WHERE id = ?`)
      .bind(pendingId)
      .first<{ n: number }>();
    expect(pending!.n).toBe(0);
  });

  // The controls. A same-account reconnect is the ordinary repair path and must
  // still work, and a switch away from a connection that is already broken must
  // still be allowed -- there is no authority left to preserve there, which is
  // why the policy now says what that case leaves behind.
  it('still allows a same-account reconnect', async () => {
    const { db, env: base } = setup();
    const env = googleEnv(base);
    await seedGuild(db, 'guild-1');
    await seedUser(db, 'u1');
    await seedMembership(db, 'u1', 'guild-1');
    await seedActiveConnection(db, 'first@gmail.com');

    const pendingId = await storePendingConnection(env, 'u1', 'r', 'a', 3600, 'first@gmail.com');
    const res = await finalize(env, pendingId);

    expect(res.status, 'refusing a switch also broke the ordinary reconnect').toBe(200);
  });

  // There is no 'unauthorized' status -- migration 0036 CHECKs status into
  // ('active','disconnecting'), and a grant Google has rejected is marked
  // sync_enabled = 0 with a last_error while STAYING 'active'. A guard keyed on
  // status alone would have trapped exactly the person most likely to be
  // switching: someone whose grant just died. This is the test that found that,
  // by failing on the CHECK constraint.
  it('still allows switching away from a grant Google has already rejected', async () => {
    const { db, env: base } = setup();
    const env = googleEnv(base);
    await seedGuild(db, 'guild-1');
    await seedUser(db, 'u1');
    await seedMembership(db, 'u1', 'guild-1');
    await seedActiveConnection(db, 'first@gmail.com');
    await db
      .prepare(
        `UPDATE google_calendar_connections SET sync_enabled = 0, last_error = 'Google access was revoked.'
         WHERE user_id = 'u1'`,
      )
      .run();

    fetchStub = stubFetch([{ match: 'oauth2.googleapis.com/revoke', status: 200, body: {} }]);
    const pendingId = await storePendingConnection(env, 'u1', 'r', 'a', 3600, 'second@gmail.com');
    const res = await finalize(env, pendingId);

    expect(res.status, 'a user whose grant is already dead was trapped').toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Pass-21 review (P21-04). Authority was re-derived correctly here and SCOPE
// was not. "Cancel this session" is only ever emitted for a one-off, but the
// owner can convert that event into a recurring series afterwards -- and the
// handler applied a one-session control to the whole series.
//
// Nothing about identity was wrong, which is why reading the custom-id parser
// and the authorization checks did not reveal it. One reviewer read exactly
// those and called the surface clean; another executed it and measured three
// occurrences going to zero.
describe('a one-session Discord control cannot cancel a series (P21-04)', () => {
  async function seedConvertedEvent(db: ShimDatabase): Promise<void> {
    await seedGuild(db, 'guild-1');
    await seedUser(db, 'owner');
    await seedMembership(db, 'owner', 'guild-1');
    // Emitted as a one-off; converted to a three-day series afterwards.
    await seedEvent(db, { id: 'evt-1', organizerId: 'owner', startAt: null, endAt: null, isRecurring: 1 });
    await db
      .prepare(
        `INSERT INTO event_recurrence_rules
           (event_id, freq, interval, by_weekday, by_month_day, start_date, start_time,
            duration_minutes, end_type, end_date, end_count)
         VALUES ('evt-1', 'DAILY', 1, NULL, NULL, '2026-09-20', '19:00', 120, 'after_count', NULL, 3)`,
      )
      .run();
  }

  it('refuses the stale one-off control and leaves the series active', async () => {
    const { db, env } = setup();
    await seedConvertedEvent(db);

    const { handleInteraction } = await import('../src/lib/interactions');
    const res = await handleInteraction(
      env,
      { type: 3, data: { custom_id: 'uo:v2:cancel:evt-1' }, member: { user: { id: 'owner' } } } as never,
    );

    const after = await db.prepare(`SELECT status FROM events WHERE id = 'evt-1'`).first<{ status: string }>();
    expect(
      after?.status,
      'a button that says "cancel this session" cancelled every date in the series',
    ).toBe('active');
    expect(JSON.stringify(res)).toMatch(/repeating/i);
  });

  // The control: an ordinary one-off cancel must still work, or this guard has
  // broken the feature instead of scoping it.
  it('still cancels a genuinely one-off event', async () => {
    const { db, env } = setup();
    await seedGuild(db, 'guild-1');
    await seedUser(db, 'owner');
    await seedMembership(db, 'owner', 'guild-1');
    await seedEvent(db, { id: 'evt-2', organizerId: 'owner' });

    const { handleInteraction } = await import('../src/lib/interactions');
    await handleInteraction(
      env,
      { type: 3, data: { custom_id: 'uo:v2:cancel:evt-2' }, member: { user: { id: 'owner' } } } as never,
    );

    const after = await db.prepare(`SELECT status FROM events WHERE id = 'evt-2'`).first<{ status: string }>();
    expect(after?.status, 'scoping the control broke ordinary one-off cancellation').toBe('cancelled');
  });
});

// ---------------------------------------------------------------------------
// Pass-21 review (P21-03). The ownership check is a read at the top of the
// handler; the writes happen later. A handover landing in between -- by the
// same person, through their own legitimate action -- let the stale request
// replace the roster and remove the NEW owner from it. The result was a group
// whose stored owner was not a member: 404 for them on every route, 403 for
// everyone else on every administrative one. Nobody could administer it, and
// nothing had failed.
describe('a roster write cannot outlive the authority it was allowed under (P21-03)', () => {
  async function seedGroup(db: ShimDatabase): Promise<void> {
    await seedGuild(db, 'guild-1');
    for (const id of ['alpha', 'bravo', 'charlie']) {
      await seedUser(db, id);
      await seedMembership(db, id, 'guild-1');
    }
    // Migration 0031 dropped groups.guild_id -- groups are server-less since
    // specs/0011. Getting this wrong is how the first version of this fixture
    // failed, which is a cheap reminder that a test written from an old schema
    // reads as a product failure.
    await db
      .prepare(`INSERT INTO groups (id, name, created_by, created_at) VALUES ('grp-1','Party','alpha',?)`)
      .bind(Date.now())
      .run();
    for (const id of ['alpha', 'bravo']) {
      await db
        .prepare(`INSERT INTO group_members (group_id, user_id, added_at) VALUES ('grp-1', ?, ?)`)
        .bind(id, Date.now())
        .run();
    }
  }

  // The handover has to land BETWEEN the handler's ownership read and its
  // write. Applying it beforehand instead is how the first version of this
  // test passed on the unfixed tree -- the handler's own read then saw the new
  // owner and returned 404 because alpha was no longer a member, which is
  // correct behaviour for a different scenario. Seventh fixture in this cycle
  // to pass for the wrong reason, and the third caught by revert-verifying
  // rather than by a reviewer.
  // The handover lands after authorization and before the write batch, which
  // is exactly where the reviewer put it. Two earlier placements both made
  // this pass on the unfixed tree for reasons unrelated to the guard: applying
  // it before the request meant the handler's own read saw the new owner, and
  // firing it on the ownership SELECT meant loadGroup's membership check --
  // which runs after that SELECT -- returned 404. Both are correct behaviour
  // for a different scenario.
  //
  // Seventh fixture in this cycle to pass for the wrong reason, and the third
  // caught by revert-verifying rather than by a reviewer. The rule from IDEAS
  // item 84 held: revert the fix and confirm the test fails FOR THE STATED
  // REASON, not merely that it fails.
  function handoverBeforeWriteBatch(env: { DB: unknown }): void {
    const db = env.DB as ShimDatabase;
    const realBatch = db.batch.bind(db);
    let fired = false;
    (db as unknown as { batch: (s: unknown[]) => unknown }).batch = async (statements: unknown[]) => {
      if (!fired) {
        fired = true;
        await db.prepare(`UPDATE groups SET created_by = 'bravo' WHERE id = 'grp-1'`).run();
        await db.prepare(`DELETE FROM group_members WHERE group_id = 'grp-1' AND user_id = 'alpha'`).run();
      }
      return realBatch(statements as never);
    };
  }

  it('refuses a roster replacement written under ownership that has since moved', async () => {
    const { db, env } = setup();
    await seedGroup(db);

    const auth = await authFor(env, 'alpha');
    // Alpha's PATCH is authorised against the ownership it reads, and the
    // handover commits immediately afterwards.
    handoverBeforeWriteBatch(env);
    const res = await app.request(
      'https://worker.test/groups/grp-1',
      {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${auth}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ member_user_ids: ['alpha', 'charlie'] }),
      },
      env,
    );

    expect(res.status, 'a former owner rewrote the roster after handing the group over').not.toBe(200);

    // The invariant that actually matters: the stored owner is still a member,
    // so the group still has someone who can administer it.
    const owner = await db.prepare(`SELECT created_by FROM groups WHERE id = 'grp-1'`).first<{ created_by: string }>();
    const ownerIsMember = await db
      .prepare(`SELECT COUNT(*) AS n FROM group_members WHERE group_id = 'grp-1' AND user_id = ?`)
      .bind(owner!.created_by)
      .first<{ n: number }>();
    expect(
      ownerIsMember!.n,
      'the group was left with an owner who is not a member, so nobody can administer it',
    ).toBe(1);
  });

  // The control: the current owner's ordinary roster edit must still work.
  it('still lets the current owner replace the roster', async () => {
    const { db, env } = setup();
    await seedGroup(db);

    const auth = await authFor(env, 'alpha');
    const res = await app.request(
      'https://worker.test/groups/grp-1',
      {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${auth}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ member_user_ids: ['alpha', 'charlie'] }),
      },
      env,
    );

    expect(res.status, 'guarding the roster write broke ordinary roster editing').toBe(200);
    const members = await db
      .prepare(`SELECT user_id FROM group_members WHERE group_id = 'grp-1' ORDER BY user_id`)
      .all<{ user_id: string }>();
    expect(members.results.map((m) => m.user_id)).toEqual(['alpha', 'charlie']);
  });

  it('still lets the current owner rename the group', async () => {
    const { db, env } = setup();
    await seedGroup(db);

    const auth = await authFor(env, 'alpha');
    const res = await app.request(
      'https://worker.test/groups/grp-1',
      {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${auth}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Renamed' }),
      },
      env,
    );

    expect(res.status).toBe(200);
    const row = await db.prepare(`SELECT name FROM groups WHERE id = 'grp-1'`).first<{ name: string }>();
    expect(row!.name).toBe('Renamed');
  });
});
