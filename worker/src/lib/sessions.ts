import type { Env } from '../env';
import { newId } from './ids';
import { CURRENT_POLICY_VERSION } from './policy';

// Absolute session lifetime. Deliberately not indefinitely renewable: once a
// session passes this age, the user must go through a real Discord login
// again, which re-syncs their guild membership from Discord's own source of
// truth. Short-lived access JWTs (see jwt.ts) can be refreshed many times
// within this window without forcing that, but never past it.
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// One person logging in from a phone, a laptop, and a work computer is
// normal; thousands of rows for one account is not. Login itself has no
// rate limit (that's a bigger piece of infrastructure this app doesn't have
// yet -- see the F-06 follow-up note), so this caps the *storage* consequence
// of repeated logins rather than the logins themselves.
const MAX_SESSIONS_PER_USER = 20;

export async function createSession(env: Env, userId: string): Promise<{ id: string }> {
  const id = newId();
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO sessions (id, user_id, created_at, last_used_at, expires_at, revoked_at, policy_version)
     VALUES (?, ?, ?, ?, ?, NULL, ?)`,
  )
    .bind(id, userId, now, now, now + SESSION_TTL_MS, CURRENT_POLICY_VERSION)
    .run();

  await env.DB.prepare(
    `DELETE FROM sessions WHERE user_id = ? AND id NOT IN (
       SELECT id FROM sessions WHERE user_id = ? ORDER BY created_at DESC LIMIT ?
     )`,
  )
    .bind(userId, userId, MAX_SESSIONS_PER_USER)
    .run();

  return { id };
}

// Expired and revoked sessions are permanently inert (isSessionActive always
// rejects them) but nothing else ever removes the rows -- called from the
// cron sweep so storage doesn't grow forever.
export async function pruneStaleSessions(env: Env): Promise<void> {
  const now = Date.now();
  // Sessions issued under a superseded policy are inert but not revoked and
  // not expired, so without this clause they would sit here until their TTL
  // ran out. Same reasoning as the other two: nothing else removes them.
  await env.DB.prepare(
    `DELETE FROM sessions WHERE expires_at < ? OR revoked_at IS NOT NULL OR policy_version <> ?`,
  )
    .bind(now, CURRENT_POLICY_VERSION)
    .run();
}

// The authority check behind every authenticated request: the JWT's
// signature and expiry alone can't be revoked, so this row is what makes
// logout, account deletion, and a leaked-token response take effect
// immediately instead of waiting out the token's lifetime.
export async function isSessionActive(env: Env, sessionId: string, userId: string): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT user_id, expires_at, revoked_at, policy_version FROM sessions WHERE id = ?`,
  )
    .bind(sessionId)
    .first<{ user_id: string; expires_at: number; revoked_at: number | null; policy_version: number }>();
  if (!row || row.user_id !== userId || row.revoked_at != null) return false;
  // A session issued under a superseded policy is dead. This is the whole
  // logout mechanism (spec 0012): bumping CURRENT_POLICY_VERSION invalidates
  // every outstanding session at once, lazily, on each holder's next request
  // -- no mass write, no deploy step, nothing to run twice. It rides on a row
  // this function already reads, so it costs no extra query.
  if (row.policy_version !== CURRENT_POLICY_VERSION) return false;
  return row.expires_at > Date.now();
}

// Used by /auth/refresh only. Confirms the session is still active and bumps
// last_used_at -- it does NOT extend expires_at, so re-login is still
// required at most SESSION_TTL_MS after the original Discord login no matter
// how often the short-lived access token gets refreshed in between.
export async function rotateSession(env: Env, sessionId: string, userId: string): Promise<boolean> {
  const active = await isSessionActive(env, sessionId, userId);
  if (!active) return false;
  await env.DB.prepare(`UPDATE sessions SET last_used_at = ? WHERE id = ?`).bind(Date.now(), sessionId).run();
  return true;
}

export async function revokeSession(env: Env, sessionId: string): Promise<void> {
  await env.DB.prepare(`UPDATE sessions SET revoked_at = ? WHERE id = ?`).bind(Date.now(), sessionId).run();
}

// Called first thing during account deletion, so auth is cut off immediately
// even if a later step in that deletion fails.
export async function revokeAllSessionsForUser(env: Env, userId: string): Promise<void> {
  await env.DB.prepare(`UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL`)
    .bind(Date.now(), userId)
    .run();
}
