-- Demo data for v0.4.5: a multi-candidate poll with real availability behind
-- it, so ideas 39, 41 and 42 have something to show.
--
-- Separate from seed-sandbox.sql on purpose. That file exists to make the
-- *cron* fire (idle groups, due reminders, resolving deadlines) and its
-- fixtures are synthetic users nobody logs in as. This one exists to make the
-- *screens* worth looking at, and for that it has to attach to a real
-- account -- a poll nobody is invited to appears on nobody's calendar.
--
-- It therefore keys off two things it looks up rather than hardcodes:
--
--   * the operator's own Discord id, which is OWNER_DISCORD_ID in
--     wrangler.toml and the one real account the sandbox is used from;
--   * whichever server that account is actually an active member of, since
--     the invitee picker, /free-busy and the calendar are all scoped by it.
--
-- NEVER point this at production. Everything it writes is prefixed 'demo-'
-- and deleted on re-run, but it also invites a real person to events and
-- gives synthetic users membership of a real server, which is fine in a
-- sandbox and is not fine anywhere else.
--
-- Usage, from worker/, with the uncleowen credentials active:
--   npm run seed:poll-demo
--
-- Safe to re-run. Times are relative to when it runs, so the poll is always
-- in the near future and always lands in the current or next month view.

DELETE FROM event_window_availability WHERE event_id LIKE 'demo-%';
DELETE FROM event_poll_votes WHERE option_id LIKE 'demo-%';
DELETE FROM event_poll_options WHERE event_id LIKE 'demo-%';
DELETE FROM event_invites WHERE event_id LIKE 'demo-%';
DELETE FROM events WHERE id LIKE 'demo-%';
DELETE FROM personal_events WHERE id LIKE 'demo-%';

-- The seed users need to share the operator's real server, or they cannot be
-- invited to anything in it and /free-busy will not return them. Idempotent,
-- and harmless in a sandbox: it makes three fake people look like members of
-- a server they are not in on Discord's side, which is exactly what a
-- fixture is for. `verified_at` is now, so it is well inside
-- MEMBERSHIP_GRACE_MS and the membership check does not go asking Discord.
INSERT INTO user_guild_membership (user_id, guild_id, is_member, verified_at)
SELECT u.id,
       (SELECT m.guild_id FROM user_guild_membership m
         JOIN guilds g ON g.id = m.guild_id AND g.is_active = 1
        WHERE m.user_id = '346042183486537730' AND m.is_member = 1
        ORDER BY m.verified_at DESC LIMIT 1),
       1,
       (CAST(strftime('%s','now') AS INTEGER) * 1000)
  FROM users u
 WHERE u.id IN ('seed-user-alice', 'seed-user-bob', 'seed-user-carol')
   AND EXISTS (SELECT 1 FROM user_guild_membership m
                WHERE m.user_id = '346042183486537730' AND m.is_member = 1)
ON CONFLICT(user_id, guild_id) DO UPDATE SET
  is_member = 1,
  verified_at = excluded.verified_at;

-- The poll itself: three candidate nights, deadline a week out. Organised by
-- the operator so it needs no invite to be visible, and so the event page
-- shows the organiser's view.
--
-- Deliberately mirrors the shape idea 40 wants to generalise -- two evening
-- slots and one long weekend afternoon -- so the difference between "vote on
-- three fixed slots" and "find 2.5 hours in any of these" is visible on
-- screen while that decision is still open.
INSERT INTO events (id, guild_id, organizer_id, title, description, game, event_type, timezone,
  status, poll_strategy, poll_threshold_count, poll_deadline_at, poll_mode, poll_resolution_mode,
  is_recurring, created_at, updated_at)
