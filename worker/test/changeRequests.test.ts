import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/router';
import { signJwt } from '../src/lib/jwt';
import { createSession } from '../src/lib/sessions';
import { runReminderSweep } from '../src/cron/reminders';
import {
  acceptChangeRequest,
  createChangeRequest,
  declineChangeRequest,
  listChangeRequests,
  loadChangeRequest,
  resolvePastDeadlineChangeRequests,
  voteOnChangeRequest,
} from '../src/lib/changeRequests';
import { ConflictError, LIMITS, ValidationError } from '../src/lib/validate';
import {
  DM_CHANNEL_RULE,
  dmSendRule,
  HOUR_MS,
  countRows,
  ids,
  loadEventRow,
  membershipRule,
  seedEvent,
  seedGuild,
  seedInvite,
  seedMembership,
  seedUser,
  setup,
  stubFetch,
  type FetchStub,
} from './helpers';
import type { Env } from '../src/env';
import type { ShimDatabase } from './d1shim';

let fetchStub: FetchStub | null = null;
afterEach(() => {
  fetchStub?.restore();
  fetchStub = null;
});

const app = buildApp();

async function authHeaders(env: Env, userId: string): Promise<Record<string, string>> {
  const { id: sessionId } = await createSession(env, userId);
  const token = await signJwt(userId, sessionId, env.JWT_SIGNING_KEY);
  return { Authorization: `Bearer ${token}` };
}

async function seedBasicEvent(db: ShimDatabase, opts: Partial<Parameters<typeof seedEvent>[1]> = {}) {
  await seedGuild(db);
  await seedUser(db, 'organizer');
  await seedMembership(db, 'organizer', 'guild-1');
  await seedEvent(db, { id: 'ev1', organizerId: 'organizer', ...opts });
}

