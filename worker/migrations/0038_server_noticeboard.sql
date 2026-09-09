-- IDEAS item 5 (second half) / docs/specs/0007: the server noticeboard.
--
-- Being able to look at a server and see what is on, including events you are
-- not invited to. Title, when it is, and who is going -- never the
-- description, and never anything on a server you are not a verified member of.

-- Whether this event is hidden from its server's noticeboard.
--
-- 0 (visible) is the default, per the spec's decision 1: a server is treated
-- as a semi-public space, so an event on it appears on the noticeboard unless
-- its organiser deliberately marks it private.
ALTER TABLE events ADD COLUMN is_private INTEGER NOT NULL DEFAULT 0;

-- Every event that already exists becomes private, and this is the single most
-- important statement in the migration.
--
-- Decision 2 of the spec: new events only, never retroactive. These rows were
-- created under a Privacy Policy that said, in as many words, "only the
-- organiser and the people invited to an event can see its details. Sharing a
-- Discord server with someone does not let you see their events." Letting the
-- column's default decide their visibility would silently break that promise
-- for every event in the database, which is the one thing this feature must
-- not do.
--
-- The spec considered the alternative -- keying visibility off a "created
-- after this shipped" timestamp comparison -- and rejected it as "the kind of
-- implicit rule that gets forgotten". An explicit backfill puts the decision
-- in the data, where a reader can see it, rather than in a predicate someone
-- has to remember to apply at every call site.
UPDATE events SET is_private = 1;

-- The noticeboard's own access path: everything on one guild in a time window,
-- rather than everything one *person* is attached to. That is a different
-- shape from every existing event query (see specs/0007's blocker 3), and it
-- is why this index exists rather than reusing idx_events_guild_time --
-- filtering on status and privacy before the range is what keeps a busy
-- server's history out of the scan.
CREATE INDEX idx_events_noticeboard ON events(guild_id, is_private, status, start_at);
