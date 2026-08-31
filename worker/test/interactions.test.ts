import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/router';
import { keepSelection, parseCustomId, rsvpCustomId, voteCustomId, withAnswer } from '../src/lib/interactions';
import { pollSelect, rsvpButtons } from '../src/lib/dmComponents';
import { countRows, seedEvent, seedGuild, seedInvite, seedMembership, seedUser, setup } from './helpers';
import type { Env } from '../src/env';
import type { ShimDatabase } from './d1shim';
import { CURRENT_POLICY_VERSION } from '../src/lib/policy';

const app = buildApp();

// A real key pair, generated once for the file: the endpoint's verification
// runs for real against it rather than being stubbed, because the signature
// check IS the authentication here and a stubbed one would test nothing.
let publicKeyHex = '';
let privateKey: KeyObject;

beforeAll(() => {
  const pair = generateKeyPairSync('ed25519');
  privateKey = pair.privateKey;
  publicKeyHex = Buffer.from(pair.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32)).toString('hex');
});

function signed(body: unknown, timestamp = String(Math.floor(Date.now() / 1000))): { body: string; headers: Record<string, string> } {
  const raw = JSON.stringify(body);
  const signature = sign(null, Buffer.from(timestamp + raw, 'utf8'), privateKey).toString('hex');
  return {
    body: raw,
    headers: { 'X-Signature-Ed25519': signature, 'X-Signature-Timestamp': timestamp, 'Content-Type': 'application/json' },
  };
}

function envWithKey(env: Env): Env {
  return { ...env, DISCORD_PUBLIC_KEY: publicKeyHex };
}

async function post(env: Env, body: string, headers: Record<string, string>): Promise<Response> {
  return app.request('https://worker.test/discord/interactions', { method: 'POST', body, headers }, env);
}

// Everything a press needs: a guild the user is currently in, an event, and
// an invite row to answer.
async function seedInvitedUser(db: ShimDatabase): Promise<void> {
  await seedGuild(db);
  await seedUser(db, 'u1');
  await seedMembership(db, 'u1', 'guild-1');
  await seedUser(db, 'organizer');
  await seedEvent(db, { id: 'e1', organizerId: 'organizer' });
  await seedInvite(db, 'e1', 'u1');
}

describe('POST /discord/interactions -- verification', () => {
  it('answers a signed PING with a PONG', async () => {
    const { env } = setup();
    const { body, headers } = signed({ type: 1 });
    const res = await post(envWithKey(env), body, headers);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ type: 1 });
  });

  it('401s a bad signature -- which is what Discord probes for when the URL is saved', async () => {
    const { env } = setup();
    const { body, headers } = signed({ type: 1 });
    // One flipped bit: a signature of the right shape over the right bytes,
    // made by nobody. Flipped rather than overwritten with a fixed digit,
    // because overwriting is a no-op whenever the byte already held that
    // value -- which made the first version of this test pass one run in
    // sixteen against code that was fine.
    const signatureBytes = Buffer.from(headers['X-Signature-Ed25519'], 'hex');
    signatureBytes[0] ^= 0x01;
    const tampered = { ...headers, 'X-Signature-Ed25519': signatureBytes.toString('hex') };
    const res = await post(envWithKey(env), body, tampered);
    expect(res.status).toBe(401);
  });

  it('401s a body that was changed after signing', async () => {
    const { env } = setup();
    const { headers } = signed({ type: 1 });
    const res = await post(envWithKey(env), JSON.stringify({ type: 1, extra: 'smuggled' }), headers);
    expect(res.status).toBe(401);
  });

  it('401s a missing signature', async () => {
    const { env } = setup();
    const res = await post(envWithKey(env), JSON.stringify({ type: 1 }), { 'Content-Type': 'application/json' });
    expect(res.status).toBe(401);
  });

  it('401s a timestamp outside the replay window, even though the signature is valid', async () => {
    const { env } = setup();
    const stale = String(Math.floor((Date.now() - 6 * 60 * 1000) / 1000));
    const { body, headers } = signed({ type: 1 }, stale);
    const res = await post(envWithKey(env), body, headers);
    expect(res.status).toBe(401);
  });

  it('401s everything when no public key is configured, rather than erroring', async () => {
    const { env } = setup();
    const { body, headers } = signed({ type: 1 });
    const res = await post(env, body, headers);
    expect(res.status).toBe(401);
  });

  it('400s a signed body that is not JSON', async () => {
    const { env } = setup();
    const timestamp = String(Math.floor(Date.now() / 1000));
    const raw = 'not json at all';
    const signature = sign(null, Buffer.from(timestamp + raw, 'utf8'), privateKey).toString('hex');
    const res = await post(envWithKey(env), raw, {
      'X-Signature-Ed25519': signature,
      'X-Signature-Timestamp': timestamp,
    });
    expect(res.status).toBe(400);
  });
});

