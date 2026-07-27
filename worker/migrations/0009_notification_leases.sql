-- Turns the notification outbox added in 0007 into a real leased outbox.
--
-- 0007 gave each row an outcome (delivered_at / failed_at) but no notion of
-- *ownership* of an in-flight attempt: two overlapping cron ticks could both
-- see the same pending row, both win their compare-and-set, and both send the
-- same DM. These columns add the missing lease, plus the retry bookkeeping
-- that lets a transient failure be retried with backoff instead of either
-- being dropped or hammered every 15 minutes forever.
--
--   claim_token      identifies which invocation currently owns the attempt.
--                    The claimant writes it, then reads it back; if what comes
--                    back isn't its own token, another invocation won the race
--                    and this one backs off without sending.
--   claimed_until    when that ownership expires, so a worker that dies
--                    mid-send doesn't strand the row as permanently claimed.
--   attempt_count    how many delivery attempts have been made, for backoff
--                    and for giving up after a bounded number of tries.
--   next_attempt_at  earliest time the row may be claimed again. NULL means
--                    "eligible now".
ALTER TABLE notification_log ADD COLUMN claim_token TEXT;
ALTER TABLE notification_log ADD COLUMN claimed_until INTEGER;
ALTER TABLE notification_log ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE notification_log ADD COLUMN next_attempt_at INTEGER;

-- Existing rows predate attempt tracking. Anything already delivered or
-- failed is terminal and never looked at again, so only the pending ones
-- matter: give them a single recorded attempt so the retry budget below
-- treats them like a first try that hasn't come back yet, rather than like a
-- row that has never been attempted at all.
UPDATE notification_log
SET attempt_count = 1
WHERE delivered_at IS NULL AND failed_at IS NULL;

-- Idle-group nudges could not use notification_log: its event_id column is a
-- foreign key into events, and a nudge is about a group with no event. They
-- therefore bypassed the outbox entirely -- delivery was assumed, and the
-- "already nudged" marker was written whether or not Discord accepted the
-- message, so a rate-limited or 5xx nudge was silently lost. This table gives
-- them the same lease/retry semantics, keyed per member per idle episode.
CREATE TABLE group_nudge_log (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES groups(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  -- The idle episode this nudge belongs to, mirroring
  -- group_activity_nudges.last_event_at: a group that goes idle again after a
  -- new event is a new episode and gets a new nudge.
  last_event_at INTEGER NOT NULL,
  sent_at INTEGER NOT NULL,
  delivered_at INTEGER,
  failed_at INTEGER,
  claim_token TEXT,
  claimed_until INTEGER,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER,
  UNIQUE(group_id, user_id, last_event_at)
);

CREATE INDEX idx_group_nudge_log_user ON group_nudge_log(user_id);

-- The sweeps look for rows that are still pending and due for another try;
-- without this they scan the whole log every tick as it accumulates.
CREATE INDEX idx_notification_log_pending
  ON notification_log(next_attempt_at)
  WHERE delivered_at IS NULL AND failed_at IS NULL;
