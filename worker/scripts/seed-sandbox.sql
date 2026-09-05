-- Synthetic data for the sandbox database (docs/specs/0002-sandbox-and-promotion.md).
--
-- Deliberately raw INSERTs, not calls through the app's own write paths
-- (lib/eventWrites.ts and friends) -- the spec's stated preference, hedged
-- with "where practical". Those write paths run inside the Worker runtime
-- against `env.DB`; reaching them from outside would mean standing up a
-- Workers-shaped execution context just to seed data, which is a bigger lift
-- than a first cut needs. If this seed rots as the schema moves (a new
-- NOT NULL column the app's write paths fill in but this file doesn't), the
-- fix is here, in this file -- not a reason to avoid raw SQL, just the
-- known cost of choosing it. Every timestamp below is computed relative to
-- when this file is *run*, not authored, so it's safe to re-run at any time
-- and always produces fresh, near-future events for the cron to act on.
--
-- Safe to re-run, which this file claimed before it was true. The first
-- version deleted events, groups, memberships, users and guilds by their
-- 'seed-' prefix and called that "children before parents". It is not, for
-- two reasons that only appear once the sandbox has been *used*:
--
--   1. The cron writes rows that reference what this file deletes, and it
--      does so *because of* this file. `group_nudge_log.group_id` and
--      `.user_id` have no ON DELETE CASCADE, and the seed group below sets
--      `idle_reminder_days = 0` precisely so sweepIdleGroups fires on the
--      first tick. So fifteen minutes after the first successful seed, the
--      next run cannot delete the group or the users any more.
--   2. Real data accumulates against the same parents. Deleting the seed
--      *guild* fails once anyone's own group or event lives on it, and
--      deleting seed *users* fails once they are on a real group's roster
--      or a real event's invite list -- neither of which cascades.
--
-- So this now deletes only what it fully owns (the seed events, which cascade
-- to their invites/options/votes/notifications, and the seed group and its
-- roster), clears the cron bookkeeping it caused, and *upserts* the guild,
-- the users and their memberships rather than deleting them. Anything a real
-- session built on top of these fixtures survives a re-run.
--
-- Usage: npm run seed:sandbox
--   (wraps: wrangler d1 execute jedi-party-scheduler-db-sandbox --remote
--    --file scripts/seed-sandbox.sql)
--
-- NEVER point this at the production database. It deletes anything whose id
-- starts with 'seed-' before reinserting, which is safe here only because
-- nothing in a real deployment is expected to use that prefix.

-- The cron's own bookkeeping first. Neither of these cascades from `groups`,
-- and the idle-nudge sweep is the one this seed is built to trigger.
DELETE FROM group_nudge_log WHERE group_id LIKE 'seed-%';
DELETE FROM group_activity_nudges WHERE group_id LIKE 'seed-%';

-- Events cascade to their invites, poll options, votes, window availability,
-- change requests and notification_log rows -- every one of those FKs carries
-- ON DELETE CASCADE (0001, 0003, 0005, 0015).
DELETE FROM events WHERE id LIKE 'seed-%';

-- A real event that invited people via the seed group holds a
-- source_group_id pointing at it, with no cascade. Detach rather than delete:
-- this is the same move routes/groups.ts makes when deleting a group for
-- real, and for the same reason -- it touches nobody's invite, just which
-- group is recorded as having sourced it.
UPDATE event_invites SET source_group_id = NULL WHERE source_group_id LIKE 'seed-%';

-- Scoped to the seed's own group, deliberately: a seed user who has been
-- added to one of *your* groups stays in it.
DELETE FROM group_members WHERE group_id LIKE 'seed-%';
DELETE FROM groups WHERE id LIKE 'seed-%';

-- One throwaway test server, and four fake users: an organizer plus three
-- friends they can invite. All discord ids are just TEXT (see 0001_init.sql)
-- so these fixed, readable strings are fine -- no real Discord account
-- issues login tokens for them, they exist purely to be foreign keys.
INSERT INTO guilds (id, name, is_active, added_at)
VALUES ('seed-guild', 'Sandbox Test Server', 1, (CAST(strftime('%s','now') AS INTEGER) * 1000))
ON CONFLICT(id) DO UPDATE SET name = excluded.name, is_active = 1;