describe('POST /discord/interactions -- RSVP buttons', () => {
  it('records the RSVP and rewrites the DM, keeping its buttons', async () => {
    const { db, env } = setup();
    await seedInvitedUser(db);

    const { body, headers } = signed({
      type: 3,
      data: { custom_id: rsvpCustomId('accepted', 'e1') },
      user: { id: 'u1' },
      message: { content: "You're invited to Test event", components: rsvpButtons('e1') },
    });
    const res = await post(envWithKey(env), body, headers);

    expect(res.status).toBe(200);
    const json = (await res.json()) as { type: number; data: { content: string; components: unknown[] } };
    // 7 = UPDATE_MESSAGE: acknowledges the press and rewrites the message in
    // the same response, so there is no second "thanks!" DM.
    expect(json.type).toBe(7);
    expect(json.data.content).toContain("You're invited to Test event");
    expect(json.data.content).toContain("you're in.");
    // The buttons survive the edit. Taking them away would make the DM a
    // one-shot and send anyone changing their mind to the website, which is
    // the journey this endpoint exists to remove.
    expect(json.data.components).toEqual(rsvpButtons('e1'));

    expect(await countRows(db, 'event_invites', `event_id = 'e1' AND user_id = 'u1' AND rsvp_status = 'accepted'`)).toBe(1);
  });

  it('keeps a partial button set rather than putting the missing ones back', async () => {
    const { db, env } = setup();
    await seedInvitedUser(db);

    // What specs/0014's ladder sends someone who already said maybe: yes and
    // no only. Answering it must not resurrect a Maybe button.
    const all = rsvpButtons('e1') as { components: unknown[] }[];
    const [row] = all;
    const twoButtons = [{ ...row, components: [row.components[0], row.components[2]] }];

    const { body, headers } = signed({
      type: 3,
      data: { custom_id: rsvpCustomId('declined', 'e1') },
      user: { id: 'u1' },
      message: { content: 'Game night', components: twoButtons },
    });
    const json = (await (await post(envWithKey(env), body, headers)).json()) as {
      data: { components: { components: unknown[] }[] };
    };

    expect(json.data.components).toEqual(twoButtons);
    expect(json.data.components[0].components).toHaveLength(2);
  });

  it('answers with a full button set when the payload carried none', async () => {
    const { db, env } = setup();
    await seedInvitedUser(db);

    const { body, headers } = signed({
      type: 3,
      data: { custom_id: rsvpCustomId('accepted', 'e1') },
      user: { id: 'u1' },
      message: { content: 'Game night' },
    });
    const json = (await (await post(envWithKey(env), body, headers)).json()) as {
      data: { components: unknown[] };
    };

    // Not reachable from a real DM -- you cannot press a button that is not
    // there -- so this pins the fallback rather than a journey: a signed but
    // odd payload still leaves a usable message behind.
    expect(json.data.components).toEqual(rsvpButtons('e1'));
  });

  it('replaces its own previous answer rather than stacking a second one', async () => {
    const { db, env } = setup();
    await seedInvitedUser(db);

    const first = signed({
      type: 3,
      data: { custom_id: rsvpCustomId('accepted', 'e1') },
      user: { id: 'u1' },
      message: { content: 'Game night' },
    });
    const firstJson = (await (await post(envWithKey(env), first.body, first.headers)).json()) as {
      data: { content: string };
    };

    const second = signed({
      type: 3,
      data: { custom_id: rsvpCustomId('declined', 'e1') },
      user: { id: 'u1' },
      message: { content: firstJson.data.content },
    });
    const secondJson = (await (await post(envWithKey(env), second.body, second.headers)).json()) as {
      data: { content: string };
    };

    expect(secondJson.data.content).toBe("Game night\n\nRecorded: you can't make it.");
    expect(await countRows(db, 'event_invites', `user_id = 'u1' AND rsvp_status = 'declined'`)).toBe(1);
  });

  it('refuses a press from someone who is no longer invited, and changes nothing', async () => {
    const { db, env } = setup();
    await seedInvitedUser(db);
    await seedUser(db, 'stranger');
    await seedMembership(db, 'stranger', 'guild-1');

    const { body, headers } = signed({
      type: 3,
      data: { custom_id: rsvpCustomId('accepted', 'e1') },
      user: { id: 'stranger' },
      message: { content: 'Game night' },
    });
    const json = (await (await post(envWithKey(env), body, headers)).json()) as {
      type: number;
      data: { content: string; flags: number };
    };

    // 4 + flag 64: an ephemeral reply only the presser sees, not an edit to
    // a message that is not theirs to change.
    expect(json.type).toBe(4);
    expect(json.data.flags).toBe(64);
    expect(json.data.content).toContain('invite list');
    expect(await countRows(db, 'event_invites', `rsvp_status <> 'pending'`)).toBe(0);
  });

  it('refuses a press from someone whose account has since been deleted', async () => {
    const { db, env } = setup();
    await seedInvitedUser(db);

    const { body, headers } = signed({
      type: 3,
      data: { custom_id: rsvpCustomId('accepted', 'e1') },
      user: { id: 'deleted-account' },
      message: { content: 'Game night' },
    });
    const json = (await (await post(envWithKey(env), body, headers)).json()) as {
      type: number;
      data: { content: string };
    };
    expect(json.type).toBe(4);
    expect(json.data.content).toContain("don't have an account");
  });

  it('reads the presser from member.user in a guild context', async () => {
    const { db, env } = setup();
    await seedInvitedUser(db);

    const { body, headers } = signed({
      type: 3,
      data: { custom_id: rsvpCustomId('tentative', 'e1') },
      member: { user: { id: 'u1' } },
      message: { content: 'Game night' },
    });
    const json = (await (await post(envWithKey(env), body, headers)).json()) as { type: number };
    expect(json.type).toBe(7);
    expect(await countRows(db, 'event_invites', `user_id = 'u1' AND rsvp_status = 'tentative'`)).toBe(1);
  });

  it('tells the presser a year-old button is out of date instead of guessing', async () => {
    const { db, env } = setup();
    await seedInvitedUser(db);

    const { body, headers } = signed({
      type: 3,
      data: { custom_id: 'uo:v0:rsvp:accepted:e1' },
      user: { id: 'u1' },
      message: { content: 'Game night' },
    });
    const json = (await (await post(envWithKey(env), body, headers)).json()) as {
      type: number;
      data: { content: string };
    };
    expect(json.type).toBe(4);
    expect(json.data.content).toContain('out of date');
    expect(await countRows(db, 'event_invites', `rsvp_status <> 'pending'`)).toBe(0);
  });
});

