import type { Env } from '../env';
import { newId } from './ids';

// Absolute session lifetime. Deliberately not indefinitely renewable: once a
// session passes this age, the user must go through a real Discord login
// again, which re-syncs their guild membership from Discord's own source of
// truth. Short-lived access JWTs (see jwt.ts) can be refreshed many times
// within this window without forcing that, but never past it.
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export async function createSession(env: Env, userId: string): Promise<{ id: string }> {
  const id = newId();
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO sessions (id, user_id, created_at, last_used_at, expires_at, revoked_at)
     VALUES (?, ?, ?, ?, ?, NULL)`,
  )
    .bind(id, userId, now, now, now + SESSION_TTL_MS)
    .run();
  return { id };
}

// The authority check behind every authenticated request: the JWT's
// signature and expiry alone can't be revoked, so this row is what makes
// logout, account deletion, and a leaked-token response take effect
// immediately instead of waiting out the token's lifetime.
export async function isSessionActive(env: Env, sessionId: string, userId: string): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT user_id, expires_at, revoked_at FROM sessions WHERE id = ?`,
  )
    .bind(sessionId)
    .first<{ user_id: string; expires_at: number; revoked_at: number | null }>();
  if (!row || row.user_id !== userId || row.revoked_at != null) return false;
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
