-- Windowed candidates (IDEAS 40, specs/0013).
--
-- A poll's candidates stop being fixed times and become *windows with a
-- minimum session length*. The model needs almost nothing new:
-- `event_poll_options.start_at`/`end_at` become the window a session may fall
-- in, and `events.window_block_minutes` becomes that minimum for the poll.
-- A poll with no minimum is exactly today's options poll; a poll with one
-- candidate and a minimum is exactly today's window poll.
--
-- One table does have to change. `event_window_availability` is keyed
-- (event_id, user_id) -- one submission per person per *poll*. Windowed
-- candidates need one per person per *candidate*.
--
-- Order matters, and it is the order the spec insists on: convert first,
-- recreate second. Every existing window poll gets an options row spanning
-- its window so that its submissions have something to point at; recreating
-- the table first would leave those rows with no option and nothing to
-- migrate them to.

-- 1. Existing window polls become single-candidate polls.
--
-- 'winopt-' || id is derived rather than random so this migration is
-- deterministic -- a replay against a copy of the same data produces the
-- same ids, which is what makes scripts/verify-schema.mjs and the test
-- shim agree with production.
--
-- display_order 0 because there is exactly one. confirmed_at is left NULL:
-- a window poll that has already resolved records its winner on the event
-- (status/resolved_option_id/start_at), and confirming the candidate here
-- would make a resolved poll look like a multi-winner one with a confirmed
-- day.
INSERT INTO event_poll_options (id, event_id, start_at, end_at, display_order)
SELECT 'winopt-' || e.id, e.id, e.window_start_at, e.window_end_at, 0
  FROM events e
 WHERE e.event_type = 'poll'
   AND e.poll_mode = 'window'
   AND e.window_start_at IS NOT NULL
   AND e.window_end_at IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM event_poll_options o WHERE o.id = 'winopt-' || e.id);

-- 2. Recreate the availability table keyed on the option.
--
-- SQLite cannot move a primary key in place, so this is the create-copy-
-- drop-rename that migrations 0003 and 0005 already made on
-- notification_log. Read 0016 before touching this: rebuilding a table in
-- SQLite drops the indexes attached to it, and the one time that was done
-- by hand against production an index went missing for three releases. Both
-- indexes are therefore recreated below, explicitly, after the rename.
--
-- `event_id` is kept alongside `option_id` even though the option implies
-- it. Three callers ask "how many people have submitted anything on this
-- poll" (the MAX_WINDOW_SUBMISSIONS backstop, the export, and account
-- deletion), and going through event_poll_options for that would turn each
-- into a join. It is denormalised on purpose, and the ON DELETE CASCADE on
-- both parents keeps it from outliving either.
CREATE TABLE event_window_availability_new (
  option_id TEXT NOT NULL REFERENCES event_poll_options(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id),
  avail_start_at INTEGER NOT NULL,
  avail_end_at INTEGER NOT NULL,
  submitted_at INTEGER NOT NULL,
  PRIMARY KEY (option_id, user_id)
);

-- The join is what makes this lossless: every surviving submission belongs
-- to a window poll, and step 1 gave every window poll an option. A
-- submission whose event somehow has no option row is dropped rather than
-- pointed at nothing -- an INSERT with a NULL option_id would fail the NOT
-- NULL and take the whole migration with it.
INSERT INTO event_window_availability_new (option_id, event_id, user_id, avail_start_at, avail_end_at, submitted_at)
SELECT o.id, a.event_id, a.user_id, a.avail_start_at, a.avail_end_at, a.submitted_at
  FROM event_window_availability a
  JOIN event_poll_options o ON o.event_id = a.event_id
 WHERE o.id = 'winopt-' || a.event_id;

DROP TABLE event_window_availability;
ALTER TABLE event_window_availability_new RENAME TO event_window_availability;

CREATE INDEX idx_window_avail_event ON event_window_availability(event_id);
CREATE INDEX idx_window_avail_option ON event_window_availability(option_id);