INSERT INTO users (id, username, global_name, timezone, notifications_enabled, created_at, updated_at, last_login_at)
VALUES
  ('seed-user-organizer', 'seed_organizer', 'Sandbox Organizer', 'America/New_York', 1,
   (CAST(strftime('%s','now') AS INTEGER) * 1000), (CAST(strftime('%s','now') AS INTEGER) * 1000), (CAST(strftime('%s','now') AS INTEGER) * 1000)),
  ('seed-user-alice', 'seed_alice', 'Sandbox Alice', 'America/New_York', 1,
   (CAST(strftime('%s','now') AS INTEGER) * 1000), (CAST(strftime('%s','now') AS INTEGER) * 1000), (CAST(strftime('%s','now') AS INTEGER) * 1000)),
  ('seed-user-bob', 'seed_bob', 'Sandbox Bob', 'America/New_York', 1,
   (CAST(strftime('%s','now') AS INTEGER) * 1000), (CAST(strftime('%s','now') AS INTEGER) * 1000), (CAST(strftime('%s','now') AS INTEGER) * 1000)),
  ('seed-user-carol', 'seed_carol', 'Sandbox Carol', 'America/New_York', 1,
   (CAST(strftime('%s','now') AS INTEGER) * 1000), (CAST(strftime('%s','now') AS INTEGER) * 1000), (CAST(strftime('%s','now') AS INTEGER) * 1000))
ON CONFLICT(id) DO UPDATE SET
  username = excluded.username,
  global_name = excluded.global_name,
  updated_at = excluded.updated_at,
  last_login_at = excluded.last_login_at;

-- verified_at set to "now" so every membership is well inside
-- MEMBERSHIP_GRACE_MS (lib/db.ts) -- the cron's recipient queries all
-- require a membership row verified within that window.
INSERT INTO user_guild_membership (user_id, guild_id, is_member, verified_at)
VALUES
  ('seed-user-organizer', 'seed-guild', 1, (CAST(strftime('%s','now') AS INTEGER) * 1000)),
  ('seed-user-alice', 'seed-guild', 1, (CAST(strftime('%s','now') AS INTEGER) * 1000)),
  ('seed-user-bob', 'seed-guild', 1, (CAST(strftime('%s','now') AS INTEGER) * 1000)),
  ('seed-user-carol', 'seed-guild', 1, (CAST(strftime('%s','now') AS INTEGER) * 1000))
ON CONFLICT(user_id, guild_id) DO UPDATE SET
  is_member = 1,
  verified_at = excluded.verified_at;

-- idle_reminder_days = 0 so the group counts as idle the instant its one
-- past event ends, rather than waiting out the real default (2 days) --
-- this is a sandbox group, not a template for what a real group's setting
-- should be.
INSERT INTO groups (id, name, created_by, created_at, idle_reminder_days)
VALUES ('seed-group-raid', 'Sandbox Raid Team', 'seed-user-organizer',
        (CAST(strftime('%s','now') AS INTEGER) * 1000), 0);

INSERT INTO group_members (group_id, user_id, added_at)
VALUES
  ('seed-group-raid', 'seed-user-alice', (CAST(strftime('%s','now') AS INTEGER) * 1000)),
  ('seed-group-raid', 'seed-user-bob', (CAST(strftime('%s','now') AS INTEGER) * 1000)),
  ('seed-group-raid', 'seed-user-carol', (CAST(strftime('%s','now') AS INTEGER) * 1000));

-- Four events, each aimed at exercising a different sweep in
-- src/cron/reminders.ts on the very first tick after this runs:
--
--   seed-event-idle-trigger  ended days ago, invited via the group above,
--                            with nothing upcoming for that group -- makes
--                            sweepIdleGroups fire.
--   seed-event-1h            starts in ~55 minutes -- inside sweepReminders'
--                            "remaining <= 1h" window (reminder_1h).
--   seed-event-24h           starts in ~20 hours -- inside its "remaining
--                            <= 24h" window (reminder_24h).
--   seed-event-poll          a threshold poll whose deadline already
--                            passed -- resolved by the past-deadline poll
--                            sweep on the first tick, regardless of whether
--                            its threshold was reached.
--
-- All four also produce an 'invite' DM to their invitees the first time the
-- new-invites sweep runs, since none of them have a notification_log row yet.
INSERT INTO events (id, guild_id, organizer_id, title, event_type, timezone, start_at, end_at, status, is_recurring, created_at, updated_at)
VALUES
  ('seed-event-idle-trigger', 'seed-guild', 'seed-user-organizer', 'Sandbox: past raid night', 'single', 'America/New_York',
   (CAST(strftime('%s','now') AS INTEGER) * 1000) - 3*24*3600*1000,
   (CAST(strftime('%s','now') AS INTEGER) * 1000) - 3*24*3600*1000 + 2*3600*1000,
   'active', 0, (CAST(strftime('%s','now') AS INTEGER) * 1000), (CAST(strftime('%s','now') AS INTEGER) * 1000)),
  ('seed-event-1h', 'seed-guild', 'seed-user-organizer', 'Sandbox: starting soon', 'single', 'America/New_York',
   (CAST(strftime('%s','now') AS INTEGER) * 1000) + 55*60*1000,
   (CAST(strftime('%s','now') AS INTEGER) * 1000) + 55*60*1000 + 3*3600*1000,
   'active', 0, (CAST(strftime('%s','now') AS INTEGER) * 1000), (CAST(strftime('%s','now') AS INTEGER) * 1000)),
  ('seed-event-24h', 'seed-guild', 'seed-user-organizer', 'Sandbox: tomorrow-ish', 'single', 'America/New_York',
   (CAST(strftime('%s','now') AS INTEGER) * 1000) + 20*3600*1000,
   (CAST(strftime('%s','now') AS INTEGER) * 1000) + 20*3600*1000 + 3*3600*1000,
   'active', 0, (CAST(strftime('%s','now') AS INTEGER) * 1000), (CAST(strftime('%s','now') AS INTEGER) * 1000));

