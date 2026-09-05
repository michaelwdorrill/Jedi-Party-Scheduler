-- Demo data for v0.8 (IDEAS item 2 / specs/0017): four events chosen so that
-- verifying Google Calendar sync proves something in both directions.
--
-- Two of them MUST appear on the connected Google calendar, and two of them
-- MUST NOT. That second half is the point. A test that only checks "my session
-- showed up" cannot tell a working sync from one that pushes everything it can
-- see -- and what this feature must never push (a poll's proposed nights, a
-- session you declined) is precisely the privacy-relevant half.
--
-- Expected result after one cron tick with a connected calendar:
--
--   gdemo-fixed     Tuesday Night Heist       +3 days          APPEARS
--   gdemo-weekly    Weekly Session            every 7 days     APPEARS (~8 entries in 60d)
--   gdemo-declined  Session You Declined      +4 days          ABSENT
--   gdemo-poll      Which night suits?        3 candidates     ABSENT
--
-- Same conventions as seed-poll-demo.sql, and for the same reasons: it keys off
-- the operator's real Discord id (OWNER_DISCORD_ID) and whichever allow-listed
-- server that account is actually an active member of, because an event nobody
-- is invited to appears on nobody's calendar. Everything it writes is prefixed
-- 'gdemo-' and deleted on re-run, so it is safe to run repeatedly.
--
-- NEVER point this at production. It invites a real person to synthetic events
-- and gives a synthetic user membership of a real server -- fine in a sandbox,
-- not fine anywhere else.
--
-- Usage, from worker/, with the uncleowen credentials active:
--   npm run seed:google-demo

-- Children before parents: google_event_links references events(id) with no
-- ON DELETE action (migration 0036), so a re-run has to clear the links before
-- the events they point at -- the same FK ordering deleteUserCompletely and the
-- terminal-history purge both spell out.
DELETE FROM google_event_links WHERE event_id LIKE 'gdemo-%';
DELETE FROM event_attendance WHERE event_id LIKE 'gdemo-%';
DELETE FROM event_poll_votes WHERE option_id LIKE 'gdemo-%';
DELETE FROM event_poll_options WHERE event_id LIKE 'gdemo-%';
DELETE FROM event_invites WHERE event_id LIKE 'gdemo-%';
DELETE FROM event_recurrence_rules WHERE event_id LIKE 'gdemo-%';
DELETE FROM events WHERE id LIKE 'gdemo-%';

-- An organiser for the two events the operator is merely *invited* to. Being
-- an invitee rather than the organiser is what makes the declined case
-- possible at all -- an organiser cannot be un-invited from their own event.
INSERT INTO users (id, username, global_name, avatar_hash, timezone, notifications_enabled,
                   created_at, updated_at, accepted_policy_version, accepted_policy_at)
VALUES ('gdemo-user-dm', 'gdemo-dungeon-master', 'The DM', NULL, 'America/New_York', 0,
        (CAST(strftime('%s','now') AS INTEGER) * 1000),
        (CAST(strftime('%s','now') AS INTEGER) * 1000), 3,
        (CAST(strftime('%s','now') AS INTEGER) * 1000))
ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at;

-- notifications_enabled = 0 above is deliberate: this fixture exists to be
-- looked at on a calendar, not to make the bot DM anyone about it.

INSERT INTO user_guild_membership (user_id, guild_id, is_member, verified_at)
SELECT 'gdemo-user-dm',
       (SELECT m.guild_id FROM user_guild_membership m
         JOIN guilds g ON g.id = m.guild_id AND g.is_active = 1
        WHERE m.user_id = '346042183486537730' AND m.is_member = 1
        ORDER BY m.verified_at DESC LIMIT 1),
       1,
       (CAST(strftime('%s','now') AS INTEGER) * 1000)
 WHERE EXISTS (SELECT 1 FROM user_guild_membership m
                WHERE m.user_id = '346042183486537730' AND m.is_member = 1)
ON CONFLICT(user_id, guild_id) DO UPDATE SET
  is_member = 1,
  verified_at = excluded.verified_at;

-- ---------------------------------------------------------------------------
-- 1. APPEARS: an ordinary fixed session the operator organises, +3 days.
-- ---------------------------------------------------------------------------
INSERT INTO events (id, guild_id, organizer_id, title, description, game, event_type, timezone,
  start_at, end_at, status, poll_mode, poll_resolution_mode, is_recurring, created_at, updated_at)
