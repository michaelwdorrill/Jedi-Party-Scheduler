import { Hono } from 'hono';
import type { AppEnv } from '../lib/authMiddleware';
import { requireAuth } from '../lib/authMiddleware';
import { exchangeCodeForToken, fetchDiscordUser, fetchDiscordUserGuilds } from '../lib/discord';
import { syncGuildMembership, upsertUser } from '../lib/db';
import { signJwt } from '../lib/jwt';

const JWT_TTL_SECONDS = 24 * 60 * 60; // 24h

export const authRoutes = new Hono<AppEnv>();

function redirectUri(c: { req: { url: string } }): string {
  return `${new URL(c.req.url).origin}/auth/callback`;
}

authRoutes.get('/login', (c) => {
  const params = new URLSearchParams({
    client_id: c.env.DISCORD_CLIENT_ID,
    redirect_uri: redirectUri(c),
    response_type: 'code',
    scope: 'identify guilds',
  });
  return c.redirect(`https://discord.com/api/oauth2/authorize?${params.toString()}`);
});

authRoutes.get('/callback', async (c) => {
  const code = c.req.query('code');
  if (!code) return c.text('Missing code', 400);

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

    const jwt = await signJwt(discordUser.id, c.env.JWT_SIGNING_KEY, JWT_TTL_SECONDS);
    return c.redirect(`${c.env.FRONTEND_URL}/#/auth/callback?token=${jwt}`);
  } catch (err) {
    return c.text(`Login failed: ${(err as Error).message}`, 500);
  }
});

authRoutes.post('/refresh', requireAuth, async (c) => {
  const userId = c.get('userId');
  const jwt = await signJwt(userId, c.env.JWT_SIGNING_KEY, JWT_TTL_SECONDS);
  return c.json({ token: jwt });
});
