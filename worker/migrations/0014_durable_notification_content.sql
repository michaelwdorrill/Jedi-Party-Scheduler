-- Pass 10 review, F-04-H2: a retryable notification (Discord 429/5xx sets
-- next_attempt_at and clears the lease) was only ever re-attempted if an
-- upstream source sweep re-selected the same event/poll/group. Every one of
-- those source queries is windowed -- "starts in the next hour", "deadline in
-- the next day" -- so an event that has since started, or a poll whose
-- deadline has passed, stops matching before its retry becomes due. The
-- outbox row sits there with a real `next_attempt_at` that nothing will ever
-- read again: not lost bookkeeping, just unreachable.
--
-- The fix is a second, source-independent consumer that scans
-- notification_log/group_nudge_log directly by `next_attempt_at`, the same
-- way the reap sweep already scans them by `attempt_count`. That consumer
-- doesn't have access to whatever event/poll/group state the *first* attempt
-- used to render the DM's text, because it deliberately never re-derives that
-- state -- re-deriving it is exactly what "ask the source sweep" means, and
-- the source may no longer offer an answer (the poll resolved differently by
-- now, the occurrence is in the past). So the rendered text is captured once,
-- on the attempt that already has it, and carried forward.
ALTER TABLE notification_log ADD COLUMN content TEXT;
ALTER TABLE group_nudge_log ADD COLUMN content TEXT;
