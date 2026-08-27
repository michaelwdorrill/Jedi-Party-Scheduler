// A per-invocation work budget for the scheduled sweep.
//
// The cron's problem was never one expensive record -- it was that the total
// work is a product of things each of which is individually within its own
// limit. One event at the 300-invitee maximum, starting within the hour,
// wanted ~600 notifications; at three D1 statements and one-to-two Discord
// calls each, a single ordinary event could exceed Cloudflare's *Paid*
// per-invocation query allowance and many times over the Free plan's 50
// outbound subrequests -- and that's before the other nine sweeps run.
//
// So the tick gets an explicit allowance and spends it. When it runs out, the
// sweep stops cleanly rather than being killed partway by the platform. That
// matters because the outbox is resumable by construction: an undelivered
// notification simply stays pending (or is never claimed), and the next tick
// -- fifteen minutes later, with a fresh allowance -- picks up close to where
// this one stopped. Two qualifications on "close to", both deliberate:
//
//   - A row whose delivery emptied the last of the budget is still recorded
//     as sent, but the cursor conservatively stays one key behind it rather
//     than advancing past a row it can't prove is finished (see
//     forEachGlobalRow and sweepReminders' `recipientsSettled`), so the next
//     tick briefly re-examines it -- which the outbox dedupes for free.
//   - "Picks up" means the row is *eventually* retried, not that the same
//     sweep that first tried it is what finds it again. A retryable failure
//     sets next_attempt_at, and by the time that's due the row's source
//     event/poll/group may no longer match whatever window the sweep that
//     originally sent it scans by. What actually guarantees the retry isn't
//     stranded is the source-independent consumers (sweepDueNotificationRetries,
//     sweepDueNudgeRetries) that scan the outbox tables directly by
//     next_attempt_at instead of by source state -- see migration 0014.
//
// Stopping early is a delay; being killed mid-flight is a lost or duplicated
// DM.
//
// The numbers come from the plan, since Free and Paid differ by more than an
// order of magnitude. Defaults are the Free-plan figures: assuming the
// smaller allowance on an unconfigured deployment degrades to "slower", while
// assuming the larger one degrades to "fails in production".

// https://developers.cloudflare.com/workers/platform/limits/
// https://developers.cloudflare.com/d1/platform/limits/
const FREE_SUBREQUESTS = 50;
const FREE_D1_QUERIES = 50;
const PAID_SUBREQUESTS = 1000; // far higher in reality; kept conservative
const PAID_D1_QUERIES = 1000;

// Headroom left unspent for the sweeps' own bookkeeping: sixteen sweeps each
// running one or more fixed queries (page reads, poll scans, the
// terminal-history purge, session pruning, the give-up reaper, the two
// source-independent retry consumers added for F-04-H2) regardless of how
// much user data exists.
//
// This is an absolute count, not a fraction, because the overhead it covers
// is roughly constant while the allowance it comes out of differs by a factor
// of twenty between plans. A fraction that leaves enough on Free
// over-reserves enormously on Paid; twenty per cent of the Free plan's fifty
// was ten, which was not enough to cover the overhead it existed for -- so
// the sweeps overspent into the platform ceiling anyway.
// Measured: a tick against an empty database spends 21 queries across its
// original fourteen sweeps. The two invitee-change-request sweeps added in
// docs/specs/0003 (deadline resolution, and a single combined query for both
// opened/decision notifications -- see sweepChangeRequestNotifications in
// cron/reminders.ts, which deliberately merges what could have been two
// separate sweeps into one query specifically to keep this reserve from
// growing by more than it has to) each run one fixed query of their own even
// when empty, the same as every other sweep here; the reserve below is
// bumped to match and re-asserted against a real empty-tick count in
// worker/test/d1limits.test.ts and worker/test/pass9.test.ts rather than
// guessed.
//
// IDEAS item 47's reminders for confirmed multi-winner days deliberately do
// NOT appear here, and that is worth recording: they were first written as a
// sweep of their own, which cost one more fixed query per tick and pushed
// this to 25. Measuring what that did was alarming out of proportion to the
// change -- sweepPurgeTerminalHistory stopped running *entirely*, not just
// later, because one less query of usable allowance left it permanently
// short of what it needs to start. The reminders were folded into
// sweepConfirmedMultiWinnerOptions instead, which already scans exactly
// those rows, so the fixed cost is unchanged and this stays at 24.
const RESERVED_QUERIES = 24;
const RESERVED_SUBREQUESTS = 4;