SELECT 'gdemo-fixed',
       (SELECT m.guild_id FROM user_guild_membership m
         JOIN guilds g ON g.id = m.guild_id AND g.is_active = 1
        WHERE m.user_id = '346042183486537730' AND m.is_member = 1
        ORDER BY m.verified_at DESC LIMIT 1),
       '346042183486537730',
       'Tuesday Night Heist',
       'THIS DESCRIPTION MUST NOT REACH GOOGLE. If you can see this text in the Google calendar entry, that is a bug.',
       'Blades in the Dark',
       'single', 'America/New_York',
       (CAST(strftime('%s', date('now','+3 day') || ' 23:30:00') AS INTEGER) * 1000),
       (CAST(strftime('%s', date('now','+4 day') || ' 02:30:00') AS INTEGER) * 1000),
       'active', 'options', 'single_winner', 0,
       (CAST(strftime('%s','now') AS INTEGER) * 1000),
       (CAST(strftime('%s','now') AS INTEGER) * 1000)
 WHERE EXISTS (SELECT 1 FROM user_guild_membership m
                WHERE m.user_id = '346042183486537730' AND m.is_member = 1);

-- The description above is a live assertion, not flavour text. specs/0017
-- says event descriptions are never sent to Google; this is how you check that
-- by looking rather than by trusting.

-- ---------------------------------------------------------------------------
-- 2. APPEARS: a weekly recurring series, which is the case that exercises
--    per-occurrence pushing -- roughly eight separate Google entries inside
--    the 60-day window rather than one repeating one. specs/0017 chose that
--    over an RRULE translation deliberately.
-- ---------------------------------------------------------------------------
INSERT INTO events (id, guild_id, organizer_id, title, description, game, event_type, timezone,
  start_at, end_at, status, poll_mode, poll_resolution_mode, is_recurring, created_at, updated_at)
SELECT 'gdemo-weekly',
       (SELECT m.guild_id FROM user_guild_membership m
         JOIN guilds g ON g.id = m.guild_id AND g.is_active = 1
        WHERE m.user_id = '346042183486537730' AND m.is_member = 1
        ORDER BY m.verified_at DESC LIMIT 1),
       '346042183486537730',
       'Weekly Session',
       NULL,
       'D&D 5e',
       'single', 'America/New_York',
       NULL, NULL,
       'active', 'options', 'single_winner', 1,
       (CAST(strftime('%s','now') AS INTEGER) * 1000),
       (CAST(strftime('%s','now') AS INTEGER) * 1000)
 WHERE EXISTS (SELECT 1 FROM user_guild_membership m
                WHERE m.user_id = '346042183486537730' AND m.is_member = 1);

-- start_at/end_at are NULL on a recurring event by design -- the rule below is
-- what decides when it happens. Weekday is left unset so the series simply
-- runs every 7 days from tomorrow, which avoids depending on what day of the
-- week you happen to run this.
INSERT INTO event_recurrence_rules (event_id, freq, interval, by_weekday, by_month_day,
  start_date, start_time, duration_minutes, end_type, end_date, end_count)
SELECT 'gdemo-weekly', 'WEEKLY', 1, NULL, NULL,
       date('now','+1 day'), '19:30', 150, 'never', NULL, NULL
 WHERE EXISTS (SELECT 1 FROM events WHERE id = 'gdemo-weekly');

-- ---------------------------------------------------------------------------
-- 3. ABSENT: an event the operator was invited to and declined. A declined
--    session must never be written to a real calendar -- that is a commitment
--    the person has explicitly refused.
-- ---------------------------------------------------------------------------
INSERT INTO events (id, guild_id, organizer_id, title, description, game, event_type, timezone,
  start_at, end_at, status, poll_mode, poll_resolution_mode, is_recurring, created_at, updated_at)
SELECT 'gdemo-declined',
       (SELECT m.guild_id FROM user_guild_membership m
         JOIN guilds g ON g.id = m.guild_id AND g.is_active = 1
        WHERE m.user_id = '346042183486537730' AND m.is_member = 1
        ORDER BY m.verified_at DESC LIMIT 1),
       'gdemo-user-dm',
       'Session You Declined (must NOT sync)',
       NULL, 'Call of Cthulhu',
       'single', 'America/New_York',
       (CAST(strftime('%s', date('now','+4 day') || ' 23:00:00') AS INTEGER) * 1000),
       (CAST(strftime('%s', date('now','+5 day') || ' 02:00:00') AS INTEGER) * 1000),
       'active', 'options', 'single_winner', 0,
       (CAST(strftime('%s','now') AS INTEGER) * 1000),
       (CAST(strftime('%s','now') AS INTEGER) * 1000)
 WHERE EXISTS (SELECT 1 FROM user_guild_membership m
                WHERE m.user_id = '346042183486537730' AND m.is_member = 1);

