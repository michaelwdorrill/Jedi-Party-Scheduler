-- A fixture for verifying v0.5's DM controls (docs/specs/0010).
--
-- Neither existing seed produces a DM you can press, and both fail for a
-- reason worth writing down rather than rediscovering:
--
--   * seed-sandbox.sql invites synthetic users only. Their Discord ids do not
--     exist, so every DM it triggers fails at Discord rather than arriving.
--   * seed-poll-demo.sql does attach to the operator's real account, but it
--     makes them the *organizer* of everything -- and sweepNewInvites
--     deliberately skips `ei.user_id != e.organizer_id`, because otherwise
--     every organizer would be DM'd "You've been invited to the event you
--     created". Its poll deadline is a week out and its confirmed event is
--     three days out, so the deadline and reminder sweeps have nothing due
--     either.
--
-- So this seeds the one shape the others do not: events organised by *someone
-- else* that invite you, due soon enough for the sweeps to act on this tick.
-- Two of them, because the two control types are different code paths:
--
--   demo-btn-fixed    a fixed-time event  -> three RSVP buttons
--   demo-btn-poll     an options poll     -> a select of the candidates
--
-- Depends on both of the others, in order, and the split is not obvious:
-- seed-sandbox.sql is what creates the seed users at all, and
-- seed-poll-demo.sql is what gives them membership of your *real* server --
-- which this needs, because an event on your real guild organised by someone
-- who is not in it is not a shape the app would ever produce.
--
--   npm run seed:sandbox
--   npm run seed:poll-demo
--   npm run seed:button-demo
--
-- Every insert is guarded on the operator actually being an active member of
-- an active guild, so a machine where that is not true produces a clean no-op
-- rather than the foreign-key error item 38 was.
--
-- **Expect the two DMs to arrive on different ticks.** A freshly re-run
-- seed-sandbox.sql leaves a backlog of notifications addressed to synthetic
-- users, and on the Free plan's per-tick allowance the sweep spends itself on
-- those before it reaches these. Nothing is lost -- the outbox is resumable,
-- and each tick picks up where the last stopped -- but the second DM can be
-- fifteen minutes behind the first, which looks like a fault if you are not
-- expecting it. There is a test for this in test/dmComponents.test.ts, and it
-- runs four ticks for exactly this reason.

DELETE FROM notification_log WHERE event_id LIKE 'demo-btn-%';
DELETE FROM event_poll_votes WHERE option_id LIKE 'demo-btn-%';
DELETE FROM event_poll_options WHERE event_id LIKE 'demo-btn-%';
DELETE FROM event_invites WHERE event_id LIKE 'demo-btn-%';
DELETE FROM events WHERE id LIKE 'demo-btn-%';

-- ---------------------------------------------------------------------------
-- 1. A fixed-time event someone else is running, starting in three hours.
--
-- Three hours rather than tomorrow: it puts the event inside the 1-hour
-- reminder's *and* the 24-hour reminder's window on the same tick, so if the
-- invite DM is somehow missed there is a second chance to see the buttons.
-- (They are mutually exclusive per tick -- see reminderFor -- so this
-- produces one reminder, not two.)
INSERT INTO events (id, guild_id, organizer_id, title, description, game, event_type, timezone,
  status, start_at, end_at, poll_mode, poll_resolution_mode, is_recurring, created_at, updated_at)
SELECT 'demo-btn-fixed',
       (SELECT m.guild_id FROM user_guild_membership m
         JOIN guilds g ON g.id = m.guild_id AND g.is_active = 1
        WHERE m.user_id = '346042183486537730' AND m.is_member = 1
        ORDER BY m.verified_at DESC LIMIT 1),
       'seed-user-alice',
       'Button check (fixed time)',
       'Press one of the three buttons. The message should rewrite itself.',
       'D&D 5e', 'single', 'America/New_York', 'active',
       (CAST(strftime('%s','now') AS INTEGER) * 1000) + 3 * 3600000,
       (CAST(strftime('%s','now') AS INTEGER) * 1000) + 6 * 3600000,
       'options', 'single_winner', 0,
       (CAST(strftime('%s','now') AS INTEGER) * 1000),
       (CAST(strftime('%s','now') AS INTEGER) * 1000)
 WHERE EXISTS (SELECT 1 FROM users WHERE id = 'seed-user-alice')
   AND EXISTS (SELECT 1 FROM user_guild_membership m
                JOIN guilds g ON g.id = m.guild_id AND g.is_active = 1
               WHERE m.user_id = '346042183486537730' AND m.is_member = 1);

