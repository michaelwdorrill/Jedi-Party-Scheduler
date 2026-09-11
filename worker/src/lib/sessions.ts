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
  // A fresh login starts its own family, so family_id is its own id
  // (migration 0042). Every successor rotation produces inherits it unchanged.
  await env.DB.prepare(
    `INSERT INTO sessions (id, user_id, family_id, created_at, last_used_at, expires_at, revoked_at, policy_version)
     VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`,
  )
    .bind(id, userId, id, now, now, now + SESSION_TTL_MS, CURRENT_POLICY_VERSION)
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
// Pass-12 review (P12-04) fixes what 0041's guard did not cover. That guard
// stopped a concurrent second rotation moving the grace window; it did not stop
// it inserting a second successor, so one session forked into two independent
// chains that could each rotate on for the rest of the seven days, with nothing
// linking them and logout reaching only the one presented. Rotation that forks
// is not rotation: the thief just refreshes into a branch of their own.
//
// Three things make it real, all resting on migration 0042:
//
//   * The retiring UPDATE is now the *claim*, taken before the successor
//     exists, and the successor is inserted in the same batch conditioned on
//     that claim having landed. Exactly one writer can move superseded_at from
//     NULL, so exactly one successor is ever created.
//   * A refresh that arrives inside the grace for an already-retired session is
//     handed the SAME successor rather than a new one, so two tabs converge on
//     one chain. Failing the loser instead is not an option -- 0041 records
//     why: the frontend treats a 401 from refresh as terminal and discards the
//     good token the winning tab just stored.
//   * A refresh that arrives AFTER the grace cannot be a slow tab. It is a
//     retired token being replayed, and the whole family is revoked on the
//     spot. That logs the legitimate holder out too, which is correct: by then
//     one of the two holders is an attacker and nothing here can tell which.
//
// The 20-session cap needs no separate enforcement once the fork is gone. A
// login starts one family, a family has exactly one live session at a time --
// every predecessor is superseded, and pruneStaleSessions removes those once
// the grace has passed -- so createSession's cap still bounds what a user can
// accumulate. It was bypassable before only because forking manufactured live
// sessions that no login had authorised.
//
// Returns the new session id, or null if the presented one is not usable.
export async function rotateSession(env: Env, sessionId: string, userId: string): Promise<string | null> {
  const row = await env.DB.prepare(
    `SELECT user_id, expires_at, revoked_at, policy_version, superseded_at, successor_id, family_id
     FROM sessions WHERE id = ?`,
  )
    .bind(sessionId)
    .first<{
      user_id: string;
      expires_at: number;
      revoked_at: number | null;
      policy_version: number;
      superseded_at: number | null;
      successor_id: string | null;
      family_id: string | null;
    }>();

  const now = Date.now();
  if (!row || row.user_id !== userId || row.revoked_at != null) return null;
  if (row.policy_version !== CURRENT_POLICY_VERSION) return null;
  if (row.expires_at <= now) return null;

  if (row.superseded_at != null) {
    if (row.superseded_at < now - ROTATION_GRACE_MS) {
      // Replay of a retired token. Revoking the family is the whole point of
      // rotating in the first place -- without it a captured token simply
      // rotates into its own branch and outlives the theft it was supposed to
      // end.
      await revokeSessionFamily(env, row.family_id ?? sessionId);
      return null;
    }
    // Inside the grace: the other tab already rotated this one. Hand back what
    // it produced.
    return row.successor_id;
  }

  const id = newId();
  const family = row.family_id ?? sessionId;
  const [claim] = await env.DB.batch([
    // Retired, not revoked: see migration 0041 for why those are different
    // facts. This is also the claim -- `superseded_at IS NULL` means exactly
    // one concurrent caller can win it.
    env.DB.prepare(
      `UPDATE sessions SET superseded_at = ?, successor_id = ? WHERE id = ? AND superseded_at IS NULL`,
    ).bind(now, id, sessionId),
    // Conditioned on that claim rather than run unconditionally, and in the
    // same batch so the two cannot come apart. A caller that lost the race
    // finds someone else's successor_id on the row and inserts nothing, which
    // is what stops the fork; a batch is one transaction, so a failure here
    // takes the claim with it rather than retiring a session whose successor
    // does not exist.
    env.DB.prepare(
      `INSERT INTO sessions (id, user_id, family_id, created_at, last_used_at, expires_at, revoked_at, policy_version)
       SELECT ?, ?, ?, ?, ?, ?, NULL, ?
       WHERE EXISTS (SELECT 1 FROM sessions WHERE id = ? AND successor_id = ?)`,
    ).bind(id, userId, family, now, now, row.expires_at, row.policy_version, sessionId, id),
  ]);

  if (claim.meta.changes === 0) {
    // Lost the race between the read above and the claim. The winner's
    // successor is the one to use.
    const winner = await env.DB.prepare(`SELECT successor_id FROM sessions WHERE id = ?`)
      .bind(sessionId)
      .first<{ successor_id: string | null }>();
    return winner?.successor_id ?? null;
  }
  return id;
}

// Logging out ends the whole chain the session belongs to, not just the row
// whose token happened to be presented (Pass-12 review, P12-04). Before
// families existed there was nothing else it could mean; now that a session
// has predecessors and a successor, revoking one row would leave the rest of
// the lineage authenticating perfectly well.
export async function revokeSession(env: Env, sessionId: string): Promise<void> {
  const row = await env.DB.prepare(`SELECT family_id FROM sessions WHERE id = ?`)
    .bind(sessionId)
    .first<{ family_id: string | null }>();
  await revokeSessionFamily(env, row?.family_id ?? sessionId);
}

// Revokes every session in a lineage. Used by logout and by reuse detection.
// Matches the family's own root row too, for rows predating migration 0042
// whose family_id was backfilled to their own id.
export async function revokeSessionFamily(env: Env, familyId: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE sessions SET revoked_at = ? WHERE (family_id = ? OR id = ?) AND revoked_at IS NULL`,
  )
    .bind(Date.now(), familyId, familyId)
    .run();
}

// Called first thing during account deletion, so auth is cut off immediately
// even if a later step in that deletion fails.
export async function revokeAllSessionsForUser(env: Env, userId: string): Promise<void> {
  await env.DB.prepare(`UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL`)
    .bind(Date.now(), userId)
    .run();
}
