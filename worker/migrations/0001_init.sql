-- Discord snowflake IDs are stored as TEXT (they exceed Number.MAX_SAFE_INTEGER).
-- Timestamps are Unix milliseconds (INTEGER) except recurrence dates, which are
-- ISO date strings (YYYY-MM-DD) since they represent a local calendar date.

CREATE TABLE users (
  id TEXT PRIMARY KEY,                    -- discord user id
  username TEXT NOT NULL,
  global_name TEXT,
  avatar_hash TEXT,
  timezone TEXT NOT NULL DEFAULT 'America/New_York',
  notifications_enabled INTEGER NOT NULL DEFAULT 1,
  discord_refresh_token TEXT,
  discord_token_expires_at INTEGER,
  dm_channel_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_login_at INTEGER
);

CREATE TABLE guilds (
  id TEXT PRIMARY KEY,                    -- discord guild id
  name TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  added_at INTEGER NOT NULL
);

CREATE TABLE user_guild_membership (
  user_id TEXT NOT NULL REFERENCES users(id),
  guild_id TEXT NOT NULL REFERENCES guilds(id),
  nickname TEXT,
  is_member INTEGER NOT NULL DEFAULT 1,
  verified_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, guild_id)
);
CREATE INDEX idx_membership_guild ON user_guild_membership(guild_id, is_member);
CREATE INDEX idx_membership_user ON user_guild_membership(user_id, is_member);

CREATE TABLE groups (
  id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL REFERENCES guilds(id),
  name TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_groups_guild ON groups(guild_id);

CREATE TABLE group_members (
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id),
  added_at INTEGER NOT NULL,
  PRIMARY KEY (group_id, user_id)
);

CREATE TABLE events (
  id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL REFERENCES guilds(id),
  organizer_id TEXT NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  description TEXT,
  game TEXT,
  event_type TEXT NOT NULL CHECK (event_type IN ('single','poll')),
  timezone TEXT NOT NULL,
  start_at INTEGER,
  end_at INTEGER,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','cancelled','resolved')),
  poll_strategy TEXT CHECK (poll_strategy IN ('threshold','most_votes')),
  poll_threshold_count INTEGER,
  poll_deadline_at INTEGER,
  resolved_option_id TEXT,
  is_recurring INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_events_guild_time ON events(guild_id, start_at);
CREATE INDEX idx_events_recurring ON events(guild_id, is_recurring);
CREATE INDEX idx_events_poll_deadline ON events(event_type, status, poll_deadline_at);

CREATE TABLE event_recurrence_rules (
  event_id TEXT PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
  freq TEXT NOT NULL CHECK (freq IN ('DAILY','WEEKLY','MONTHLY')),
  interval INTEGER NOT NULL DEFAULT 1,
  by_weekday TEXT,                        -- CSV ints, 0=Mon..6=Sun (WEEKLY only)
  by_month_day INTEGER,                   -- day-of-month (MONTHLY only)
  start_date TEXT NOT NULL,               -- ISO date, local to events.timezone
  start_time TEXT NOT NULL,               -- 'HH:MM' local time
  duration_minutes INTEGER NOT NULL,
  end_type TEXT NOT NULL CHECK (end_type IN ('never','on_date','after_count')),
  end_date TEXT,
  end_count INTEGER
);

CREATE TABLE event_occurrence_overrides (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  occurrence_date TEXT NOT NULL,          -- ISO date of the original occurrence
  is_cancelled INTEGER NOT NULL DEFAULT 0,
  override_start_at INTEGER,
  override_end_at INTEGER,
  UNIQUE(event_id, occurrence_date)
);

CREATE TABLE event_invites (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id),
  invited_via TEXT NOT NULL CHECK (invited_via IN ('individual','group')),
  source_group_id TEXT REFERENCES groups(id),
  rsvp_status TEXT NOT NULL DEFAULT 'pending' CHECK (rsvp_status IN ('pending','accepted','declined','tentative')),
  responded_at INTEGER,
  invited_at INTEGER NOT NULL,
  UNIQUE(event_id, user_id)
);
CREATE INDEX idx_invites_user ON event_invites(user_id);
CREATE INDEX idx_invites_event ON event_invites(event_id);

CREATE TABLE event_poll_options (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  start_at INTEGER NOT NULL,
  end_at INTEGER NOT NULL,
  display_order INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_poll_options_event ON event_poll_options(event_id);

CREATE TABLE event_poll_votes (
  option_id TEXT NOT NULL REFERENCES event_poll_options(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id),
  vote TEXT NOT NULL CHECK (vote IN ('yes','no','maybe')),
  voted_at INTEGER NOT NULL,
  PRIMARY KEY (option_id, user_id)
);
CREATE INDEX idx_poll_votes_option ON event_poll_votes(option_id);

CREATE TABLE notification_log (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  notification_type TEXT NOT NULL CHECK (notification_type IN ('invite','reminder_24h','reminder_1h','poll_resolved')),
  -- '' (not NULL) for notification types that aren't tied to one occurrence
  -- (invite/poll_resolved, and reminders on non-recurring events) -- SQLite's
  -- UNIQUE index treats every NULL as distinct, which would silently defeat
  -- the dedupe guarantee below for exactly the non-recurring/one-off case.
  occurrence_date TEXT NOT NULL DEFAULT '',
  sent_at INTEGER NOT NULL,
  UNIQUE(user_id, event_id, notification_type, occurrence_date)
);
