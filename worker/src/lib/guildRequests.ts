// IDEAS item 9 / docs/specs/0015: the pending-request state and the
// approve/reject actions behind the self-service "add this bot" flow. Kept
// separate from routes/guildRequests.ts (the HTTP layer, including the
// Discord OAuth round trip) so the same approve/reject logic can be called
// from both the emailed signed link and the owner-only admin fallback page
// without duplicating it.

import type { Env } from '../env';
import { newId } from './ids';
import { sendOwnerEmail } from './email';
import { signToken } from './signedToken';

export const DECISION_TOKEN_PURPOSE = 'guild_request_decision';
export const GUILD_VERIFY_TOKEN_PURPOSE = 'guild_request_verify';

// A week is comfortably inside SESSION_TTL_MS's own 7-day precedent
// elsewhere in this codebase, and enough slack for an owner who doesn't
// check a particular inbox daily.
const DECISION_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60;
// Only needs to survive one page load and one follow-up submit -- the whole
// point of the OAuth round trip it comes out of is that it's re-provable, so
// there's no reason to make a stale one usable.
const GUILD_VERIFY_TOKEN_TTL_SECONDS = 10 * 60;

export interface GuildVerifyTokenPayload {
  guildId: string;
  guildName: string;
  requestedBy: string;
}

export interface DecisionTokenPayload {
  requestId: string;
  action: 'approve' | 'reject';
}

export function signGuildVerifyToken(env: Env, payload: GuildVerifyTokenPayload): Promise<string> {
  return signToken(GUILD_VERIFY_TOKEN_PURPOSE, payload, env.JWT_SIGNING_KEY, GUILD_VERIFY_TOKEN_TTL_SECONDS);
}

export type CreateResult =
  | { outcome: 'created'; id: string }
  | { outcome: 'already_active' }
  | { outcome: 'already_pending' };

export async function createGuildAddRequest(
  env: Env,
  payload: GuildVerifyTokenPayload,
  // This Worker's own origin, for the decision links the owner's email
  // carries -- they hit this Worker directly (a plain GET that performs the
  // action and confirms it), not the frontend SPA. Computed by the caller
  // from the live request (`new URL(c.req.url).origin`), the same way
  // routes/auth.ts derives its own OAuth redirect_uri, rather than a stored
  // env var: it stays correct for whichever of production/sandbox actually
  // handled the request with no separate config to keep in sync.
  workerOrigin: string,
): Promise<CreateResult> {
  const { guildId, guildName, requestedBy } = payload;

  const active = await env.DB.prepare(`SELECT 1 FROM guilds WHERE id = ? AND is_active = 1`).bind(guildId).first();
  if (active) return { outcome: 'already_active' };

  const id = newId();
  const now = Date.now();
  try {
    await env.DB.prepare(
      `INSERT INTO guild_add_requests (id, guild_id, guild_name, requested_by, status, requested_at)
       VALUES (?, ?, ?, ?, 'pending', ?)`,
    )
      .bind(id, guildId, guildName, requestedBy, now)
      .run();
  } catch (err) {
    // The partial unique index (idx_guild_add_requests_one_pending) is what
    // actually enforces "one pending request per guild" -- catching its
    // violation here, rather than SELECTing first, is the same
    // race-safe-by-construction shape claim() in lib/outbox.ts uses: a
    // concurrent double-submit collides on the constraint instead of both
    // succeeding.
    if (err instanceof Error && /UNIQUE constraint failed/.test(err.message)) {
      return { outcome: 'already_pending' };
    }
    throw err;
  }

  const [approveToken, rejectToken] = await Promise.all([
    signToken(DECISION_TOKEN_PURPOSE, { requestId: id, action: 'approve' } satisfies DecisionTokenPayload, env.JWT_SIGNING_KEY, DECISION_TOKEN_TTL_SECONDS),
    signToken(DECISION_TOKEN_PURPOSE, { requestId: id, action: 'reject' } satisfies DecisionTokenPayload, env.JWT_SIGNING_KEY, DECISION_TOKEN_TTL_SECONDS),
  ]);

  await sendOwnerEmail(env, {
    subject: `"${guildName}" wants to add the bot`,
    text:
      `A Discord server admin has asked to add the bot to "${guildName}" (guild id ${guildId}).\n\n` +
      `Approve: ${workerOrigin}/guild-requests/${approveToken}/decide\n` +
      `Reject: ${workerOrigin}/guild-requests/${rejectToken}/decide\n\n` +
      `Either link works once; both expire in 7 days. You can also decide this from the admin page ` +
      `(Settings > Admin > Guild requests) if these links have expired.`,
  });

  return { outcome: 'created', id };
}

export type DecideResult = 'approved' | 'rejected' | 'already_decided' | 'not_found';

// Shared by the emailed token link and the owner-only admin fallback route --
// see this module's header comment for why. Idempotent: a request already
// decided (by whichever path got there first) is a clean no-op, the same
// discipline `guild_add_requests.decided_at IS NULL` is checked for
// everywhere else this is read.
export async function decideGuildAddRequest(env: Env, requestId: string, action: 'approve' | 'reject'): Promise<DecideResult> {
  const request = await env.DB.prepare(
    `SELECT guild_id, guild_name, status FROM guild_add_requests WHERE id = ? AND decided_at IS NULL`,
  )
    .bind(requestId)
    .first<{ guild_id: string; guild_name: string; status: string }>();
  if (!request) {
    const exists = await env.DB.prepare(`SELECT 1 FROM guild_add_requests WHERE id = ?`).bind(requestId).first();
    return exists ? 'already_decided' : 'not_found';
  }

  const now = Date.now();
  const newStatus = action === 'approve' ? 'approved' : 'rejected';
  const claimed = await env.DB.prepare(
    `UPDATE guild_add_requests SET status = ?, decided_at = ? WHERE id = ? AND decided_at IS NULL`,
  )
    .bind(newStatus, now, requestId)
    .run();
  // Lost a race with another decision (the email link and an admin click
  // landing at the same moment) -- whoever got there first wins, and this
  // caller is told the same "already decided" outcome it would have gotten
  // by arriving a moment later.
  if (claimed.meta.changes === 0) return 'already_decided';

  if (action === 'approve') {
    // The exact allow-list insert the manual `wrangler d1 execute` step in
    // SETUP.md does today (see routes/admin.ts's POST /guilds).
    await env.DB.prepare(
      `INSERT INTO guilds (id, name, is_active, added_at) VALUES (?, ?, 1, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, is_active = 1`,
    )
      .bind(request.guild_id, request.guild_name, now)
      .run();
  }

  return newStatus === 'approved' ? 'approved' : 'rejected';
}

export interface GuildAddRequestRow {
  id: string;
  guild_id: string;
  guild_name: string;
  requested_by: string;
  status: string;
  requested_at: number;
  decided_at: number | null;
}

export async function listGuildAddRequests(env: Env): Promise<GuildAddRequestRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT id, guild_id, guild_name, requested_by, status, requested_at, decided_at
     FROM guild_add_requests ORDER BY requested_at DESC LIMIT 100`,
  ).all<GuildAddRequestRow>();
  return results;
}
