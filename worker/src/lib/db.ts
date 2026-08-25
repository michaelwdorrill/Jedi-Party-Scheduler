import type { Env } from '../env';
import { CURRENT_POLICY_VERSION } from './policy';
import { chunkIds, chunkRows, placeholders } from './d1';
import { checkGuildMembership } from './discord';
import { revokeAllSessionsForUser } from './sessions';

// How long a cached membership row is trusted before a request forces a live
// Discord check. Bounds how long someone who left a guild can keep acting on
// it through an active application session -- previously that was only
// refreshed on the next full OAuth login (up to 7 days).
export const MEMBERSHIP_FRESHNESS_MS = 60 * 60 * 1000;

// The outer bound. Past MEMBERSHIP_FRESHNESS_MS we try to revalidate against
// Discord; if Discord can't answer (outage, rate limit, broken bot token) we
// keep honouring the last known-good answer, but only up to this age. After
// that the cached row is not evidence of anything and access is refused.
//
// This is the deliberate middle ground between the two failure policies:
//
//   fail open   a Discord blip never locks anyone out, but someone who left
//               the server keeps their access for as long as the outage
//               lasts -- unbounded.
//   fail closed the moment Discord can't be reached (or the bot token
//               breaks, or the bot is removed from the server) every user is
//               locked out of the app until an operator intervenes.
//
// A 24-hour grace keeps a short outage invisible to users while capping a
// departed member's residual access at one day instead of forever. A failure
// that outlasts the grace is an operator problem, and at that point locking
// down is the right answer.
export const MEMBERSHIP_GRACE_MS = 24 * 60 * 60 * 1000;

// Bulk membership checks (validating an invite list, a group roster) revalidate
// stale rows live, but a request must not be able to trigger an unbounded
// number of outbound Discord calls -- an organizer submitting 300 resolved
// invitees would otherwise mean 300 sequential REST lookups inside one
// request. A request needing more live checks than this is refused as
// temporarily unverifiable rather than served from cache: see
// filterActiveGuildMembers for why that direction is the only safe one here.
const MAX_LIVE_REVALIDATIONS_PER_REQUEST = 20;

export interface UserRow {
  id: string;
  username: string;
  global_name: string | null;
  avatar_hash: string | null;
  timezone: string;
  notifications_enabled: number;
  free_busy_visible?: number;
  // Only selected by GET /me, which is why these are optional here.
  accepted_policy_version?: number;
  accepted_policy_at?: number | null;
}

export interface GuildRow {
  id: string;
  name: string;
}

// `isOwnerFlag` is computed by the caller (it needs `env`, which this
// function deliberately doesn't take) and merely carried through here so
// every response shaped by mapUser stays consistent. It only ever reflects
// the caller's own account back to them -- OWNER_DISCORD_ID itself is never
// exposed, just whether the requesting user matches it.
export function mapUser(row: UserRow, isOwnerFlag: boolean) {
  return {
    id: row.id,
    username: row.username,
    globalName: row.global_name,
    avatarHash: row.avatar_hash,
    timezone: row.timezone,
    notificationsEnabled: !!row.notifications_enabled,
    freeBusyVisible: row.free_busy_visible === undefined ? true : !!row.free_busy_visible,
    isOwner: isOwnerFlag,
  };
}

export function mapFriend(row: UserRow) {
  return {
    id: row.id,
    username: row.username,
    globalName: row.global_name,
    avatarHash: row.avatar_hash,
  };
}

export function mapGuild(row: GuildRow) {
  return { id: row.id, name: row.name };
}

// Three outcomes, not two. `denied` and `unverifiable` are both refusals, but
// they mean opposite things to the person on the other end -- "you're not in
// that server" is final, "we can't reach Discord right now" is not -- and the
// routes turn them into 403 and 503 respectively so a Discord outage doesn't
// masquerade as a permissions problem.
export type GuildAccess = 'member' | 'denied' | 'unverifiable';

