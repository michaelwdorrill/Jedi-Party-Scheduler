-- Pass-12 security review (P12-04): make rotation actually rotate.
--
-- What migration 0041 built, and what it missed. Rotation retires the session
-- presented and mints a successor, so a stolen token and the legitimate one
-- cannot both keep working. The `superseded_at IS NULL` guard on the retiring
-- UPDATE was there to stop a concurrent second rotation pushing the grace
-- window forward repeatedly -- and it does stop that. What it does not stop is
-- the second rotation inserting a second successor.
--
-- So two refreshes of the same sid inside the 60-second grace -- two tabs, or a
-- victim and whoever captured their token -- each got their own brand-new
-- session row. One session forks into two independent chains, each of which can
-- go on rotating for the remainder of the original seven days. Nothing links
-- them, so logging out of one leaves the other running, and the "theft ends at
-- the next refresh" property 0041's own comment claims is exactly what does not
-- happen: the thief simply refreshes into a branch of their own.
--
-- The 20-session cap was bypassed the same way, since it is applied in
-- createSession and rotation never went through it: fifty refreshes left fifty
-- live sessions.
--
-- family_id. Every session carries the id of the login that started its chain,
-- inherited unchanged by each successor. That is what gives revocation
-- something to aim at: logging out, or detecting a replayed token, can now
-- revoke the whole lineage rather than the one row that happened to be
-- presented. Backfilled to each existing row's own id, which is exactly what a
-- chain of length one means.
--
-- successor_id. What a retired session rotated INTO. It is what makes rotation
-- idempotent within the grace: the second tab to call refresh is handed the
-- same successor the first one got, rather than minting a rival. Without it the
-- only options are to fork (the bug) or to fail the loser's refresh outright,
-- and 0041 records why failing it is not acceptable -- the frontend treats a
-- 401 from refresh as terminal and throws away the good token the winning tab
-- just stored.
--
-- Together they also give reuse detection, which is the point of rotation and
-- what 0041 stopped short of. A sid presented for refresh AFTER its grace has
-- passed cannot be a slow tab; it is a token that was retired and is being
-- replayed. The whole family is revoked at that moment, so the legitimate
-- holder is logged out too -- which is the correct outcome, because by then
-- one of the two holders is an attacker and there is no way to tell which.
--
-- Not a foreign key in either direction. Both point at rows that
-- pruneStaleSessions removes on its own schedule -- a family's root is usually
-- the first row to go -- and a constraint here would either block that or
-- cascade the live successor away with it.
ALTER TABLE sessions ADD COLUMN family_id TEXT;
ALTER TABLE sessions ADD COLUMN successor_id TEXT;

UPDATE sessions SET family_id = id WHERE family_id IS NULL;

CREATE INDEX idx_sessions_family ON sessions(family_id);
