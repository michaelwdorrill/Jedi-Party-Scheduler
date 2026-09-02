import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { AppEnv } from './lib/authMiddleware';
import { requireAuth, requirePolicyAcceptance } from './lib/authMiddleware';
import { authRoutes } from './routes/auth';
import { meRoutes } from './routes/me';
import { guildRoutes } from './routes/guilds';
import { groupRoutes } from './routes/groups';
import { eventRoutes } from './routes/events';
import { pollRoutes } from './routes/polls';
import { changeRequestRoutes } from './routes/changeRequests';
import { personalRoutes } from './routes/personal';
import { adminRoutes } from './routes/admin';
import { discordInteractionRoutes } from './routes/discordInteractions';
import { guildRequestRoutes } from './routes/guildRequests';
import { MembershipUnavailableError } from './lib/db';
import { BodyTooLargeError, ConflictError, FreeBusyTooLargeError, MAX_BODY_BYTES, ValidationError } from './lib/validate';

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
    if (err instanceof BodyTooLargeError) return c.text(err.message, 413);
    if (err instanceof ValidationError) return c.text(err.message, 400);
    // 409, not 400: the request was well-formed and authorized, it just
    // raced someone else's edit. Retrying against fresh state is the fix.
    if (err instanceof ConflictError) return c.text(err.message, 409);
    // 422, not 400: the request is syntactically valid and authorized. What
    // failed is that answering it accurately would cost more work than one
    // invocation is allowed -- so it is refused rather than answered wrongly.
    if (err instanceof FreeBusyTooLargeError) return c.text(err.message, 422);
    // Membership couldn't be confirmed with Discord and the cached answer is
    // too old to keep honouring. Deliberately a 503, not a 403: nothing about
    // the caller's authorization has been established, so telling them
    // they're forbidden would be a guess -- and the wrong one to act on. See
    // MEMBERSHIP_GRACE_MS in lib/db.ts.
    if (err instanceof MembershipUnavailableError) {
      c.header('Retry-After', '300');
      return c.text(
        "Can't confirm your Discord server membership right now -- this is usually a temporary " +
          'Discord problem. Try again in a few minutes.',
        503,
      );
    }
    console.error('Unhandled error:', err);
    return c.text('Internal error', 500);
  });

  app.route('/auth', authRoutes);

  // Everything authenticated is also gated on having agreed to the current
  // Terms and Privacy Policy (docs/specs/0012), with four routes under /me
  // deliberately left reachable while ungated -- see the exemptions below.
  app.use('/me/*', requireAuth);
  app.route('/me', meRoutes);

  app.use('/guilds/*', requireAuth, requirePolicyAcceptance);
  app.route('/guilds', guildRoutes);

  app.use('/groups/*', requireAuth, requirePolicyAcceptance);
  app.route('/groups', groupRoutes);

  app.use('/events/*', requireAuth, requirePolicyAcceptance);
  app.route('/events', eventRoutes);
  app.route('/events', pollRoutes);
  app.route('/events', changeRequestRoutes);

  app.use('/personal-events/*', requireAuth, requirePolicyAcceptance);
  app.route('/personal-events', personalRoutes);

  app.use('/admin/*', requireAuth, requirePolicyAcceptance);
  app.route('/admin', adminRoutes);

  // Unauthenticated on purpose: a Discord interaction arrives with no cookie
  // and no Authorization header, so this endpoint authenticates by Ed25519
  // signature alone and cannot sit behind requireAuth. It is also outside the
  // policy gate -- a button press is not a place to put a Terms dialog, and
  // the acceptance state is checked where it can actually be shown.
  app.route('/discord', discordInteractionRoutes);

  // Unauthenticated by design (specs/0015): this is its own short-lived
  // Discord OAuth round trip and a pair of signed-token capabilities, not a
  // site session -- see routes/guildRequests.ts's header comment for why
  // reusing requireAuth/the policy gate doesn't fit here.
  app.route('/guild-requests', guildRequestRoutes);

  return app;
}
