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
