import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { beginLogin, LoginNotStartedError, redeemLoginCode } from '../src/auth/loginTransaction';

// R02 from the Pass-11 security review, browser half.
//
// The Worker used to finish a login by redirecting to
// `#/auth/callback?token=<jwt>`, and AuthCallbackPage installed whatever token
// was in that fragment as this browser's session -- with nothing tying the
// token to the browser receiving it. Anyone with a valid session could send
// someone else that link carrying their own token and silently log the visitor
// into their account, where anything the visitor saved afterwards (personal
// time, private notes, a connected Google calendar) was the sender's to read.
//
// The redirect carries a one-time code now, and redeeming it requires the
// verifier this browser parked before it ever navigated away. These tests are
// about that verifier: that starting a login creates one, and that a code
// arriving without one is refused rather than spent.

class MemoryStorage {
  private entries = new Map<string, string>();
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
  storage = new MemoryStorage();
  vi.stubGlobal('sessionStorage', storage);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const VERIFIER_KEY = 'jps_login_verifier';

describe('beginLogin', () => {
  it('parks a verifier and sends only its challenge in the URL', async () => {
    const url = await beginLogin();

    const verifier = storage.getItem(VERIFIER_KEY);
    expect(verifier).toBeTruthy();

    const challenge = new URL(url).searchParams.get('challenge');
    // The challenge is the SHA-256 of the verifier, Base64URL, unpadded: 43
    // characters, which is the shape the Worker validates on the way in.
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // The secret itself must not travel -- that is the entire point of it.
    expect(url).not.toContain(verifier!);
  });

  it('mints a fresh verifier each time, so one login cannot complete another', async () => {
    await beginLogin();
    const first = storage.getItem(VERIFIER_KEY);
    await beginLogin();
    expect(storage.getItem(VERIFIER_KEY)).not.toBe(first);
  });
});

describe('redeemLoginCode', () => {
  it('refuses to redeem in a browser that never started a login', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    // The finding itself: a callback URL someone else was sent. There is no
    // verifier here, so this must not even reach the network -- there is
    // nothing this browser could offer as proof.
    await expect(redeemLoginCode('a-code-from-somebody-else')).rejects.toBeInstanceOf(
      LoginNotStartedError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends the parked verifier with the code, and returns the token', async () => {
    await beginLogin();
    const verifier = storage.getItem(VERIFIER_KEY);

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ token: 'the-session-token' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(redeemLoginCode('the-code')).resolves.toBe('the-session-token');

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ code: 'the-code', verifier });
  });

  it('clears the verifier even when redemption fails, so it cannot be reused', async () => {
    await beginLogin();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, text: async () => 'nope' }),
    );

    await expect(redeemLoginCode('the-code')).rejects.toThrow();
    expect(storage.getItem(VERIFIER_KEY)).toBeNull();
  });
});
