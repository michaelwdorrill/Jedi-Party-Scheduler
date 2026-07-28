-- Lets a cron sweep resume where the previous tick stopped.
--
-- The per-invocation work budget (added in the previous pass) stops a tick
-- cleanly when it runs out of D1 queries or outbound subrequests. That was
-- correct as far as it went, but every sweep restarted its scan from the
-- beginning on the next tick -- so with more events than one tick can afford,
-- the same prefix was scanned every fifteen minutes forever and the events
-- past it were never reached at all. Deferred work was not being delayed, it
-- was being starved: those invitees would simply never get their reminder.
--
-- A cursor makes deferral mean what it says. Each cursored sweep records how
-- far it got, and the next tick picks up from there, wrapping to the start
-- once it has been all the way round.
--
-- The position is an OFFSET into a deterministically ordered scan, not a
-- durable pointer at a particular row: an insert or delete between ticks can
-- shift it, so a given pass may skip or repeat an event. That is fine, and
-- deliberately so -- this is a fairness mechanism, not a correctness one.
-- Correctness comes from the outbox, which will not send a notification twice
-- no matter how many times a sweep visits its event, and will keep it pending
-- until it is sent. All the cursor has to guarantee is that the scan keeps
-- moving, so every event comes up again within a bounded number of ticks.
CREATE TABLE cron_cursors (
  name TEXT PRIMARY KEY,
  position INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
