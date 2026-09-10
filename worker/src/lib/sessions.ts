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

// How long a session that has just been rotated away from keeps working
// (F-20 / migration 0041). Long enough to cover two tabs hitting a 401 at the
// same moment and both calling refresh -- the loser would otherwise get a 401
// from refresh itself, which the frontend's API client treats as terminal:
// it clears the stored token and bounces to login, discarding the good token
// the winning tab had just written. Short enough that it does not meaningfully
// extend what a captured token is worth.
const ROTATION_GRACE_MS = 60 * 1000;

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
  // Superseded rows join the list for the same reason (F-20): once the
  // rotation grace has passed they are as inert as a revoked one, and nothing
  // else would ever remove them before their seven-day TTL. Refresh runs often
  // enough that they would otherwise be the bulk of this table.
  await env.DB.prepare(
    `DELETE FROM sessions
     WHERE expires_at < ? OR revoked_at IS NOT NULL OR policy_version <> ?
        OR (superseded_at IS NOT NULL AND superseded_at < ?)`,
  )
    .bind(now, CURRENT_POLICY_VERSION, now - ROTATION_GRACE_MS)
    .run();
}

// The authority check behind every authenticated request: the JWT's
// signature and expiry alone can't be revoked, so this row is what makes
// logout, account deletion, and a leaked-token response take effect
// immediately instead of waiting out the token's lifetime.
export async function isSessionActive(env: Env, sessionId: string, userId: string): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT user_id, expires_at, revoked_at, policy_version, superseded_at FROM sessions WHERE id = ?`,
  )
    .bind(sessionId)
    .first<{
      user_id: string;
      expires_at: number;
      revoked_at: number | null;
      policy_version: number;
      superseded_at: number | null;
    }>();
  if (!row || row.user_id !== userId || row.revoked_at != null) return false;
  // A session that has been rotated away from (F-20) keeps working just long
  // enough for a second tab already mid-request to finish, and then stops.
  // Revocation above is checked first and stays absolute -- logout must not
  // be graced.
  if (row.superseded_at != null && row.superseded_at < Date.now() - ROTATION_GRACE_MS) return false;
  // A session issued under a superseded policy is dead. This is the whole
  // logout mechanism (spec 0012): bumping CURRENT_POLICY_VERSION invalidates
  // every outstanding session at once, lazily, on each holder's next request
  // -- no mass write, no deploy step, nothing to run twice. It rides on a row
  // this function already reads, so it costs no extra query.
  if (row.policy_version !== CURRENT_POLICY_VERSION) return false;
  return row.expires_at > Date.now();
}

// Used by /auth/refresh only. Refresh, done properly (F-20 in the Pass-11
// review).
//
// This used to bump last_used_at and hand back a token carrying the SAME sid,
// which made the new token interchangeable with the old one: a captured token
// could be refreshed indefinitely for the whole seven-day session, and the
// 30-minute access-token lifetime that jwt.ts and README section 4 both
// describe as bounding a theft bounded nothing at all.
//
// Now each refresh mints a new session and retires the one presented. Two
// tokens for one session can no longer both keep working -- whoever refreshes
// second is holding a sid that stops authenticating once the grace passes --
// so a parallel-use theft dies at the next refresh rather than at the end of
// the week.
//
// The successor inherits expires_at and policy_version rather than starting
// fresh, which is what keeps SESSION_TTL_MS an absolute ceiling: refreshing
// cannot extend a session past the original Discord login's seven days, and
// a policy-version bump still invalidates the whole chain at once.
//
// Returns the new session id, or null if the presented one is not usable.
export async function rotateSession(env: Env, sessionId: string, userId: string): Promise<string | null> {
  const active = await isSessionActive(env, sessionId, userId);
  if (!active) return null;

  const row = await env.DB.prepare(`SELECT expires_at, policy_version FROM sessions WHERE id = ?`)
    .bind(sessionId)
    .first<{ expires_at: number; policy_version: number }>();
  if (!row) return null;

  const id = newId();
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO sessions (id, user_id, created_at, last_used_at, expires_at, revoked_at, policy_version)
       VALUES (?, ?, ?, ?, ?, NULL, ?)`,
    ).bind(id, userId, now, now, row.expires_at, row.policy_version),
    // Retired, not revoked: see migration 0041 for why those are different
    // facts. `superseded_at IS NULL` makes a concurrent second rotation of the
    // same row a no-op on the marker rather than pushing the grace window
    // forward each time.
    env.DB.prepare(`UPDATE sessions SET superseded_at = ? WHERE id = ? AND superseded_at IS NULL`).bind(
      now,
      sessionId,
    ),
  ]);
  return id;
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
