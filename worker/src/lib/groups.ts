import type { Env } from '../env';
import { MEMBERSHIP_GRACE_MS } from './db';
import { ValidationError } from './validate';

export interface CommonServer {
  id: string;
  name: string;
}

// specs/0011 / IDEAS item 36: a group is a list of people, valid while there
// exists at least one server every member is currently in. This is the
// whole mechanism -- one GROUP BY, not the O(n^2) pairwise check that would
// otherwise be needed, and it degrades gracefully: an empty roster or a
// roster with no shared server both just return no servers, rather than
// throwing, so callers decide what "no venue" means for them (a validation
// error on write, a "no common server" state on read).
//
// verified_at >= the same MEMBERSHIP_GRACE_MS bound the calendar and the
// cron's recipient queries use, rather than a live Discord call per
// candidate server -- consistent with every other read-side membership
// check in this codebase (listFriends, /me/groups). The spec notes that
// staleness is actually *cheaper* to tolerate here than for a single fixed
// guild (a candidate venue can be answered from whichever rows are fresh),
// but this does not chase that optimization: it is a nice property of the
// query, not a requirement to implement live revalidation for.
export async function commonServerSet(env: Env, userIds: readonly string[]): Promise<CommonServer[]> {
  if (userIds.length === 0) return [];
  const placeholders = userIds.map(() => '?').join(', ');
  const { results } = await env.DB.prepare(
    `SELECT m.guild_id AS id, g.name AS name
       FROM user_guild_membership m
       JOIN guilds g ON g.id = m.guild_id AND g.is_active = 1
      WHERE m.user_id IN (${placeholders}) AND m.is_member = 1 AND m.verified_at >= ?
      GROUP BY m.guild_id
     HAVING COUNT(DISTINCT m.user_id) = ?
      ORDER BY g.name`,
  )
    .bind(...userIds, Date.now() - MEMBERSHIP_GRACE_MS, userIds.length)
    .all<CommonServer>();
  return results;
}

// Throws with a message fit to show the person who submitted the roster,
// rather than returning a boolean and making every call site write its own
// wording -- every caller (group create, whole-roster PATCH, add-member)
// wants the same refusal.
export async function assertValidRoster(env: Env, userIds: readonly string[]): Promise<void> {
  const servers = await commonServerSet(env, userIds);
  if (servers.length === 0) {
    throw new ValidationError(
      "These people don't all share a server -- a group needs at least one server every member is currently in.",
    );
  }
}

// Group ownership (IDEAS.md item 16).
//
// `groups.created_by` is the owner, and the owner is the only person who may
// change the roster, rename or delete. That makes "the owner left the group"
// a state the app has to have an answer for -- before this, it either
// couldn't happen (the creator was never a member to begin with, which was
// the bug) or would have left a group nobody could administer.

export interface GroupOwnershipRow {
  id: string;
  created_by: string;
}

// Who inherits a group when its owner removes themselves: the member who has
// actually turned up to the most of that group's sessions.
//
// "Turned up" is read as an accepted event_attendance row (specs/0014) on an
// event the group was invited through (`event_invites.source_group_id`),
// joined through the invite for that attribution -- attendance itself
// doesn't carry source_group_id -- which is the only attendance signal the
// schema carries; there's no check-in, and a confirmed poll option's
// yes-voters aren't recorded as attendance either. It's a proxy, but it's the
// right shape: the most engaged member is a better default owner than the
// oldest or the alphabetically-first. This now counts accepted *occurrences*
// rather than accepted *events*, arguably a better reading of "who actually
// showed up" for a recurring group.
//
// Ties break by earliest `added_at` then user id, so the outcome is
// deterministic rather than dependent on row order -- the same reason
// pickMostVotes in lib/polls.ts spells its tiebreaks out.
export async function findSuccessorOwner(
  env: Env,
  groupId: string,
  departingOwnerId: string,
): Promise<string | null> {
  const row = await env.DB.prepare(
    `SELECT gm.user_id
     FROM group_members gm
     LEFT JOIN event_invites ei
       ON ei.user_id = gm.user_id
       AND ei.source_group_id = ?
     LEFT JOIN event_attendance ea
       ON ea.event_id = ei.event_id
       AND ea.user_id = gm.user_id
       AND ea.rsvp_status = 'accepted'
     WHERE gm.group_id = ? AND gm.user_id != ?
     GROUP BY gm.user_id, gm.added_at
     ORDER BY COUNT(ea.id) DESC, gm.added_at ASC, gm.user_id ASC
     LIMIT 1`,
  )
    .bind(groupId, groupId, departingOwnerId)
    .first<{ user_id: string }>();
  return row?.user_id ?? null;
}

// Statements to run when the owner is leaving their own group: hand the group
// to a successor in the same batch as the removal, so there is never a
// committed state where the group exists with an owner who isn't in it.
//
// Returns the statements plus the successor's id. Throws when there is nobody
// left to take it -- deliberately blocking the removal rather than deleting
// the group out from under its members or leaving it unadministerable. The
// owner can still delete the group outright if that's what they meant.
export async function ownerDepartureStatements(
  env: Env,
  group: GroupOwnershipRow,
): Promise<{ statements: D1PreparedStatement[]; successorId: string }> {
  const successorId = await findSuccessorOwner(env, group.id, group.created_by);
  if (!successorId) {
    throw new ValidationError(
      "You're the only member of this group, so there's no one to hand it to -- delete the group instead.",
    );
  }
  return {
    successorId,
    statements: [
      env.DB.prepare(`UPDATE groups SET created_by = ? WHERE id = ? AND created_by = ?`).bind(
        successorId,
        group.id,
        group.created_by,
      ),
      env.DB.prepare(`DELETE FROM group_members WHERE group_id = ? AND user_id = ?`).bind(
        group.id,
        group.created_by,
      ),
    ],
  };
}