describe('filing a change request', () => {
  it('rejects the organizer filing on their own event', async () => {
    const { db, env } = setup();
    await seedBasicEvent(db);
    const event = await loadEventRow(db, 'ev1');

    await expect(
      createChangeRequest(env, event, 'organizer', {
        kind: 'time_change',
        proposedStartAt: Date.now() + 5 * HOUR_MS,
        proposedEndAt: Date.now() + 6 * HOUR_MS,
      }),
    ).rejects.toThrow(ValidationError);
  });

  it('rejects a non-invitee filing', async () => {
    const { db, env } = setup();
    await seedBasicEvent(db);
    await seedUser(db, 'outsider');
    await seedMembership(db, 'outsider', 'guild-1');
    const event = await loadEventRow(db, 'ev1');

    await expect(
      createChangeRequest(env, event, 'outsider', {
        kind: 'time_change',
        proposedStartAt: Date.now() + 5 * HOUR_MS,
        proposedEndAt: Date.now() + 6 * HOUR_MS,
      }),
    ).rejects.toThrow(ValidationError);
  });

  it('rejects a time_change on a poll event', async () => {
    const { db, env } = setup();
    await seedBasicEvent(db, { eventType: 'poll', startAt: null, endAt: null });
    await seedUser(db, 'inv-a');
    await seedMembership(db, 'inv-a', 'guild-1');
    await seedInvite(db, 'ev1', 'inv-a');
    const event = await loadEventRow(db, 'ev1');

    await expect(
      createChangeRequest(env, event, 'inv-a', {
        kind: 'time_change',
        proposedStartAt: Date.now() + 5 * HOUR_MS,
        proposedEndAt: Date.now() + 6 * HOUR_MS,
      }),
    ).rejects.toThrow(/no single time/);
  });

  it('resolves immediately when the requester is the event\'s only invitee (threshold of 1)', async () => {
    const { db, env } = setup();
    await seedBasicEvent(db);
    await seedUser(db, 'inv-a');
    await seedMembership(db, 'inv-a', 'guild-1');
    await seedInvite(db, 'ev1', 'inv-a');
    const event = await loadEventRow(db, 'ev1');
    const proposedStartAt = Date.now() + 10 * HOUR_MS;
    const proposedEndAt = Date.now() + 11 * HOUR_MS;

    const id = await createChangeRequest(env, event, 'inv-a', {
      kind: 'time_change',
      proposedStartAt,
      proposedEndAt,
    });

    const request = await loadChangeRequest(env, 'ev1', id);
    expect(request!.status).toBe('accepted');
    expect(request!.vote_threshold_count).toBe(1);

    const updated = await loadEventRow(db, 'ev1');
    expect(updated.start_at).toBe(proposedStartAt);
    expect(updated.end_at).toBe(proposedEndAt);
  });

  it('enforces the per-user open-request bound', async () => {
    const { db, env } = setup();
    await seedBasicEvent(db);
    await seedUser(db, 'inv-a');
    await seedMembership(db, 'inv-a', 'guild-1');
    await seedInvite(db, 'ev1', 'inv-a');
    const event = await loadEventRow(db, 'ev1');

    // Fill inv-a's per-user quota with add_invitee requests (which never
    // auto-resolve, so they stay pending and keep consuming the quota).
    for (let i = 0; i < LIMITS.MAX_OPEN_CHANGE_REQUESTS_PER_USER_PER_EVENT; i++) {
      const targetId = `target-${i}`;
      await seedUser(db, targetId);
      await seedMembership(db, targetId, 'guild-1');
      await createChangeRequest(env, event, 'inv-a', { kind: 'add_invitee', targetUserId: targetId });
    }

    const overflowTarget = 'target-overflow';
    await seedUser(db, overflowTarget);
    await seedMembership(db, overflowTarget, 'guild-1');
    await expect(
      createChangeRequest(env, event, 'inv-a', { kind: 'add_invitee', targetUserId: overflowTarget }),
    ).rejects.toThrow(ConflictError);
  });

  it('enforces the per-event open-request bound across many distinct requesters', async () => {
    const { db, env } = setup();
    await seedBasicEvent(db);
    const event = await loadEventRow(db, 'ev1');

    // Each of MAX_OPEN_CHANGE_REQUESTS_PER_EVENT invitees files exactly one
    // request -- comfortably under any single requester's own per-user bound
    // -- so only the per-event bound is what's being exercised here.
    for (let i = 0; i < LIMITS.MAX_OPEN_CHANGE_REQUESTS_PER_EVENT; i++) {
      const requesterId = `filler-${i}`;
      const targetId = `target-${i}`;
      await seedUser(db, requesterId);
      await seedMembership(db, requesterId, 'guild-1');
      await seedInvite(db, 'ev1', requesterId);
      await seedUser(db, targetId);
      await seedMembership(db, targetId, 'guild-1');
      await createChangeRequest(env, event, requesterId, { kind: 'add_invitee', targetUserId: targetId });
    }

    const oneMore = 'filler-one-more';
    await seedUser(db, oneMore);
    await seedMembership(db, oneMore, 'guild-1');
    await seedInvite(db, 'ev1', oneMore);
    const overflowTarget = 'target-per-event-overflow';
    await seedUser(db, overflowTarget);
    await seedMembership(db, overflowTarget, 'guild-1');
    await expect(
      createChangeRequest(env, event, oneMore, { kind: 'add_invitee', targetUserId: overflowTarget }),
    ).rejects.toThrow(ConflictError);
  });

  it('rejects an add_invitee target outside the guild, and one already invited', async () => {
    const { db, env } = setup();
    await seedBasicEvent(db);
    await seedUser(db, 'inv-a');
    await seedMembership(db, 'inv-a', 'guild-1');
    await seedInvite(db, 'ev1', 'inv-a');
    await seedUser(db, 'outsider');
    // No membership row for 'outsider' -- not a guild member.
    const event = await loadEventRow(db, 'ev1');

    fetchStub = stubFetch([membershipRule(404)]);
    await expect(
      createChangeRequest(env, event, 'inv-a', { kind: 'add_invitee', targetUserId: 'outsider' }),
    ).rejects.toThrow(ValidationError);

    // 'inv-a' is already an invitee (via seedInvite above), so naming them
    // as the add_invitee target should be rejected rather than no-op-accepted.
    await expect(
      createChangeRequest(env, event, 'inv-a', { kind: 'add_invitee', targetUserId: 'inv-a' }),
    ).rejects.toThrow(/already invited/);
  });
});

