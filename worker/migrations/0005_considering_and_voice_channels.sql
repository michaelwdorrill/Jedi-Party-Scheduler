-- Personal events gain a third state: 'considering' means "not committed,
-- could still play" -- unlike 'busy', it must NOT block the free/busy view,
-- since the whole point is that this time slot is still open to others.
ALTER TABLE personal_events ADD COLUMN availability TEXT NOT NULL DEFAULT 'busy'
  CHECK (availability IN ('busy','considering','free'));
UPDATE personal_events SET availability = CASE WHEN busy = 1 THEN 'busy' ELSE 'free' END;
ALTER TABLE personal_events DROP COLUMN busy;

-- Optional voice channel tied to an event. Populated from a dropdown of the
-- guild's actual voice channels (fetched live via the bot token), with the
-- name cached alongside the id purely so the UI can display it without an
-- extra round trip.
ALTER TABLE events ADD COLUMN voice_channel_id TEXT;
ALTER TABLE events ADD COLUMN voice_channel_name TEXT;

-- Recreated (not altered) to add 'voice_channel_invite' -- SQLite can't modify
-- an existing CHECK constraint via ALTER TABLE. Same tradeoff as migration
-- 0003: this is a pure dedupe log, so losing its rows here risks a handful of
-- duplicate notifications right at the boundary, not any real data loss.
DROP TABLE notification_log;
CREATE TABLE notification_log (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  notification_type TEXT NOT NULL CHECK (notification_type IN ('invite','reminder_24h','reminder_1h','poll_resolved','poll_deadline_reminder','voice_channel_invite')),
  occurrence_date TEXT NOT NULL DEFAULT '',
  sent_at INTEGER NOT NULL,
  UNIQUE(user_id, event_id, notification_type, occurrence_date)
);
