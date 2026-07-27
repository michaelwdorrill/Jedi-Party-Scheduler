import { Hono } from 'hono';
import type { AppEnv } from '../lib/authMiddleware';
import { isOwner } from '../lib/db';
import { assertString, readJsonBody } from '../lib/validate';

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
