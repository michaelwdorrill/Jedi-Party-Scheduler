import { API_BASE_URL } from '../api/client';
import { decodeTokenPayload } from './tokenStorage';

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
// Each pending revocation gets its OWN storage key. Two earlier shapes both
// lost tokens:
//
//   one key holding one token   a second failed logout overwrote the first.
//   one key holding an array    read-modify-write is not atomic across tabs,
//                               so two tabs enqueueing concurrently kept only
//                               the last writer's, and a retry that read the
//                               array before another tab appended to it wrote
//                               back its stale filtered copy on success,
//                               deleting the newcomer.
//
// Keying per token removes the shared mutable value entirely: an enqueue
// writes exactly one key, a confirmed revocation removes exactly one key, and
// neither ever rewrites the other's. There is no interleaving that loses a
// token, because no two operations touch the same key unless they're about
// the same session.

const KEY_PREFIX = 'jps_pending_revocation:';

// The single-array key this replaced. A user whose logout failed under the
// previous build has their token sitting here, and the per-key scan below
// would never look at it -- so the moment they loaded the new frontend, a
// session that was queued for revocation became unrevocable and simply lived
// out its seven days. Migrated once at startup rather than left behind.
const LEGACY_ARRAY_KEY = 'jps_pending_revocations';

// Past a session's own absolute lifetime there is nothing left to revoke, so
// an entry that old is dropped rather than retried forever.
const MAX_PENDING_AGE_MS = 8 * 24 * 60 * 60 * 1000;

interface PendingRevocation {
  token: string;
  queuedAt: number;
}

// The session id is the natural per-token key: it's exactly what the server
// would revoke, so two entries share a key only if they're the same session.
// The hash fallback keeps this total for a token we can't parse -- it never
// needs to be cryptographic, only stable and collision-resistant enough to
// separate a handful of concurrent sessions.
function keyFor(token: string): string {
  const sid = decodeTokenPayload(token)?.sid;
  if (typeof sid === 'string' && sid.length > 0) return `${KEY_PREFIX}${sid}`;
  let hash = 5381;
  for (let i = 0; i < token.length; i++) hash = ((hash << 5) + hash + token.charCodeAt(i)) | 0;
  return `${KEY_PREFIX}h${(hash >>> 0).toString(36)}`;
}

// Copies any entries left by the previous single-array format into per-token
// keys. The legacy key is removed only after every entry it held has been
// durably written under its own key -- if storage fails partway (quota, a
// blocked origin), the array stays put and the next startup tries again,
// which is the outcome that cannot lose a token. Re-enqueueing one that was
// already copied is harmless: the key is derived from the token, so it
// overwrites itself rather than duplicating.
function migrateLegacyQueue(): void {
  let raw: string | null;
  try {
    raw = localStorage.getItem(LEGACY_ARRAY_KEY);
  } catch {
    return;
  }
  if (!raw) return;

  let entries: unknown;
  try {
    entries = JSON.parse(raw);
  } catch {
    // Unparseable: nothing can be recovered from it, so stop carrying it.
    try {
      localStorage.removeItem(LEGACY_ARRAY_KEY);
    } catch {
      /* storage unavailable; nothing further to try */
    }
    return;
  }

  const now = Date.now();
  let allCopied = true;
  for (const entry of Array.isArray(entries) ? entries : []) {
    // The old format stored {token, queuedAt}; tolerate a bare string too,
    // since being generous here costs nothing and dropping a real token does.
    const token = typeof entry === 'string' ? entry : (entry as PendingRevocation | null)?.token;
    if (typeof token !== 'string' || token.length === 0) continue;
    const queuedAt =
      typeof entry === 'object' && entry !== null && typeof (entry as PendingRevocation).queuedAt === 'number'
        ? (entry as PendingRevocation).queuedAt
        : now;
    if (now - queuedAt > MAX_PENDING_AGE_MS) continue; // past its session lifetime; nothing left to revoke
    try {
      localStorage.setItem(keyFor(token), JSON.stringify({ token, queuedAt } satisfies PendingRevocation));
    } catch {
      allCopied = false;
    }
  }

  if (allCopied) {
    try {
      localStorage.removeItem(LEGACY_ARRAY_KEY);
    } catch {
      /* storage unavailable; the array stays and is retried next startup */
    }
  }
}

function readAll(): { key: string; entry: PendingRevocation }[] {
  const out: { key: string; entry: PendingRevocation }[] = [];
  let keys: string[];
  try {
    keys = Object.keys(localStorage);
  } catch {
    return out;
  }
  for (const key of keys) {
    if (!key.startsWith(KEY_PREFIX)) continue;
    try {
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      const parsed = JSON.parse(raw) as PendingRevocation;
      if (typeof parsed?.token === 'string' && typeof parsed?.queuedAt === 'number') {
        out.push({ key, entry: parsed });
      } else {
        localStorage.removeItem(key);
      }
    } catch {
      // Unparseable entry: nothing can ever be done with it, so drop it
      // rather than retrying it forever.
      try {
        localStorage.removeItem(key);
      } catch {
        /* storage unavailable; nothing further to try */
      }
    }
  }
  return out;
}

// Returns whether the write actually took effect -- a full or blocked storage
// quota throws here, and the caller needs to know the entry is NOT durably
// queued rather than silently proceeding as if it were.
function enqueue(token: string): boolean {
  try {
    localStorage.setItem(keyFor(token), JSON.stringify({ token, queuedAt: Date.now() } satisfies PendingRevocation));
    return true;
  } catch {
    return false;
  }
}

function remove(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* storage unavailable; the entry simply stays and is retried later */
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
// retried if not. The queue write happens before the network attempt so a tab
// closing mid-request still leaves a durable record.
export async function revokeOrQueue(token: string): Promise<LogoutOutcome> {
  const queued = enqueue(token);
  if (await revoke(token)) {
    remove(keyFor(token));
    return { confirmed: true, queued: false };
  }
  return { confirmed: false, queued };
}

export async function retryPendingRevocation(): Promise<void> {
  // Run before the scan, so a queue inherited from the previous format is
  // picked up on the very first retry rather than after some later event.
  migrateLegacyQueue();
  const now = Date.now();
  for (const { key, entry } of readAll()) {
    if (now - entry.queuedAt > MAX_PENDING_AGE_MS) {
      remove(key);
      continue;
    }
    if (await revoke(entry.token)) remove(key);
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