// Applies the cached row plus, if it's stale, a live Discord check. Requires
// BOTH that the cache says the user is currently a member AND that the guild
// itself hasn't been deactivated -- deactivating a guild is supposed to
// immediately block every route derived from it, not just stop it from
// appearing in listings.
//
// The live check is a single REST lookup, not a gateway subscription, so it
// doesn't need the privileged members intent. See MEMBERSHIP_GRACE_MS above
// for what happens when that lookup can't be completed.
export async function checkGuildAccess(env: Env, userId: string, guildId: string): Promise<GuildAccess> {
  const row = await env.DB.prepare(
    `SELECT m.is_member, m.verified_at, g.is_active FROM user_guild_membership m
     JOIN guilds g ON g.id = m.guild_id
     WHERE m.user_id = ? AND m.guild_id = ?`,
  )
    .bind(userId, guildId)
    .first<{ is_member: number; verified_at: number; is_active: number }>();

  // No row, a deactivated guild, or a cache that already says "not a member"
  // are all settled answers that no amount of revalidation would change.
  if (!row || !row.is_active) return 'denied';
  if (!row.is_member) return 'denied';

  const age = Date.now() - row.verified_at;
  if (age <= MEMBERSHIP_FRESHNESS_MS) return 'member';

  const status = await checkGuildMembership(env.DISCORD_BOT_TOKEN, guildId, userId);
  const now = Date.now();

  if (status === 'member') {
    await env.DB.prepare(`UPDATE user_guild_membership SET verified_at = ? WHERE user_id = ? AND guild_id = ?`)
      .bind(now, userId, guildId)
      .run();
    return 'member';
  }

  if (status === 'not_member') {
    await env.DB.prepare(
      `UPDATE user_guild_membership SET is_member = 0, verified_at = ? WHERE user_id = ? AND guild_id = ?`,
    )
      .bind(now, userId, guildId)
      .run();
    return 'denied';
  }

  // Couldn't verify. verified_at is deliberately NOT refreshed -- the next
  // request retries the live check, and the grace window keeps counting from
  // the last time Discord actually confirmed this membership rather than
  // resetting on every failed attempt.
  if (age <= MEMBERSHIP_GRACE_MS) return 'member';
  console.warn(
    `Membership for user ${userId} in guild ${guildId} is ${Math.round(age / 3600_000)}h stale ` +
      `and Discord is ${status} -- denying access until it can be re-verified.`,
  );
  return 'unverifiable';
}

// Thrown when membership can't be established either way. Routes don't catch
// it: router.ts's error handler turns it into a 503 with Retry-After, which
// keeps every call site's existing `if (!(await isGuildMember(...)))` shape
// while still distinguishing "you're not in that server" (a settled 403/404)
// from "we couldn't ask Discord" (try again shortly). Conflating the two
// would tell someone they'd lost access to their own group because Discord
// had a bad minute.
export class MembershipUnavailableError extends Error {}

// Boolean form for route call sites: true to proceed, false for a settled
// refusal, and a throw for the third case.
export async function isGuildMember(env: Env, userId: string, guildId: string): Promise<boolean> {
  const access = await checkGuildAccess(env, userId, guildId);
  if (access === 'unverifiable') {
    throw new MembershipUnavailableError('Guild membership could not be verified with Discord');
  }
  return access === 'member';
}

// Same check, phrased for call sites that resolve a guildId from some other
// object (an event, a group, a poll) rather than from the URL directly, and
// want a uniform 404 for "not found" vs "not yours" rather than leaking which
// one it is.
export async function requireActiveGuildMember(env: Env, userId: string, guildId: string): Promise<boolean> {
  return isGuildMember(env, userId, guildId);
}

