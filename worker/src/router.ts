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
import { personalRoutes } from './routes/personal';
import { adminRoutes } from './routes/admin';
import { MAX_BODY_BYTES, ValidationError } from './lib/validate';

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

  // Rejects an oversized body by its declared Content-Length before any
  // route buffers it into memory as JSON. A request that omits
  // Content-Length (chunked transfer) falls through to this check and to
  // Cloudflare's own platform-level body size ceiling as a backstop.
  app.use('*', async (c, next) => {
    const len = c.req.header('Content-Length');
    if (len && Number(len) > MAX_BODY_BYTES) return c.text('Request body too large', 413);
    await next();
    c.header('Referrer-Policy', 'no-referrer');
  });

  app.onError((err, c) => {
    if (err instanceof ValidationError) return c.text(err.message, 400);
    console.error('Unhandled error:', err);
    return c.text('Internal error', 500);
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

  app.use('/personal-events/*', requireAuth);
  app.route('/personal-events', personalRoutes);

  app.use('/admin/*', requireAuth);
  app.route('/admin', adminRoutes);

  return app;
}