// What one delivery attempt actually costs, which is not one number: the
// first DM to a user has to open a DM channel first (a second Discord call)
// and then cache the resulting channel id (a third statement). Every DM after
// that reuses the cached channel. Charging the worst case for every delivery
// halved the tick's throughput for a cost that is only paid once per user.
const COST_UNCACHED = { subrequests: 2, queries: 3 };
const COST_CACHED = { subrequests: 1, queries: 2 };

export type WorkersPlan = 'free' | 'paid';

export function planFrom(value: string | undefined): WorkersPlan {
  return value?.trim().toLowerCase() === 'paid' ? 'paid' : 'free';
}

export class TickBudget {
  private subrequests: number;
  private queries: number;

  constructor(plan: WorkersPlan) {
    const subrequests = plan === 'paid' ? PAID_SUBREQUESTS : FREE_SUBREQUESTS;
    const queries = plan === 'paid' ? PAID_D1_QUERIES : FREE_D1_QUERIES;
    this.subrequests = Math.max(0, subrequests - RESERVED_SUBREQUESTS);
    this.queries = Math.max(0, queries - RESERVED_QUERIES);
  }

  // Reserves one delivery attempt, in full and before anything is spent on
  // it. `cachedChannel` says whether this recipient's DM channel id is
  // already known, which decides both how many Discord calls and how many
  // statements the attempt will take.
  //
  // Returns false when the tick can no longer afford it, which is the
  // caller's signal to stop -- not to skip this item and try the next, since
  // the next costs at least as much.
  reserveDelivery(cachedChannel: boolean): boolean {
    const cost = cachedChannel ? COST_CACHED : COST_UNCACHED;
    if (this.subrequests < cost.subrequests || this.queries < cost.queries) return false;
    this.subrequests -= cost.subrequests;
    this.queries -= cost.queries;
    return true;
  }

  // Returns a reservation for a delivery that never happened -- the row was
  // already settled, backing off, or claimed elsewhere. One statement is kept
  // back because the claim attempt that discovered this really did run.
  //
  // Without the refund, reserving before claiming would make every settled
  // row a tick merely *looks* at cost as much as a real send, and a large
  // delivered backlog would exhaust the allowance without a DM going out.
  refundUnsentDelivery(cachedChannel: boolean): void {
    const cost = cachedChannel ? COST_CACHED : COST_UNCACHED;
    this.subrequests += cost.subrequests;
    this.queries += cost.queries - 1;
  }

  // Charges queries the tick spends looking for work, as opposed to doing it:
  // per-event participant lists, settled-set lookups, page reads.
  //
  // Deliveries were never the only cost that scales with the install. A guild
  // with a hundred events in the next day pays a couple of queries per event
  // per tick just to discover there is nothing to send, and none of that was
  // deducted from the allowance the deliveries drew on -- so a tick could sit
  // at "budget not exhausted" while already well past the platform ceiling.
  // Charging the scan makes `exhausted` mean what its callers assume: the
  // tick is out of allowance, whatever it was being spent on.
  trySpend(queries: number): boolean {
    if (this.queries < queries) return false;
    this.queries -= queries;
    return true;
  }

  // A live Discord membership check: one subrequest, and at most one write to
  // record the result.
  tryMembershipCheck(): boolean {
    if (this.subrequests < 1 || this.queries < 1) return false;
    this.subrequests -= 1;
    this.queries -= 1;
    return true;
  }

  // An upper bound on how many more deliveries this tick could fund, used to
  // size the LIMIT on recipient queries. Deliberately optimistic (it assumes
  // the cheap, cached-channel case): the point is to stop a sweep asking the
  // database for hundreds of candidates it cannot possibly get to, not to
  // predict the exact stopping point.
  get deliveriesAffordable(): number {
    return Math.max(
      0,
      Math.min(
        Math.floor(this.subrequests / COST_CACHED.subrequests),
        Math.floor(this.queries / COST_CACHED.queries),
      ),
    );
  }

  get exhausted(): boolean {
    return this.subrequests < COST_CACHED.subrequests || this.queries < COST_CACHED.queries;
  }

  // For logging at the end of a tick, so an operator can see whether the
  // sweep is routinely running out (which means work is being deferred every
  // tick and the plan or the limits need revisiting) or comfortably finishing.
  remaining(): { subrequests: number; queries: number } {
    return { subrequests: this.subrequests, queries: this.queries };
  }
}