// Given a set of candidate user IDs, returns only the ones who are currently
// active members of the given (active) guild. Used to validate group-member
// and event-invite targets so a request can't graft a user from one guild
// onto another guild's roster/invite list just by knowing their ID.
//
// Unlike the previous version this is not purely cache-driven: a row that has
// gone stale is revalidated against Discord (bounded, see
// MAX_LIVE_REVALIDATIONS_PER_REQUEST) before the user is offered as a valid
// target, so someone who left the server months ago and never came back can't
// remain permanently selectable just because nothing has re-read their row.
export async function filterActiveGuildMembers(env: Env, guildId: string, userIds: string[]): Promise<Set<string>> {
  if (userIds.length === 0) return new Set();

  // Chunked: userIds comes from an invite list or group roster whose
  // configured maximum (up to 300 after group expansion) is well past D1's
  // per-statement bound-parameter ceiling.
  const cached: { user_id: string; verified_at: number }[] = [];
  for (const chunk of chunkIds(userIds, 1)) {
    const { results } = await env.DB.prepare(
      `SELECT m.user_id, m.verified_at FROM user_guild_membership m
       JOIN guilds g ON g.id = m.guild_id
       WHERE m.guild_id = ? AND m.is_member = 1 AND g.is_active = 1
         AND m.user_id IN (${placeholders(chunk.length)})`,
    )
      .bind(guildId, ...chunk)
      .all<{ user_id: string; verified_at: number }>();
    cached.push(...results);
  }

  const now = Date.now();
  const active = new Set<string>();
  const stale: { user_id: string; verified_at: number }[] = [];
  for (const row of cached) {
    if (now - row.verified_at <= MEMBERSHIP_FRESHNESS_MS) active.add(row.user_id);
    else stale.push(row);
  }

  // Oldest first: if the revalidation budget runs out, spend it on the rows
  // whose cached answer is least trustworthy.
  stale.sort((a, b) => a.verified_at - b.verified_at);

  // More stale targets than this request can afford to verify. Every caller
  // of this function is about to *grant* something -- add someone to a
  // roster, invite them to a private event, DM them its title -- so silently
  // treating "we ran out of budget before checking this one" as "confirmed
  // current member" is the one interpretation that isn't available. Refusing
  // is retryable: the background sweep is continuously refreshing the oldest
  // rows, so the same request a few minutes later will have fewer to check.
  if (stale.length > MAX_LIVE_REVALIDATIONS_PER_REQUEST) {
    throw new MembershipUnavailableError(
      `${stale.length} of the selected members need re-checking with Discord, which is more than one request can do at once`,
    );
  }

  // Discord lookups still happen one at a time -- each is a distinct outbound
  // subrequest with no batch form -- but the D1 writeback for the results
  // does not need to be. Collecting outcomes and writing them back in
  // set-based chunks turns up to MAX_LIVE_REVALIDATIONS_PER_REQUEST individual
  // UPDATE statements into at most two, regardless of how many rows were
  // revalidated.
  const confirmed: string[] = [];
  const departed: string[] = [];
  for (const row of stale) {
    const status = await checkGuildMembership(env.DISCORD_BOT_TOKEN, guildId, row.user_id);
    if (status === 'member') {
      confirmed.push(row.user_id);
      active.add(row.user_id);
    } else if (status === 'not_member') {
      departed.push(row.user_id);
    } else if (now - row.verified_at <= MEMBERSHIP_GRACE_MS) {
      active.add(row.user_id);
    }
  }

  const writeNow = Date.now();
  const writes: D1PreparedStatement[] = [];
  for (const chunk of chunkIds(confirmed, 1)) {
    writes.push(
      env.DB.prepare(
        `UPDATE user_guild_membership SET verified_at = ?
         WHERE guild_id = ? AND user_id IN (${placeholders(chunk.length)})`,
      ).bind(writeNow, guildId, ...chunk),
    );
  }
  for (const chunk of chunkIds(departed, 1)) {
    writes.push(
      env.DB.prepare(
        `UPDATE user_guild_membership SET is_member = 0, verified_at = ?
         WHERE guild_id = ? AND user_id IN (${placeholders(chunk.length)})`,
      ).bind(writeNow, guildId, ...chunk),
    );
  }
  if (writes.length > 0) await env.DB.batch(writes);

  return active;
}

