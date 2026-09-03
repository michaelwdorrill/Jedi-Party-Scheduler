-- New idea captured alongside IDEAS item 54 (Sept 2026): the organizer hears
-- about every invitee's RSVP, for every event they organize -- not just
-- minimum-attendees ones. Its own outbox table, same lease shape as
-- group_nudge_log/change_request_log (0009's lease columns, 0014's content),
-- because notification_log's dedupe key (user_id, event_id, notification_type,
-- occurrence_date) has no room for *which invitee* answered: two different
-- invitees responding to the same event on the same occurrence would collide
-- and the second would be silently dropped as "already notified."
--
-- responded_at is part of the UNIQUE key rather than just carried data, the
-- same way group_nudge_log's last_event_at is: it's what makes a second,
-- different answer from the same person a new notification rather than a
-- no-op against an already-delivered row.
CREATE TABLE organizer_rsvp_notice_log (
  id TEXT PRIMARY KEY,
  organizer_id TEXT NOT NULL REFERENCES users(id),
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  occurrence_date TEXT NOT NULL,
  responder_id TEXT NOT NULL REFERENCES users(id),
  responded_at INTEGER NOT NULL,
  sent_at INTEGER NOT NULL,
  delivered_at INTEGER,
  failed_at INTEGER,
  claim_token TEXT,
  claimed_until INTEGER,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER,
  content TEXT,
  UNIQUE(organizer_id, event_id, occurrence_date, responder_id, responded_at)
);

CREATE INDEX idx_organizer_rsvp_notice_log_pending
  ON organizer_rsvp_notice_log(next_attempt_at)
  WHERE delivered_at IS NULL AND failed_at IS NULL;
