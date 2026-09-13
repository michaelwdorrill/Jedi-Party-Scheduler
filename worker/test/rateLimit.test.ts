import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/router';
import { MAX_CALLBACKS_PER_MINUTE } from '../src/lib/rateLimit';
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

let fetchStub: FetchStub | null = null;
afterEach(() => {
  fetchStub?.restore();
  fetchStub = null;
});

const app = buildApp();

interface FakeLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
  keys: string[];
}

// Counts per key the way the real binding does, so a test that exhausts one
// address proves nothing about another. `keys` records every consultation,
// which is how the ordering test sees that a forged state never reached here.
function fakeLimiter(limit = MAX_CALLBACKS_PER_MINUTE): FakeLimiter {
  const counts = new Map<string, number>();
  const keys: string[] = [];
  return {
    keys,
    async limit({ key }) {
      keys.push(key);
      const next = (counts.get(key) ?? 0) + 1;
      counts.set(key, next);
      return { success: next <= limit };
    },
  };
}

function withLimiter(env: Env, limiter: FakeLimiter): Env {
  return { ...env, OAUTH_CALLBACK_LIMITER: limiter as unknown as RateLimit };
}

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
    const env = withLimiter(base, fakeLimiter());
    fetchStub = discordLoginStub();

    const res = await realLoginCallback(env, IP);

    expect(res.status, 'bounding the callback broke ordinary login').not.toBe(429);
    expect(tokenEndpointCalls(fetchStub).length).toBe(1);
  });

  it('refuses with 429 and spends nothing once an address is over the limit', async () => {
    const { db, env: base } = setup();
    await seedGuild(db as ShimDatabase, 'guild-1');
    // A limit of 1 rather than 20 so this is one refusal rather than twenty
    // successful logins first. The threshold is a constant; the behaviour at
    // the boundary is what is under test.
    const env = withLimiter(base, fakeLimiter(1));
    fetchStub = discordLoginStub();

    const first = await realLoginCallback(env, IP, 'a');
    expect(first.status).not.toBe(429);
    expect(tokenEndpointCalls(fetchStub).length).toBe(1);

    const second = await realLoginCallback(env, IP, 'b');
    expect(second.status).toBe(429);
    // The whole point: the refusal costs Discord nothing. Still one call.
    expect(tokenEndpointCalls(fetchStub).length).toBe(1);
  });

  it('keys on CF-Connecting-IP, so one caller cannot lock out another', async () => {
    const { db, env: base } = setup();
    await seedGuild(db as ShimDatabase, 'guild-1');
    const limiter = fakeLimiter(1);
    const env = withLimiter(base, limiter);
    fetchStub = discordLoginStub();

    await realLoginCallback(env, IP, 'a');
    expect((await realLoginCallback(env, IP, 'b')).status).toBe(429);

    // A different address is unaffected -- a global counter would refuse here,
    // which would turn one attacker into an outage for everyone.
    const other = await realLoginCallback(env, OTHER_IP, 'c');
    expect(other.status).not.toBe(429);
    expect(limiter.keys).toContain(OTHER_IP);
  });

  it('is consulted after the signature check, so a forged state burns no allowance', async () => {
    const { env: base } = setup();
    const limiter = fakeLimiter(1);
    const env = withLimiter(base, limiter);
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
      limiter.keys,
      'a forged state consumed limiter budget, so an attacker could exhaust a real address for free',
    ).toEqual([]);
  });

  // INVARIANT GUARD, not a reproduction: with no binding there is nothing to
  // remove, so this passes either way. It pins the deliberate fail-open choice
  // so that a later change to fail closed has to argue with a named test
  // rather than silently break every login in `wrangler dev`.
  it('fails open when the binding is absent, rather than breaking every login', async () => {
    const { db, env } = setup();
    await seedGuild(db as ShimDatabase, 'guild-1');
    fetchStub = discordLoginStub();

    // No OAUTH_CALLBACK_LIMITER at all -- `wrangler dev`, and any deploy where
    // the binding was dropped. scripts/check-env-parity.mjs is what stops the
    // second case reaching production silently; this pins the runtime half.
    expect(env.OAUTH_CALLBACK_LIMITER).toBeUndefined();
    const res = await realLoginCallback(env, IP);

    expect(res.status).not.toBe(429);
    expect(tokenEndpointCalls(fetchStub).length).toBe(1);
  });

  it('bounds /guild-requests/callback on the same rule', async () => {
    const { db, env: base } = setup();
    await seedUser(db as ShimDatabase, 'u1');
    await seedGuild(db as ShimDatabase, 'guild-1');
    await seedMembership(db as ShimDatabase, 'u1', 'guild-1');
    const env = withLimiter(base, fakeLimiter(0));
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
      ...withLimiter(base, fakeLimiter(0)),
      GOOGLE_SYNC_MODE: 'live',
      GOOGLE_CLIENT_ID: 'google-client-id',
      GOOGLE_CLIENT_SECRET: 'google-client-secret',
      GOOGLE_TOKEN_ENCRYPTION_KEY: 'test-google-encryption-key-at-least-32-chars',
    };
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