INSERT INTO events (id, guild_id, organizer_id, title, event_type, timezone, status, poll_strategy, poll_threshold_count, poll_deadline_at, is_recurring, created_at, updated_at)
VALUES
  ('seed-event-poll', 'seed-guild', 'seed-user-organizer', 'Sandbox: past-deadline poll', 'poll', 'America/New_York',
   'active', 'threshold', 3,
   (CAST(strftime('%s','now') AS INTEGER) * 1000) - 10*60*1000,
   0, (CAST(strftime('%s','now') AS INTEGER) * 1000), (CAST(strftime('%s','now') AS INTEGER) * 1000));

INSERT INTO event_invites (id, event_id, user_id, invited_via, source_group_id, rsvp_status, invited_at)
VALUES
  ('seed-invite-idle-alice', 'seed-event-idle-trigger', 'seed-user-alice', 'group', 'seed-group-raid', 'accepted', (CAST(strftime('%s','now') AS INTEGER) * 1000)),
  ('seed-invite-idle-bob', 'seed-event-idle-trigger', 'seed-user-bob', 'group', 'seed-group-raid', 'accepted', (CAST(strftime('%s','now') AS INTEGER) * 1000)),
  ('seed-invite-1h-alice', 'seed-event-1h', 'seed-user-alice', 'individual', NULL, 'pending', (CAST(strftime('%s','now') AS INTEGER) * 1000)),
  ('seed-invite-1h-bob', 'seed-event-1h', 'seed-user-bob', 'individual', NULL, 'accepted', (CAST(strftime('%s','now') AS INTEGER) * 1000)),
  ('seed-invite-24h-alice', 'seed-event-24h', 'seed-user-alice', 'individual', NULL, 'pending', (CAST(strftime('%s','now') AS INTEGER) * 1000)),
  ('seed-invite-24h-carol', 'seed-event-24h', 'seed-user-carol', 'individual', NULL, 'accepted', (CAST(strftime('%s','now') AS INTEGER) * 1000)),
  ('seed-invite-poll-alice', 'seed-event-poll', 'seed-user-alice', 'individual', NULL, 'pending', (CAST(strftime('%s','now') AS INTEGER) * 1000)),
  ('seed-invite-poll-bob', 'seed-event-poll', 'seed-user-bob', 'individual', NULL, 'pending', (CAST(strftime('%s','now') AS INTEGER) * 1000)),
  ('seed-invite-poll-carol', 'seed-event-poll', 'seed-user-carol', 'individual', NULL, 'pending', (CAST(strftime('%s','now') AS INTEGER) * 1000));

-- Two candidate slots, both a few days out; two "yes" votes on the first --
-- short of the threshold_count of 3 above, so the past-deadline sweep
-- resolves this by most-votes rather than an early threshold confirm,
-- exercising the "threshold never reached" path specifically.
INSERT INTO event_poll_options (id, event_id, start_at, end_at, display_order)
VALUES
  ('seed-poll-option-a', 'seed-event-poll',
   (CAST(strftime('%s','now') AS INTEGER) * 1000) + 2*24*3600*1000,
   (CAST(strftime('%s','now') AS INTEGER) * 1000) + 2*24*3600*1000 + 3*3600*1000, 0),
  ('seed-poll-option-b', 'seed-event-poll',
   (CAST(strftime('%s','now') AS INTEGER) * 1000) + 3*24*3600*1000,
   (CAST(strftime('%s','now') AS INTEGER) * 1000) + 3*24*3600*1000 + 3*3600*1000, 1);

INSERT INTO event_poll_votes (option_id, user_id, vote, voted_at)
VALUES
  ('seed-poll-option-a', 'seed-user-alice', 'yes', (CAST(strftime('%s','now') AS INTEGER) * 1000)),
  ('seed-poll-option-a', 'seed-user-bob', 'yes', (CAST(strftime('%s','now') AS INTEGER) * 1000)),
  ('seed-poll-option-b', 'seed-user-carol', 'maybe', (CAST(strftime('%s','now') AS INTEGER) * 1000));