INSERT INTO event_invites (id, event_id, user_id, invited_via, rsvp_status, invited_at)
SELECT 'gdemo-inv-declined', 'gdemo-declined', '346042183486537730', 'individual', 'declined',
       (CAST(strftime('%s','now') AS INTEGER) * 1000)
 WHERE EXISTS (SELECT 1 FROM events WHERE id = 'gdemo-declined');

-- Since specs/0014 the answer that actually counts lives in event_attendance,
-- keyed per occurrence ('' meaning "the whole event" for a non-recurring one).
-- event_invites.rsvp_status above is the legacy column; this row is the one
-- the sync sweep reads.
INSERT INTO event_attendance (id, event_id, occurrence_date, user_id, rsvp_status, responded_at)
SELECT 'gdemo-att-declined', 'gdemo-declined', '', '346042183486537730', 'declined',
       (CAST(strftime('%s','now') AS INTEGER) * 1000)
 WHERE EXISTS (SELECT 1 FROM events WHERE id = 'gdemo-declined');

-- ---------------------------------------------------------------------------
-- 4. ABSENT: an open poll with three candidate nights. A maybe is not a
--    commitment -- the same rule lib/freeBusy.ts applies to busy time. Without
--    this, an unresolved poll would put three provisional Tuesdays on a real
--    calendar.
-- ---------------------------------------------------------------------------
INSERT INTO events (id, guild_id, organizer_id, title, description, game, event_type, timezone,
  status, poll_strategy, poll_threshold_count, poll_deadline_at, poll_mode, poll_resolution_mode,
  is_recurring, created_at, updated_at)
SELECT 'gdemo-poll',
       (SELECT m.guild_id FROM user_guild_membership m
         JOIN guilds g ON g.id = m.guild_id AND g.is_active = 1
        WHERE m.user_id = '346042183486537730' AND m.is_member = 1
        ORDER BY m.verified_at DESC LIMIT 1),
       'gdemo-user-dm',
       'Which night suits? (must NOT sync)',
       'An open poll. None of these nights is settled yet.',
       'Pathfinder',
       'poll', 'America/New_York', 'active', 'threshold', 3,
       (CAST(strftime('%s','now') AS INTEGER) * 1000) + 7 * 86400000,
       'options', 'single_winner', 0,
       (CAST(strftime('%s','now') AS INTEGER) * 1000),
       (CAST(strftime('%s','now') AS INTEGER) * 1000)
 WHERE EXISTS (SELECT 1 FROM user_guild_membership m
                WHERE m.user_id = '346042183486537730' AND m.is_member = 1);

INSERT INTO event_invites (id, event_id, user_id, invited_via, rsvp_status, invited_at)
SELECT 'gdemo-inv-poll', 'gdemo-poll', '346042183486537730', 'individual', 'pending',
       (CAST(strftime('%s','now') AS INTEGER) * 1000)
 WHERE EXISTS (SELECT 1 FROM events WHERE id = 'gdemo-poll');

INSERT INTO event_poll_options (id, event_id, start_at, end_at, display_order)
SELECT 'gdemo-opt-1', 'gdemo-poll',
       (CAST(strftime('%s', date('now','+6 day') || ' 23:30:00') AS INTEGER) * 1000),
       (CAST(strftime('%s', date('now','+7 day') || ' 02:00:00') AS INTEGER) * 1000), 0
 WHERE EXISTS (SELECT 1 FROM events WHERE id = 'gdemo-poll');
INSERT INTO event_poll_options (id, event_id, start_at, end_at, display_order)
SELECT 'gdemo-opt-2', 'gdemo-poll',
       (CAST(strftime('%s', date('now','+8 day') || ' 23:30:00') AS INTEGER) * 1000),
       (CAST(strftime('%s', date('now','+9 day') || ' 02:00:00') AS INTEGER) * 1000), 1
 WHERE EXISTS (SELECT 1 FROM events WHERE id = 'gdemo-poll');
INSERT INTO event_poll_options (id, event_id, start_at, end_at, display_order)
SELECT 'gdemo-opt-3', 'gdemo-poll',
       (CAST(strftime('%s', date('now','+10 day') || ' 17:00:00') AS INTEGER) * 1000),
       (CAST(strftime('%s', date('now','+10 day') || ' 23:00:00') AS INTEGER) * 1000), 2
 WHERE EXISTS (SELECT 1 FROM events WHERE id = 'gdemo-poll');
