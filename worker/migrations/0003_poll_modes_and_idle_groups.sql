-- Configurable "group went idle" reminder window, per group.
ALTER TABLE groups ADD COLUMN idle_reminder_days INTEGER NOT NULL DEFAULT 2;

-- Dedupe for idle-group nudges. Not tied to a single event (unlike everything
-- in notification_log), so it needs its own table -- keyed on the group's
-- last-known event time so a nudge fires once per idle episode, not every
-- 15-minute tick, and fires again if the group goes idle a second time.
CREATE TABLE group_activity_nudges (
  group_id TEXT PRIMARY KEY REFERENCES groups(id) ON DELETE CASCADE,
  last_event_at INTEGER NOT NULL,
  notified_at INTEGER NOT NULL
);

-- poll_mode: 'options' (existing discrete-slot polls) or 'window' (propose a
-- span of time + a required block length; attendees submit the sub-range
-- they can commit to, and the server finds the best-overlapping block).
ALTER TABLE events ADD COLUMN poll_mode TEXT NOT NULL DEFAULT 'options' CHECK (poll_mode IN ('options','window'));

-- poll_resolution_mode: 'single_winner' (existing behavior -- exactly one
-- option/block wins and the event resolves) or 'multi_winner' (options mode
-- only: every candidate day that independently reaches the threshold becomes
-- its own confirmed session; the event itself never "resolves" as a whole).
ALTER TABLE events ADD COLUMN poll_resolution_mode TEXT NOT NULL DEFAULT 'single_winner' CHECK (poll_resolution_mode IN ('single_winner','multi_winner'));

-- Window-mode proposal: the outer span, and how long a committed block must be.
ALTER TABLE events ADD COLUMN window_start_at INTEGER;
ALTER TABLE events ADD COLUMN window_end_at INTEGER;
ALTER TABLE events ADD COLUMN window_block_minutes INTEGER;

-- Per-option confirmation timestamp, used by multi_winner mode so each
-- option can independently become "its own session" without the parent
-- event ever moving out of 'active'.
ALTER TABLE event_poll_options ADD COLUMN confirmed_at INTEGER;

-- Window-mode: each attendee's single submitted sub-range within the window.
CREATE TABLE event_window_availability (
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id),
  avail_start_at INTEGER NOT NULL,
  avail_end_at INTEGER NOT NULL,
  submitted_at INTEGER NOT NULL,
  PRIMARY KEY (event_id, user_id)
);
CREATE INDEX idx_window_avail_event ON event_window_availability(event_id);

-- Recreated (not altered) to add 'poll_deadline_reminder' -- SQLite can't
-- modify an existing CHECK constraint via ALTER TABLE. This table is purely
-- an operational dedupe log, so losing its rows across the migration just
-- risks a handful of duplicate notifications right at the boundary, not any
-- real data loss.
DROP TABLE notification_log;
CREATE TABLE notification_log (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  notification_type TEXT NOT NULL CHECK (notification_type IN ('invite','reminder_24h','reminder_1h','poll_resolved','poll_deadline_reminder')),
  -- For multi_winner mode, poll_resolved notifications reuse this column
  -- (holding the option_id) to dedupe per-option instead of per-event.
  occurrence_date TEXT NOT NULL DEFAULT '',
  sent_at INTEGER NOT NULL,
  UNIQUE(user_id, event_id, notification_type, occurrence_date)
);