export async function listUserGuilds(env: Env, userId: string) {
  const { results } = await env.DB.prepare(
    `SELECT g.id, g.name FROM guilds g
     JOIN user_guild_membership m ON m.guild_id = g.id
     WHERE m.user_id = ? AND m.is_member = 1 AND g.is_active = 1
     ORDER BY g.name`,
  )
    .bind(userId)
    .all<GuildRow>();
  return results.map(mapGuild);
}

// "Friends" = other users who have also logged into this app and share the
// given guild with the requesting user. Requires a membership confirmed
// within the grace window, same as every other listing/target query -- a row
// that has drifted past it is not evidence the person is still around, and
// this is a way to learn about and select them (as an invite/group target)
// just as much as any of those other checks are.
export async function listFriends(env: Env, userId: string, guildId: string) {
  const { results } = await env.DB.prepare(
    `SELECT u.id, u.username, u.global_name, u.avatar_hash, u.timezone, u.notifications_enabled
     FROM users u
     JOIN user_guild_membership m ON m.user_id = u.id
     WHERE m.guild_id = ? AND m.is_member = 1 AND m.verified_at >= ? AND u.id != ?
     ORDER BY u.username`,
  )
    .bind(guildId, Date.now() - MEMBERSHIP_GRACE_MS, userId)
    .all<UserRow>();
  return results.map(mapFriend);
}

export function isOwner(env: Env, userId: string): boolean {
  return userId === env.OWNER_DISCORD_ID;
}

export interface UpsertUserInput {
  id: string;
  username: string;
  globalName: string | null;
  avatarHash: string | null;
}

// Records a login *attempt*, not a successful login. This runs as soon as
// Discord hands back a valid profile, which is before routes/auth.ts checks
// that the caller shares an allow-listed server -- a check that can still
// reject with a 403 and issue no session. Stamping `last_login_at` here made
// those two outcomes identical on the owner-only user list (migration 0018);
// `markLoginSucceeded` below is what records the real thing.
export async function upsertUser(env: Env, input: UpsertUserInput): Promise<void> {
  const now = Date.now();
  // `accepted_policy_version` and `accepted_policy_at` appear in the INSERT
  // list and NOT in the DO UPDATE list, and that asymmetry is the whole point
  // (docs/specs/0012). This function runs on *every* login, not only on
  // account creation -- so re-stamping the current version here would mean
  // logging in counts as agreeing, the gate would never fire for anybody, and
  // the feature would appear to work while doing nothing at all.
  // test/policyAcceptance.test.ts has a test named for exactly this.
  //
  // New accounts are stamped at creation because the alternative is showing
  // someone an acceptance screen as the first thing after the login that
  // created their account, asking them to agree to what they just agreed to.
  await env.DB.prepare(
    `INSERT INTO users (id, username, global_name, avatar_hash, timezone, notifications_enabled,
       created_at, updated_at, last_login_attempt_at, accepted_policy_version, accepted_policy_at)
     VALUES (?, ?, ?, ?, 'America/New_York', 1, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       username = excluded.username,
       global_name = excluded.global_name,
       avatar_hash = excluded.avatar_hash,
       updated_at = excluded.updated_at,
       last_login_attempt_at = excluded.last_login_attempt_at`,
  )
    .bind(
      input.id,
      input.username,
      input.globalName,
      input.avatarHash,
      now,
      now,
      now,
      CURRENT_POLICY_VERSION,
      now,
    )
    .run();
}

// Called only once a session is actually being issued, so `last_login_at`
// means what its name says.
export async function markLoginSucceeded(env: Env, userId: string): Promise<void> {
  await env.DB.prepare(`UPDATE users SET last_login_at = ? WHERE id = ?`).bind(Date.now(), userId).run();
}

