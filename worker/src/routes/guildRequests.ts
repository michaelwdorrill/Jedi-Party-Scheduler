// IDEAS item 9 / docs/specs/0015: self-service "add this bot to your
// server" requests, gated by owner approval.
//
// Everything here is deliberately unauthenticated by requireAuth -- see the
// spec's "Who may request, and for what" section. /connect and /callback are
// their own short-lived Discord OAuth round trip (mirroring routes/auth.ts's
// login flow, but never issuing a session), because the app persists no
// Discord access token past login to ask "does this person administer guild
// X" with later, and user_guild_membership can't hold a row for a guild
// that isn't allow-listed yet either way. POST / consumes the signed token
// that round trip hands back, which is its own proof of both identity and
// permission -- a session would be redundant. GET /:token/decide consumes a
// different signed token (the emailed decision link), presented by the
// owner from wherever they read mail, which may not be a logged-in browser.
import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { AppEnv } from '../lib/authMiddleware';
import { canAdministerGuild, exchangeCodeForToken, fetchDiscordUser, fetchDiscordUserGuilds } from '../lib/discord';
import {
  createGuildAddRequest,
  decideGuildAddRequest,
  DECISION_TOKEN_PURPOSE,
  type DecisionTokenPayload,
  GUILD_VERIFY_TOKEN_PURPOSE,
  type GuildVerifyTokenPayload,
  signGuildVerifyToken,
} from '../lib/guildRequests';
import { verifyToken } from '../lib/signedToken';
import { assertString, readJsonBody } from '../lib/validate';

export const guildRequestRoutes = new Hono<AppEnv>();

const STATE_COOKIE = 'guild_verify_state';
const NO_STORE = 'no-store, private';

function redirectUri(c: { req: { url: string } }): string {
  return `${new URL(c.req.url).origin}/guild-requests/callback`;
}

