-- Invitee change requests (docs/specs/0003-event-change-requests.md).
--
-- Lets an invitee ask the organizer for two things without ever writing the
-- event themselves: "move this" (time_change) and "invite this person"
-- (add_invitee). Accepting a request always goes through the same code path
-- the organizer's own edit uses (updateEvent / addInvitesToEvent), so this
-- table only ever records the *request*, never the change itself.

CREATE TABLE event_change_requests (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  requester_id TEXT NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL CHECK (kind IN ('time_change','add_invitee')),

  -- time_change only
  proposed_start_at INTEGER,
  proposed_end_at INTEGER,
  -- '' for non-recurring, matching notification_log's convention: SQLite
  -- treats every NULL as distinct, which would defeat any dedupe this column
  -- takes part in for exactly the common (non-recurring) case.
  occurrence_date TEXT NOT NULL DEFAULT '',

  -- add_invitee only
  target_user_id TEXT REFERENCES users(id),

  message TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','accepted','declined','withdrawn')),
  decision_note TEXT,
  -- events.revision as read when the request was made. Passed back into
  -- updateEvent's revision guard on accept for a non-recurring time_change;
  -- purely advisory (staleness display) for everything else -- see the spec.
  event_revision INTEGER NOT NULL,

  -- time_change only: a system-computed majority of the invitee count at
  -- filing time (not organizer-configured -- letting the requester set their
  -- own threshold would let them pick 1 and pass on their own vote), and a
  -- fixed 72h deadline. NULL for add_invitee, which has no vote.
  vote_threshold_count INTEGER,
  vote_deadline_at INTEGER,
  -- Consecutive failed deadline-resolution attempts, same purpose as
  -- events.poll_resolution_failures (migration 0012): keeps one broken row
  -- from holding a place in the deadline sweep's page ahead of healthy ones.
  vote_resolution_failures INTEGER NOT NULL DEFAULT 0,

  created_at INTEGER NOT NULL,
  decided_at INTEGER,
  -- NULL for a threshold/deadline auto-resolution; set only when the
  -- organizer closed it early via accept/decline.
  decided_by TEXT REFERENCES users(id)
);
CREATE INDEX idx_change_requests_event ON event_change_requests(event_id, status);
CREATE INDEX idx_change_requests_requester ON event_change_requests(requester_id, status);

-- Shaped like event_poll_votes. Absence of a row means "hasn't voted", the
-- same convention getOptionTallies' LEFT JOIN relies on -- no separate
-- "seeded pending" row to write or clean up.
CREATE TABLE event_change_request_votes (
  request_id TEXT NOT NULL REFERENCES event_change_requests(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id),
  vote TEXT NOT NULL CHECK (vote IN ('yes','no','maybe')),
  voted_at INTEGER NOT NULL,
  PRIMARY KEY (request_id, user_id)
);

-- A third outbox table, not a new type on notification_log: notification_log's
-- UNIQUE key (user_id, event_id, notification_type, occurrence_date) cannot
-- distinguish two requests on the same event, so a second request would
-- collide with the first's dedupe key and silently never be delivered.
-- Same shape as group_nudge_log (0009's lease columns, 0014's content).
CREATE TABLE change_request_log (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES event_change_requests(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id),
  notification_type TEXT NOT NULL CHECK (notification_type IN ('change_request_opened','change_request_decision')),
  sent_at INTEGER NOT NULL,
  delivered_at INTEGER,
  failed_at INTEGER,
  claim_token TEXT,
  claimed_until INTEGER,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER,
  content TEXT,
  UNIQUE(request_id, user_id, notification_type)
);
CREATE INDEX idx_change_request_log_user ON change_request_log(user_id);
CREATE INDEX idx_change_request_log_pending
  ON change_request_log(request_id)
  WHERE delivered_at IS NULL AND failed_at IS NULL;
