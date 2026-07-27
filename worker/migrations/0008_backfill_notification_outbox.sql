-- One-time backfill for the rows that predate 0007's delivered_at/failed_at
-- columns. NULL in both meant "still pending" under the new retry logic in
-- notifyOnce -- correct for anything created from now on, but wrong for
-- historical rows, where NULL only meant "we had no column to record the
-- outcome in yet," not "never delivered." Those rows were written by the old
-- fire-and-forget code, which assumed success the moment it inserted the
-- dedupe row -- this backfill restores that same assumption so they don't
-- get silently retried (and re-sent to the recipient) on the next cron tick.
--
-- Bounded to rows over 30 minutes old (at the moment this migration actually
-- runs) rather than every NULL/NULL row: a notification genuinely mid-retry
-- right now (a real transient Discord failure awaiting the next cron tick)
-- also reads as NULL/NULL, and backfilling *that* would wrongly mark it
-- delivered and swallow it. Anything already 30+ minutes old is unambiguous.
UPDATE notification_log
SET delivered_at = sent_at
WHERE delivered_at IS NULL
  AND failed_at IS NULL
  AND sent_at < (CAST(strftime('%s', 'now') AS INTEGER) * 1000 - 1800000);