function randomState(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Where the frontend's request-picker page lives, so /callback can hand the
// filtered guild list back to something a person can actually click through.
function frontendRequestPageUrl(c: { env: { FRONTEND_URL: string } }): string {
  return `${c.env.FRONTEND_URL}/#/add-bot`;
}

guildRequestRoutes.get('/connect', (c) => {
  const state = randomState();
  setCookie(c, STATE_COOKIE, state, {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    path: '/guild-requests',
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

guildRequestRoutes.get('/callback', async (c) => {
  const code = c.req.query('code');
  const state = c.req.query('state');
  const cookieState = getCookie(c, STATE_COOKIE);
  deleteCookie(c, STATE_COOKIE, { path: '/guild-requests' });

  if (!code || !state || !cookieState || state !== cookieState) {
    c.header('Cache-Control', NO_STORE);
    return c.text('This request could not be verified. Please try again.', 400);
  }

  try {
    const token = await exchangeCodeForToken(code, c.env.DISCORD_CLIENT_ID, c.env.DISCORD_CLIENT_SECRET, redirectUri(c));
    const [discordUser, discordGuilds] = await Promise.all([
      fetchDiscordUser(token.access_token),
      fetchDiscordUserGuilds(token.access_token),
    ]);
    // Discarded immediately after this call, same discipline as
    // routes/auth.ts's login callback -- nothing here needs to act on
    // Discord's behalf again.

    // Requesting a new server is not the same thing as logging in, but it
    // still requires having *ever* logged in: an account with zero
    // relationship to this app has no standing to ask for a server to be
    // added, and `guild_add_requests.requested_by` is a real FK into users.
    const isKnownUser = await c.env.DB.prepare(`SELECT 1 FROM users WHERE id = ?`).bind(discordUser.id).first();
    if (!isKnownUser) {
      c.header('Cache-Control', NO_STORE);
      return c.text(
        "You'll need to log into the site at least once before requesting a server -- " +
          'this proves who you are the same way logging in does.',
        403,
      );
    }

    const administered = discordGuilds.filter(canAdministerGuild);
    const candidates = await Promise.all(
      administered.map(async (g) => {
        const active = await c.env.DB.prepare(`SELECT 1 FROM guilds WHERE id = ? AND is_active = 1`).bind(g.id).first();
        if (active) return null;
        const payload: GuildVerifyTokenPayload = { guildId: g.id, guildName: g.name, requestedBy: discordUser.id };
        return { guildId: g.id, guildName: g.name, token: await signGuildVerifyToken(c.env, payload) };
      }),
    );
    const eligible = candidates.filter((x): x is NonNullable<typeof x> => x !== null);

    // Base64 output can contain '+' and '/', both meaningful in a query
    // string ('+' decodes to a space under application/x-www-form-urlencoded
    // parsing) -- encodeURIComponent is what makes this round-trip correctly
    // through URLSearchParams on the way back out.
    const data = encodeURIComponent(btoa(unescape(encodeURIComponent(JSON.stringify(eligible)))));
    c.header('Cache-Control', NO_STORE);
    return c.redirect(`${frontendRequestPageUrl(c)}?data=${data}`);
  } catch (err) {
    console.error('Guild-request Discord verification failed:', err);
    c.header('Cache-Control', NO_STORE);
    return c.text('Verification failed. Please try again.', 500);
  }
});

guildRequestRoutes.post('/', async (c) => {
  c.header('Cache-Control', NO_STORE);
  const body = await readJsonBody<{ token: string }>(c);
  const rawToken = assertString(body.token, 'token', 2000);

  const payload = await verifyToken<GuildVerifyTokenPayload>(rawToken, GUILD_VERIFY_TOKEN_PURPOSE, c.env.JWT_SIGNING_KEY);
  if (!payload) return c.text('This request link has expired. Please start over.', 400);

  const workerOrigin = new URL(c.req.url).origin;
  const result = await createGuildAddRequest(c.env, payload, workerOrigin);

  if (result.outcome === 'already_active') {
    return c.json({ status: 'already_active', message: 'This server already has the bot.' });
  }
  if (result.outcome === 'already_pending') {
    return c.json({ status: 'already_pending', message: 'A request for this server is already pending review.' });
  }

  return c.json({
    status: 'created',
    // The frontend redirects here so Discord's own consent screen is what
    // actually adds the bot -- see specs/0015's flow step 3 for why this
    // doesn't wait for owner approval first. permissions=0: the bot needs no
    // elevated guild permissions (lib/discord.ts's fetchGuildVoiceChannels
    // already notes bots read channels with none, and every other guild-side
    // action it takes needs none either -- DMs are a user-level Discord
    // feature, not a guild permission).
    //
    // disable_guild_select=true is load-bearing, not decoration. `guild_id`
    // alone only *pre-selects* the server in Discord's dropdown -- the person
    // can still change it, which sandbox testing did by accident: a request
    // recorded for one server, the bot installed into another, and no part of
    // this flow noticing the two had diverged. The allow-list still gated
    // correctly (approval writes the *requested* guild id, never whatever
    // Discord was handed), so this was never an access hole -- but it leaves
    // an approved server with no bot in it and a bot sitting in a server
    // nobody approved, which is its own kind of wrong.
    botInviteUrl:
      `https://discord.com/oauth2/authorize?client_id=${encodeURIComponent(c.env.DISCORD_CLIENT_ID)}` +
      `&scope=bot&permissions=0&guild_id=${encodeURIComponent(payload.guildId)}&disable_guild_select=true`,
  }, 201);
});

// Consumed from an email, not a browser session -- see this file's header
// comment. A GET rather than POST because that's what a mail client's own
// link-click gives us, and the token itself (single-purpose, short-lived,
// one-shot via decided_at) is what makes a GET safe to act on here.
guildRequestRoutes.get('/:token/decide', async (c) => {
  c.header('Cache-Control', NO_STORE);
  const payload = await verifyToken<DecisionTokenPayload>(c.req.param('token'), DECISION_TOKEN_PURPOSE, c.env.JWT_SIGNING_KEY);
  if (!payload) return c.text('This link has expired or is invalid.', 400);

  const result = await decideGuildAddRequest(c.env, payload.requestId, payload.action);
  switch (result) {
    case 'approved':
      return c.text('Approved -- the server has been added to the allow-list.');
    case 'rejected':
      return c.text('Rejected -- no changes were made.');
    case 'already_decided':
      return c.text('This request was already decided (by this link or the admin page). No changes were made.');
    case 'not_found':
      return c.text('This request no longer exists.', 404);
  }
});
