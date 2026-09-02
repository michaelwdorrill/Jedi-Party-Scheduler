import { Hono } from 'hono';
import type { AppEnv } from '../lib/authMiddleware';
import { placeholders } from '../lib/d1';
import { isOwner } from '../lib/db';
import { decideGuildAddRequest, listGuildAddRequests } from '../lib/guildRequests';
import { assertString, readJsonBody } from '../lib/validate';

export const adminRoutes = new Hono<AppEnv>();

adminRoutes.use('*', async (c, next) => {
  if (!isOwner(c.env, c.get('userId'))) return c.text('Forbidden', 403);
  await next();
});

// Owner-only: everyone signed up, which guilds they're in, and when they last
// logged in (idea 11). Deliberately not an event-data endpoint -- users and
// guild membership only, matching ARCHITECTURE.md's privacy model, which
// states there is no admin endpoint that reads other people's event data.
//
// Keyset-paged on users.id rather than an unbounded SELECT *, the same shape
// cron/cursor.ts uses for its scans -- correct today's handful of rows, and
// still correct once that's no longer true. The page size is capped well
// under D1_MAX_BIND_PARAMS so the membership IN-list below never needs
// chunking.
const MAX_USERS_PAGE = 50;

adminRoutes.get('/users', async (c) => {
  const requestedLimit = Number(c.req.query('limit') ?? MAX_USERS_PAGE);
  const limit = Math.min(MAX_USERS_PAGE, Math.max(1, Number.isFinite(requestedLimit) ? requestedLimit : MAX_USERS_PAGE));
  const after = c.req.query('after') ?? '';

  const { results: users } = await c.env.DB.prepare(
    `SELECT id, username, global_name, notifications_enabled, last_login_at, last_login_attempt_at
     FROM users WHERE id > ? ORDER BY id LIMIT ?`,
  )
    .bind(after, limit)
    .all<{
      id: string;
      username: string;
      global_name: string | null;
      notifications_enabled: number;
      last_login_at: number | null;
      last_login_attempt_at: number | null;
    }>();

  if (users.length === 0) return c.json({ users: [], nextCursor: null });

  // One follow-up query for the whole page's membership, not one per user --
  // the same reason the cron's notification sources fold their "already
  // handled?" check into the source query rather than issuing a per-row
  // follow-up (see lib/outbox.ts's PENDING_NOTIFICATION_JOIN comment).
  // Deliberately no `is_member = 1` filter. Membership rows aren't deleted
  // when someone leaves a server -- syncGuildMembership and the cron's
  // revalidateStaleMemberships just flip the flag to 0 -- so filtering them
  // out here made "was in this server, since departed" look identical to
  // "has never been in it". That cost a real investigation: a member showing
  // zero servers on this page turned out to be a departed row, and the only
  // way to find out was a raw SQL query. Both states now come back, tagged.
  const ids = users.map((u) => u.id);
  const { results: memberships } = await c.env.DB.prepare(
    `SELECT ugm.user_id AS user_id, g.id AS guild_id, g.name AS guild_name,
            ugm.is_member AS is_member, ugm.verified_at AS verified_at
     FROM user_guild_membership ugm
     JOIN guilds g ON g.id = ugm.guild_id
     WHERE ugm.user_id IN (${placeholders(ids.length)})`,
  )
    .bind(...ids)
    .all<{ user_id: string; guild_id: string; guild_name: string; is_member: number; verified_at: number | null }>();

  const guildsByUser = new Map<
    string,
    { id: string; name: string; isMember: boolean; verifiedAt: number | null }[]
  >();
  for (const m of memberships) {
    const list = guildsByUser.get(m.user_id) ?? [];
    list.push({ id: m.guild_id, name: m.guild_name, isMember: !!m.is_member, verifiedAt: m.verified_at });
    guildsByUser.set(m.user_id, list);
  }

  return c.json({
    users: users.map((u) => ({
      id: u.id,
      username: u.username,
      globalName: u.global_name,
      notificationsEnabled: !!u.notifications_enabled,
      lastLoginAt: u.last_login_at,
      lastLoginAttemptAt: u.last_login_attempt_at,
      guilds: guildsByUser.get(u.id) ?? [],
    })),
    nextCursor: users.length === limit ? users[users.length - 1].id : null,
  });
});

adminRoutes.get('/guilds', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT id, name, is_active, added_at FROM guilds ORDER BY name`,
  ).all<{ id: string; name: string; is_active: number; added_at: number }>();
  return c.json(
    results.map((g) => ({ id: g.id, name: g.name, isActive: !!g.is_active, addedAt: g.added_at })),
  );
});

adminRoutes.post('/guilds', async (c) => {
  const body = await readJsonBody<{ id: string; name: string }>(c);
  const id = assertString(body.id, 'id', 64);
  const name = assertString(body.name, 'name', 200);

  await c.env.DB.prepare(
    `INSERT INTO guilds (id, name, is_active, added_at) VALUES (?, ?, 1, ?)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, is_active = 1`,
  )
    .bind(id, name, Date.now())
    .run();
  return c.json({ ok: true }, 201);
});

adminRoutes.delete('/guilds/:id', async (c) => {
  await c.env.DB.prepare(`UPDATE guilds SET is_active = 0 WHERE id = ?`).bind(c.req.param('id')).run();
  return c.json({ ok: true });
});

// specs/0015: the fallback for the emailed decision links -- useful if an
// email is lost, delayed, or the owner just wants to review history. Shares
// its approve/reject logic with GET /guild-requests/:token/decide via
// lib/guildRequests.ts rather than duplicating it.
adminRoutes.get('/guild-requests', async (c) => {
  const requests = await listGuildAddRequests(c.env);
  return c.json(
    requests.map((r) => ({
      id: r.id,
      guildId: r.guild_id,
      guildName: r.guild_name,
      requestedBy: r.requested_by,
      status: r.status,
      requestedAt: r.requested_at,
      decidedAt: r.decided_at,
    })),
  );
});

adminRoutes.post('/guild-requests/:id/:action', async (c) => {
  const action = c.req.param('action');
  if (action !== 'approve' && action !== 'reject') return c.text('Unknown action', 400);
  const result = await decideGuildAddRequest(c.env, c.req.param('id'), action);
  if (result === 'not_found') return c.text('Request not found', 404);
  return c.json({ status: result });
});
