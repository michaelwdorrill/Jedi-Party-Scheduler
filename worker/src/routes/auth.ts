import { Hono } from 'hono';
import type { AppEnv } from '../lib/authMiddleware';
import { requireAuth } from '../lib/authMiddleware';
import {
  exchangeCodeForToken,
  fetchDiscordUser,
  fetchDiscordUserGuilds,
  refreshUserToken,
} from '../lib/discord';
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

    await upsertUser(c.env, {
      id: discordUser.id,
      username: discordUser.username,
      globalName: discordUser.global_name,
      avatarHash: discordUser.avatar,
      discordRefreshToken: token.refresh_token,
      discordTokenExpiresAt: Date.now() + token.expires_in * 1000,
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

authRoutes.post('/sync-guilds', requireAuth, async (c) => {
  const userId = c.get('userId');
  const user = await c.env.DB.prepare(
    `SELECT discord_refresh_token FROM users WHERE id = ?`,
  )
    .bind(userId)
    .first<{ discord_refresh_token: string | null }>();

  if (!user?.discord_refresh_token) return c.text('No stored Discord session', 400);

  const token = await refreshUserToken(
    user.discord_refresh_token,
    c.env.DISCORD_CLIENT_ID,
    c.env.DISCORD_CLIENT_SECRET,
  );
  await c.env.DB.prepare(
    `UPDATE users SET discord_refresh_token = ?, discord_token_expires_at = ?, updated_at = ? WHERE id = ?`,
  )
    .bind(token.refresh_token, Date.now() + token.expires_in * 1000, Date.now(), userId)
    .run();

  const discordGuilds = await fetchDiscordUserGuilds(token.access_token);
  await syncGuildMembership(
    c.env,
    userId,
    discordGuilds.map((g) => g.id),
  );

  return c.json({ ok: true });
});