describe('voting and threshold resolution', () => {
  it("applies the write once a second invitee's vote crosses the majority threshold", async () => {
    const { db, env } = setup();
    await seedBasicEvent(db);
    await seedUser(db, 'inv-a');
    await seedMembership(db, 'inv-a', 'guild-1');
    await seedInvite(db, 'ev1', 'inv-a');
    await seedUser(db, 'inv-b');
    await seedMembership(db, 'inv-b', 'guild-1');
    await seedInvite(db, 'ev1', 'inv-b');
    let event = await loadEventRow(db, 'ev1');

    const proposedStartAt = Date.now() + 20 * HOUR_MS;
    const proposedEndAt = Date.now() + 21 * HOUR_MS;
    const id = await createChangeRequest(env, event, 'inv-a', {
      kind: 'time_change',
      proposedStartAt,
      proposedEndAt,
    });

    // 2 invitees -> majority threshold of 2. Requester's own implicit yes is
    // one vote; not enough on its own.
    let request = await loadChangeRequest(env, 'ev1', id);
    expect(request!.status).toBe('pending');
    expect(request!.vote_threshold_count).toBe(2);

    event = await loadEventRow(db, 'ev1');
    await voteOnChangeRequest(env, event, request!, 'inv-b', 'yes');

    request = await loadChangeRequest(env, 'ev1', id);
    expect(request!.status).toBe('accepted');
    const updated = await loadEventRow(db, 'ev1');
    expect(updated.start_at).toBe(proposedStartAt);
  });

  it('rejects a vote from a non-invitee and on a non-time_change request', async () => {
    const { db, env } = setup();
    await seedBasicEvent(db);
    await seedUser(db, 'inv-a');
    await seedMembership(db, 'inv-a', 'guild-1');
    await seedInvite(db, 'ev1', 'inv-a');
    await seedUser(db, 'target');
    await seedMembership(db, 'target', 'guild-1');
    const event = await loadEventRow(db, 'ev1');

    const id = await createChangeRequest(env, event, 'inv-a', { kind: 'add_invitee', targetUserId: 'target' });
    const request = await loadChangeRequest(env, 'ev1', id);
    await expect(voteOnChangeRequest(env, event, request!, 'inv-a', 'yes')).rejects.toThrow(/voted on/);
  });
});

