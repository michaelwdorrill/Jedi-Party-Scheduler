-- IDEAS item 54: the T-24h-before-deadline heads-up DM to the organizer,
-- when an occurrence (or a non-recurring event) is still below its minimum
-- with a day left before the deadline decides it one way or the other.
--
-- Same lossless-copy shape as 0021/0026/0027/0030/0032.
CREATE TABLE notification_log_new (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  notification_type TEXT NOT NULL CHECK (notification_type IN (
    'invite','reminder_24h','reminder_1h','poll_resolved','poll_deadline_reminder','voice_channel_invite',
    'ladder_unanswered_96h','ladder_unanswered_48h',
    'ladder_maybe_72h','ladder_maybe_24h',
    'ladder_accepted_24h','ladder_accepted_1h',
    'ladder_window_outside_hours',
    'organizer_cancel_prompt','event_cancelled_below_minimum',
    'event_cancelled',
    'group_venue_drift',
    'minimum_attendees_deadline_warning'
  )),
  occurrence_date TEXT NOT NULL DEFAULT '',
  sent_at INTEGER NOT NULL,
  delivered_at INTEGER,
  failed_at INTEGER,
  claim_token TEXT,
  claimed_until INTEGER,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER,
  content TEXT,
  message_id TEXT,
  components TEXT,
  message_edited_at INTEGER,
  UNIQUE(user_id, event_id, notification_type, occurrence_date)
);

INSERT INTO notification_log_new
SELECT id, user_id, event_id, notification_type, occurrence_date, sent_at,
       delivered_at, failed_at, claim_token, claimed_until, attempt_count,
       next_attempt_at, content, message_id, components, message_edited_at
  FROM notification_log;

DROP TABLE notification_log;
ALTER TABLE notification_log_new RENAME TO notification_log;

CREATE INDEX idx_notification_log_pending
  ON notification_log(next_attempt_at)
  WHERE delivered_at IS NULL AND failed_at IS NULL;
