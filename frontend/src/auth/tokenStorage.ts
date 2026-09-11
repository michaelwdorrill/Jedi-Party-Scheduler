const TOKEN_KEY = 'jps_token';
const IDENTITY_KEY = 'jps_identity';

// Which "authentication era" this browser is in (Pass-12 review, P12-05;
// widened from per-tab to shared by the Pass-14 review, P14-03).
//
// Anything that changes who is logged in moves it, so work that started under
// a previous identity can tell that it did. The case this exists for: an
// expired request triggers a refresh, the user hits Log out while that refresh
// is still in flight, and the response then arrives and unconditionally stores
// the successor token -- putting a live credential back into localStorage for
// an account the user has just left, on a session that logout's revocation
// never reached, because the token it revoked was the predecessor.
//
// This was an in-memory counter, on the reasoning that it was about a page's
// own in-flight promises. That was wrong, and P14-03 is the consequence: the
// TOKEN lives in localStorage, which every tab shares, while the counter lived
// in each tab's module state. So adopting a second account in one tab left
// another tab's pending refresh believing its own era was still current, and
// its late response overwrote the shared token -- putting the first account
// back under the second account's session.
//
// So the marker lives beside the thing it guards. It is a value rather than a
// counter because tabs cannot agree on a count, and it changes only on a real
// identity change -- never on a refresh, which is the same session continuing
// (P13-06) and is what two tabs racing a refresh of one session legitimately
// do. Both of them commit; neither is an identity change; nobody is logged out.
//
// localStorage can throw (private mode, blocked site data), so every access is
// guarded and falls back to an in-memory value. That degrades to the old
// per-tab behaviour rather than to a crash.
let fallbackIdentity: string | null = null;

function newIdentity(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now()}-${Math.random()}`;
  }
}

export function authEpoch(): string | null {
  try {
    return localStorage.getItem(IDENTITY_KEY);
  } catch {
    return fallbackIdentity;
  }
}

function moveIdentity(): void {
  const next = newIdentity();
  fallbackIdentity = next;
  try {
    localStorage.setItem(IDENTITY_KEY, next);
  } catch {
    // Held in memory only; see above.
  }
}

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

// Replaces the token for the SAME identity -- what a refresh does. The
// identity deliberately does not move: refreshing is the session continuing,
// and moving it here made every successful refresh look to the API client like
// somebody else had logged in (Pass-13 review, P13-06).
export function setToken(token: string): void {
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {
    // Nothing useful to do: the next request simply re-authenticates.
  }
}

// Adopts a token as a NEW identity -- what logging in does. This is the write
// that moves the identity, so work started for whoever was signed in before
// can tell that it no longer speaks for the current session.
export function adoptSession(token: string): void {
  moveIdentity();
  setToken(token);
}

export function clearToken(): void {
  moveIdentity();
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    // As above.
  }
}

// Decodes the JWT payload without verifying it (verification happens
// server-side on every request); used only to read `exp` for a client-side
// "should we bother sending this token" check.
export function decodeTokenPayload(token: string): { sub: string; exp: number; sid?: string } | null {
  try {
    const [, payload] = token.split('.');
    return JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
  } catch {
    return null;
  }
}

export function isTokenExpired(token: string): boolean {
  const payload = decodeTokenPayload(token);
  if (!payload) return true;
  return payload.exp * 1000 < Date.now();
}
