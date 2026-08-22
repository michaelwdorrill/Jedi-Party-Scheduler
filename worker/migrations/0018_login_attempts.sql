-- Tell "logged in" apart from "tried to log in and was turned away"
-- (IDEAS.md item 15, second half).
--
-- `upsertUser` stamps `last_login_at` in routes/auth.ts *before* the
-- zero-shared-guilds check that can still reject the login with a 403 and
-- issue no session. So a bounced attempt has been indistinguishable from a
-- real login on the owner-only user list ever since -- which is exactly what
-- made one production investigation take three wrong guesses instead of one
-- query.
--
-- Splitting the two: `last_login_attempt_at` is stamped on every attempt that
-- gets as far as a valid Discord profile, and `last_login_at` only once the
-- login actually succeeds and a session is issued.
ALTER TABLE users ADD COLUMN last_login_attempt_at INTEGER;

-- Every recorded successful login was also an attempt. Backfilling keeps the
-- new column from reading as "has never tried to log in" for every existing
-- user, which would be a fresh version of the same lie this fixes.
UPDATE users SET last_login_attempt_at = last_login_at WHERE last_login_at IS NOT NULL;
