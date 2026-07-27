-- Personal events: private to one user, not tied to any guild, no invites or
-- polls. They appear on the owner's own calendar and (unless marked not-busy)
-- block their availability in the free/busy scheduling assistant.
--
-- Recurrence is stored inline rather than reusing event_recurrence_rules,
-- because that table's FK points at events(id) and personal events aren't
-- rows in `events`. The rule is 1:1 with the event anyway, and the actual
-- expansion logic is shared -- see lib/recurrence.ts expandOccurrences().
CREATE TABLE personal_events (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  description TEXT,
  timezone TEXT NOT NULL,
  start_at INTEGER,                  -- NULL for recurring series (derived from the rule)
  end_at INTEGER,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','cancelled')),
  -- 0 lets someone log a personal note that does NOT make them look unavailable.
  busy INTEGER NOT NULL DEFAULT 1,
  is_recurring INTEGER NOT NULL DEFAULT 0,
  freq TEXT CHECK (freq IN ('DAILY','WEEKLY','MONTHLY')),
  interval INTEGER,
  by_weekday TEXT,                   -- CSV ints, 0=Mon..6=Sun (WEEKLY only)
  by_month_day INTEGER,              -- day-of-month (MONTHLY only)
  rule_start_date TEXT,              -- ISO date, local to `timezone`
  rule_start_time TEXT,              -- 'HH:MM' local time
  duration_minutes INTEGER,          -- may exceed 24h for multi-day blocks (travel, etc.)
  end_type TEXT CHECK (end_type IN ('never','on_date','after_count')),
  rule_end_date TEXT,
  end_count INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_personal_events_user ON personal_events(user_id, start_at);
CREATE INDEX idx_personal_events_recurring ON personal_events(user_id, is_recurring);

-- Per-occurrence cancel/move for a recurring personal series.
CREATE TABLE personal_event_overrides (
  id TEXT PRIMARY KEY,
  personal_event_id TEXT NOT NULL REFERENCES personal_events(id) ON DELETE CASCADE,
  occurrence_date TEXT NOT NULL,
  is_cancelled INTEGER NOT NULL DEFAULT 0,
  override_start_at INTEGER,
  override_end_at INTEGER,
  UNIQUE(personal_event_id, occurrence_date)
);

-- Opt-out for the free/busy scheduling assistant. When 0, other members of a
-- shared server see nothing at all for this user -- not even opaque blocks.
ALTER TABLE users ADD COLUMN free_busy_visible INTEGER NOT NULL DEFAULT 1;

-- Stop retaining long-lived Discord credentials. These backed POST
-- /auth/sync-guilds, which no UI ever called -- guild membership is already
-- re-synced on every login. Discord's Developer Terms require deleting API
-- Data once it's no longer necessary for the app's functionality, and an
-- unused refresh token is exactly that. Purge before dropping so the values
-- are actually gone rather than just unreferenced.
UPDATE users SET discord_refresh_token = NULL, discord_token_expires_at = NULL;
ALTER TABLE users DROP COLUMN discord_refresh_token;
ALTER TABLE users DROP COLUMN discord_token_expires_at;