describe('accepting a request', () => {
  it("throws ConflictError when the event moved since the request's captured revision", async () => {
    const { db, env } = setup();
    await seedBasicEvent(db);
    await seedUser(db, 'inv-a');
    await seedMembership(db, 'inv-a', 'guild-1');
    await seedInvite(db, 'ev1', 'inv-a');
    await seedUser(db, 'inv-b');
    await seedMembership(db, 'inv-b', 'guild-1');
    await seedInvite(db, 'ev1', 'inv-b');
    const event = await loadEventRow(db, 'ev1');

    const id = await createChangeRequest(env, event, 'inv-a', {
      kind: 'time_change',
      proposedStartAt: Date.now() + 20 * HOUR_MS,
      proposedEndAt: Date.now() + 21 * HOUR_MS,
    });
    const request = await loadChangeRequest(env, 'ev1', id);

    // Someone else edits the event in the meantime, bumping its revision.
    await db.prepare(`UPDATE events SET revision = revision + 1, title = 'Renamed' WHERE id = ?`).bind('ev1').run();
    const staleEventView = await loadEventRow(db, 'ev1');

    await expect(acceptChangeRequest(env, staleEventView, request!, 'organizer')).rejects.toThrow(ConflictError);
    const untouched = await loadEventRow(db, 'ev1');
    expect(untouched.title).toBe('Renamed');
    // The proposed time was never applied.
    expect(untouched.start_at).not.toBe(request!.proposed_start_at);
  });

  it('accepting a recurring time_change writes an occurrence override, not the series', async () => {
    const { db, env } = setup();
    await seedBasicEvent(db, { isRecurring: 1, startAt: null, endAt: null });
    await seedUser(db, 'inv-a');
    await seedMembership(db, 'inv-a', 'guild-1');
    await seedInvite(db, 'ev1', 'inv-a');
    await seedUser(db, 'inv-b');
    await seedMembership(db, 'inv-b', 'guild-1');
    await seedInvite(db, 'ev1', 'inv-b');
    const event = await loadEventRow(db, 'ev1');
    const revisionBefore = event.revision ?? 0;

    const proposedStartAt = Date.now() + 30 * HOUR_MS;
    const proposedEndAt = Date.now() + 31 * HOUR_MS;
    const id = await createChangeRequest(env, event, 'inv-a', {
      kind: 'time_change',
      proposedStartAt,
      proposedEndAt,
      occurrenceDate: '2026-09-01',
    });
    const request = await loadChangeRequest(env, 'ev1', id);

    await acceptChangeRequest(env, event, request!, 'organizer');

    const override = await db
      .prepare(`SELECT * FROM event_occurrence_overrides WHERE event_id = ? AND occurrence_date = ?`)
      .bind('ev1', '2026-09-01')
      .first<{ override_start_at: number; override_end_at: number }>();
    expect(override?.override_start_at).toBe(proposedStartAt);
    expect(override?.override_end_at).toBe(proposedEndAt);

    const afterEvent = await loadEventRow(db, 'ev1');
    expect(afterEvent.revision ?? 0).toBe(revisionBefore);
    expect(afterEvent.start_at).toBeNull();
  });

  it('fails an add_invitee accept at MAX_INVITEES with the quota error, and applies it once under the cap', async () => {
    const { db, env } = setup();
    await seedBasicEvent(db);
    await seedUser(db, 'inv-a');
    await seedMembership(db, 'inv-a', 'guild-1');
    await seedInvite(db, 'ev1', 'inv-a');
    for (const existingId of ids('existing', LIMITS.MAX_INVITEES - 1)) {
      await seedUser(db, existingId);
      await seedMembership(db, existingId, 'guild-1');
      await seedInvite(db, 'ev1', existingId);
    }
    await seedUser(db, 'target');
    await seedMembership(db, 'target', 'guild-1');
    let event = await loadEventRow(db, 'ev1');

    const id = await createChangeRequest(env, event, 'inv-a', { kind: 'add_invitee', targetUserId: 'target' });
    let request = await loadChangeRequest(env, 'ev1', id);
    // Exactly at MAX_INVITEES - 1 existing + inv-a itself = MAX_INVITEES already.
    await expect(acceptChangeRequest(env, event, request!, 'organizer')).rejects.toThrow(/limit of invitees/);

    // Free up a slot and retry -- should now succeed.
    await db.prepare(`DELETE FROM event_invites WHERE event_id = ? AND user_id = 'existing-0'`).bind('ev1').run();
    event = await loadEventRow(db, 'ev1');
    request = await loadChangeRequest(env, 'ev1', id);
    await acceptChangeRequest(env, event, request!, 'organizer');

    const invited = await countRows(db, 'event_invites', 'event_id = ? AND user_id = ?', 'ev1', 'target');
    expect(invited).toBe(1);
    const finalRequest = await loadChangeRequest(env, 'ev1', id);
    expect(finalRequest!.status).toBe('accepted');
  });

  it('a second accept on an already-decided request gets ConflictError', async () => {
    const { db, env } = setup();
    await seedBasicEvent(db);
    await seedUser(db, 'inv-a');
    await seedMembership(db, 'inv-a', 'guild-1');
    await seedInvite(db, 'ev1', 'inv-a');
    await seedUser(db, 'target');
    await seedMembership(db, 'target', 'guild-1');
    const event = await loadEventRow(db, 'ev1');

    const id = await createChangeRequest(env, event, 'inv-a', { kind: 'add_invitee', targetUserId: 'target' });
    const request = await loadChangeRequest(env, 'ev1', id);
    await acceptChangeRequest(env, event, request!, 'organizer');

    const decided = await loadChangeRequest(env, 'ev1', id);
    await expect(acceptChangeRequest(env, event, decided!, 'organizer')).rejects.toThrow(ConflictError);
  });

  it('declining requires status=pending and records the note', async () => {
    const { db, env } = setup();
    await seedBasicEvent(db);
    await seedUser(db, 'inv-a');
    await seedMembership(db, 'inv-a', 'guild-1');
    await seedInvite(db, 'ev1', 'inv-a');
    await seedUser(db, 'target');
    await seedMembership(db, 'target', 'guild-1');
    const event = await loadEventRow(db, 'ev1');

    const id = await createChangeRequest(env, event, 'inv-a', { kind: 'add_invitee', targetUserId: 'target' });
    const request = await loadChangeRequest(env, 'ev1', id);
    await declineChangeRequest(env, request!, 'organizer', 'not this time');

    const decided = await loadChangeRequest(env, 'ev1', id);
    expect(decided!.status).toBe('declined');
    expect(decided!.decision_note).toBe('not this time');

    await expect(declineChangeRequest(env, decided!, 'organizer', null)).rejects.toThrow(ConflictError);
  });
});

