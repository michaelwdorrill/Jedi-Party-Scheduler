-- specs/0017 v2: the Google read-calendar pull now imports real personal-time
-- entries (title, description, time) instead of caching opaque busy
-- intervals. Decided (Michael, Sept 2026), after 0.8.1 sandbox verification
-- found the previous mechanism (freebusy.query) silently excluded any event
-- Google itself considers "Free" -- an all-day event defaults to that the
-- moment it's created, with no parameter to override it. Every event on the
-- chosen calendar now counts as busy, Google's own per-event flag
-- notwithstanding; the choice of *which calendar* is the privacy control this
-- feature offers, not a second filter layered on top of it.
--
-- google_event_id ties an imported row back to the Google event it mirrors.
-- NULL for every hand-created personal event -- which is all of them before
-- this migration, and the overwhelming majority after it. The unique index
-- on (user_id, google_event_id) is what makes the sync idempotent: syncing
-- the same window twice upserts the same rows rather than duplicating them.
-- SQLite does not enforce uniqueness between NULLs, so hand-created rows
-- (google_event_id always NULL) never collide with each other or with this
-- constraint.
ALTER TABLE personal_events ADD COLUMN google_event_id TEXT;
CREATE UNIQUE INDEX idx_personal_events_google ON personal_events(user_id, google_event_id);

-- The opaque-cache mechanism this replaces. Nothing reads these columns once
-- the new sync ships; dropped rather than left dead, so a reader six months
-- from now never has to work out whether a value still means anything.
ALTER TABLE google_calendar_connections DROP COLUMN busy_blocks;
ALTER TABLE google_calendar_connections DROP COLUMN busy_cached_at;
ALTER TABLE google_calendar_connections DROP COLUMN busy_window_end_at;
