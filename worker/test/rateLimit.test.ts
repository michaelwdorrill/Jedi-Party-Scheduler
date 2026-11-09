import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/router';
import { runReminderSweep } from '../src/cron/reminders';
import { callbackBucket, MAX_CALLBACKS_PER_MINUTE, oauthCallbackAllowed } from '../src/lib/rateLimit';
import { createSession } from '../src/lib/sessions';
import { signJwt } from '../src/lib/jwt';
import { seedGuild, seedMembership, seedUser, setup, stubFetch, type FetchStub } from './helpers';
import type { Env } from '../src/env';
import type { ShimDatabase } from './d1shim';

// IDEAS item 92 / release-bar clause 3. F-59 made a FORGED OAuth callback free
// (signature before spend); it did not bound a callback that verifies. An
// attacker calls /auth/login for a real signed state and pays two requests per
// token exchange instead of one -- the price went up, the rate did not.
//
// src/lib/rateLimit.ts is that bound. These tests pin the three properties the
// bound has to have and the one it must not break:
//
//   1. Over the limit, no token exchange happens at all.
//   2. It is consulted AFTER the signature check, so a forged state cannot
//      burn a real address's allowance.
//   3. It keys on CF-Connecting-IP, so one caller cannot lock out another.
//   4. An ordinary login still works. (The control. This is the one that
//      matters more than the other three put together.)
//
// Rewritten 9 November 2026, when the bound moved from Cloudflare's
// rate-limiting binding (which never refused anything in the sandbox) to a
// count in D1. The tests used to run against a fake binding that counted
// exactly -- which is how a binding that did not count at all passed them.
// They now drive the real counter, in the same database the app uses.

let fetchStub: FetchStub | null = null;
afterEach(() => {
  fetchStub?.restore();
  fetchStub = null;
  vi.useRealTimers();
});

const app = buildApp();

// Fills an address's allowance for the current minute, as if it had already
// made `count` callbacks -- so a route test can check the refusal without
// twenty real logins first. Uses the same bucket derivation as the code.
async function exhaust(env: Env, ip: string, count = MAX_CALLBACKS_PER_MINUTE): Promise<void> {
  const bucket = await callbackBucket(env, new Headers({ 'CF-Connecting-IP': ip }));
  const now = Date.now();
  await (env.DB as unknown as ShimDatabase)
    .prepare(`INSERT INTO oauth_callback_counts (bucket, window_start, count) VALUES (?, ?, ?)`)
    .bind(bucket, now - (now % 60_000), count)
    .run();
}

async function countRows(env: Env): Promise<{ bucket: string; count: number }[]> {
  const { results } = await (env.DB as unknown as ShimDatabase)
    .prepare(`SELECT bucket, count FROM oauth_callback_counts`)
    .all<{ bucket: string; count: number }>();
  return results;
}

const fromIp = (ip: string) => new Headers({ 'CF-Connecting-IP': ip });

function tokenEndpointCalls(stub: FetchStub): string[] {
  return stub.calls.filter((u) => u.includes('/oauth2/token'));
}

const IP = '203.0.113.7';
const OTHER_IP = '198.51.100.9';

// A real login, start to finish: /auth/login mints the signed state and the
// cookie, and the callback is given exactly that pair. Nothing here is
// fabricated, which is the point -- this is the request F-59's fix admits.
async function realLoginCallback(
  env: Env,
  ip: string,
  challengeChar = 'a',
): Promise<Response> {
  const challenge = challengeChar.repeat(43);
  const start = await app.request(`https://worker.test/auth/login?challenge=${challenge}`, {}, env);
  const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
  const cookie = start.headers.get('set-cookie')!.split(';')[0];
  return app.request(
    `https://worker.test/auth/callback?code=abc&state=${encodeURIComponent(state)}`,
    { headers: { Cookie: cookie, 'CF-Connecting-IP': ip } },
    env,
  );
}

function discordLoginStub(): FetchStub {
  return stubFetch([
    { match: '/oauth2/token', status: 200, body: { access_token: 'a', token_type: 'Bearer' } },
    { match: '/users/@me/guilds', status: 200, body: [{ id: 'guild-1' }] },
    { match: '/users/@me', status: 200, body: { id: 'u1', username: 'u1', global_name: 'U One', avatar: null } },
  ]);
}