// Full erasure of a user's data, exposed as DELETE /me. Discord's Developer
// Terms require an easily accessible way for users to have their API Data
// deleted, and GDPR/CCPA give a right to erasure -- this is that path, done
// in-app rather than by emailing the operator.
//
// Events this user organised are removed outright (they own that content, and
// the invitees' copies are meaningless without it). Where the user was merely
// a participant, only their own rows go: the event survives for everyone else.
// The whole erasure is ONE D1 batch, which Cloudflare documents as a single
// transaction. The previous version ran a batch per organised event and a
// batch per owned group, which meant a failure partway through committed
// everything before it and left a half-erased account with no record that
// deletion had been attempted -- exactly the durability gap flagged in
// review. Collapsing it works because every per-object delete can be phrased
// as a subquery (`WHERE event_id IN (SELECT id FROM events WHERE
// organizer_id = ?)`) instead of a loop over fetched IDs, which also keeps it
// clear of D1's bound-parameter ceiling: the statement count is fixed and
// each one binds a single value no matter how much data the account has.
export async function deleteUserCompletely(env: Env, userId: string): Promise<void> {
  // Revoke every session first, before touching any other data. Even though
  // the erasure below is now atomic, this ordering means a failure to erase
  // still leaves the account locked out rather than usable.
  await revokeAllSessionsForUser(env, userId);

  const organisedEvents = `SELECT id FROM events WHERE organizer_id = ?`;
  const ownedGroups = `SELECT id FROM groups WHERE created_by = ?`;

  // Explicit child deletes rather than relying on ON DELETE CASCADE. D1 does
  // enforce foreign keys, but not every child here has a cascade declared,
  // and spelling out the order makes the erasure guarantee reviewable rather
  // than inferred from a dozen table definitions. Children before parents
  // throughout, which is also what keeps the batch valid under enforcement.
  await env.DB.batch([
    // Events this user organised: they own that content, and the invitees'
    // copies are meaningless without it, so it goes outright.
    env.DB.prepare(
      `DELETE FROM event_poll_votes WHERE option_id IN
         (SELECT id FROM event_poll_options WHERE event_id IN (${organisedEvents}))`,
    ).bind(userId),
    env.DB.prepare(`DELETE FROM event_poll_options WHERE event_id IN (${organisedEvents})`).bind(userId),
    env.DB.prepare(`DELETE FROM event_window_availability WHERE event_id IN (${organisedEvents})`).bind(userId),
    env.DB.prepare(`DELETE FROM event_invites WHERE event_id IN (${organisedEvents})`).bind(userId),
    env.DB.prepare(`DELETE FROM event_recurrence_rules WHERE event_id IN (${organisedEvents})`).bind(userId),
    env.DB.prepare(`DELETE FROM event_occurrence_overrides WHERE event_id IN (${organisedEvents})`).bind(userId),
    env.DB.prepare(`DELETE FROM notification_log WHERE event_id IN (${organisedEvents})`).bind(userId),
    env.DB.prepare(`DELETE FROM events WHERE organizer_id = ?`).bind(userId),

    // Groups this user created. event_invites.source_group_id references
    // groups(id) with no ON DELETE action, so it has to be cleared first or
    // the group delete is blocked.
    env.DB.prepare(
      `UPDATE event_invites SET source_group_id = NULL WHERE source_group_id IN (${ownedGroups})`,
    ).bind(userId),
    env.DB.prepare(`DELETE FROM group_members WHERE group_id IN (${ownedGroups})`).bind(userId),
    env.DB.prepare(`DELETE FROM group_nudge_log WHERE group_id IN (${ownedGroups})`).bind(userId),
    env.DB.prepare(`DELETE FROM group_activity_nudges WHERE group_id IN (${ownedGroups})`).bind(userId),
    env.DB.prepare(`DELETE FROM groups WHERE created_by = ?`).bind(userId),

    // Everywhere the user was merely a participant: only their own rows go,
    // and the event or group survives for everyone else.
    env.DB.prepare(
      `DELETE FROM personal_event_overrides WHERE personal_event_id IN
         (SELECT id FROM personal_events WHERE user_id = ?)`,
    ).bind(userId),
    env.DB.prepare(`DELETE FROM personal_events WHERE user_id = ?`).bind(userId),
    env.DB.prepare(`DELETE FROM event_poll_votes WHERE user_id = ?`).bind(userId),
    env.DB.prepare(`DELETE FROM event_window_availability WHERE user_id = ?`).bind(userId),
    env.DB.prepare(`DELETE FROM event_invites WHERE user_id = ?`).bind(userId),
    env.DB.prepare(`DELETE FROM group_members WHERE user_id = ?`).bind(userId),
    env.DB.prepare(`DELETE FROM group_nudge_log WHERE user_id = ?`).bind(userId),
    env.DB.prepare(`DELETE FROM notification_log WHERE user_id = ?`).bind(userId),
    env.DB.prepare(`DELETE FROM user_guild_membership WHERE user_id = ?`).bind(userId),
    // revokeAllSessionsForUser() above only sets revoked_at, so the rows (and
    // their FK to users) are still here -- delete them for real, or the final
    // DELETE FROM users below fails against that constraint.
    env.DB.prepare(`DELETE FROM sessions WHERE user_id = ?`).bind(userId),
    env.DB.prepare(`DELETE FROM users WHERE id = ?`).bind(userId),
  ]);
}

