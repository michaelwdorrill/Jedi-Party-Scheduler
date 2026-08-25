// docs/specs/0012-policy-reacceptance.md.
//
// The feature ships dormant -- CURRENT_POLICY_VERSION is 1 and both migration
// defaults are 1, so on the day it deploys nobody is logged out and nobody is
// gated. That makes it a feature the rest of the suite cannot see, so these
// tests drive the version by hand: they write a session or a user at an older
// version, which is exactly what a real bump produces.
//
// The most important test in here is the last one. `upsertUser` runs on every
// login, not only on account creation, so putting accepted_policy_version in
// its ON CONFLICT DO UPDATE clause would make logging in count as agreeing --
// the gate would never fire for anyone and the whole feature would appear to
// work while doing nothing.
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/router';
import { signJwt } from '../src/lib/jwt';
import { createSession, isSessionActive, pruneStaleSessions } from '../src/lib/sessions';
import { upsertUser } from '../src/lib/db';
import { CURRENT_POLICY_VERSION } from '../src/lib/policy';
import { seedGuild, seedMembership, seedUser, setup } from './helpers';
import type { Env } from '../src/env';
import type { ShimDatabase } from './d1shim';

const app = buildApp();

const OLD = CURRENT_POLICY_VERSION - 1;

async function authHeaders(env: Env, userId: string): Promise<Record<string, string>> {
  const { id: sessionId } = await createSession(env, userId);
  const token = await signJwt(userId, sessionId, env.JWT_SIGNING_KEY);
  return { Authorization: `Bearer ${token}` };
}

// Puts the caller's session back a version, which is what a bump does to
// every session in the table at once.
async function ageSession(db: ShimDatabase, userId: string) {
  await db.prepare(`UPDATE sessions SET policy_version = ? WHERE user_id = ?`).bind(OLD, userId).run();
}

async function behindOnPolicy(db: ShimDatabase, userId: string) {
  await db.prepare(`UPDATE users SET accepted_policy_version = ? WHERE id = ?`).bind(OLD, userId).run();
}

async function person(db: ShimDatabase, id = 'u1') {
  await seedGuild(db);
  await seedUser(db, id);
  await seedMembership(db, id, 'guild-1');
  return id;
}

describe('a version bump logs everyone out', () => {
  it('kills a session issued under the previous version', async () => {
    const { db, env } = setup();
    await person(db);
    const { id: sessionId } = await createSession(env, 'u1');
    expect(await isSessionActive(env, sessionId, 'u1')).toBe(true);

    await ageSession(db, 'u1');
    expect(await isSessionActive(env, sessionId, 'u1')).toBe(false);
  });

  it('is indistinguishable from any other dead session at the edge', async () => {
    const { db, env } = setup();
    await person(db);
    const headers = await authHeaders(env, 'u1');
    await ageSession(db, 'u1');

    const res = await app.request('https://worker.test/me', { headers }, env);
    // 401, not the policy 403: the session is gone, so there is nobody to
    // ask. The agreement is collected after they log in again.
    expect(res.status).toBe(401);
  });

  it('lets the prune sweep collect the dead rows', async () => {
    const { db, env } = setup();
    await person(db);
    await createSession(env, 'u1');
    await ageSession(db, 'u1');

    await pruneStaleSessions(env);
    const left = await db.prepare(`SELECT COUNT(*) AS n FROM sessions`).first<{ n: number }>();
    expect(left?.n).toBe(0);
  });
});