describe('POST /discord/interactions -- poll select', () => {
  async function seedPoll(db: ShimDatabase): Promise<void> {
    await seedGuild(db);
    await seedUser(db, 'u1');
    await seedMembership(db, 'u1', 'guild-1');
    await seedUser(db, 'organizer');
    await seedEvent(db, { id: 'p1', organizerId: 'organizer', eventType: 'poll', startAt: null, endAt: null });
    await seedInvite(db, 'p1', 'u1');
    for (const [i, id] of ['o1', 'o2', 'o3'].entries()) {
      await db.prepare(
        `INSERT INTO event_poll_options (id, event_id, start_at, end_at, display_order) VALUES (?, 'p1', ?, ?, ?)`,
      )
        .bind(id, Date.now() + (i + 1) * 86400000, Date.now() + (i + 1) * 86400000 + 3600000, i)
        .run();
    }
  }

  it('records the picked candidates as yes and leaves the rest with no vote at all', async () => {
    const { db, env } = setup();
    await seedPoll(db);

    const { body, headers } = signed({
      type: 3,
      data: { custom_id: voteCustomId('p1'), values: ['o1', 'o3'] },
      user: { id: 'u1' },
      message: { content: 'Which nights work?' },
    });
    const json = (await (await post(envWithKey(env), body, headers)).json()) as {
      type: number;
      data: { content: string };
    };

    expect(json.type).toBe(7);
    expect(await countRows(db, 'event_poll_votes', `user_id = 'u1' AND vote = 'yes'`)).toBe(2);
    // Not a `no`: an unticked night is not a statement that it is impossible,
    // and absence is how the tallies already read it.
    expect(await countRows(db, 'event_poll_votes', `user_id = 'u1' AND option_id = 'o2'`)).toBe(0);
    expect(json.data.content).toContain('2 of these work for you.');
    // The DM's own text already says this; the recorded line must not repeat
    // it, because the original stays visible above the edit.
    expect(json.data.content.split('Recorded:')[1]).not.toContain('left blank');
  });

  it('clears a previous yes when the same person re-answers without it', async () => {
    const { db, env } = setup();
    await seedPoll(db);

    const first = signed({
      type: 3,
      data: { custom_id: voteCustomId('p1'), values: ['o1', 'o2'] },
      user: { id: 'u1' },
      message: { content: 'Which nights work?' },
    });
    await post(envWithKey(env), first.body, first.headers);

    const second = signed({
      type: 3,
      data: { custom_id: voteCustomId('p1'), values: ['o2'] },
      user: { id: 'u1' },
      message: { content: 'Which nights work?' },
    });
    await post(envWithKey(env), second.body, second.headers);

    expect(await countRows(db, 'event_poll_votes', `user_id = 'u1'`)).toBe(1);
    expect(await countRows(db, 'event_poll_votes', `user_id = 'u1' AND option_id = 'o2'`)).toBe(1);
  });

  it('keeps the select after an answer, with the picks ticked, so it can be changed again', async () => {
    const { db, env } = setup();
    await seedPoll(db);

    const sent = pollSelect('p1', [
      { id: 'o1', label: 'Mon' },
      { id: 'o2', label: 'Tue' },
      { id: 'o3', label: 'Wed' },
    ]);

    const first = signed({
      type: 3,
      data: { custom_id: voteCustomId('p1'), values: ['o1', 'o3'] },
      user: { id: 'u1' },
      message: { content: 'Which nights work?', components: sent },
    });
    const firstJson = (await (await post(envWithKey(env), first.body, first.headers)).json()) as {
      data: { content: string; components: { components: { options: { value: string; default: boolean }[] }[] }[] };
    };

    // Reopening the DM has to show what is on record, not an untouched picker.
    const options = firstJson.data.components[0].components[0].options;
    expect(options.map((o) => [o.value, o.default])).toEqual([
      ['o1', true],
      ['o2', false],
      ['o3', true],
    ]);

    // And the whole point of keeping it: a second answer arrives, through the
    // components the first answer left behind, and replaces the first.
    const second = signed({
      type: 3,
      data: { custom_id: voteCustomId('p1'), values: ['o2'] },
      user: { id: 'u1' },
      message: { content: firstJson.data.content, components: firstJson.data.components },
    });
    const secondJson = (await (await post(envWithKey(env), second.body, second.headers)).json()) as {
      data: { components: { components: { options: { value: string; default: boolean }[] }[] }[] };
    };

    expect(secondJson.data.components[0].components[0].options.map((o) => [o.value, o.default])).toEqual([
      ['o1', false],
      ['o2', true],
      ['o3', false],
    ]);
    expect(await countRows(db, 'event_poll_votes', `user_id = 'u1'`)).toBe(1);
    expect(await countRows(db, 'event_poll_votes', `user_id = 'u1' AND option_id = 'o2'`)).toBe(1);
  });

  it('accepts an empty selection as "none of these"', async () => {
    const { db, env } = setup();
    await seedPoll(db);

    const first = signed({
      type: 3,
      data: { custom_id: voteCustomId('p1'), values: ['o1'] },
      user: { id: 'u1' },
      message: { content: 'Which nights work?' },
    });
    await post(envWithKey(env), first.body, first.headers);

    const cleared = signed({
      type: 3,
      data: { custom_id: voteCustomId('p1'), values: [] },
      user: { id: 'u1' },
      message: { content: 'Which nights work?' },
    });
    const json = (await (await post(envWithKey(env), cleared.body, cleared.headers)).json()) as {
      type: number;
      data: { content: string };
    };

    expect(json.type).toBe(7);
    expect(json.data.content).toContain('none of these');
    expect(await countRows(db, 'event_poll_votes', `user_id = 'u1'`)).toBe(0);
  });

  it('refuses options that belong to a different poll', async () => {
    const { db, env } = setup();
    await seedPoll(db);

    const { body, headers } = signed({
      type: 3,
      data: { custom_id: voteCustomId('p1'), values: ['o1', 'someone-elses-option'] },
      user: { id: 'u1' },
      message: { content: 'Which nights work?' },
    });
    const json = (await (await post(envWithKey(env), body, headers)).json()) as {
      type: number;
      data: { content: string };
    };
    expect(json.type).toBe(4);
    expect(json.data.content).toContain("aren't on that poll");
    expect(await countRows(db, 'event_poll_votes', `user_id = 'u1'`)).toBe(0);
  });
});

