-- Pass-13 security review (P13-08): a sync mapping records which calendar it
-- was written to.
--
-- google_event_links says "this occurrence is mirrored as this Google event
-- id", and the destination was implicit -- whatever `calendar_id` the
-- connection row happened to hold when anything read it. That is fine while
-- the destination never changes and wrong the moment it does, in three ways
-- this review demonstrated:
--
--   * A push already in flight when the destination changes returns and
--     inserts a mapping for an event id that lives in the OLD calendar, after
--     the cleanup that was supposed to remove exactly those mappings has run.
--     Nothing on the row says which calendar it belongs to, so nothing can
--     reject it.
--   * The disconnect sweep and the PATCH cleanup delete entries from the
--     connection's CURRENT calendar, which is not necessarily the one the
--     entry is in -- so the tidy-up misses, and the entry is orphaned in a
--     calendar the user still has.
--   * Reading a mapping tells you nothing about whether it is stale, so the
--     only recovery is the accidental one: patch it, let Google 404, treat it
--     as missing and re-insert. That works, but it costs a cycle and leaves an
--     orphan behind each time.
--
-- Backfilled to each row's current connection destination, which is what the
-- code assumed until now and is correct for every row written while the
-- destination was stable. Rows whose connection has since gone take NULL and
-- are treated as "destination unknown" by the guard, which fails safe: an
-- unknown-destination link is re-verified rather than trusted.
ALTER TABLE google_event_links ADD COLUMN calendar_id TEXT;

UPDATE google_event_links
SET calendar_id = (
  SELECT c.calendar_id FROM google_calendar_connections c
  WHERE c.user_id = google_event_links.user_id
)
WHERE calendar_id IS NULL;

CREATE INDEX idx_google_links_destination ON google_event_links(user_id, calendar_id);
