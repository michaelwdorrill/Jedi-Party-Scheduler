import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { AppEnv } from '../lib/authMiddleware';
import { exchangeCodeForToken, fetchDiscordUser, fetchDiscordUserGuilds } from '../lib/discord';
import { activeAllowListedGuildIds, markLoginSucceeded, syncGuildMembership, upsertUser } from '../lib/db';
import { signJwt, verifyJwt } from '../lib/jwt';
import { createSession, revokeSession, rotateSession } from '../lib/sessions';
import { signToken, verifyToken } from '../lib/signedToken';
import { base64UrlEncode } from '../lib/base64url';

export const authRoutes = new Hono<AppEnv>();

const STATE_COOKIE = 'oauth_state';
const NO_STORE = 'no-store, private';

// Pass-11 review (R02). The callback used to finish a login by redirecting to
// `${FRONTEND_URL}/#/auth/callback?token=<jwt>`, and the frontend installed
// whatever token was in that fragment as the browser's session. The Discord
// leg was properly CSRF-bound (the state cookie below), but this last hop was
// not bound to anything at all: a person with a valid session could send
// someone else that URL carrying their *own* token, and the visitor would
// silently become logged in as them -- then save personal time, private notes
// or a Google connection into an account the sender controls. Login CSRF, not
// a stolen token.
//
// So the redirect now carries a one-time login *code* that is worthless on its
// own, and the browser that started the login proves it did by producing a
// secret only it holds. That is PKCE, applied to this app's own final hop
// rather than to the provider leg: the frontend mints a random verifier before
// navigating, keeps it in sessionStorage, and sends only its SHA-256 challenge
// through the redirect chain. A victim's browser has no verifier matching an
// attacker's code, so an unsolicited callback URL cannot be completed.
//
// Deliberately not a server-side pending-code table: the code names a session
// that already exists, and with the verifier required, a replay within the
// two-minute window is only possible for the browser that legitimately holds
// it. That buys one-time semantics where they matter without a migration, a
// new table and a pruning sweep.
const LOGIN_CODE_PURPOSE = 'login_code';
const LOGIN_CODE_TTL_SECONDS = 120;

// The challenge is the Base64URL of a SHA-256 digest: 43 characters, no
// padding. Checked on the way in so a malformed one fails at /login rather
// than silently never matching at redemption.
const CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

async function sha256Base64Url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return base64UrlEncode(new Uint8Array(digest));
}

