-- Notification outbox (security review F-12). Previously `sent_at` was set
-- the instant the dedupe row was inserted, before Discord was even asked to
-- deliver anything -- a transient failure permanently looked "sent" and was
-- never retried. `sent_at` now means "first attempted"; these two new
-- columns carry the real outcome: delivered_at is set only after Discord
-- confirms success, failed_at is set only for a permanent (non-retryable)
-- failure. Both NULL means still pending/retryable.
ALTER TABLE notification_log ADD COLUMN delivered_at INTEGER;
ALTER TABLE notification_log ADD COLUMN failed_at INTEGER;
