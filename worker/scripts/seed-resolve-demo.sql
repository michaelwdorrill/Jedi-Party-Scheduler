-- A poll that is about to settle, for verifying specs/0010's edit-on-resolve.
--
-- The thing under test is awkward to produce by hand: you need a poll whose
-- vote DM has already been *delivered* (so the app knows the message id it
-- has to edit), and which then resolves. Waiting for that naturally means
-- creating a poll, waiting a tick for the DM, voting, and waiting for a
-- deadline.
--
-- So this seeds the first half and leaves the second to a real vote. Run it,
-- wait for the DM with the dropdown, then pick a night. The poll's threshold
-- is 1, so your own vote resolves it, and the next tick should rewrite the
-- DM you just answered.
--
-- Depends on seed-sandbox.sql and seed-poll-demo.sql, in that order, for the
-- seed users and their membership of your real server -- same chain as
-- seed-button-demo.sql, and for the same reasons.
--
-- Usage: npm run seed:resolve-demo

DELETE FROM notification_log WHERE event_id LIKE 'demo-resolve%';
DELETE FROM event_poll_votes WHERE option_id LIKE 'demo-resolve%';
DELETE FROM event_poll_options WHERE event_id LIKE 'demo-resolve%';
DELETE FROM event_invites WHERE event_id LIKE 'demo-resolve%';
DELETE FROM events WHERE id LIKE 'demo-resolve%';

-- Organised by someone else, so the invite sweep actually DMs the operator:
-- sweepNewInvites skips an organizer's own row (idea 26).
INSERT INTO events (id, guild_id, organizer_id, title, description, game, event_type, timezone,
  status, poll_strategy, poll_threshold_count, poll_deadline_at, poll_mode, poll_resolution_mode,
  is_recurring, created_at, updated_at)
SELECT 'demo-resolve',
       (SELECT m.guild_id FROM user_guild_membership m
         JOIN guilds g ON g.id = m.guild_id AND g.is_active = 1
        WHERE m.user_id = '346042183486537730' AND m.is_member = 1
        ORDER BY m.verified_at DESC LIMIT 1),
       'seed-user-alice',
       'Resolve check — pick one and watch',
       'Your vote alone settles this poll. The DM should rewrite itself.',
       'D&D 5e', 'poll', 'America/New_York', 'active',
       -- Threshold of one: the point is to watch the edit, not to round up a
       -- quorum. checkThresholdAndResolve fires synchronously on the vote.
       'threshold', 1,
       (CAST(strftime('%s','now') AS INTEGER) * 1000) + 3 * 86400000,
       'options', 'single_winner', 0,
       (CAST(strftime('%s','now') AS INTEGER) * 1000),
       (CAST(strftime('%s','now') AS INTEGER) * 1000)
 WHERE EXISTS (SELECT 1 FROM users WHERE id = 'seed-user-alice')
   AND EXISTS (SELECT 1 FROM user_guild_membership m
                JOIN guilds g ON g.id = m.guild_id AND g.is_active = 1
               WHERE m.user_id = '346042183486537730' AND m.is_member = 1);

INSERT INTO event_poll_options (id, event_id, start_at, end_at, display_order)
SELECT 'demo-resolve-a', 'demo-resolve',
       (CAST(strftime('%s', date('now','+4 day') || ' 23:30:00') AS INTEGER) * 1000),
       (CAST(strftime('%s', date('now','+5 day') || ' 02:30:00') AS INTEGER) * 1000), 0
 WHERE EXISTS (SELECT 1 FROM events WHERE id = 'demo-resolve');
INSERT INTO event_poll_options (id, event_id, start_at, end_at, display_order)
SELECT 'demo-resolve-b', 'demo-resolve',
       (CAST(strftime('%s', date('now','+6 day') || ' 23:30:00') AS INTEGER) * 1000),
       (CAST(strftime('%s', date('now','+7 day') || ' 02:30:00') AS INTEGER) * 1000), 1
 WHERE EXISTS (SELECT 1 FROM events WHERE id = 'demo-resolve');

INSERT INTO event_invites (id, event_id, user_id, invited_via, source_group_id, rsvp_status, invited_at)
SELECT 'demo-resolve-inv-' || u.id, 'demo-resolve', u.id, 'individual', NULL, 'pending',
       (CAST(strftime('%s','now') AS INTEGER) * 1000)
  FROM users u
 WHERE u.id IN ('346042183486537730', 'seed-user-bob')
   AND EXISTS (SELECT 1 FROM events WHERE id = 'demo-resolve');