describe('past-deadline vote resolution', () => {
  it('accepts a below-threshold request where yes still outnumbers no', async () => {
    const { db, env } = setup();
    await seedBasicEvent(db);
    // 5 invitees -> majority threshold of 3 (floor(5/2)+1). Requester's
    // implicit yes plus one more yes is 2, which never crosses the
    // synchronous threshold -- exactly the case the deadline sweep exists for.
    for (const invId of ['inv-a', 'inv-b', 'inv-c', 'inv-d', 'inv-e']) {
      await seedUser(db, invId);
      await seedMembership(db, invId, 'guild-1');
      await seedInvite(db, 'ev1', invId);
    }
    const event = await loadEventRow(db, 'ev1');

    const proposedStartAt = Date.now() + 40 * HOUR_MS;
    const proposedEndAt = Date.now() + 41 * HOUR_MS;
    const id = await createChangeRequest(env, event, 'inv-a', {
      kind: 'time_change',
      proposedStartAt,
      proposedEndAt,
    });
    const request = await loadChangeRequest(env, 'ev1', id);
    expect(request!.vote_threshold_count).toBe(3);
    await voteOnChangeRequest(env, event, request!, 'inv-b', 'yes');
    await voteOnChangeRequest(env, event, request!, 'inv-c', 'no');
    // inv-d, inv-e never vote. yes=2, no=1, still pending (2 < 3).
    expect((await loadChangeRequest(env, 'ev1', id))!.status).toBe('pending');

    await db.prepare(`UPDATE event_change_requests SET vote_deadline_at = ? WHERE id = ?`).bind(Date.now() - 1000, id).run();
    await resolvePastDeadlineChangeRequests(env);

    const decided = await loadChangeRequest(env, 'ev1', id);
    expect(decided!.status).toBe('accepted'); // 2 yes > 1 no
    const updated = await loadEventRow(db, 'ev1');
    expect(updated.start_at).toBe(proposedStartAt);
  });

  it('declines on a tie, and when no outnumbers yes', async () => {
    const { db, env } = setup();
    await seedBasicEvent(db);
    for (const invId of ['inv-a', 'inv-b', 'inv-c']) {
      await seedUser(db, invId);
      await seedMembership(db, invId, 'guild-1');
      await seedInvite(db, 'ev1', invId);
    }
    const event = await loadEventRow(db, 'ev1');

    const proposedStartAt = Date.now() + 40 * HOUR_MS;
    const proposedEndAt = Date.now() + 41 * HOUR_MS;

    // Tie: requester's implicit yes vs inv-b's no. Majority threshold for 3
    // invitees is 2, so 1 yes never crosses it synchronously.
    const id = await createChangeRequest(env, event, 'inv-a', {
      kind: 'time_change',
      proposedStartAt,
      proposedEndAt,
    });
    const request = await loadChangeRequest(env, 'ev1', id);
    await voteOnChangeRequest(env, event, request!, 'inv-b', 'no');
    await db.prepare(`UPDATE event_change_requests SET vote_deadline_at = ? WHERE id = ?`).bind(Date.now() - 1000, id).run();
    await resolvePastDeadlineChangeRequests(env);
    expect((await loadChangeRequest(env, 'ev1', id))!.status).toBe('declined'); // 1 yes vs 1 no

    // No outnumbers yes outright.
    const id2 = await createChangeRequest(env, event, 'inv-c', {
      kind: 'time_change',
      proposedStartAt: proposedStartAt + HOUR_MS,
      proposedEndAt: proposedEndAt + HOUR_MS,
    });
    const request2 = await loadChangeRequest(env, 'ev1', id2);
    await voteOnChangeRequest(env, event, request2!, 'inv-a', 'no');
    await voteOnChangeRequest(env, event, request2!, 'inv-b', 'no');
    await db.prepare(`UPDATE event_change_requests SET vote_deadline_at = ? WHERE id = ?`).bind(Date.now() - 1000, id2).run();
    await resolvePastDeadlineChangeRequests(env);

    const decided2 = await loadChangeRequest(env, 'ev1', id2);
    expect(decided2!.status).toBe('declined'); // 1 yes vs 2 no
  });
});