interface LoginCodePayload {
  userId: string;
  sessionId: string;
  challenge: string;
}

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
  // Required, not optional: accepting a login that carries no challenge would
  // leave the pre-R02 path open alongside the fixed one, which is the same as
  // not fixing it. A browser arriving here without one is running a frontend
  // build older than this Worker, and re-loading the page is the whole remedy.
  const challenge = c.req.query('challenge');
  if (!challenge || !CHALLENGE_PATTERN.test(challenge)) {
    c.header('Cache-Control', NO_STORE);
    return c.text('Login could not be started. Please reload the page and try again.', 400);
  }

  const state = randomState();
  // Both halves in the one HttpOnly cookie -- only the server ever reads it.
  // ':' is safe as a separator because both values are Base64URL, whose
  // alphabet does not include it.
  setCookie(c, STATE_COOKIE, `${state}:${challenge}`, {
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
  const cookieValue = getCookie(c, STATE_COOKIE);
  deleteCookie(c, STATE_COOKIE, { path: '/auth' });
  const [cookieState, challenge] = (cookieValue ?? '').split(':');

  if (!code) return c.text('Missing code', 400);
  if (!challenge) {
    c.header('Cache-Control', NO_STORE);
    return c.text('Login request could not be verified. Please try logging in again.', 400);
  }
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

    // This app has nothing to offer someone who shares none of the
    // allow-listed servers -- personal scheduling is meant to complement a
    // guild's calendar, not stand alone.
    //
    // Pass-11 review (F-24): checked BEFORE anything is written, which it was
    // not. upsertUser ran first, so a Discord account that shares no
    // allow-listed server was turned away with a 403 and no session -- and
    // kept a full users row: id, username, display name, avatar hash,
    // last_login_attempt_at, listed on the owner's user page. Those people
    // never logged in, cannot log in to export or delete the row, and are not
    // told it exists, against a Privacy Policy that describes what is stored
    // "when you log in" and says "if something isn't listed here, the service
    // doesn't collect it".
    //
    // The intersection is a pure read, so the refusal now costs no record at
    // all for someone with no account here.
    const allowListed = await activeAllowListedGuildIds(
      c.env,
      discordGuilds.map((g) => g.id),
    );
    if (allowListed.length === 0) {
      // Migration 0018 exists so the owner can tell "logged in" from "tried
      // and was turned away", and that is still worth having -- for someone
      // who *has* an account. A returning user who has left every allow-listed
      // server is a real user whose own record this is, and it appears in
      // their export; a stranger is not, and gets a log line instead of a
      // profile. That distinction is the whole of this finding.
      const existing = await c.env.DB.prepare(`SELECT 1 FROM users WHERE id = ?`).bind(discordUser.id).first();
      if (existing) {
        await c.env.DB.prepare(`UPDATE users SET last_login_attempt_at = ? WHERE id = ?`)
          .bind(Date.now(), discordUser.id)
          .run();
      } else {
        console.warn(`Login refused for Discord id ${discordUser.id}: shares no allow-listed server. No record kept.`);
      }
      c.header('Cache-Control', NO_STORE);
      return c.text("You're not a member of any server this app is set up for.", 403);
    }

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

    // Past the guild check, so this is a real login rather than an attempt
    // that got turned away (migration 0018).
    await markLoginSucceeded(c.env, discordUser.id);

    const session = await createSession(c.env, discordUser.id);
    // No bearer token in the redirect (R02): a code, useless to anyone who
    // cannot also present the verifier whose challenge is sealed inside it.
    const loginCode = await signToken<LoginCodePayload>(
      LOGIN_CODE_PURPOSE,
      { userId: discordUser.id, sessionId: session.id, challenge },
      c.env.JWT_SIGNING_KEY,
      LOGIN_CODE_TTL_SECONDS,
    );
    c.header('Cache-Control', NO_STORE);
    return c.redirect(`${c.env.FRONTEND_URL}/#/auth/callback?code=${encodeURIComponent(loginCode)}`);
  } catch (err) {
    // Never reflect the raw upstream error back to the browser -- it can
    // contain Discord response bodies. Server-side logs get the detail.
    console.error('OAuth callback failed:', err);
    c.header('Cache-Control', NO_STORE);
    return c.text('Login failed. Please try again.', 500);
  }
});

// The second half of R02's fix. Unauthenticated by construction -- this is
// what issues the first token of a session -- but it is not unproven: the
// caller has to present a verifier whose SHA-256 matches the challenge the
// code was minted against, and that verifier never left the browser that
// started the login.
authRoutes.post('/redeem', async (c) => {
  c.header('Cache-Control', NO_STORE);

  const body = await c.req.json<{ code?: unknown; verifier?: unknown }>().catch(() => null);
  const code = typeof body?.code === 'string' ? body.code : null;
  const verifier = typeof body?.verifier === 'string' ? body.verifier : null;
  if (!code || !verifier) return c.text('Login could not be completed. Please try logging in again.', 400);

  const payload = await verifyToken<LoginCodePayload>(code, LOGIN_CODE_PURPOSE, c.env.JWT_SIGNING_KEY);
  // Covers a forged code, one signed for a different purpose, and one whose
  // two-minute window has passed.
  if (!payload) return c.text('Login could not be completed. Please try logging in again.', 400);

  // The check the whole finding turns on. A code sent to someone who did not
  // start this login stops here: their browser has no verifier that hashes to
  // the sealed challenge, and they cannot construct one without reversing
  // SHA-256.
  if ((await sha256Base64Url(verifier)) !== payload.challenge) {
    return c.text('Login could not be completed. Please try logging in again.', 403);
  }

  const jwt = await signJwt(payload.userId, payload.sessionId, c.env.JWT_SIGNING_KEY);
  return c.json({ token: jwt });
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

  // F-20: the new token names a NEW session, not the one just presented. That
  // is the whole point -- a token that could be exchanged for an equivalent
  // token forever made the 30-minute access lifetime meaningless against a
  // capture.
  const rotatedSessionId = await rotateSession(c.env, payload.sid, payload.sub);
  if (!rotatedSessionId) return c.text('Unauthorized', 401);

  const jwt = await signJwt(payload.sub, rotatedSessionId, c.env.JWT_SIGNING_KEY);
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
