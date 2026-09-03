-- Empties the sandbox of everything schedule-shaped, so the bot stops DMing.
--
-- **This deletes all events, polls, personal time and groups.** It is only
-- ever pointed at the sandbox database (see the npm script, which passes
-- --env sandbox and the sandbox database name explicitly), and the sandbox
-- exists to be thrown away. Do not repurpose it against production.
--
-- What it keeps, deliberately: users, guilds, membership and sessions. You
-- stay logged in, your servers stay allow-listed, and the seed users survive
-- so the demo fixtures can be re-run without starting from scratch.
--
-- Order is not cosmetic. Two things would fail if this ran top-to-bottom in
-- the obvious order:
--
--   * `group_nudge_log` references `groups` with NO cascade -- the exact
--     foreign-key wall item 38 hit, which came back as a bare
--     "FOREIGN KEY constraint failed" naming nothing. Its rows go first.
--   * Almost everything hanging off `events` *does* cascade, so deleting
--     events alone would take invites, poll options, votes, window
--     availability, recurrence rules, overrides, change requests and the
--     notification log with it. Those deletes are still written out, because
--     a script that silently depends on cascade behaviour is a script that
--     breaks quietly the day a table is rebuilt without it (see migration
--     0016, where exactly that happened to an index).
--
-- Usage: npm run clean:sandbox

-- 1. The outbox logs, before the rows they point at.
DELETE FROM group_nudge_log;
DELETE FROM change_request_log;
DELETE FROM notification_log;

-- 2. Everything that hangs off an event.
--
-- The UPDATE has to come first. specs/0014 stage 3 (migration 0027) added
-- events.created_from_poll_id/created_from_option_id -- a fanned-out event's
-- pointer back to the multi-winner poll and option it came from -- and
-- neither carries ON DELETE CASCADE. created_from_option_id REFERENCES
-- event_poll_options(id), so with this script's original order (options
-- deleted, then events), deleting a poll's options while a still-live
-- fanned-out event still points at one of them is a bare "FOREIGN KEY
-- constraint failed" naming nothing -- exactly item 38's failure mode,
-- from a different column. Nulling both columns on every row first breaks
-- the reference before anything referenced is removed; self-referencing
-- created_from_poll_id needs the same treatment for the same reason.
UPDATE events SET created_from_poll_id = NULL, created_from_option_id = NULL;
DELETE FROM event_change_request_votes;
DELETE FROM event_change_requests;
DELETE FROM event_window_availability;
DELETE FROM event_poll_votes;
DELETE FROM event_poll_options;
DELETE FROM event_attendance;
DELETE FROM event_occurrence_overrides;
DELETE FROM event_recurrence_rules;
DELETE FROM event_invites;
DELETE FROM events;

-- 3. Personal time, which is its own tree.
DELETE FROM personal_event_overrides;
DELETE FROM personal_events;

-- 4. Groups. Deleted rather than left alone, because the idle-group sweep
--    nudges about a group with nothing scheduled -- so clearing the events
--    and keeping the groups is the one combination that makes the DMs
--    *worse* rather than better.
DELETE FROM group_activity_nudges;
DELETE FROM group_members;
DELETE FROM groups;

-- 5. The cron's scan positions, so the next tick starts clean rather than
--    resuming from a keyset cursor pointing at a row that no longer exists.
DELETE FROM cron_cursors;
