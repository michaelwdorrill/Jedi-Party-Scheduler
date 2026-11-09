-- The 1.0 launch announcement (9 Nov 2026). LAUNCH-ONLY: removed in 1.1 --
-- see docs/IDEAS.md item 105 for what comes out and what stays.
--
-- Two halves, one per surface:
--
-- 1. announcement_log: the one-off DM to everyone, through the same leased
--    outbox every other DM uses (lib/outbox.ts), so it is sent at most once
--    per person, retried on failure, and paced by the cron's budget. Shape
--    copied from account_purge_warnings (migration 0028): a user-scoped DM with
--    no event, keyed on which announcement it was.
-- 2. users.announcement_seen: the id of the last announcement this person was
--    shown the in-app pop-up for. Per account rather than per browser, so it
--    appears once on whichever device they sign in from first.
CREATE TABLE announcement_log (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  announcement_id TEXT NOT NULL,
  sent_at INTEGER NOT NULL,
  delivered_at INTEGER,
  failed_at INTEGER,
  claim_token TEXT,
  claimed_until INTEGER,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER,
  -- Every outbox table needs this: claim() writes it on every claim.
  content TEXT,
  UNIQUE(user_id, announcement_id)
);

CREATE INDEX idx_announcement_log_user ON announcement_log(user_id);

ALTER TABLE users ADD COLUMN announcement_seen TEXT;
