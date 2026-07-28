import { beforeEach, describe, expect, it, vi } from 'vitest';
import { retryPendingRevocation, revokeOrQueue } from '../src/auth/pendingRevocation';

// A minimal localStorage. Entries are real own properties, because the
// module enumerates the store with Object.keys() -- which is exactly the
// mechanism the legacy array key escapes.
class MemoryStorage {
  getItem(k: string): string | null {
    return Object.prototype.hasOwnProperty.call(this, k) ? ((this as never as Record<string, string>)[k]) : null;
  }
  setItem(k: string, v: string): void {
    (this as never as Record<string, string>)[k] = String(v);
  }
  removeItem(k: string): void {
    delete (this as never as Record<string, string>)[k];
  }
}

const LEGACY_KEY = 'jps_pending_revocations';
const NEW_PREFIX = 'jps_pending_revocation:';

let storage: MemoryStorage;

function keys(): string[] {
  return Object.keys(storage as unknown as Record<string, unknown>);
}

beforeEach(() => {
  storage = new MemoryStorage();
  vi.stubGlobal('localStorage', storage);
  vi.stubGlobal('window', { addEventListener: () => {}, removeEventListener: () => {} });
});

describe('upgrade from the single-array pending logout queue', () => {
  it('revokes every token the previous format had queued', async () => {
    const tokens = ['tok-a', 'tok-b', 'tok-c'];
    storage.setItem(
      LEGACY_KEY,
      JSON.stringify(tokens.map((token) => ({ token, queuedAt: Date.now() }))),
    );

    const seen: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      seen.push(String((init.headers as Record<string, string>).Authorization));
      return new Response('', { status: 200 });
    }));

    await retryPendingRevocation();

    // Every legacy token was actually sent to the server, not stranded.
    for (const token of tokens) expect(seen).toContain(`Bearer ${token}`);
    // And the queue is empty afterwards: legacy key gone, no per-token
    // leftovers for sessions the server confirmed.
    expect(storage.getItem(LEGACY_KEY)).toBeNull();
    expect(keys().filter((k) => k.startsWith(NEW_PREFIX))).toEqual([]);
  });

  it('keeps the legacy entries queued when the server is unreachable', async () => {
    storage.setItem(LEGACY_KEY, JSON.stringify([{ token: 'tok-a', queuedAt: Date.now() }]));
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline'); }));

    await retryPendingRevocation();

    // Migrated out of the array (so the new scanner can see it) but not lost:
    // still exactly one pending entry, under the new per-token key.
    expect(storage.getItem(LEGACY_KEY)).toBeNull();
    expect(keys().filter((k) => k.startsWith(NEW_PREFIX))).toHaveLength(1);
  });

  it('drops legacy entries older than a session could possibly live', async () => {
    const ancient = Date.now() - 30 * 24 * 60 * 60 * 1000;
    storage.setItem(LEGACY_KEY, JSON.stringify([{ token: 'stale', queuedAt: ancient }]));
    const fetchMock = vi.fn(async () => new Response('', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await retryPendingRevocation();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(storage.getItem(LEGACY_KEY)).toBeNull();
    expect(keys().filter((k) => k.startsWith(NEW_PREFIX))).toEqual([]);
  });

  it('survives an unparseable legacy value instead of retrying it forever', async () => {
    storage.setItem(LEGACY_KEY, 'not json');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 200 })));

    await retryPendingRevocation();

    expect(storage.getItem(LEGACY_KEY)).toBeNull();
  });

  it('does not lose a newly queued revocation while migrating an old one', async () => {
    storage.setItem(LEGACY_KEY, JSON.stringify([{ token: 'old', queuedAt: Date.now() }]));
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline'); }));

    // A logout happening in this session, alongside the inherited queue.
    const outcome = await revokeOrQueue('new');
    expect(outcome).toEqual({ confirmed: false, queued: true });

    await retryPendingRevocation();

    // Both are still pending under their own keys -- neither overwrote the
    // other, which is the whole reason for per-token keys.
    expect(keys().filter((k) => k.startsWith(NEW_PREFIX))).toHaveLength(2);
  });
});
