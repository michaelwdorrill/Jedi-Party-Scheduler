import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createSession,
  isSessionActive,
  pruneStaleSessions,
  revokeSession,
  rotateSession,
} from '../src/lib/sessions';
import { countRows, seedUser, setup, type FetchStub } from './helpers';

// Pass 13 review (September 2026). Two independent reviewers re-read the
// Pass-12 corrections; fifteen distinct findings, all verified real. Five were
// regressions introduced by those corrections, which is what this file mostly
// pins. One describe() per finding, finding id in the title.

let fetchStub: FetchStub | null = null;
afterEach(() => {
  fetchStub?.restore();
  fetchStub = null;
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// P13-01
// ---------------------------------------------------------------------------

// rotateSession read the row, checked revocation and expiry against it, and
// then ran a claim guarded only by `superseded_at IS NULL`. Logout landing
// between the two revoked the family, the claim still won on the revoked row,
// and the successor was inserted with revoked_at NULL -- an active session
// minted after logout had already returned.
describe('rotation cannot mint a successor after logout has completed (P13-01)', () => {
  it('refuses to rotate when logout lands between the read and the claim', async () => {
    const { db, env } = setup();
    await seedUser(db, 'u1');
    const { id: original } = await createSession(env, 'u1');

    // The real interleaving. rotateSession reads the row, then runs its claim
    // as a batch; logout completing in that window is exactly the case the
    // read-time checks cannot see. Revoking just before the batch delegates
    // puts the logout precisely there.
    let interleaved = false;
    const racing = {
      ...db,
      prepare: (sql: string) => db.prepare(sql),
      batch: async (statements: unknown[]) => {
        if (!interleaved) {
          interleaved = true;
          await revokeSession(env, original);
        }
        return db.batch(statements as never);
      },
    };

    const successor = await rotateSession({ ...env, DB: racing } as never, original, 'u1');

    expect(interleaved, 'the test did not actually reach the claim').toBe(true);
    expect(successor, 'a successor was minted after logout completed').toBeNull();
    expect(await countRows(db, 'sessions', `user_id = 'u1' AND revoked_at IS NULL`)).toBe(0);
  });

  it('does not hand back a successor that has itself been revoked', async () => {
    const { db, env } = setup();
    await seedUser(db, 'u1');
    const { id: original } = await createSession(env, 'u1');
    const successor = await rotateSession(env, original, 'u1');
    expect(successor).not.toBeNull();

    // Only the successor row, so the predecessor stays usable and the grace
    // branch is the thing under test rather than the read-time check.
    await db.prepare(`UPDATE sessions SET revoked_at = ? WHERE id = ?`).bind(Date.now(), successor!).run();

    expect(await rotateSession(env, original, 'u1'), 'a revoked successor was handed back').toBeNull();
  });
});

// ---------------------------------------------------------------------------
// P13-02
// ---------------------------------------------------------------------------

// The family mechanism resolves a lineage by reading the row whose token was
// presented. Pruning deleted superseded rows once the rotation grace passed,
// so logging out with an intermediate token found no row, fell back to
// treating that id as its own family, matched no descendant, revoked nothing
// and returned success.
//
// A ROOT token happens to work, because its id equals its family id. Testing
// only a root token is what let this through in the first place.
describe('logout still revokes the family after pruning (P13-02)', () => {
  it('revokes the lineage when the token presented is a pruned intermediate', async () => {
    vi.useFakeTimers();
    const base = Date.UTC(2026, 8, 10, 12, 0, 0);
    vi.setSystemTime(base);

    const { db, env } = setup();
    await seedUser(db, 'u1');
    const { id: root } = await createSession(env, 'u1');
    const intermediate = await rotateSession(env, root, 'u1');
    const current = await rotateSession(env, intermediate!, 'u1');
    expect(current).not.toBeNull();

    // Two minutes on, well past the 60-second rotation grace, and a prune runs.
    vi.setSystemTime(base + 2 * 60 * 1000);
    await pruneStaleSessions(env);

    // The user logs out from the tab still holding the intermediate token.
    await revokeSession(env, intermediate!);

    expect(await isSessionActive(env, current!, 'u1'), 'the live successor survived logout').toBe(false);
  });

  it('keeps the id-to-family mapping alive rather than deleting it', async () => {
    vi.useFakeTimers();
    const base = Date.UTC(2026, 8, 10, 12, 0, 0);
    vi.setSystemTime(base);

    const { db, env } = setup();
    await seedUser(db, 'u1');
    const { id: root } = await createSession(env, 'u1');
    await rotateSession(env, root, 'u1');

    vi.setSystemTime(base + 2 * 60 * 1000);
    await pruneStaleSessions(env);

    expect(await countRows(db, 'sessions', `id = ?`, root)).toBe(1);
  });

  it('still removes superseded rows once they actually expire', async () => {
    vi.useFakeTimers();
    const base = Date.UTC(2026, 8, 10, 12, 0, 0);
    vi.setSystemTime(base);

    const { db, env } = setup();
    await seedUser(db, 'u1');
    const { id: root } = await createSession(env, 'u1');
    await rotateSession(env, root, 'u1');

    // Past the absolute seven-day session lifetime.
    vi.setSystemTime(base + 8 * 24 * 60 * 60 * 1000);
    await pruneStaleSessions(env);

    expect(await countRows(db, 'sessions', `user_id = 'u1'`)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// F-36
// ---------------------------------------------------------------------------

// createSession's cap deleted everything outside the twenty newest rows by
// created_at, regardless of state. Once every refresh inserts a row -- and
// especially once P13-02 keeps the superseded ones -- a person with a few
// devices open can push live successors out of that window, so logging in
// somewhere new silently logs them out somewhere else.
describe('the session cap counts sign-ins, not rotation rows (F-36)', () => {
  it('does not evict a live session because another device refreshed a lot', async () => {
    const { db, env } = setup();
    await seedUser(db, 'u1');

    // One device, signed in and refreshing steadily.
    const { id: phone } = await createSession(env, 'u1');
    let current = phone;
    for (let i = 0; i < 30; i++) {
      const next = await rotateSession(env, current, 'u1');
      expect(next).not.toBeNull();
      current = next!;
    }

    // A second device signs in, which is what runs the cap.
    await createSession(env, 'u1');

    expect(await isSessionActive(env, current, 'u1'), 'the first device was silently logged out').toBe(true);
  });

  it('still caps the number of live sign-ins', async () => {
    const { db, env } = setup();
    await seedUser(db, 'u1');
    for (let i = 0; i < 25; i++) await createSession(env, 'u1');

    expect(await countRows(db, 'sessions', `user_id = 'u1' AND superseded_at IS NULL AND revoked_at IS NULL`)).toBe(20);
  });
});