describe('custom_id', () => {
  it('round-trips, and stays inside Discord\'s 100-character limit', () => {
    const eventId = crypto.randomUUID();
    const id = rsvpCustomId('declined', eventId);
    expect(id.length).toBeLessThanOrEqual(100);
    expect(parseCustomId(id)).toEqual({ kind: 'rsvp', status: 'declined', eventId });
    expect(voteCustomId(eventId).length).toBeLessThanOrEqual(100);
    expect(parseCustomId(voteCustomId(eventId))).toEqual({ kind: 'vote', eventId });
  });

  it('reports someone else\'s component as not ours, and our own old formats as stale', () => {
    expect(parseCustomId('some-other-bot-button')).toBeNull();
    expect(parseCustomId(undefined)).toBeNull();
    expect(parseCustomId('uo:v9:rsvp:accepted:e1')).toEqual({ kind: 'stale' });
    expect(parseCustomId('uo:v1:something-new:e1')).toEqual({ kind: 'stale' });
    expect(parseCustomId('uo:v1:rsvp:maybe-not-a-status:e1')).toEqual({ kind: 'stale' });
  });

  it('keeps the answer line replaceable and the content bounded', () => {
    expect(withAnswer('Invite', 'yes.')).toBe('Invite\n\nRecorded: yes.');
    expect(withAnswer('Invite\n\nRecorded: yes.', 'no.')).toBe('Invite\n\nRecorded: no.');
    expect(withAnswer('x'.repeat(2100), 'yes.').length).toBeLessThanOrEqual(2000);

    // Since v0.5.1 a DM with controls keeps its words in an embed, so the
    // content reaching here is empty on the first press and nothing but the
    // previous answer on the second. Both must replace rather than stack --
    // and the second must do so whether or not Discord kept the leading
    // blank line it was stored with.
    expect(withAnswer('', 'yes.')).toBe('\n\nRecorded: yes.');
    expect(withAnswer('\n\nRecorded: yes.', 'no.')).toBe('\n\nRecorded: no.');
    expect(withAnswer('Recorded: yes.', 'no.')).toBe('\n\nRecorded: no.');
  });
});

