const TOKEN_KEY = 'jps_token';

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
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
