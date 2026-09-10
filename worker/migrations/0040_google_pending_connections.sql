-- Pass-11 security review (F-16 / R01): a Google grant now waits here until
-- the app account it would attach to actively claims it from an authenticated
-- session.
--
-- The hole this closes. /google/start is unauthenticated by construction -- it
-- is the top-level navigation that sets the nonce cookie, and a browser
-- following a redirect chain carries no bearer token -- so it took the app
-- identity from the signed `t` token in its own URL. That URL is transferable.
-- An attacker could mint one naming their own account, send it to someone
-- else ("connect your calendar here"), and every check downstream still
-- passed: the state signature was valid, and the nonce matched because the
-- *victim's* browser is the one that created it at /start. The callback then
-- stored the victim's refresh token against the attacker's user_id. The
-- attacker could then nominate one of the victim's calendars, read the real
-- titles and descriptions the hourly sync imports, and write their own
-- sessions into it -- while the victim's own Settings page showed nothing
-- connected at all.
--
-- What was missing was never a *second* proof that the browser started the
-- flow; it was any proof that the browser belonged to the account being
-- connected. The two halves are now proven in the two places each can
-- actually be proven: the callback still checks the nonce cookie, which is
-- what shows the consent came from the browser that began this transaction,
-- and finalization is an ordinary authenticated request, which is what shows
-- the account claiming the grant is the one operating that browser. A grant
-- whose two halves disagree is revoked at Google rather than merely dropped.
--
-- Rows are short-lived (minutes) and self-clearing three ways: consumed by
-- finalize, deleted when a mismatched claim is refused, and swept by
-- pruneStaleSessions for the ones nobody ever comes back for -- the same
-- "nothing else removes them" reasoning sessions themselves get.
--
-- The tokens are sealed with the same AES-GCM key and column shape as
-- google_calendar_connections, deliberately: a pending grant is exactly as
-- sensitive as a live one, and storing it any more weakly for being temporary
-- would be the wrong trade.
CREATE TABLE google_pending_connections (
  id TEXT PRIMARY KEY,
  -- The account named by the start token -- the *claim*, not yet a fact. It
  -- is only ever compared against the authenticated caller at finalize; it
  -- never by itself authorises attaching anything to that account.
  user_id TEXT NOT NULL REFERENCES users(id),
  refresh_token_ciphertext TEXT NOT NULL,
  refresh_token_iv TEXT NOT NULL,
  access_token_ciphertext TEXT NOT NULL,
  access_token_iv TEXT NOT NULL,
  access_token_expires_at INTEGER,
  google_account_email TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX idx_google_pending_expires ON google_pending_connections(expires_at);
