-- A group's creator is a member of their own group (IDEAS.md item 16).
--
-- The gap this closes was found in production: the "Spacebros" idle-group
-- nudge fired correctly but never reached the creator, because they had
-- never been in `group_members` at all. That wasn't one bad save -- it was
-- structural. `group_members` is populated only from the list submitted when
-- a group is created or edited, nothing auto-added `created_by`, and the
-- picker that list came from was backed by `listFriends`, which binds
-- `AND u.id != ?` against the caller (correct for "who can I invite", wrong
-- for "who is in this group"). Only the creator may edit membership, so
-- nobody else could add them either: a closed loop.
--
-- An earlier fix let the creator tick themselves in the picker. This is the
-- other half -- they shouldn't have to remember to.
--
-- Applied retroactively on purpose. The alternative (new groups only) leaves
-- every existing group permanently wrong in a way no one can see, which is
-- exactly the condition that hid the original bug. The visible consequence
-- is that "N members" goes up by one on groups whose creator wasn't already
-- listed; that number was previously understating reality.
--
-- NOT EXISTS rather than INSERT OR IGNORE: group_members' primary key is
-- (group_id, user_id), so a creator who *had* already added themselves is
-- skipped either way, but the explicit predicate says so at a glance and
-- keeps `added_at` on their existing row rather than depending on conflict
-- semantics to preserve it.
INSERT INTO group_members (group_id, user_id, added_at)
SELECT g.id, g.created_by, (CAST(strftime('%s','now') AS INTEGER) * 1000)
FROM groups g
WHERE NOT EXISTS (
  SELECT 1 FROM group_members gm
  WHERE gm.group_id = g.id AND gm.user_id = g.created_by
);