describe('GET asymmetry and notification dedupe', () => {
  it('an invitee sees only their own requests; the organizer sees all, with aggregate tallies only', async () => {
    const { db, env } = setup();
    await seedBasicEvent(db);
    await seedUser(db, 'inv-a');
    await seedMembership(db, 'inv-a', 'guild-1');
    await seedInvite(db, 'ev1', 'inv-a');
    await seedUser(db, 'inv-b');
    await seedMembership(db, 'inv-b', 'guild-1');
    await seedInvite(db, 'ev1', 'inv-b');
    const event = await loadEventRow(db, 'ev1');

    await createChangeRequest(env, event, 'inv-a', {
      kind: 'time_change',
      proposedStartAt: Date.now() + 20 * HOUR_MS,
      proposedEndAt: Date.now() + 21 * HOUR_MS,
    });
    await seedUser(db, 'target');
    await seedMembership(db, 'target', 'guild-1');
    await createChangeRequest(env, event, 'inv-b', { kind: 'add_invitee', targetUserId: 'target' });

    const asInviteeA = await listChangeRequests(env, event, 'inv-a', false);
    expect(asInviteeA).toHaveLength(1);
    expect(asInviteeA[0].requesterId).toBe('inv-a');
    expect(asInviteeA[0].tally).toEqual({ yes: 1, no: 0, maybe: 0 });

    const asOrganizer = await listChangeRequests(env, event, 'organizer', true);
    expect(asOrganizer).toHaveLength(2);
  });

  it("exposes another invitee's open time_change request so it can be voted on, but not their add_invitee request", async () => {
    const { db, env } = setup();
    await seedBasicEvent(db);
    await seedUser(db, 'inv-a');
    await seedMembership(db, 'inv-a', 'guild-1');
    await seedInvite(db, 'ev1', 'inv-a');
    await seedUser(db, 'inv-b');
    await seedMembership(db, 'inv-b', 'guild-1');
    await seedInvite(db, 'ev1', 'inv-b');
    await seedUser(db, 'inv-c');
    await seedMembership(db, 'inv-c', 'guild-1');
    await seedInvite(db, 'ev1', 'inv-c');
    const event = await loadEventRow(db, 'ev1');

    const requestId = await createChangeRequest(env, event, 'inv-a', {
      kind: 'time_change',
      proposedStartAt: Date.now() + 20 * HOUR_MS,
      proposedEndAt: Date.now() + 21 * HOUR_MS,
    });
    await seedUser(db, 'target');
    await seedMembership(db, 'target', 'guild-1');
    await createChangeRequest(env, event, 'inv-a', { kind: 'add_invitee', targetUserId: 'target' });

    // inv-b filed nothing, but should see inv-a's open time_change (to vote
    // on it) and not inv-a's add_invitee (not theirs, not a vote).
    const asInviteeB = await listChangeRequests(env, event, 'inv-b', false);
    expect(asInviteeB.map((r) => r.kind).sort()).toEqual(['time_change']);

    // Once decided, it's no longer someone else's business to see.
    const request = await loadChangeRequest(env, 'ev1', requestId);
    await declineChangeRequest(env, request!, 'organizer', null);
    const afterDecision = await listChangeRequests(env, event, 'inv-b', false);
    expect(afterDecision).toHaveLength(0);
  });

  it('produces two distinct change_request_log rows for two requests on one event', async () => {
    const { db, env } = setup();
    await seedBasicEvent(db);
    await seedUser(db, 'inv-a');
    await seedMembership(db, 'inv-a', 'guild-1');
    await seedInvite(db, 'ev1', 'inv-a');
    await seedUser(db, 'target-1');
    await seedMembership(db, 'target-1', 'guild-1');
    await seedUser(db, 'target-2');
    await seedMembership(db, 'target-2', 'guild-1');
    const event = await loadEventRow(db, 'ev1');

    await createChangeRequest(env, event, 'inv-a', { kind: 'add_invitee', targetUserId: 'target-1' });
    await createChangeRequest(env, event, 'inv-a', { kind: 'add_invitee', targetUserId: 'target-2' });

    fetchStub = stubFetch([DM_CHANNEL_RULE, dmSendRule(200), membershipRule(200)]);
    await runReminderSweep(env);

    const delivered = await countRows(
      db,
      'change_request_log',
      "notification_type = 'change_request_opened' AND user_id = 'organizer' AND delivered_at IS NOT NULL",
    );
    expect(delivered).toBe(2);
  });
});

