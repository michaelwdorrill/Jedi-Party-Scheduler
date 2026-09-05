-- IDEAS item 55: DELETE /:eventId (routes/events.ts) has only ever flipped
-- events.status to 'cancelled' -- no DM to anyone, since v0.1. specs/0014
-- stage 3 gave sweepCancellationCascade its first "this event just got
-- cancelled, tell everyone still coming" notice, but scoped narrowly to
-- events.minimum_attendees IS NOT NULL, since both paths that release added
-- (the auto-cancel write, the organizer's own cancel-prompt button) only
-- ever apply to an event that opted into a minimum. This widens the same
-- sweep to any organizer cancellation of a non-recurring event, which needs
-- its own notification_type: 'event_cancelled_below_minimum' says *why*
-- (attendance dropped below what the organizer required); a plain cancel
-- has no such reason to give, so it gets its own wording rather than a
-- misleading reuse of that message.
--
-- Same lossless-copy shape as 0021/0026/0027 -- notification_type carries a
-- CHECK, so widening it needs a full rebuild, not a plain ALTER. Every index
-- is re-declared explicitly afterward: rebuilding a table in SQLite drops
-- its indexes (migration 0016's lesson).
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
    'event_cancelled'
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
