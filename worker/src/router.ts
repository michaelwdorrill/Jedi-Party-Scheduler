import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { AppEnv } from './lib/authMiddleware';
import { requireAuth } from './lib/authMiddleware';
import { authRoutes } from './routes/auth';
import { meRoutes } from './routes/me';
import { guildRoutes } from './routes/guilds';
import { groupRoutes } from './routes/groups';
import { eventRoutes } from './routes/events';
import { pollRoutes } from './routes/polls';
import { adminRoutes } from './routes/admin';

export function buildApp() {
  const app = new Hono<AppEnv>();

  app.use('*', async (c, next) => {
    // The Origin header browsers send is always bare scheme+host (e.g.
    // https://michaelwdorrill.github.io), never the GitHub Pages project
    // path (/Jedi-Party-Scheduler) that FRONTEND_URL also needs to carry
    // for the post-login redirect. Comparing against the full FRONTEND_URL
    // would never match, silently failing every cross-origin request.
    const corsMiddleware = cors({
      origin: new URL(c.env.FRONTEND_URL).origin,
      allowHeaders: ['Content-Type', 'Authorization'],
      allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    });
    return corsMiddleware(c, next);
  });

  app.route('/auth', authRoutes);

  app.use('/me/*', requireAuth);
  app.route('/me', meRoutes);

  app.use('/guilds/*', requireAuth);
  app.route('/guilds', guildRoutes);

  app.use('/groups/*', requireAuth);
  app.route('/groups', groupRoutes);

  app.use('/events/*', requireAuth);
  app.route('/events', eventRoutes);
  app.route('/events', pollRoutes);

  app.use('/admin/*', requireAuth);
  app.route('/admin', adminRoutes);

  return app;
}