describe('a fresh session is gated until the policy is accepted', () => {
  it('refuses the app with a machine-readable 403', async () => {
    const { db, env } = setup();
    await person(db);
    const headers = await authHeaders(env, 'u1');
    await behindOnPolicy(db, 'u1');

    const res = await app.request('https://worker.test/me/events?from=0&to=1000', { headers }, env);
    expect(res.status).toBe(403);
    // A bare 403 would be indistinguishable from "not invited" or "not a
    // member", which is what the frontend has to tell apart to know it should
    // show the acceptance screen rather than an error.
    expect(await res.json()).toEqual({
      error: 'policy_acceptance_required',
      policyVersion: CURRENT_POLICY_VERSION,
    });
  });

  it.each([
    ['GET', '/me'],
    ['GET', '/me/export'],
  ])('still allows %s %s, so they can see the screen and take their data', async (method, path) => {
    const { db, env } = setup();
    await person(db);
    const headers = await authHeaders(env, 'u1');
    await behindOnPolicy(db, 'u1');

    const res = await app.request(`https://worker.test${path}`, { method, headers }, env);
    expect(res.status).toBe(200);
  });

  it('still allows DELETE /me, so someone who will not agree can leave', async () => {
    const { db, env } = setup();
    await person(db);
    const headers = await authHeaders(env, 'u1');
    await behindOnPolicy(db, 'u1');

    const res = await app.request('https://worker.test/me', { method: 'DELETE', headers }, env);
    expect(res.status).toBe(200);
    const left = await db.prepare(`SELECT COUNT(*) AS n FROM users WHERE id = 'u1'`).first<{ n: number }>();
    expect(left?.n).toBe(0);
  });

  it('tells the frontend both numbers, so it can render the screen on load', async () => {
    const { db, env } = setup();
    await person(db);
    const headers = await authHeaders(env, 'u1');
    await behindOnPolicy(db, 'u1');

    const body = (await (await app.request('https://worker.test/me', { headers }, env)).json()) as {
      policyVersion: number;
      acceptedPolicyVersion: number;
    };
    expect(body.policyVersion).toBe(CURRENT_POLICY_VERSION);
    expect(body.acceptedPolicyVersion).toBe(OLD);
  });

  it('unlocks everything once accepted, and records when', async () => {
    const { db, env } = setup();
    await person(db);
    const headers = await authHeaders(env, 'u1');
    await behindOnPolicy(db, 'u1');

    const accept = await app.request(
      'https://worker.test/me/accept-policy',
      { method: 'POST', headers },
      env,
    );
    expect(accept.status).toBe(200);

    const after = await app.request('https://worker.test/me/events?from=0&to=1000', { headers }, env);
    expect(after.status).toBe(200);

    const row = await db
      .prepare(`SELECT accepted_policy_version AS v, accepted_policy_at AS at FROM users WHERE id = 'u1'`)
      .first<{ v: number; at: number | null }>();
    expect(row?.v).toBe(CURRENT_POLICY_VERSION);
    // The timestamp is what makes this a consent record rather than a flag.
    expect(row?.at).toBeGreaterThan(0);
  });
});

describe('upsertUser must never re-stamp the accepted version', () => {
  // The trap named in spec 0012. If accepted_policy_version joins the
  // ON CONFLICT DO UPDATE list, every login silently re-accepts on the user's
  // behalf, the gate never fires, and nothing else in this suite would fail.
  it('leaves an existing user behind on the policy when they log in again', async () => {
    const { db, env } = setup();
    await person(db);
    await behindOnPolicy(db, 'u1');

    await upsertUser(env, { id: 'u1', username: 'u1', globalName: null, avatarHash: null });

    const row = await db
      .prepare(`SELECT accepted_policy_version AS v FROM users WHERE id = 'u1'`)
      .first<{ v: number }>();
    expect(row?.v).toBe(OLD);
  });

  it('stamps a brand-new account at creation, so signing up is not immediately gated', async () => {
    const { env, db } = setup();
    await upsertUser(env, { id: 'newbie', username: 'newbie', globalName: null, avatarHash: null });

    const row = await db
      .prepare(`SELECT accepted_policy_version AS v, accepted_policy_at AS at FROM users WHERE id = 'newbie'`)
      .first<{ v: number; at: number | null }>();
    expect(row?.v).toBe(CURRENT_POLICY_VERSION);
    expect(row?.at).toBeGreaterThan(0);
  });
});

describe('the bot is unaffected', () => {
  it('does not read sessions or acceptance when choosing who to notify', async () => {
    // Decided in IDEAS 37: a reminder about an event someone already RSVP'd
    // to is the service working, and suppressing it makes them miss a session
    // because they have not opened the website yet. The cron never joins
    // either column -- this asserts that stays true.
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const cron = readFileSync(join(__dirname, '..', 'src', 'cron', 'reminders.ts'), 'utf8');
    expect(cron).not.toContain('accepted_policy_version');
    expect(cron).not.toContain('policy_version');
  });
});