// Intersects the caller's live Discord guild list against our allow-list and
// updates the membership cache: allow-listed guilds they're currently in are
// marked is_member=1, previously-cached memberships they're no longer in
// (left the server, or it dropped off the allow-list) are marked is_member=0.
export async function syncGuildMembership(
  env: Env,
  userId: string,
  discordGuildIds: string[],
): Promise<void> {
  const now = Date.now();

  // Discord returns up to 200 guilds for one account, past D1's per-statement
  // parameter ceiling, so the intersection against the allow-list is chunked.
  const currentlyMemberOf: string[] = [];
  for (const chunk of chunkIds(discordGuildIds)) {
    const { results } = await env.DB.prepare(
      `SELECT id FROM guilds WHERE is_active = 1 AND id IN (${placeholders(chunk.length)})`,
    )
      .bind(...chunk)
      .all<{ id: string }>();
    currentlyMemberOf.push(...results.map((r) => r.id));
  }

  // Which cached memberships need clearing is computed here rather than with a
  // `NOT IN (...)` list: NOT IN can't be chunked (each chunk would clear every
  // row absent from *that* chunk, including ones present in another), and the
  // list is user-influenced in size. Reading the current rows and diffing in
  // memory turns it back into a chunkable positive IN list.
  const { results: cachedRows } = await env.DB.prepare(
    `SELECT guild_id FROM user_guild_membership WHERE user_id = ? AND is_member = 1`,
  )
    .bind(userId)
    .all<{ guild_id: string }>();

  const stillMember = new Set(currentlyMemberOf);
  const noLongerMember = cachedRows.map((r) => r.guild_id).filter((id) => !stillMember.has(id));

  const statements = currentlyMemberOf.map((guildId) =>
    env.DB.prepare(
      `INSERT INTO user_guild_membership (user_id, guild_id, is_member, verified_at)
       VALUES (?, ?, 1, ?)
       ON CONFLICT(user_id, guild_id) DO UPDATE SET is_member = 1, verified_at = excluded.verified_at`,
    ).bind(userId, guildId, now),
  );

  for (const chunk of chunkIds(noLongerMember, 2)) {
    statements.push(
      env.DB.prepare(
        `UPDATE user_guild_membership SET is_member = 0, verified_at = ?
         WHERE user_id = ? AND guild_id IN (${placeholders(chunk.length)})`,
      ).bind(now, userId, ...chunk),
    );
  }

  if (statements.length > 0) await env.DB.batch(statements);
}