describe('what the endpoint sends back to Discord', () => {
  it('suppresses mentions on every response it emits', async () => {
    const { db, env } = setup();
    await seedInvitedUser(db);
    // An event title is user-controlled and ends up in the DM's content, which
    // this endpoint echoes back in its edit. Without allowed_mentions the
    // trusted bot account would fire the ping on the way back out.
    const { body, headers } = signed({
      type: 3,
      data: { custom_id: rsvpCustomId('accepted', 'e1') },
      user: { id: 'u1' },
      message: { content: 'You are invited to @everyone night' },
    });
    const edit = (await (await post(envWithKey(env), body, headers)).json()) as {
      data: { allowed_mentions?: { parse: string[] } };
    };
    expect(edit.data.allowed_mentions).toEqual({ parse: [] });

    const refused = signed({
      type: 3,
      data: { custom_id: 'uo:v0:rsvp:accepted:e1' },
      user: { id: 'u1' },
      message: { content: 'x' },
    });
    const ephemeralReply = (await (await post(envWithKey(env), refused.body, refused.headers)).json()) as {
      data: { allowed_mentions?: { parse: string[] } };
    };
    expect(ephemeralReply.data.allowed_mentions).toEqual({ parse: [] });
  });

  it('answers a slash command it does not implement instead of failing the interaction', async () => {
    const { env } = setup();
    const { body, headers } = signed({ type: 2, data: { custom_id: undefined }, user: { id: 'u1' } });
    const json = (await (await post(envWithKey(env), body, headers)).json()) as {
      type: number;
      data: { content: string; flags: number };
    };
    expect(json.type).toBe(4);
    expect(json.data.flags).toBe(64);
    expect(json.data.content).toContain("can't do that here yet");
  });

  it('accepts the same candidate listed twice rather than refusing the answer', async () => {
    const { db, env } = setup();
    await seedGuild(db);
    await seedUser(db, 'u1');
    await seedMembership(db, 'u1', 'guild-1');
    await seedUser(db, 'organizer');
    await seedEvent(db, { id: 'p2', organizerId: 'organizer', eventType: 'poll', startAt: null, endAt: null });
    await seedInvite(db, 'p2', 'u1');
    await db
      .prepare(`INSERT INTO event_poll_options (id, event_id, start_at, end_at, display_order) VALUES ('x1', 'p2', ?, ?, 0)`)
      .bind(Date.now() + 86400000, Date.now() + 90000000)
      .run();

    const { body, headers } = signed({
      type: 3,
      data: { custom_id: voteCustomId('p2'), values: ['x1', 'x1'] },
      user: { id: 'u1' },
      message: { content: 'Which nights work?' },
    });
    const json = (await (await post(envWithKey(env), body, headers)).json()) as { type: number };
    expect(json.type).toBe(7);
    expect(await countRows(db, 'event_poll_votes', `user_id = 'u1' AND option_id = 'x1'`)).toBe(1);
  });
});

