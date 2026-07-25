const API_BASE = 'https://discord.com/api/v10';

export interface DiscordTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
}

export interface DiscordUser {
  id: string;
  username: string;
  global_name: string | null;
  avatar: string | null;
}

export interface DiscordGuild {
  id: string;
  name: string;
}

export async function exchangeCodeForToken(
  code: string,
  clientId: string,
  clientSecret: string,
  redirectUri: string,
): Promise<DiscordTokenResponse> {
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
  });
  const res = await fetch(`${API_BASE}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) throw new Error(`Discord token exchange failed: ${res.status} ${await res.text()}`);
  return res.json();
}

export async function refreshUserToken(
  refreshToken: string,
  clientId: string,
  clientSecret: string,
): Promise<DiscordTokenResponse> {
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });
  const res = await fetch(`${API_BASE}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) throw new Error(`Discord token refresh failed: ${res.status} ${await res.text()}`);
  return res.json();
}

export async function fetchDiscordUser(accessToken: string): Promise<DiscordUser> {
  const res = await fetch(`${API_BASE}/users/@me`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`Discord /users/@me failed: ${res.status}`);
  return res.json();
}

export async function fetchDiscordUserGuilds(accessToken: string): Promise<DiscordGuild[]> {
  const res = await fetch(`${API_BASE}/users/@me/guilds`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`Discord /users/@me/guilds failed: ${res.status}`);
  return res.json();
}

export interface DmSendResult {
  ok: boolean;
  status: number;
  retryAfterMs?: number;
}

// Opens (or reuses) a DM channel with the given user and sends `content` via
// the bot. Returns enough info for the caller to decide whether to retry.
export async function sendBotDm(
  botToken: string,
  recipientUserId: string,
  content: string,
  existingChannelId?: string | null,
): Promise<{ result: DmSendResult; channelId: string | null }> {
  let channelId = existingChannelId ?? null;

  if (!channelId) {
    const channelRes = await fetch(`${API_BASE}/users/@me/channels`, {
      method: 'POST',
      headers: {
        Authorization: `Bot ${botToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ recipient_id: recipientUserId }),
    });
    if (!channelRes.ok) {
      return { result: { ok: false, status: channelRes.status }, channelId: null };
    }
    const channel = (await channelRes.json()) as { id: string };
    channelId = channel.id;
  }

  const messageRes = await fetch(`${API_BASE}/channels/${channelId}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bot ${botToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ content }),
  });

  if (messageRes.status === 429) {
    const body = (await messageRes.json().catch(() => ({}))) as { retry_after?: number };
    return {
      result: { ok: false, status: 429, retryAfterMs: (body.retry_after ?? 1) * 1000 },
      channelId,
    };
  }

  return { result: { ok: messageRes.ok, status: messageRes.status }, channelId };
}
