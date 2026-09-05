-- IDEAS item 2 / docs/specs/0017: push the sessions someone is committed to
-- onto one Google calendar of their choosing.
--
-- Two tables: the connection (one per user) and the mapping from our
-- occurrences to the Google events we wrote for them.

-- The first and only long-lived third-party credential this app stores.
-- ARCHITECTURE.md's auth section says Discord's tokens are discarded because
-- nothing acts on Discord's behalf later; a cron sweep writing to Google with
-- nobody logged in is precisely the case that sentence did not cover, so the
-- token has to survive. What pays for that is spelled out in specs/0017: it is
-- encrypted at rest under its own secret, never returned by any route, and
-- revoked at Google on disconnect and on account deletion.
CREATE TABLE google_calendar_connections (
  -- One connection per user, so the user id *is* the key. Supporting two
  -- Google accounts at once would mean deciding which one an event goes to,
  -- which is a question nobody has asked.
  user_id TEXT PRIMARY KEY REFERENCES users(id),

  -- AES-GCM ciphertext and its 96-bit IV, both base64url (lib/crypto.ts). The
  -- IV is per-record and stored in the clear, which is how AES-GCM is meant to
  -- be used -- it must be unique per encryption under a key, not secret.
  refresh_token_ciphertext TEXT NOT NULL,
  refresh_token_iv TEXT NOT NULL,

  -- The short-lived access token, cached so an ordinary tick spends no
  -- outbound subrequest renewing it. Google's are ~1 hour; the sweep refreshes
  -- inside a skew rather than on exact expiry. Encrypted with the same key as
  -- the refresh token: it is a bearer credential for the same calendar, and
  -- storing it in the clear next to an encrypted one protects nothing.
  access_token_ciphertext TEXT,
  access_token_iv TEXT,
  access_token_expires_at INTEGER,

  -- Which Google account this is, shown in Settings so someone with several
  -- can tell which one they connected. Not used to authenticate anything.
  google_account_email TEXT,

  -- The calendar events are written to. 'primary' is Google's own alias for
  -- the account's default calendar, which is what a fresh connection uses
  -- until the person picks another.
  calendar_id TEXT NOT NULL DEFAULT 'primary',

  -- The toggle in Settings. Distinct from deleting the connection: turning
  -- sync off keeps the authorisation so turning it back on doesn't mean
  -- another trip through Google's consent screen.
  sync_enabled INTEGER NOT NULL DEFAULT 1,

  -- 'active', or 'disconnecting' while the sweep removes the future events we
  -- wrote before the token is revoked and this row goes. specs/0017: the
  -- request cannot do that synchronously without timing out on somebody with a
  -- busy fortnight, and revoking first would strand the entries permanently.
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disconnecting')),

  -- Bookkeeping for the sweep and for what Settings shows. last_error is the
  -- reason sync stopped (a revoked grant, a deleted calendar), shown to the
  -- user because "it silently stopped working" is the failure this feature is
  -- most likely to have.
  last_synced_at INTEGER,
  last_error TEXT,
  -- Counts consecutive failed cleanup passes while disconnecting, so a
  -- connection whose tidy-up can never succeed is eventually dropped anyway
  -- rather than holding a credential forever.
  disconnect_attempts INTEGER NOT NULL DEFAULT 0,

  connected_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- The sweep's discovery read: least-recently-synced first, which is a cursor
-- for free (specs/0017 -- no CursorStore slot, so no extra per-tick statement
-- against cron/budget.ts's very tight reserve).
CREATE INDEX idx_google_connections_sweep
  ON google_calendar_connections(sync_enabled, status, last_synced_at);

-- One row per (user, event, occurrence) we have written to Google.
--
-- This is what makes the sweep idempotent: whether to POST or PATCH is decided
-- by whether a row exists, so "did this already go out" is a local lookup
-- rather than a question for Google -- and a re-run after a partial tick
-- cannot create a second copy of the same session.
CREATE TABLE google_event_links (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  event_id TEXT NOT NULL REFERENCES events(id),

  -- '' for a non-recurring event, the ISO date for one occurrence of a series.
  -- Deliberately the same convention event_attendance uses (migration 0025 /
  -- specs/0014) rather than a new one: two parts of this codebase disagreeing
  -- about what identifies an occurrence is a bug generator, and a per-
  -- occurrence decline is exactly the case this table has to agree with.
  occurrence_date TEXT NOT NULL DEFAULT '',

  -- What Google gave back on insert. The handle for every later patch/delete.
  google_event_id TEXT NOT NULL,

  -- Exactly what we last wrote, so the sweep can tell "unchanged" from "needs
  -- a patch" without reading the event back from Google.
  --
  -- Deliberately the payload fields themselves rather than events.revision
  -- (migration 0013). Revision is the right token for detecting an *edit*, but
  -- it is the wrong one here for two reasons: a recurring series' revision
  -- does not move when an occurrence override shifts a single date, and a
  -- revision bump for a field this sync never sends (a description edit, a
  -- voice channel change) would spend a Google call rewriting an identical
  -- entry. Comparing what we would send against what we sent answers the
  -- question being asked, and cannot drift from the payload builder.
  synced_title TEXT,
  synced_start_at INTEGER,
  synced_end_at INTEGER,
  synced_at INTEGER NOT NULL,

  UNIQUE(user_id, event_id, occurrence_date)
);

-- Covers the sweep's per-user read of everything it has already written, which
-- is how it works out what to delete (a link with no matching live occurrence).
CREATE INDEX idx_google_event_links_user ON google_event_links(user_id);
-- Covers the cascade in lib/db.ts's deleteUserCompletely and the cancelled-
-- event cleanup, both of which come at this by event rather than by user.
CREATE INDEX idx_google_event_links_event ON google_event_links(event_id);
