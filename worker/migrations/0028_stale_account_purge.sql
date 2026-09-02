-- IDEAS item 10 / docs/specs/0016: warn, then purge, an account that hasn't
-- logged in for a year.
--
-- Same leased-outbox shape as group_nudge_log (migration 0009): a user-scoped
-- notification with no event_id, so it can't live in notification_log. The
-- "episode" key is last_login_at rather than group_nudge_log's last_event_at,
-- for the identical reason -- if the person logs back in, last_login_at moves,
-- this becomes a new episode, and the old warning rows are simply never
-- looked at again (they can never become due, since the account that earned
-- them is no longer stale).
CREATE TABLE account_purge_warnings (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  last_login_at INTEGER NOT NULL,
  warning_type TEXT NOT NULL CHECK (warning_type IN ('stale_2wk', 'stale_1wk')),
  sent_at INTEGER NOT NULL,
  delivered_at INTEGER,
  failed_at INTEGER,
  claim_token TEXT,
  claimed_until INTEGER,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER,
  -- Every outbox table needs this: claim() in lib/outbox.ts writes `content`
  -- unconditionally on every claim (migration 0014), independent of
  -- TABLES_WITH_MESSAGE_COLUMNS, which only gates the separate `components`
  -- column notification_log alone carries.
  content TEXT,
  UNIQUE(user_id, last_login_at, warning_type)
);

CREATE INDEX idx_account_purge_warnings_user ON account_purge_warnings(user_id);
