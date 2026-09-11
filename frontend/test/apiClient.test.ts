import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// P12-05 from the Pass-12 security review.
//
// The API client refreshes on a 401 and then stores whatever token comes back.
// That store was unconditional, and a refresh is a network round trip the user
// can act during -- so pressing Log out while one was in flight ended with a
// live token back in localStorage for the account they had just left.
//
// Revocation could not have covered it either: logout revokes the token it
// holds, and the successor the refresh returns is a *different* session that
// rotation minted from it. The server-side half of that is P12-04's session
// families; this is the browser half, and either alone leaves the hole open.

class MemoryStorage {
  entries = new Map<string, string>();
  getItem(k: string): string | null {
    return this.entries.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.entries.set(k, String(v));
  }
  removeItem(k: string): void {
    this.entries.delete(k);
  }
}

let storage: MemoryStorage;

beforeEach(() => {
  vi.resetModules();
  storage = new MemoryStorage();
  vi.stubGlobal('localStorage', storage);
  vi.stubGlobal('window', { location: { hash: '' } });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const TOKEN_KEY = 'jps_token';

describe('a refresh that lands after logout is discarded (P12-05)', () => {
  it('does not reinstate a token once the user has logged out', async () => {
    const { api } = await import('../src/api/client');
    const { clearToken } = await import('../src/auth/tokenStorage');

    storage.setItem(TOKEN_KEY, 'original-token');

    // The retry after refreshing has to SUCCEED, or the client bounces to
    // login and clears the token on its way out -- which would make this test
    // pass for a reason that has nothing to do with the fix.
    let dataCalls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/auth/refresh')) {
          // The logout happens here, with the refresh genuinely in flight --
          // the request has been sent and its response has not arrived. Doing
          // it any earlier just means the refresh never starts, which is not
          // the race this is about.
          clearToken();
          return new Response(JSON.stringify({ token: 'successor-token' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        dataCalls += 1;
        return dataCalls === 1
          ? new Response('', { status: 401 })
          : new Response(JSON.stringify({ id: 'u1' }), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            });
      }),
    );

    await api.get('/me').catch(() => undefined);

    expect(
      storage.getItem(TOKEN_KEY),
      'a live token was put back in storage for an account the user had logged out of',
    ).toBeNull();
  });

  it('still installs the successor on an ordinary refresh', async () => {
    const { api } = await import('../src/api/client');

    storage.setItem(TOKEN_KEY, 'original-token');

    let call = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/auth/refresh')) {
          return new Response(JSON.stringify({ token: 'successor-token' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        call += 1;
        // First attempt is stale, the retry after refreshing succeeds.
        return call === 1
          ? new Response('', { status: 401 })
          : new Response(JSON.stringify({ id: 'u1' }), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            });
      }),
    );

    await expect(api.get('/me')).resolves.toEqual({ id: 'u1' });
    expect(storage.getItem(TOKEN_KEY)).toBe('successor-token');
  });
});

// P13-06 from the Pass-13 review, and a regression the P12-05 fix introduced.
//
// tryRefresh returns false both when authentication has genuinely failed and
// when the epoch guard discards a response belonging to an identity that is no
// longer current. The caller treated both the same way: clear the stored token
// and bounce to login. So a refresh begun as account A, correctly discarded
// once account B was installed, then logged account B out.
describe('a discarded stale refresh does not log out the new account (P13-06)', () => {
  it('leaves the newly installed token alone', async () => {
    const { api } = await import('../src/api/client');
    const { adoptSession } = await import('../src/auth/tokenStorage');

    storage.setItem(TOKEN_KEY, 'account-a-token');

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/auth/refresh')) {
          // While account A's refresh is in flight, the user signs in as
          // account B -- a real identity change, not a logout.
          adoptSession('account-b-token');
          return new Response(JSON.stringify({ token: 'account-a-successor' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response('', { status: 401 });
      }),
    );

    await api.get('/me').catch(() => undefined);

    expect(
      storage.getItem(TOKEN_KEY),
      "account A's dead refresh logged account B out",
    ).toBe('account-b-token');
    expect(window.location.hash, 'the new account was bounced to login').not.toBe('#/login');
  });
});

// P14-03 from the Pass-14 review. The token lives in localStorage, which every
// tab shares; the identity marker guarding it used to live in each tab's
// module state. So adopting a second account in one tab left another tab's
// pending refresh believing its own era was current, and its late response
// overwrote the shared token -- putting the first account back under the
// second account's session.
describe('a refresh in another tab cannot replace a newly adopted account (P14-03)', () => {
  it('discards the old tab’s late refresh once a second tab adopts someone else', async () => {
    // Two module instances, one storage: that is what two tabs are.
    vi.resetModules();
    const tabOne = await import('../src/api/client');
    const tabOneStorage = await import('../src/auth/tokenStorage');
    vi.resetModules();
    const tabTwoStorage = await import('../src/auth/tokenStorage');

    tabOneStorage.adoptSession('alice-token');

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/auth/refresh')) {
          // The *other* tab signs in as Bob while Alice's refresh is away.
          tabTwoStorage.adoptSession('bob-token');
          return new Response(JSON.stringify({ token: 'alice-successor' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response('', { status: 401 });
      }),
    );

    await tabOne.api.get('/me').catch(() => undefined);

    expect(
      storage.getItem(TOKEN_KEY),
      "the other tab's stale refresh replaced the newly adopted account",
    ).toBe('bob-token');
  });

  it('still lets two tabs refresh the same session', async () => {
    vi.resetModules();
    const tabOne = await import('../src/api/client');
    const tabOneStorage = await import('../src/auth/tokenStorage');

    tabOneStorage.adoptSession('shared-token');

    let call = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/auth/refresh')) {
          return new Response(JSON.stringify({ token: 'shared-successor' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        call += 1;
        return call === 1
          ? new Response('', { status: 401 })
          : new Response(JSON.stringify({ id: 'u1' }), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            });
      }),
    );

    // A refresh is the same identity continuing, so it must commit -- two tabs
    // racing a refresh of one session is ordinary, and neither is a login.
    await expect(tabOne.api.get('/me')).resolves.toEqual({ id: 'u1' });
    expect(storage.getItem(TOKEN_KEY)).toBe('shared-successor');
  });
});

// P14-04. The identity check added for P13-06 sat only on the first 401. A
// request retried with isRetry=true skipped it, so its own terminal 401 --
// correct, for a session that has since ended -- cleared whatever credential
// was in storage by then and redirected to login.
describe('an obsolete retry does not log out the current account (P14-04)', () => {
  it('abandons the retry without touching the newly adopted session', async () => {
    const { api } = await import('../src/api/client');
    const { adoptSession } = await import('../src/auth/tokenStorage');

    adoptSession('alice-token');

    let dataCalls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/auth/refresh')) {
          return new Response(JSON.stringify({ token: 'alice-successor' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        dataCalls += 1;
        if (dataCalls === 1) return new Response('', { status: 401 });
        // The retry. Alice's session has ended and Bob has signed in while it
        // was in flight, so this 401 is correct -- and must not be acted on.
        adoptSession('bob-token');
        return new Response('', { status: 401 });
      }),
    );

    await api.get('/me').catch(() => undefined);

    expect(storage.getItem(TOKEN_KEY), "an obsolete retry logged out the current account").toBe('bob-token');
    expect(window.location.hash, 'the current account was bounced to login').not.toBe('#/login');
  });
});
