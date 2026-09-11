-- Pass-15 security review (P15-08), which is P13-11 / P14-12 under its third
-- number: accepting a change request and applying it are two writes, and
-- nothing records whether the second one happened.
--
-- `applyAndAccept` claims the decision -- moves the request from 'pending' to
-- 'accepted' -- and then mutates the event, with a compensating release if the
-- mutation throws. If the isolate dies between those two writes, or the apply
-- AND its release both fail, the request reads 'accepted' over an event that
-- never moved. The resolver will not pick it up again, because it is no longer
-- 'pending'. What makes that worse than a stuck row is the notice: the
-- decision arm DMs the requester "accepted", so they plan around a time the
-- invitees never saw, and it surfaces as a no-show rather than an error.
--
-- IDEAS item 70 recorded two candidate fixes and this is neither of them. An
-- 'applying' status cannot be added without a full table rebuild, because the
-- status column carries a CHECK constraint; threading a compare-and-set into
-- `updateEvent`'s batch means surgery in the one write path every event edit
-- goes through. This column is the third option, from the Pass-15 review:
-- DETECTION rather than a new state.
--
--   * The apply path stamps `applied_at` once the change has landed.
--   * The resolver gains a recovery arm for rows that are 'accepted' with
--     `applied_at IS NULL` and have been that way for longer than any healthy
--     window, and re-runs the apply -- which is idempotent, because the
--     override write is an upsert and `updateEvent` is revision-guarded.
--   * The decision notice only fires for an accepted request once
--     `applied_at` is set, so "accepted" is never announced for a change that
--     has not happened.
--
-- Nullable, no CHECK, no rebuild.
ALTER TABLE event_change_requests ADD COLUMN applied_at INTEGER;

-- Backfill is load-bearing, not tidiness. Without it every request accepted
-- before this migration reads as "accepted but never applied" on the first
-- tick after deploy, and the recovery arm re-applies all of them -- moving
-- events that have long since been moved, or declining them as stale. Rows
-- accepted before this column existed were applied by the code path that had
-- no other outcome, so their decision time is the honest stamp.
UPDATE event_change_requests SET applied_at = decided_at WHERE status = 'accepted' AND applied_at IS NULL;

-- The recovery arm's predicate, which runs on every resolver tick and must not
-- scan the table. Partial, so the index holds only the rows that can ever
-- match -- in a healthy database, none.
CREATE INDEX idx_change_requests_unapplied
  ON event_change_requests(decided_at)
  WHERE status = 'accepted' AND applied_at IS NULL;