describe('the OAuth callbacks are bounded (item 92, bar clause 3)', () => {
  // INVARIANT GUARD, not a reproduction: this passes with the limiter removed
  // too, which is the point of a control. It is here because breaking login is
  // a far worse outcome than the finding, and nothing else in this file would
  // notice.
  it('still completes an ordinary login — the control', async () => {
    const { db, env: base } = setup();
    await seedGuild(db as ShimDatabase, 'guild-1');
    const env = base;
    fetchStub = discordLoginStub();

    const res = await realLoginCallback(env, IP);

    expect(res.status, 'bounding the callback broke ordinary login').not.toBe(429);
    expect(tokenEndpointCalls(fetchStub).length).toBe(1);
  });

  it('allows exactly MAX_CALLBACKS_PER_MINUTE from one address in a minute, then refuses', async () => {
    // The property the Cloudflare binding never had in the sandbox: the
    // twenty-first callback from one address in a minute is refused.
    const { env } = setup();
    const answers: boolean[] = [];
    for (let i = 0; i < MAX_CALLBACKS_PER_MINUTE + 1; i++) answers.push(await oauthCallbackAllowed(env, fromIp(IP)));
    expect(answers.slice(0, MAX_CALLBACKS_PER_MINUTE).every(Boolean)).toBe(true);
    expect(answers[MAX_CALLBACKS_PER_MINUTE]).toBe(false);
  });

  it('refuses with 429 and spends nothing once an address is over the limit', async () => {
    const { db, env } = setup();
    await seedGuild(db as ShimDatabase, 'guild-1');
    fetchStub = discordLoginStub();
    await exhaust(env, IP);

    const res = await realLoginCallback(env, IP, 'b');
    expect(res.status).toBe(429);
    // The whole point: the refusal costs Discord nothing.
    expect(tokenEndpointCalls(fetchStub).length).toBe(0);
  });

  it('starts counting again in the next minute', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2030-01-01T12:00:10Z'));
    const { env } = setup();
    await exhaust(env, IP);
    expect(await oauthCallbackAllowed(env, fromIp(IP))).toBe(false);

    vi.setSystemTime(new Date('2030-01-01T12:01:05Z'));
    expect(await oauthCallbackAllowed(env, fromIp(IP))).toBe(true);
  });

  it('keys on CF-Connecting-IP, so one caller cannot lock out another', async () => {
    const { db, env } = setup();
    await seedGuild(db as ShimDatabase, 'guild-1');
    fetchStub = discordLoginStub();
    await exhaust(env, IP);
    expect((await realLoginCallback(env, IP, 'b')).status).toBe(429);

    // A different address is unaffected -- a global counter would refuse here,
    // which would turn one attacker into an outage for everyone.
    const other = await realLoginCallback(env, OTHER_IP, 'c');
    expect(other.status).not.toBe(429);
  });

  it('never stores the address, only a keyed fingerprint of it', async () => {
    const { env } = setup();
    await oauthCallbackAllowed(env, fromIp(IP));
    const rows = await countRows(env);
    expect(rows).toHaveLength(1);
    expect(rows[0].bucket).not.toContain(IP);
    expect(rows[0].bucket).toMatch(/^[0-9a-f]{32}$/);
    // Keyed: the same address under a different secret is a different bucket,
    // so the stored value can't be reversed by hashing every IPv4 address.
    const other = await callbackBucket({ ...env, JWT_SIGNING_KEY: 'a-different-secret' }, fromIp(IP));
    expect(other).not.toBe(rows[0].bucket);
  });

  it("removes earlier minutes' counts, so nothing outlives the window", async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2030-01-01T12:00:10Z'));
    const { env } = setup();
    await oauthCallbackAllowed(env, fromIp(OTHER_IP));
    vi.setSystemTime(new Date('2030-01-01T12:01:10Z'));
    await oauthCallbackAllowed(env, fromIp(IP));
    const rows = await countRows(env);
    expect(rows, 'the earlier minute\'s row for another address is still there').toHaveLength(1);
  });

  // The clean-up above only runs when somebody calls back. On a quiet day that
  // left the last caller's row in place until the next login, while the privacy
  // policy says how long it is kept -- so the cron tick prunes too.
  it('the cron tick removes a finished minute even when nobody calls back', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2030-01-01T12:00:10Z'));
    const { env } = setup();
    fetchStub = stubFetch([]);
    await oauthCallbackAllowed(env, fromIp(IP));
    vi.setSystemTime(new Date('2030-01-01T12:15:00Z'));
    await oauthCallbackAllowed(env, fromIp(OTHER_IP));
    // Put the earlier row back, as if the callback's own DELETE had not run.
    await exhaust(env, IP, 3);
    await (env.DB as unknown as ShimDatabase)
      .prepare(`UPDATE oauth_callback_counts SET window_start = ? WHERE count = 3`)
      .bind(Date.parse('2030-01-01T12:00:00Z'))
      .run();
    expect(await countRows(env)).toHaveLength(2);

    await runReminderSweep(env);

    const rows = await countRows(env);
    expect(rows, 'only the current minute survives a tick').toHaveLength(1);
    expect(rows[0].count).toBe(1);
  });

  it('is consulted after the signature check, so a forged state burns no allowance', async () => {
    const { env } = setup();
    fetchStub = discordLoginStub();

    // F-59's exact request: both halves of the comparison supplied by the
    // caller, no /auth/login first.
    const forged = await app.request(
      'https://worker.test/auth/callback?code=anything&state=X',
      { headers: { Cookie: 'oauth_state=X:anything', 'CF-Connecting-IP': IP } },
      env,
    );
    expect(forged.status).toBe(400);
    expect(
      await countRows(env),
      'a forged state consumed allowance, so an attacker could exhaust a real address for free',
    ).toEqual([]);
  });

  // INVARIANT GUARD: pins the deliberate fail-open choice, so a later change to
  // fail closed has to argue with a named test. A database that can't take
  // this write can't complete the login after it either.
  it('fails open when the count cannot be written, rather than refusing everyone', async () => {
    const { db, env: base } = setup();
    await seedGuild(db as ShimDatabase, 'guild-1');
    fetchStub = discordLoginStub();
    const failingBatch = new Proxy(base.DB, {
      get(target, prop) {
        if (prop === 'prepare') throw new Error('D1 unavailable');
        const value = Reflect.get(target, prop);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    expect(await oauthCallbackAllowed({ ...base, DB: failingBatch }, fromIp(IP))).toBe(true);
  });

  it('bounds /guild-requests/callback on the same rule', async () => {
    const { db, env: base } = setup();
    await seedUser(db as ShimDatabase, 'u1');
    await seedGuild(db as ShimDatabase, 'guild-1');
    await seedMembership(db as ShimDatabase, 'u1', 'guild-1');
    const env = base;
    await exhaust(env, IP);
    fetchStub = discordLoginStub();

    const { id: sessionId } = await createSession(env, 'u1');
    const auth = await signJwt('u1', sessionId, env.JWT_SIGNING_KEY);
    const start = await app.request(
      'https://worker.test/guild-requests/connect',
      { headers: { Authorization: `Bearer ${auth}` }, redirect: 'manual' },
      env,
    );
    const location = start.headers.get('location');
    const setCookie = start.headers.get('set-cookie');
    // Guard the fixture rather than the feature: if /start ever stops issuing
    // the pair, this test would otherwise pass by never reaching the callback.
    expect(location, 'fixture: /guild-requests/connect did not redirect').toBeTruthy();
    expect(setCookie, 'fixture: /guild-requests/connect set no state cookie').toBeTruthy();

    const state = new URL(location!).searchParams.get('state')!;
    const res = await app.request(
      `https://worker.test/guild-requests/callback?code=abc&state=${encodeURIComponent(state)}`,
      { headers: { Cookie: setCookie!.split(';')[0], 'CF-Connecting-IP': IP } },
      env,
    );

    expect(res.status).toBe(429);
    expect(tokenEndpointCalls(fetchStub)).toEqual([]);
  });
  // Included even though production ships GOOGLE_SYNC_MODE = "off", where
  // isGoogleConfigured() refuses before anything is spent. The sandbox runs it
  // live and 1.0.1 turns it on, and bounding two of three unauthenticated
  // spends is the shape P21-05 already was: one rule, three implementations of
  // it, and the one nobody updated is the one that lets an answer through.
  it('bounds /google/callback on the same rule', async () => {
    const { db, env: base } = setup();
    await seedUser(db as ShimDatabase, 'u1');
    await seedGuild(db as ShimDatabase, 'guild-1');
    await seedMembership(db as ShimDatabase, 'u1', 'guild-1');
    const env: Env = {
      ...base,
      GOOGLE_SYNC_MODE: 'live',
      GOOGLE_CLIENT_ID: 'google-client-id',
      GOOGLE_CLIENT_SECRET: 'google-client-secret',
      GOOGLE_TOKEN_ENCRYPTION_KEY: 'test-google-encryption-key-at-least-32-chars',
    };
    await exhaust(env, IP);
    fetchStub = stubFetch([
      { match: '/oauth2/token', status: 200, body: { access_token: 'a', refresh_token: 'r', expires_in: 3600 } },
    ]);

    const { id: sessionId } = await createSession(env, 'u1');
    const auth = await signJwt('u1', sessionId, env.JWT_SIGNING_KEY);
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
    const setCookie = startRes.headers.get('set-cookie');
    expect(setCookie, 'fixture: /google/start set no nonce cookie').toBeTruthy();
    const state = new URL(startRes.headers.get('location')!).searchParams.get('state')!;

    const res = await app.request(
      `https://worker.test/google/callback?code=abc&state=${encodeURIComponent(state)}`,
      { headers: { Cookie: setCookie!.split(';')[0], 'CF-Connecting-IP': IP }, redirect: 'manual' },
      env,
    );

    // Redirects rather than 429s, because every other outcome of this callback
    // is a redirect back to Settings with a reason -- an HTTP status here
    // would be shown to the user as a bare error page.
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('google=rate_limited');
    expect(tokenEndpointCalls(fetchStub)).toEqual([]);
  });
});
