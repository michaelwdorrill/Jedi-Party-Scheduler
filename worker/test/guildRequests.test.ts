import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/router';
import { signJwt } from '../src/lib/jwt';
import { createSession } from '../src/lib/sessions';
import { signToken } from '../src/lib/signedToken';
import { DECISION_TOKEN_PURPOSE, GUILD_VERIFY_TOKEN_PURPOSE } from '../src/lib/guildRequests';
import { countRows, seedGuild, seedUser, setup, stubFetch, type FetchStub } from './helpers';
import type { Env } from '../src/env';
import type { ShimDatabase } from './d1shim';

let fetchStub: FetchStub | null = null;
afterEach(() => {
  fetchStub?.restore();
  fetchStub = null;
});

const app = buildApp();

async function call(env: Env, path: string, init: RequestInit = {}): Promise<Response> {
  return app.request(`https://worker.test${path}`, init, env);
}

async function authFor(env: Env, userId: string): Promise<string> {
  const { id: sessionId } = await createSession(env, userId);
  return signJwt(userId, sessionId, env.JWT_SIGNING_KEY);
}

function setCookieValue(res: Response): string {
  const raw = res.headers.get('set-cookie');
  if (!raw) throw new Error('test fixture: no Set-Cookie on response');
  return raw.split(';')[0];
}

const TOKEN_RULE = { match: 'oauth2/token', status: 200, body: { access_token: 'discord-access-token', refresh_token: 'r', expires_in: 604800, token_type: 'Bearer' } };
function userRule(id: string) {
  return { match: '/users/@me', status: 200, body: { id, username: `user-${id}`, global_name: null, avatar: null } };
}
function guildsRule(guilds: { id: string; name: string; owner?: boolean; permissions?: string }[]) {
  return { match: '/users/@me/guilds', status: 200, body: guilds };
}

