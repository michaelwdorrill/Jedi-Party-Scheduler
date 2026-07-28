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
//
// The queue holds a *set* of tokens, not one slot. An earlier version stored
// a single {token, queuedAt} object: a second failed logout (a different
// session -- e.g. a stale tab, or logging out then back in and out again
// before the first retry lands) silently overwrote the first, and even
// without that, a retry that read the queue before a second logout wrote to
// it would still unconditionally clear() the whole key on success, deleting
// the second token's entry along with the first's. Both failure modes are
// closed by keying on the token itself: enqueue only adds, and a completed
// revocation only ever removes its own entry.

const PENDING_KEY = 'jps_pending_revocations';

// Past a session's own absolute lifetime there is nothing left to revoke, so
// an entry that old is dropped rather than retried forever.
const MAX_PENDING_AGE_MS = 8 * 24 * 60 * 60 * 1000;

interface PendingRevocation {
  token: string;
  queuedAt: number;
}

function readAll(): PendingRevocation[] {
  try {
    const raw = localStorage.getItem(PENDING_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (p): p is PendingRevocation => typeof p?.token === 'string' && typeof p?.queuedAt === 'number',
    );
  } catch {
    return [];
  }
}

// Returns whether the write actually took effect -- a full or blocked
// storage quota throws here, and the caller needs to know the entry is NOT
// durably queued rather than silently proceeding as if it were.
function writeAll(entries: PendingRevocation[]): boolean {
  try {
    if (entries.length === 0) localStorage.removeItem(PENDING_KEY);
    else localStorage.setItem(PENDING_KEY, JSON.stringify(entries));
    return true;
  } catch {
    return false;
  }
}

function enqueue(token: string): boolean {
  const entries = readAll();
  if (!entries.some((e) => e.token === token)) entries.push({ token, queuedAt: Date.now() });
  return writeAll(entries);
}

// Removes only this specific token's entry. Never a blanket clear -- that's
// exactly the race described above.
function removeToken(token: string): void {
  const entries = readAll();
  const next = entries.filter((e) => e.token !== token);
  if (next.length !== entries.length) writeAll(next);
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

export interface LogoutOutcome {
  // The server confirmed the session is gone.
  confirmed: boolean;
  // Only meaningful when !confirmed: whether the token was durably recorded
  // for retry. False means storage itself failed (full or blocked) -- there
  // is no record of this logout anywhere, and the caller must say so rather
  // than imply it'll be handled automatically later.
  queued: boolean;
}

// Revokes now if possible, and durably records the attempt so it can be
// retried if not. The queue write happens before the network attempt so a
// tab closing mid-request still leaves a durable record.
export async function revokeOrQueue(token: string): Promise<LogoutOutcome> {
  const queued = enqueue(token);
  if (await revoke(token)) {
    removeToken(token);
    return { confirmed: true, queued: false };
  }
  return { confirmed: false, queued };
}

export async function retryPendingRevocation(): Promise<void> {
  const entries = readAll();
  const now = Date.now();
  for (const entry of entries) {
    if (now - entry.queuedAt > MAX_PENDING_AGE_MS) {
      removeToken(entry.token);
      continue;
    }
    if (await revoke(entry.token)) removeToken(entry.token);
  }
}

// Wired up once at startup: retry immediately, then again whenever the
// browser regains connectivity.
export function startRevocationRetries(): () => void {
  void retryPendingRevocation();
  const onOnline = () => void retryPendingRevocation();
  window.addEventListener('online', onOnline);
  return () => window.removeEventListener('online', onOnline);
}
