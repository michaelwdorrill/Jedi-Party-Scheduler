-- specs/0014: attendance becomes per-occurrence rather than per-event.
-- event_invites.rsvp_status answered "are you coming to this event," which
-- had no way to express "coming to the 10/14 session but not the 10/21 one"
-- for a recurring series. This table gives every (event, occurrence) pair
-- its own answer, the same way event_occurrence_overrides and
-- notification_log already are keyed.
--
-- occurrence_date is '' for a non-recurring event -- not NULL, matching the
-- convention notification_log has used since migration 0001, since SQLite's
-- UNIQUE index treats every NULL as distinct and would defeat the constraint
-- below for exactly the non-recurring case.
--
-- No 'pending' value, and no row is written until someone actually answers.
-- Under the old model every invitee got a row at invite time, so "no answer"
-- needed a value to mean it. Here the absence of a row *is* no answer, which
-- removes a class of bug where a row exists but means nothing.
--
-- Decision 5 (specs/0014, Michael, Aug 2026): this migration carries nothing
-- forward from event_invites.rsvp_status. A recurring event's single old
-- answer had no fact of the matter about which occurrence it meant, and
-- copying it forward to occurrences nobody was ever shown would manufacture
-- a commitment the person never made. Everyone starts unanswered -- see the
-- v0.6 changelog entry for the costs this accepts (anyone who had declined
-- gets asked again; the first cron tick after release has a throughput
-- spike as the backlog clears), recorded there because they are costs to
-- people rather than to the schema.
--
-- event_invites keeps its rsvp_status column, unused, for one more release:
-- dropping a column the deployed Worker still reads is a two-release change
-- (see deploy-worker.yml's migrate-then-deploy ordering), and this
-- migration does not touch it.
CREATE TABLE event_attendance (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  occurrence_date TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  rsvp_status TEXT NOT NULL CHECK (rsvp_status IN ('accepted','declined','tentative')),
  responded_at INTEGER NOT NULL,
  UNIQUE(event_id, occurrence_date, user_id)
);

-- Every (event_id, occurrence_date[, user_id]) point lookup this release
-- needs -- getConfirmedAttendeeIds, GET /:eventId's per-invitee join,
-- recordRsvp's ON CONFLICT target -- is already served by the UNIQUE
-- constraint's own automatic index. The one access pattern that doesn't
-- serve is "everything this user has answered across a set of events," which
-- the calendar's per-viewer load runs on every page view, so it gets an
-- index with user_id leading.
CREATE INDEX idx_attendance_user_event ON event_attendance(user_id, event_id);