SELECT 'demo-poll-nights',
       (SELECT m.guild_id FROM user_guild_membership m
         JOIN guilds g ON g.id = m.guild_id AND g.is_active = 1
        WHERE m.user_id = '346042183486537730' AND m.is_member = 1
        ORDER BY m.verified_at DESC LIMIT 1),
       '346042183486537730',
       'Curse of Strahd — which night?',
       'Three options. Vote for every night you can make.',
       'D&D 5e',
       'poll', 'America/New_York', 'active', 'threshold', 3,
       (CAST(strftime('%s','now') AS INTEGER) * 1000) + 7 * 86400000,
       'options', 'single_winner', 0,
       (CAST(strftime('%s','now') AS INTEGER) * 1000),
       (CAST(strftime('%s','now') AS INTEGER) * 1000)
 WHERE EXISTS (SELECT 1 FROM user_guild_membership m
                WHERE m.user_id = '346042183486537730' AND m.is_member = 1);

-- Candidate slots. Offsets are whole days from now, then a fixed local-ish
-- hour: +1d 19:30-22:00, +2d 19:30-22:00, +5d 13:00-23:00. The third is
-- deliberately ten hours long -- that is the one that makes "any 2.5 hours in
-- here" mean something, and the one whose availability strip has enough span
-- to be worth reading.
INSERT INTO event_poll_options (id, event_id, start_at, end_at, display_order)
SELECT 'demo-opt-1', 'demo-poll-nights',
       (CAST(strftime('%s', date('now','+1 day') || ' 23:30:00') AS INTEGER) * 1000),
       (CAST(strftime('%s', date('now','+2 day') || ' 02:00:00') AS INTEGER) * 1000), 0
 WHERE EXISTS (SELECT 1 FROM events WHERE id = 'demo-poll-nights');
INSERT INTO event_poll_options (id, event_id, start_at, end_at, display_order)
SELECT 'demo-opt-2', 'demo-poll-nights',
       (CAST(strftime('%s', date('now','+2 day') || ' 23:30:00') AS INTEGER) * 1000),
       (CAST(strftime('%s', date('now','+3 day') || ' 02:00:00') AS INTEGER) * 1000), 1
 WHERE EXISTS (SELECT 1 FROM events WHERE id = 'demo-poll-nights');
INSERT INTO event_poll_options (id, event_id, start_at, end_at, display_order)
SELECT 'demo-opt-3', 'demo-poll-nights',
       (CAST(strftime('%s', date('now','+5 day') || ' 17:00:00') AS INTEGER) * 1000),
       (CAST(strftime('%s', date('now','+6 day') || ' 03:00:00') AS INTEGER) * 1000), 2
 WHERE EXISTS (SELECT 1 FROM events WHERE id = 'demo-poll-nights');

-- Everyone on the invite list, including the organiser (migration 0019 made
-- that a real row rather than something folded in by hand).
INSERT INTO event_invites (id, event_id, user_id, invited_via, source_group_id, rsvp_status, invited_at)
SELECT 'demo-inv-' || u.id, 'demo-poll-nights', u.id, 'individual', NULL, 'pending',
       (CAST(strftime('%s','now') AS INTEGER) * 1000)
  FROM users u
 WHERE u.id IN ('346042183486537730', 'seed-user-alice', 'seed-user-bob', 'seed-user-carol')
   AND EXISTS (SELECT 1 FROM events WHERE id = 'demo-poll-nights');

-- Busy time, so the availability strips have something to draw. Without this
-- every bar is empty and "everyone is free" is the only thing idea 39's fix
-- can show -- which is exactly the state that made the old single-day view
-- look like it was working.
--
-- `availability = 'busy'` rather than the `busy` column the first draft of
-- this file used: migration 0005 replaced that boolean with a three-state
-- column, because 'considering' has to mean "still open to others" and so
-- must NOT block free/busy. A test caught the stale column name before this
-- ever reached the sandbox.
--
-- Personal events rather than guild events on purpose: they feed free/busy
-- (that is their whole point) without putting extra chips on the calendar,
-- so the month view still shows the poll's candidates rather than a wall of
-- fixtures. They are private to their owner, so nothing here reveals what
-- anyone is doing -- the strips show opaque busy blocks, as designed.
--
-- Each one deliberately clips a *different* part of the candidates:
--   alice  busy across the first night entirely -> option 1 has a conflict
--   bob    busy for the first half of the long Saturday -> the good 2.5h
--          block on option 3 is the second half
--   carol  busy early evening on night two -> option 2 partially blocked
INSERT INTO personal_events (id, user_id, title, timezone, start_at, end_at, status, availability, is_recurring, created_at, updated_at)
SELECT 'demo-busy-alice', 'seed-user-alice', 'Busy', 'America/New_York',
       (CAST(strftime('%s', date('now','+1 day') || ' 23:00:00') AS INTEGER) * 1000),
       (CAST(strftime('%s', date('now','+2 day') || ' 03:00:00') AS INTEGER) * 1000),
       'active', 'busy', 0,
       (CAST(strftime('%s','now') AS INTEGER) * 1000), (CAST(strftime('%s','now') AS INTEGER) * 1000)
 WHERE EXISTS (SELECT 1 FROM users WHERE id = 'seed-user-alice');

