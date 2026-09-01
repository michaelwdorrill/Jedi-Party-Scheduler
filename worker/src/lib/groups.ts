import type { Env } from '../env';
import { ValidationError } from './validate';

// Group ownership (IDEAS.md item 16).
//
// `groups.created_by` is the owner, and the owner is the only person who may
// change the roster, rename or delete. That makes "the owner left the group"
// a state the app has to have an answer for -- before this, it either
// couldn't happen (the creator was never a member to begin with, which was
// the bug) or would have left a group nobody could administer.

export interface GroupOwnershipRow {
  id: string;
  guild_id: string;
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
