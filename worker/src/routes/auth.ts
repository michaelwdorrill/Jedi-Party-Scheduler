import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { AppEnv } from '../lib/authMiddleware';
import { exchangeCodeForToken, fetchDiscordUser, fetchDiscordUserGuilds } from '../lib/discord';
import { listUserGuilds, syncGuildMembership, upsertUser } from '../lib/db';
import { signJwt, verifyJwt } from '../lib/jwt';
import { createSession, revokeSession, rotateSession } from '../lib/sessions';

export const authRoutes = new Hono<AppEnv>();

const STATE_COOKIE = 'oauth_state';
const NO_STORE = 'no-store, private';

function redirectUri(c: { req: { url: string } }): string {
  return `${new URL(c.req.url).origin}/auth/callback`;
}

function randomState(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Double-submit-cookie CSRF binding: the state only Discord ever sees is
// mirrored into an HttpOnly cookie on *this* browser. An attacker who injects
// a code+state pair captured from their own login attempt cannot also set
// this cookie on the victim's browser, so the callback can tell "a login this
// browser started" apart from "a login someone else started and redirected
// the victim into." No server-side storage needed -- the cookie IS the state.
authRoutes.get('/login', (c) => {
  const state = randomState();
  setCookie(c, STATE_COOKIE, state, {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    path: '/auth',
    maxAge: 600,
  });
  const params = new URLSearchParams({
    client_id: c.env.DISCORD_CLIENT_ID,
    redirect_uri: redirectUri(c),
    response_type: 'code',
    scope: 'identify guilds',
    state,
  });
  return c.redirect(`https://discord.com/api/oauth2/authorize?${params.toString()}`);
});

authRoutes.get('/callback', async (c) => {
  const code = c.req.query('code');
  const state = c.req.query('state');
  const cookieState = getCookie(c, STATE_COOKIE);
  deleteCookie(c, STATE_COOKIE, { path: '/auth' });

  if (!code) return c.text('Missing code', 400);
  if (!state || !cookieState || state !== cookieState) {
    // Covers a missing/forged state, an expired cookie, and callback replay
    // (the cookie is cleared above on first use either way).
    return c.text('Login request could not be verified. Please try logging in again.', 400);
  }

  try {
    const token = await exchangeCodeForToken(
      code,
      c.env.DISCORD_CLIENT_ID,
      c.env.DISCORD_CLIENT_SECRET,
      redirectUri(c),
    );
    const [discordUser, discordGuilds] = await Promise.all([
      fetchDiscordUser(token.access_token),
      fetchDiscordUserGuilds(token.access_token),
    ]);

    // Discord's access/refresh tokens are deliberately NOT persisted -- they
    // are used once here to read the profile and guild list, then discarded.
    // Nothing in the app needs to act on Discord's behalf later, so keeping
    // them would be retaining API Data beyond what the functionality requires.
    await upsertUser(c.env, {
      id: discordUser.id,
      username: discordUser.username,
      globalName: discordUser.global_name,
      avatarHash: discordUser.avatar,
    });
    await syncGuildMembership(
      c.env,
      discordUser.id,
      discordGuilds.map((g) => g.id),
    );

    // This app has nothing to offer someone who shares none of the
    // allow-listed servers -- personal scheduling is meant to complement a
    // guild's calendar, not stand alone. Reject before any session/JWT is
    // issued rather than letting an unrelated Discord account accumulate data.
    const activeGuilds = await listUserGuilds(c.env, discordUser.id);
    if (activeGuilds.length === 0) {
      c.header('Cache-Control', NO_STORE);
      return c.text("You're not a member of any server this app is set up for.", 403);
    }

    const session = await createSession(c.env, discordUser.id);
    const jwt = await signJwt(discordUser.id, session.id, c.env.JWT_SIGNING_KEY);
    c.header('Cache-Control', NO_STORE);
    return c.redirect(`${c.env.FRONTEND_URL}/#/auth/callback?token=${jwt}`);
  } catch (err) {
    // Never reflect the raw upstream error back to the browser -- it can
    // contain Discord response bodies. Server-side logs get the detail.
    console.error('OAuth callback failed:', err);
    c.header('Cache-Control', NO_STORE);
    return c.text('Login failed. Please try again.', 500);
  }
});

authRoutes.post('/refresh', async (c) => {
  c.header('Cache-Control', NO_STORE);
  const header = c.req.header('Authorization');
  const token = header?.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return c.text('Unauthorized', 401);

  // Deliberately ignores `exp` here: the whole point of refresh is renewing a
  // token *after* its short lifetime has passed. Signature, structure, and
  // claim shape are still fully validated; actual authority comes from
  // rotateSession() confirming the underlying session is still active.
  const payload = await verifyJwt(token, c.env.JWT_SIGNING_KEY, { ignoreExpiration: true });
  if (!payload) return c.text('Unauthorized', 401);

  const rotated = await rotateSession(c.env, payload.sid, payload.sub);
  if (!rotated) return c.text('Unauthorized', 401);

  const jwt = await signJwt(payload.sub, payload.sid, c.env.JWT_SIGNING_KEY);
  return c.json({ token: jwt });
});

authRoutes.post('/logout', async (c) => {
  c.header('Cache-Control', NO_STORE);
  // Deliberately not gated on requireAuth: the whole point of logout is to
  // revoke a session, and that must still work when the access token handed
  // to it has already expired (e.g. the browser sat idle past 30 minutes
  // before the user clicked "log out"). Signature and claim shape are still
  // fully verified -- this isn't an open revoke-anything endpoint, just one
  // that doesn't also demand a *currently valid* token to do its job.
  const header = c.req.header('Authorization');
  const token = header?.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return c.json({ ok: true }); // nothing to revoke

  const payload = await verifyJwt(token, c.env.JWT_SIGNING_KEY, { ignoreExpiration: true });
  if (payload) await revokeSession(c.env, payload.sid);
  return c.json({ ok: true });
});