// IDEAS item 9 / docs/specs/0015: self-service "add this bot" flow.
describe('GET /guild-requests/connect', () => {
  it('sets a state cookie and redirects to Discord', async () => {
    const { env } = setup();
    const res = await call(env, '/guild-requests/connect', { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('discord.com/api/oauth2/authorize');
    expect(res.headers.get('set-cookie')).toContain('guild_verify_state=');
  });
});

describe('GET /guild-requests/callback', () => {
  it('rejects a mismatched state', async () => {
    const { env } = setup();
    const connectRes = await call(env, '/guild-requests/connect', { redirect: 'manual' });
    const cookie = setCookieValue(connectRes);
    const res = await call(env, '/guild-requests/callback?code=abc&state=wrong', { headers: { Cookie: cookie } });
    expect(res.status).toBe(400);
  });

  it('refuses someone who has never logged into the site', async () => {
    const { env } = setup();
    const connectRes = await call(env, '/guild-requests/connect', { redirect: 'manual' });
    const location = new URL(connectRes.headers.get('location')!);
    const state = location.searchParams.get('state')!;
    const cookie = setCookieValue(connectRes);

    fetchStub = stubFetch([TOKEN_RULE, guildsRule([]), userRule('unknown-user')]);
    const res = await call(env, `/guild-requests/callback?code=abc&state=${state}`, { headers: { Cookie: cookie } });
    expect(res.status).toBe(403);
  });

  it('filters to administered guilds not already on the allow-list, and redirects with a signed token per guild', async () => {
    const { db, env } = setup();
    await seedGuild(db, 'already-active');
    await seedUser(db, 'requester');

    const connectRes = await call(env, '/guild-requests/connect', { redirect: 'manual' });
    const connectLocation = new URL(connectRes.headers.get('location')!);
    const state = connectLocation.searchParams.get('state')!;
    const cookie = setCookieValue(connectRes);

    fetchStub = stubFetch([
      TOKEN_RULE,
      guildsRule([
        { id: 'already-active', name: 'Already Active', owner: true },
        { id: 'not-admin', name: 'Not Mine', permissions: '0' },
        { id: 'my-new-server', name: 'My New Server', owner: true },
      ]),
      userRule('requester'),
    ]);

    const res = await call(env, `/guild-requests/callback?code=abc&state=${state}`, {
      headers: { Cookie: cookie },
      redirect: 'manual',
    });
    expect(res.status).toBe(302);
    const location = res.headers.get('location')!;
    // The frontend is a HashRouter, so the query string this route hands
    // back lives after the '#', not in the URL's own .search -- parsed the
    // same way frontend/src/pages/AuthCallbackPage.tsx reads its own token
    // out of the login redirect.
    expect(location).toContain('/#/add-bot');
    const hashQuery = new URLSearchParams(location.split('?')[1] ?? '');
    const data = JSON.parse(decodeURIComponent(escape(atob(hashQuery.get('data')!))));
    expect(data).toHaveLength(1);
    expect(data[0].guildId).toBe('my-new-server');
    expect(typeof data[0].token).toBe('string');
  });
});

describe('POST /guild-requests', () => {
  async function verifyToken(env: Env, guildId = 'new-guild', guildName = 'New Guild', requestedBy = 'requester') {
    return signToken(GUILD_VERIFY_TOKEN_PURPOSE, { guildId, guildName, requestedBy }, env.JWT_SIGNING_KEY, 600);
  }

  it('creates a pending request and returns a bot-invite URL', async () => {
    const { db, env } = setup();
    await seedUser(db, 'requester');
    const token = await verifyToken(env);

    const res = await call(env, '/guild-requests', { method: 'POST', body: JSON.stringify({ token }) });
    expect(res.status).toBe(201);
    const body = await res.json<{ status: string; botInviteUrl: string }>();
    expect(body.status).toBe('created');
    expect(body.botInviteUrl).toContain('guild_id=new-guild');
    expect(await countRows(db, 'guild_add_requests', "guild_id = 'new-guild' AND status = 'pending'")).toBe(1);
  });

  it('refuses an expired or forged token', async () => {
    const { env } = setup();
    const res = await call(env, '/guild-requests', { method: 'POST', body: JSON.stringify({ token: 'garbage' }) });
    expect(res.status).toBe(400);
  });

  it('reports already_active for a guild already on the allow-list', async () => {
    const { db, env } = setup();
    await seedGuild(db, 'active-guild');
    await seedUser(db, 'requester');
    const token = await verifyToken(env, 'active-guild', 'Active Guild');

    const res = await call(env, '/guild-requests', { method: 'POST', body: JSON.stringify({ token }) });
    const body = await res.json<{ status: string }>();
    expect(body.status).toBe('already_active');
  });

  it('reports already_pending for a second request on the same guild', async () => {
    const { db, env } = setup();
    await seedUser(db, 'requester');
    const token1 = await verifyToken(env);
    await call(env, '/guild-requests', { method: 'POST', body: JSON.stringify({ token: token1 }) });

    const token2 = await verifyToken(env);
    const res = await call(env, '/guild-requests', { method: 'POST', body: JSON.stringify({ token: token2 }) });
    const body = await res.json<{ status: string }>();
    expect(body.status).toBe('already_pending');
    expect(await countRows(db, 'guild_add_requests', "guild_id = 'new-guild'")).toBe(1);
  });
});

async function createPendingRequest(db: ShimDatabase, env: Env, guildId = 'g1'): Promise<string> {
  await seedUser(db, 'requester');
  const token = await signToken(GUILD_VERIFY_TOKEN_PURPOSE, { guildId, guildName: 'G1', requestedBy: 'requester' }, env.JWT_SIGNING_KEY, 600);
  const res = await call(env, '/guild-requests', { method: 'POST', body: JSON.stringify({ token }) });
  const body = await res.json<{ status: string }>();
  expect(body.status).toBe('created');
  const row = await db.prepare(`SELECT id FROM guild_add_requests WHERE guild_id = ?`).bind(guildId).first<{ id: string }>();
  return row!.id;
}

describe('GET /guild-requests/:token/decide', () => {
  it('approving adds the guild to the allow-list', async () => {
    const { db, env } = setup();
    const requestId = await createPendingRequest(db, env);
    const token = await signToken(DECISION_TOKEN_PURPOSE, { requestId, action: 'approve' }, env.JWT_SIGNING_KEY, 600);

    const res = await call(env, `/guild-requests/${token}/decide`);
    expect(res.status).toBe(200);
    expect(await countRows(db, 'guilds', "id = 'g1' AND is_active = 1")).toBe(1);
    expect(await countRows(db, 'guild_add_requests', "guild_id = 'g1' AND status = 'approved'")).toBe(1);
  });

  it('rejecting does not touch the allow-list', async () => {
    const { db, env } = setup();
    const requestId = await createPendingRequest(db, env, 'g2');
    const token = await signToken(DECISION_TOKEN_PURPOSE, { requestId, action: 'reject' }, env.JWT_SIGNING_KEY, 600);

    const res = await call(env, `/guild-requests/${token}/decide`);
    expect(res.status).toBe(200);
    expect(await countRows(db, 'guilds', "id = 'g2'")).toBe(0);
    expect(await countRows(db, 'guild_add_requests', "guild_id = 'g2' AND status = 'rejected'")).toBe(1);
  });

  it('a second decision on the same request is a no-op', async () => {
    const { db, env } = setup();
    const requestId = await createPendingRequest(db, env, 'g3');
    const approveToken = await signToken(DECISION_TOKEN_PURPOSE, { requestId, action: 'approve' }, env.JWT_SIGNING_KEY, 600);
    const rejectToken = await signToken(DECISION_TOKEN_PURPOSE, { requestId, action: 'reject' }, env.JWT_SIGNING_KEY, 600);

    await call(env, `/guild-requests/${approveToken}/decide`);
    const secondRes = await call(env, `/guild-requests/${rejectToken}/decide`);
    expect(secondRes.status).toBe(200);
    // Still approved -- the first decision wins, the second is a no-op.
    expect(await countRows(db, 'guilds', "id = 'g3' AND is_active = 1")).toBe(1);
    expect(await countRows(db, 'guild_add_requests', "guild_id = 'g3' AND status = 'approved'")).toBe(1);
  });

  it('an unknown request id is a 404', async () => {
    const { env } = setup();
    const token = await signToken(DECISION_TOKEN_PURPOSE, { requestId: 'nope', action: 'approve' }, env.JWT_SIGNING_KEY, 600);
    const res = await call(env, `/guild-requests/${token}/decide`);
    expect(res.status).toBe(404);
  });
});

describe('admin guild-requests fallback', () => {
  it('lists and can approve/reject like the emailed link', async () => {
    const { db, env } = setup();
    const requestId = await createPendingRequest(db, env, 'g4');
    await seedUser(db, env.OWNER_DISCORD_ID);
    const ownerAuth = await authFor(env, env.OWNER_DISCORD_ID);

    const listRes = await call(env, '/admin/guild-requests', { headers: { Authorization: `Bearer ${ownerAuth}` } });
    expect(listRes.status).toBe(200);
    const list = await listRes.json<{ id: string; guildId: string; status: string }[]>();
    expect(list.some((r) => r.id === requestId && r.status === 'pending')).toBe(true);

    const approveRes = await call(env, `/admin/guild-requests/${requestId}/approve`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ownerAuth}` },
    });
    expect(approveRes.status).toBe(200);
    expect(await countRows(db, 'guilds', "id = 'g4' AND is_active = 1")).toBe(1);
  });

  it('is forbidden to a non-owner', async () => {
    const { db, env } = setup();
    await seedUser(db, 'not-the-owner');
    const auth = await authFor(env, 'not-the-owner');
    const res = await call(env, '/admin/guild-requests', { headers: { Authorization: `Bearer ${auth}` } });
    expect(res.status).toBe(403);
  });
});
