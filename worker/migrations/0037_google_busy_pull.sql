-- IDEAS item 2 / docs/specs/0017, pull half: read one chosen Google calendar's
-- busy times back into Uncle Owen's scheduling assistant.
--
-- Everything here hangs off the existing connection row rather than a new
-- table, and that is a budget decision rather than a modelling one. See
-- `busy_blocks` below.

-- WHICH calendar may be read. Deliberately separate from `calendar_id`, which
-- is the *write* target: writing sessions into a dedicated "Games" calendar
-- while reading busy time from a personal one is the obvious setup, and one
-- column cannot be both.
--
-- NULL means the pull half is off for this user, and that is the default for
-- everyone including people who connected during v0.8. Reading is opt-in on
-- top of an opt-in: connecting to push must never silently start a pull.
--
-- What this column cannot do is enforce itself. Google's calendar scopes are
-- account-wide -- there is no per-calendar scope -- so `calendar.readonly`
-- grants read access to every calendar the account can see. The promise that
-- only this one is read is kept by the query the Worker chooses to send, and
-- by nothing else. The Privacy Policy says so in those words rather than
-- implying a stronger guarantee.
ALTER TABLE google_calendar_connections ADD COLUMN read_calendar_id TEXT;

-- The cached busy times, as a JSON array of [startMs, endMs] pairs.
--
-- A blob on this row rather than a `google_busy_blocks` table, because of
-- where it is read: lib/freeBusy.ts's computeBusyBlocksForUsers runs
-- *synchronously inside a request*, for up to 25 users, and its own header
-- documents a bug where per-user follow-up queries took a valid request past
-- the Free plan's ceiling. A blob means one chunked SELECT serves every
-- requested user, and one UPDATE refreshes a user -- against a table it would
-- be a delete plus an insert storm per refresh, and a range query per request.
--
-- The trade is that the range filter happens in memory instead of in SQL. That
-- is fine here: the array is capped when written (MAX_CACHED_BUSY_BLOCKS), and
-- freeBusy already filters and merges blocks in memory anyway.
ALTER TABLE google_calendar_connections ADD COLUMN busy_blocks TEXT;

-- When the cache was last refreshed, and how far forward it reaches.
--
-- Both are load-bearing, and the second is the subtler one. The cache has a
-- horizon -- roughly the next two months -- and *beyond that horizon we know
-- nothing*. That is not the same as knowing someone is free. Recording where
-- the knowledge stops keeps the difference in the data rather than in a
-- comment, so a reader can tell "no busy blocks because they are free" from
-- "no busy blocks because we never looked that far".
ALTER TABLE google_calendar_connections ADD COLUMN busy_cached_at INTEGER;
ALTER TABLE google_calendar_connections ADD COLUMN busy_window_end_at INTEGER;
