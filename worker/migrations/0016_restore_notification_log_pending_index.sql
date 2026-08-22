-- Restores the partial index migration 0009 created on notification_log.
--
-- 0009 created `idx_notification_log_pending`, and it exists in the sandbox
-- and in any clean replay of these migrations. It does *not* exist in
-- production, and the reason is recorded in SETUP.md: migration 0005's
-- rebuild of notification_log had to be redone by hand against production
-- as a rename-copy-drop, and rebuilding a table in SQLite drops the indexes
-- that were attached to it. 0009 then ran against the rebuilt table and
-- created the index -- but the hand-repair happened *after*, so the index
-- went away again and nothing has recreated it since.
--
-- The consequence is a performance one, not a correctness one: the sweeps
-- that look for pending, due notifications (see the source-independent
-- retry consumers in cron/reminders.ts) fall back to scanning the whole
-- log, which grows monotonically. Worth fixing before it's large.
--
-- IF NOT EXISTS because this is a no-op everywhere the index survived --
-- a clean database, and the sandbox -- and only does work in production.
-- That also keeps a replay of these migrations byte-identical to what it
-- produced before, which is what scripts/verify-schema.mjs compares
-- against.
CREATE INDEX IF NOT EXISTS idx_notification_log_pending
  ON notification_log(next_attempt_at)
  WHERE delivered_at IS NULL AND failed_at IS NULL;
