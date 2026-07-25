import { Hono } from 'hono';
import type { AppEnv } from '../lib/authMiddleware';
import { isOwner } from '../lib/db';

export const adminRoutes = new Hono<AppEnv>();

adminRoutes.use('*', async (c, next) => {
  if (!isOwner(c.env, c.get('userId'))) return c.text('Forbidden', 403);
  await next();
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
  const body = await c.req.json<{ id: string; name: string }>();
  if (!body.id || !body.name) return c.text('id and name are required', 400);

  await c.env.DB.prepare(
    `INSERT INTO guilds (id, name, is_active, added_at) VALUES (?, ?, 1, ?)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, is_active = 1`,
  )
    .bind(body.id, body.name, Date.now())
    .run();
  return c.json({ ok: true }, 201);
});

adminRoutes.delete('/guilds/:id', async (c) => {
  await c.env.DB.prepare(`UPDATE guilds SET is_active = 0 WHERE id = ?`).bind(c.req.param('id')).run();
  return c.json({ ok: true });
});
