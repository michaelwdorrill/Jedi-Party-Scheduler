-- specs/0014 stage 3: multi-winner fan-out and the minimum-attendees
-- cancellation cascade (decision 4).
--
-- Four additive columns on events, no rebuild needed -- unlike
-- notification_type below, none of these carries a CHECK constraint, so a
-- plain ALTER TABLE ADD COLUMN is enough (same as 0005's voice_channel_id,
-- 0012's poll_resolution_failures, 0013's revision).
--
-- minimum_attendees / auto_cancel_below_minimum: optional, organizer-set.
-- NULL minimum_attendees means "no minimum" -- the cascade never runs for an
-- event that never opted in. auto_cancel_below_minimum defaults to 0
-- (organizer decides) rather than 1, per decision 4's own reasoning: nobody
-- gets "everyone else's evening ended" by accident just by setting a number.
--
-- created_from_poll_id / created_from_option_id: provenance for a fanned-out
-- event, so the app can show "this came from that poll" and, together with
-- the partial unique index below, make fan-out idempotent -- the sweep that
-- creates these deliberately re-scans every confirmed option rather than
-- tracking "already handled" itself, the same shape sweepConfirmedMultiWinnerOptions
-- already used. A second attempt at the same option is a constraint
-- violation the creating statement is written to tolerate, not a duplicate
-- event.
ALTER TABLE events ADD COLUMN minimum_attendees INTEGER;
ALTER TABLE events ADD COLUMN auto_cancel_below_minimum INTEGER NOT NULL DEFAULT 0;
ALTER TABLE events ADD COLUMN created_from_poll_id TEXT REFERENCES events(id);
ALTER TABLE events ADD COLUMN created_from_option_id TEXT REFERENCES event_poll_options(id);

-- Partial rather than a plain UNIQUE column: every ordinary event (created
-- the normal way) has created_from_option_id = NULL, and a plain unique
-- index would allow at most one such event ever.
CREATE UNIQUE INDEX idx_events_created_from_option
  ON events(created_from_option_id)
  WHERE created_from_option_id IS NOT NULL;

-- notification_log.notification_type does carry a CHECK, so widening it
-- needs the lossless copy pattern 0021/0026 established, not a plain ALTER.
-- Two new values: organizer_cancel_prompt (a one-shot "cancel this session?"
-- DM to the organizer when attendance drops below the minimum and
-- auto-cancel is off) and event_cancelled_below_minimum (the notice to
-- everyone still marked as coming once the cascade actually cancels it,
-- automatically or by the organizer's own press).
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
    'organizer_cancel_prompt','event_cancelled_below_minimum'
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

-- Re-declared explicitly, same discipline as 0026 -- rebuilding a table in
-- SQLite drops its indexes.
CREATE INDEX idx_notification_log_pending
  ON notification_log(next_attempt_at)
  WHERE delivered_at IS NULL AND failed_at IS NULL;