interface StaleMembershipRow {
  user_id: string;
  guild_id: string;
  verified_at: number;
}

// `WHERE (a, b) IN (VALUES (?,?), (?,?), ...)` -- SQLite's row-value IN,
// supported since 3.15. This is what lets many (user_id, guild_id) pairs be
// updated in one statement despite the table's key being composite, so a
// bulk revalidation result isn't forced back into one UPDATE per row.
function rowValuesPlaceholder(n: number): string {
  return new Array(n).fill('(?,?)').join(',');
}

// Background revalidation, driven by the cron sweep. Interactive requests
// refresh their *own* membership on the way through, but the notification
// jobs have no such trigger: they DM people who may not have opened the app
// in weeks, and they can't afford a live Discord call per recipient per tick.
// This keeps the cache fresh for everyone from one bounded batch instead, so
// the cron recipient queries can safely filter on verified_at alone.
//
// The live Discord checks still happen one at a time (they're outbound
// fetches, not D1 queries, so they don't count against the invocation
// budget), but the results are collected and written back in a small,
// fixed number of set-based statements instead of one D1 UPDATE per row --
// at the previous one-row-per-statement rate, 50 confirmed rows in a single
// tick was already 51 D1 queries on its own, before any other cron work ran.
//
// Returns how many rows it revalidated, for the caller to log.
export interface MembershipCheckBudget {
  tryMembershipCheck(): boolean;
}

export async function revalidateStaleMemberships(
  env: Env,
  limit: number,
  budget?: MembershipCheckBudget,
): Promise<number> {
  const cutoff = Date.now() - MEMBERSHIP_FRESHNESS_MS;
  const { results } = await env.DB.prepare(
    `SELECT m.user_id, m.guild_id, m.verified_at FROM user_guild_membership m
     JOIN guilds g ON g.id = m.guild_id
     WHERE m.is_member = 1 AND g.is_active = 1 AND m.verified_at < ?
     ORDER BY m.verified_at ASC
     LIMIT ?`,
  )
    .bind(cutoff, limit)
    .all<StaleMembershipRow>();

  const confirmed: [string, string][] = [];
  const departed: [string, string][] = [];
  let checked = 0;

  for (const row of results) {
    // Each check is an outbound Discord call, and the tick has a finite
    // allowance shared with the DM sends that follow. Refreshing the cache
    // matters, but not more than actually delivering the notifications that
    // cache exists to serve -- so this yields rather than spending the whole
    // budget before the first DM. The rows it skips are simply still stale
    // next tick, which is what the grace window already accounts for.
    if (budget && !budget.tryMembershipCheck()) break;

    const status = await checkGuildMembership(env.DISCORD_BOT_TOKEN, row.guild_id, row.user_id);
    if (status === 'member') {
      confirmed.push([row.user_id, row.guild_id]);
    } else if (status === 'not_member') {
      departed.push([row.user_id, row.guild_id]);
    } else if (status === 'bot_unauthorized') {
      // Every subsequent check this tick would fail the same way, and each
      // one costs a round trip. Stop and let the next tick retry.
      break;
    }
    checked++;
  }

  const now = Date.now();
  const statements: D1PreparedStatement[] = [];
  for (const chunk of chunkRows(confirmed, 2, 1)) {
    statements.push(
      env.DB.prepare(
        `UPDATE user_guild_membership SET verified_at = ? WHERE (user_id, guild_id) IN (VALUES ${rowValuesPlaceholder(chunk.length)})`,
      ).bind(now, ...chunk.flat()),
    );
  }
  for (const chunk of chunkRows(departed, 2, 1)) {
    statements.push(
      env.DB.prepare(
        `UPDATE user_guild_membership SET is_member = 0, verified_at = ? WHERE (user_id, guild_id) IN (VALUES ${rowValuesPlaceholder(chunk.length)})`,
      ).bind(now, ...chunk.flat()),
    );
  }
  if (statements.length > 0) await env.DB.batch(statements);

  return checked;
}
