const TOKEN_KEY = 'jps_token';

// Which "authentication era" this tab is in (Pass-12 review, P12-05).
//
// Anything that changes who is logged in bumps it, so work that started under
// a previous identity can tell that it did. The case this exists for: an
// expired request triggers a refresh, the user hits Log out while that refresh
// is still in flight, and the response then arrives and unconditionally stores
// the successor token -- putting a live credential back into localStorage for
// an account the user has just left, on a session that logout's revocation
// never reached, because the token it revoked was the predecessor.
//
// In memory rather than in storage, deliberately: it is about this page's
// in-flight promises, and a fresh tab has none.
let epoch = 0;

export function authEpoch(): number {
  return epoch;
}

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  epoch += 1;
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  epoch += 1;
  localStorage.removeItem(TOKEN_KEY);
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