describe('a press from someone behind on the Terms (item 45)', () => {
  it('is refused with somewhere to go, and records nothing', async () => {
    const { db, env } = setup();
    await seedInvitedUser(db);
    // Behind on the policy: the website would be showing them the acceptance
    // screen right now instead of answering.
    await db
      .prepare(`UPDATE users SET accepted_policy_version = ? WHERE id = 'u1'`)
      .bind(CURRENT_POLICY_VERSION - 1)
      .run();

    const { body, headers } = signed({
      type: 3,
      data: { custom_id: rsvpCustomId('accepted', 'e1') },
      user: { id: 'u1' },
      message: { content: 'Game night' },
    });
    const json = (await (await post(envWithKey(env), body, headers)).json()) as {
      type: number;
      data: { content: string; flags: number };
    };

    expect(json.type).toBe(4);
    expect(json.data.flags).toBe(64);
    expect(json.data.content).toContain('have changed');
    expect(json.data.content).toContain(env.FRONTEND_URL);
    expect(await countRows(db, 'event_invites', `rsvp_status <> 'pending'`)).toBe(0);
  });

  it('works again once they have agreed', async () => {
    const { db, env } = setup();
    await seedInvitedUser(db);
    await db
      .prepare(`UPDATE users SET accepted_policy_version = ? WHERE id = 'u1'`)
      .bind(CURRENT_POLICY_VERSION)
      .run();

    const { body, headers } = signed({
      type: 3,
      data: { custom_id: rsvpCustomId('accepted', 'e1') },
      user: { id: 'u1' },
      message: { content: 'Game night' },
    });
    const json = (await (await post(envWithKey(env), body, headers)).json()) as { type: number };
    expect(json.type).toBe(7);
    expect(await countRows(db, 'event_invites', `user_id = 'u1' AND rsvp_status = 'accepted'`)).toBe(1);
  });
});

describe('keepSelection', () => {
  const select = () =>
    pollSelect('p1', [
      { id: 'o1', label: 'Mon' },
      { id: 'o2', label: 'Tue' },
    ]) as { components: { options: { value: string; default?: boolean }[] }[] }[];

  it('marks every picked value and unmarks the rest', () => {
    const kept = keepSelection(select(), ['o2']) as { components: { options: { value: string; default: boolean }[] }[] }[];
    expect(kept[0].components[0].options.map((o) => o.default)).toEqual([false, true]);
  });

  it('unmarks everything for an empty pick, so "none of these" reopens empty', () => {
    const kept = keepSelection(select(), []) as { components: { options: { value: string; default: boolean }[] }[] }[];
    expect(kept[0].components[0].options.every((o) => o.default === false)).toBe(true);
  });

  it('leaves anything that is not a string select alone', () => {
    const buttons = rsvpButtons('e1');
    expect(keepSelection(buttons, ['whatever'])).toEqual(buttons);
  });

  it('returns an empty set rather than throwing when there are no components', () => {
    expect(keepSelection(undefined, ['o1'])).toEqual([]);
  });

  // A select that reopens without its ticks is cosmetic; a malformed one
  // Discord rejects would take the whole edit down with it.
  it('passes a shape it does not recognise straight through', () => {
    const odd = [{ type: 1, components: 'not an array' }] as unknown as unknown[];
    expect(keepSelection(odd, ['o1'])).toEqual(odd);
  });
});