INSERT INTO personal_events (id, user_id, title, timezone, start_at, end_at, status, availability, is_recurring, created_at, updated_at)
SELECT 'demo-busy-bob', 'seed-user-bob', 'Busy', 'America/New_York',
       (CAST(strftime('%s', date('now','+5 day') || ' 16:00:00') AS INTEGER) * 1000),
       (CAST(strftime('%s', date('now','+5 day') || ' 21:00:00') AS INTEGER) * 1000),
       'active', 'busy', 0,
       (CAST(strftime('%s','now') AS INTEGER) * 1000), (CAST(strftime('%s','now') AS INTEGER) * 1000)
 WHERE EXISTS (SELECT 1 FROM users WHERE id = 'seed-user-bob');

INSERT INTO personal_events (id, user_id, title, timezone, start_at, end_at, status, availability, is_recurring, created_at, updated_at)
SELECT 'demo-busy-carol', 'seed-user-carol', 'Busy', 'America/New_York',
       (CAST(strftime('%s', date('now','+2 day') || ' 22:30:00') AS INTEGER) * 1000),
       (CAST(strftime('%s', date('now','+3 day') || ' 00:30:00') AS INTEGER) * 1000),
       'active', 'busy', 0,
       (CAST(strftime('%s','now') AS INTEGER) * 1000), (CAST(strftime('%s','now') AS INTEGER) * 1000)
 WHERE EXISTS (SELECT 1 FROM users WHERE id = 'seed-user-carol');

-- One confirmed event alongside the poll, with a long title and a game, so
-- the month grid shows a solid chip next to the dashed ones and idea 42's
-- two-line layout has something to truncate. Same day as candidate two, so
-- "confirmed" and "maybe" appear in the same week.
INSERT INTO events (id, guild_id, organizer_id, title, description, game, event_type, timezone,
  status, start_at, end_at, poll_mode, poll_resolution_mode, is_recurring, created_at, updated_at)
SELECT 'demo-confirmed', e.guild_id, '346042183486537730',
       'Descent into Avernus (session 14)', NULL, 'D&D 5e', 'single', 'America/New_York', 'active',
       (CAST(strftime('%s', date('now','+3 day') || ' 23:00:00') AS INTEGER) * 1000),
       (CAST(strftime('%s', date('now','+4 day') || ' 02:00:00') AS INTEGER) * 1000),
       'options', 'single_winner', 0,
       (CAST(strftime('%s','now') AS INTEGER) * 1000), (CAST(strftime('%s','now') AS INTEGER) * 1000)
  FROM events e WHERE e.id = 'demo-poll-nights';

INSERT INTO event_invites (id, event_id, user_id, invited_via, source_group_id, rsvp_status, invited_at)
SELECT 'demo-cinv-' || u.id, 'demo-confirmed', u.id, 'individual', NULL,
       CASE WHEN u.id = '346042183486537730' THEN 'accepted' ELSE 'pending' END,
       (CAST(strftime('%s','now') AS INTEGER) * 1000)
  FROM users u
 WHERE u.id IN ('346042183486537730', 'seed-user-alice', 'seed-user-bob')
   AND EXISTS (SELECT 1 FROM events WHERE id = 'demo-confirmed');
