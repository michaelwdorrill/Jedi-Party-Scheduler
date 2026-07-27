import { API_BASE_URL } from '../api/client';

// Logout used to be fire-and-forget: the request went out, every failure was
// swallowed, the local token was deleted immediately, and the user was told
// they were logged out. If that request never landed -- offline, flaky
// connection, the tab closed mid-flight -- the server-side session stayed
// alive for the rest of its seven days, and the only credential that could
// have identified it had just been thrown away. Nothing could ever revoke it.
//
// So the token is parked here *before* it's discarded, and stays parked until
// the server confirms the session is gone. Retries happen on app start and
// whenever the browser comes back online.

const PENDING_KEY = 'jps_pending_revocation';

// Past the session's own absolute lifetime there is nothing left to revoke,
// so a stored token that old is dropped rather than retried forever.
const MAX_PENDING_AGE_MS = 8 * 24 * 60 * 60 * 1000;

interface PendingRevocation {
  token: string;
  queuedAt: number;
}

function read(): PendingRevocation | null {
  try {
    const raw = localStorage.getItem(PENDING_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PendingRevocation;
    if (typeof parsed?.token !== 'string' || typeof parsed?.queuedAt !== 'number') return null;
    return parsed;
  } catch {
    return null;
  }
}

function clear(): void {
  localStorage.removeItem(PENDING_KEY);
}

export function queueRevocation(token: string): void {
  try {
    localStorage.setItem(PENDING_KEY, JSON.stringify({ token, queuedAt: Date.now() } satisfies PendingRevocation));
  } catch {
    // Storage full or blocked. Nothing useful to do here -- the caller still
    // attempts the revocation immediately; this only costs us the retry.
  }
}

// Attempts the revocation with a specific token. `keepalive` lets the request
// outlive the page when logout is the last thing a user does before closing
// the tab, which is precisely when the old code was most likely to lose it.
//
// Returns true when the session is definitely gone. A 401 counts: the server
// rejecting the token means it no longer names a live session.
async function revoke(token: string): Promise<boolean> {
  try {
    const res = await fetch(`${API_BASE_URL}/auth/logout`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      keepalive: true,
    });
    return res.ok || res.status === 401;
  } catch {
    return false;
  }
}

// Revokes now if possible, and durably records the attempt so it can be
// retried if not. Returns whether the session is confirmed revoked, so the UI
// can be honest about it rather than always claiming success.
export async function revokeOrQueue(token: string): Promise<boolean> {
  queueRevocation(token);
  if (await revoke(token)) {
    clear();
    return true;
  }
  return false;
}

export async function retryPendingRevocation(): Promise<void> {
  const pending = read();
  if (!pending) return;
  if (Date.now() - pending.queuedAt > MAX_PENDING_AGE_MS) {
    clear();
    return;
  }
  if (await revoke(pending.token)) clear();
}

// Wired up once at startup: retry immediately, then again whenever the
// browser regains connectivity.
export function startRevocationRetries(): () => void {
  void retryPendingRevocation();
  const onOnline = () => void retryPendingRevocation();
  window.addEventListener('online', onOnline);
  return () => window.removeEventListener('online', onOnline);
}
