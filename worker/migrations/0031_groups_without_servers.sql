-- specs/0011 / IDEAS item 36: a group stops belonging to one server and
-- becomes a list of people, valid only while there is at least one server
-- containing every member (the intersection rule -- see the spec for why it
-- was chosen over the cheaper "adder-anchored" and "pairwise" alternatives).
--
-- The backfill is a no-op, and that is the spec's own point: every existing
-- group's members are all in that group's one guild today, by construction,
-- so every existing group already satisfies the intersection rule with at
-- least that guild in its set. Nothing to migrate, only a column to drop.
DROP INDEX idx_groups_guild;
ALTER TABLE groups DROP COLUMN guild_id;