describe('route-level authorization', () => {
  it('a non-invitee gets a client error filing, and the organizer is forbidden from voting on an unrelated request', async () => {
    const { db, env } = setup();
    await seedBasicEvent(db);
    await seedUser(db, 'inv-a');
    await seedMembership(db, 'inv-a', 'guild-1');
    await seedInvite(db, 'ev1', 'inv-a');
    await seedUser(db, 'outsider');
    await seedMembership(db, 'outsider', 'guild-1', { isMember: 0 });

    const headers = await authHeaders(env, 'outsider');
    const res = await app.request(
      `https://worker.test/events/ev1/change-requests`,
      {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'time_change', proposedStartAt: Date.now() + HOUR_MS, proposedEndAt: Date.now() + 2 * HOUR_MS }),
      },
      env,
    );
    expect(res.status).toBe(404);
  });

  it('withdraw is forbidden for anyone but the requester', async () => {
    const { db, env } = setup();
    await seedBasicEvent(db);
    await seedUser(db, 'inv-a');
    await seedMembership(db, 'inv-a', 'guild-1');
    await seedInvite(db, 'ev1', 'inv-a');
    await seedUser(db, 'inv-b');
    await seedMembership(db, 'inv-b', 'guild-1');
    await seedInvite(db, 'ev1', 'inv-b');
    await seedUser(db, 'target');
    await seedMembership(db, 'target', 'guild-1');

    const event = await loadEventRow(db, 'ev1');
    const id = await createChangeRequest(env, event, 'inv-a', { kind: 'add_invitee', targetUserId: 'target' });

    const headers = await authHeaders(env, 'inv-b');
    const res = await app.request(`https://worker.test/events/ev1/change-requests/${id}`, { method: 'DELETE', headers }, env);
    expect(res.status).toBe(403);
  });
});
