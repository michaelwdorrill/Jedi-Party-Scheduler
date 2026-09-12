-- Pass-19 review (P19-08). A remote Google event this app created, which no
-- google_event_links row points at.
--
-- The push half inserts into Google and then records the mapping under a
-- guard: the mapping is refused if the connection's destination or credential
-- has changed since the insert was dispatched (P13-08, P14-06). That guard is
-- correct and must stay -- recording a mapping against the wrong account is
-- how an older and worse class of bug worked.
--
-- What was missing is what happens to the remote event when the guard refuses.
-- Nothing. It stayed in the user's calendar with no local record, so the next
-- sweep created a second copy and tracked only that one, and -- the part that
-- makes this more than a duplicate -- DISCONNECT could not remove it either,
-- because disconnect enumerates google_event_links. The confirm dialog, the
-- disconnecting state and the Privacy Policy all promise, without
-- qualification, that disconnecting removes the upcoming entries this service
-- added. For this event, it did not.
--
-- A row here is an obligation: we created this, we could not attach it, and we
-- still owe its deletion. The push path compensates immediately where it can
-- and only writes a row when it cannot, so in a healthy database this table is
-- empty -- the same shape as the outbox's terminal rows.
--
-- Deliberately NOT a foreign key to events: the obligation outlives the local
-- event, and the whole point is that it is reachable when nothing else is. It
-- does reference the user, because account erasure should take it with it.
CREATE TABLE google_orphaned_inserts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  google_event_id TEXT NOT NULL,
  calendar_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(user_id, calendar_id, google_event_id)
);

-- Disconnect and account erasure both sweep by user, and in a healthy
-- database there is nothing to find.
CREATE INDEX idx_google_orphaned_inserts_user ON google_orphaned_inserts(user_id);
