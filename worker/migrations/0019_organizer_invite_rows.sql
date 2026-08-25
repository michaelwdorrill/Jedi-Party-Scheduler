-- The organizer of an event is on its invite list (IDEAS.md item 26).
--
-- Found on the sandbox while verifying v0.4: on a fixed-time event you
-- organised, "I'm in / Maybe / Can't make it" rendered and did nothing.
-- `POST /events/:eventId/rsvp` is
-- `UPDATE event_invites ... WHERE event_id = ? AND user_id = ?` followed by a
-- 403 when nothing matched -- and an organizer had no row, because the model
-- folded them in by hand with `... UNION SELECT <organizer>` everywhere it
-- needed them. So the update matched nothing and the app told the organizer
-- they were not invited to their own event.
--
-- It looked arbitrary because it was intermittent: a *group* event whose
-- organizer is in one of the invited groups gets a row through ordinary group
-- resolution (and since migration 0017 a group's creator is always a member of
-- their group), so RSVP worked there and had always worked. Only a non-group
-- event -- individual invitees, or none -- left the organizer without a row.
--
-- The decision, from IDEAS.md item 26: give them a real row rather than hiding
-- the buttons. Hiding them is cheaper and matches the model as built, but it
-- costs the ability to say you can't make your own session, which is a genuine
-- case -- the DM can be ill.
--
-- 'accepted', not the 'pending' default: the organizer is the one person whose
-- attendance is not in question until they say otherwise.
--
-- Applied retroactively for the same reason 0017 was: the alternative leaves
-- every existing event permanently wrong in a way only its organizer can see,
-- and only by clicking a button that appears to be broken.
--
-- Two visible consequences, both intended. An organizer now appears in the
-- event's "Invited" list (previously they appeared only in "Organized by"),
-- and a time-change request's vote threshold no longer counts them -- see
-- lib/changeRequests.ts, where excluding them from the count is what the spec
-- said all along.

-- Suppressor rows FIRST, before the invites they suppress exist.
--
-- `cron/sweepNewInvites` DMs "You've been invited to X" for any event_invites
-- row with no delivered notification_log entry. The deployed code guards
-- against that with `ei.user_id != e.organizer_id`, but migrations are applied
-- *before* the Worker is deployed (see deploy-worker.yml), so for the minute
-- or two in between, the old code is live against the new rows -- and a cron
-- tick landing in that window would DM every organizer once per event they
-- have ever run. Writing the settled log rows first closes that window
-- outright rather than betting on the timing.
--
-- delivered_at is set to the same instant as sent_at: these notifications are
-- not pending, deferred or failed -- they are ones that never needed to exist.
--
-- The ids are `lower(hex(randomblob(16)))` rather than the app's UUID shape.
-- Nothing reads or parses an id in either table -- they are opaque primary
-- keys -- and the SQLite expression for a formatted v4 UUID is six nested
-- substr calls that would obscure what these two statements actually do.
INSERT INTO notification_log (id, user_id, event_id, notification_type, occurrence_date, sent_at, delivered_at)
SELECT lower(hex(randomblob(16))), e.organizer_id, e.id, 'invite', '', (CAST(strftime('%s','now') AS INTEGER) * 1000), (CAST(strftime('%s','now') AS INTEGER) * 1000)
FROM events e
WHERE NOT EXISTS (
        SELECT 1 FROM event_invites ei WHERE ei.event_id = e.id AND ei.user_id = e.organizer_id
      )
  AND NOT EXISTS (
        SELECT 1 FROM notification_log nl
        WHERE nl.user_id = e.organizer_id AND nl.event_id = e.id
          AND nl.notification_type = 'invite' AND nl.occurrence_date = ''
      );

-- NOT EXISTS rather than INSERT OR IGNORE, following 0017: an organizer who
-- had already invited themselves is skipped either way, but the explicit
-- predicate says so at a glance -- and, more importantly here, it leaves their
-- existing row's rsvp_status alone. Someone who had already declined an event
-- they organised must not be quietly re-accepted by a backfill.
--
-- invited_via 'individual': the CHECK constraint allows only 'individual' or
-- 'group', and of the two the organizer is plainly not group-derived. Adding
-- an 'organizer' value would mean rebuilding the table, which is a great deal
-- of risk to buy a label that nothing reads.
--
-- invited_at is the event's creation time, not now: they have been on this
-- event since it existed, and dating the row today would misreport that in the
-- one place it is visible.
INSERT INTO event_invites (id, event_id, user_id, invited_via, source_group_id, rsvp_status, invited_at)
SELECT lower(hex(randomblob(16))), e.id, e.organizer_id, 'individual', NULL, 'accepted', e.created_at
FROM events e
WHERE NOT EXISTS (
  SELECT 1 FROM event_invites ei WHERE ei.event_id = e.id AND ei.user_id = e.organizer_id
);
