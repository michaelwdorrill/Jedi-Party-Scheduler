-- IDEAS item 54: minimum_attendees gets a deadline instead of (or alongside,
-- for the recurring case) reacting to every decline in real time.
--
-- Two columns, not one, because the two event shapes need different things:
-- a non-recurring event has one date to anchor an absolute deadline to;
-- a recurring event has many (one per occurrence), so it needs a relative
-- offset instead -- "N hours before *this* occurrence" -- applied fresh to
-- each one. At most one of the two is ever set on a given event: which one
-- is legal is decided by is_recurring, enforced in validateEventWriteInput,
-- the same way minimum_attendees itself already is.
--
-- Both nullable, and that nullability is load-bearing, not just permissive:
-- an existing minimum_attendees event predates this column and has neither
-- set, and NULL is what keeps it on the original real-time reactive cascade
-- (decision 4, v0.6.2) rather than silently switching behaviour underneath
-- an organizer who never asked for a deadline.
ALTER TABLE events ADD COLUMN minimum_attendees_deadline_at INTEGER;
ALTER TABLE events ADD COLUMN minimum_attendees_deadline_hours_before INTEGER;
