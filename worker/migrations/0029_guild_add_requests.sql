-- IDEAS item 9 / docs/specs/0015: self-service "add this bot to your
-- server" requests, gated by owner approval.
--
-- guild_id is deliberately NOT a foreign key into guilds(id) -- the whole
-- point of this table is to hold a guild that ISN'T on the allow-list yet.
CREATE TABLE guild_add_requests (
  id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL,
  guild_name TEXT NOT NULL,            -- as Discord reported it at request time
  requested_by TEXT NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  requested_at INTEGER NOT NULL,
  decided_at INTEGER
);

CREATE INDEX idx_guild_add_requests_requester ON guild_add_requests(requested_by);

-- Only one *pending* request per guild at a time -- a partial index rather
-- than UNIQUE(guild_id) so a previously-rejected guild can be requested
-- again later (an owner declining once shouldn't permanently block a future
-- ask, e.g. after the server changes hands).
CREATE UNIQUE INDEX idx_guild_add_requests_one_pending
  ON guild_add_requests(guild_id)
  WHERE status = 'pending';