INSERT INTO event_invites (id, event_id, user_id, invited_via, source_group_id, rsvp_status, invited_at)
SELECT 'demo-btn-inv-' || u.id, 'demo-btn-fixed', u.id, 'individual', NULL, 'pending',
       (CAST(strftime('%s','now') AS INTEGER) * 1000)
  FROM users u
 WHERE u.id IN ('346042183486537730', 'seed-user-bob')
   AND EXISTS (SELECT 1 FROM events WHERE id = 'demo-btn-fixed');

-- ---------------------------------------------------------------------------
-- 2. An options poll someone else is running, with three candidate nights.
--
-- The deadline is deliberately inside 24 hours, which is what makes the
-- deadline sweep DM the people who have not voted -- you, since this seed
-- casts no vote for you. That DM carries the same select as the invite does,
-- so it is a second route to the control if the invite is missed.
INSERT INTO events (id, guild_id, organizer_id, title, description, game, event_type, timezone,
  status, poll_strategy, poll_threshold_count, poll_deadline_at, poll_mode, poll_resolution_mode,
  is_recurring, created_at, updated_at)
SELECT 'demo-btn-poll',
       (SELECT guild_id FROM events WHERE id = 'demo-btn-fixed'),
       'seed-user-alice',
       'Button check (which nights?)',
       'Pick every night that works. Unpicked nights record no vote at all.',
       'D&D 5e', 'poll', 'America/New_York', 'active', 'threshold', 3,
       (CAST(strftime('%s','now') AS INTEGER) * 1000) + 6 * 3600000,
       'options', 'single_winner', 0,
       (CAST(strftime('%s','now') AS INTEGER) * 1000),
       (CAST(strftime('%s','now') AS INTEGER) * 1000)
 WHERE EXISTS (SELECT 1 FROM events WHERE id = 'demo-btn-fixed');

INSERT INTO event_poll_options (id, event_id, start_at, end_at, display_order)
SELECT 'demo-btn-opt-1', 'demo-btn-poll',
       (CAST(strftime('%s', date('now','+1 day') || ' 23:30:00') AS INTEGER) * 1000),
       (CAST(strftime('%s', date('now','+2 day') || ' 02:00:00') AS INTEGER) * 1000), 0
 WHERE EXISTS (SELECT 1 FROM events WHERE id = 'demo-btn-poll');
INSERT INTO event_poll_options (id, event_id, start_at, end_at, display_order)
SELECT 'demo-btn-opt-2', 'demo-btn-poll',
       (CAST(strftime('%s', date('now','+2 day') || ' 23:30:00') AS INTEGER) * 1000),
       (CAST(strftime('%s', date('now','+3 day') || ' 02:00:00') AS INTEGER) * 1000), 1
 WHERE EXISTS (SELECT 1 FROM events WHERE id = 'demo-btn-poll');
INSERT INTO event_poll_options (id, event_id, start_at, end_at, display_order)
SELECT 'demo-btn-opt-3', 'demo-btn-poll',
       (CAST(strftime('%s', date('now','+5 day') || ' 17:00:00') AS INTEGER) * 1000),
       (CAST(strftime('%s', date('now','+6 day') || ' 03:00:00') AS INTEGER) * 1000), 2
 WHERE EXISTS (SELECT 1 FROM events WHERE id = 'demo-btn-poll');

INSERT INTO event_invites (id, event_id, user_id, invited_via, source_group_id, rsvp_status, invited_at)
SELECT 'demo-btn-pinv-' || u.id, 'demo-btn-poll', u.id, 'individual', NULL, 'pending',
       (CAST(strftime('%s','now') AS INTEGER) * 1000)
  FROM users u
 WHERE u.id IN ('346042183486537730', 'seed-user-bob')
   AND EXISTS (SELECT 1 FROM events WHERE id = 'demo-btn-poll');
