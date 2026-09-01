-- specs/0014 stage 2: the reminder ladder needs one notification_type per
-- (answer-status, hours-before-start) rung, plus a one-shot notice for the
-- window-poll "outside your hours" state (a submission that doesn't cover
-- the resolved span).
--
-- New names throughout, none reusing reminder_24h/reminder_1h. Those two
-- stay live and unrelated: sweepConfirmedMultiWinnerOptions still fires them
-- for a confirmed multi-winner day's reminder, which has no per-occurrence
-- attendance until stage 3's fan-out. Reusing them for the ladder's accepted
-- rungs would also let a row written by the old status-blind sweep *before*
-- this release silently satisfy the dedupe check for someone's first real
-- ladder send, since that row means nothing about their actual status.
--
-- Unlike migrations 0003 and 0005's DROP-and-recreate of this table, this is
-- a lossless copy, matching migration 0021's pattern. Back then this table
-- was a pure dedupe log, so losing a few rows at the boundary cost at most a
-- handful of duplicate sends. It is no longer that: it carries the delivery
-- lease (claim_token/claimed_until/attempt_count/next_attempt_at, 0009), the
-- durable retry content and components a retry redelivers verbatim (0014,
-- 0023), and the message-edit bookkeeping edit-on-resolve depends on (0022,
-- 0024). Dropping it would mark every already-delivered notification on
-- every live event "never sent," and the next tick would re-invite and
-- re-remind an install's entire backlog -- compounding the throughput spike
-- decision 5 already accepts from the event_attendance wipe with a second,
-- larger one from this table.
--
-- Every index is re-declared explicitly afterward: rebuilding a table in
-- SQLite drops the indexes attached to it, and the one time that was missed
-- by hand against production (see 0016) an index went missing for three
-- releases.
CREATE TABLE notification_log_new (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  notification_type TEXT NOT NULL CHECK (notification_type IN (
    'invite','reminder_24h','reminder_1h','poll_resolved','poll_deadline_reminder','voice_channel_invite',
    'ladder_unanswered_96h','ladder_unanswered_48h',
    'ladder_maybe_72h','ladder_maybe_24h',
    'ladder_accepted_24h','ladder_accepted_1h',
    'ladder_window_outside_hours'
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

-- 0009 created this index, 0016 restored it after a prior hand-rebuild
-- dropped it silently -- the exact mistake the comment above exists to not
-- repeat.
CREATE INDEX idx_notification_log_pending
  ON notification_log(next_attempt_at)
  WHERE delivered_at IS NULL AND failed_at IS NULL;
