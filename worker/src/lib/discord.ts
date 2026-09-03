import { dmEmbeds } from './dmComponents';

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
  // Only meaningful on the response to /users/@me/guilds (an OAuth-scoped
  // call about the caller's own membership) -- owner is true iff the caller
  // owns that guild, and permissions is the caller's own permission bitfield
  // in it, stringified because it can exceed a JS safe integer. Both are
  // present on every real Discord response; declared optional here only
  // because nothing enforces that at the type level and the login flow
  // (routes/auth.ts) never reads either, so a mock/fixture without them
  // shouldn't be forced to add fields it doesn't use.
  owner?: boolean;
  permissions?: string;
}

// MANAGE_GUILD. https://discord.com/developers/docs/topics/permissions
const MANAGE_GUILD = 0x20n;
// ADMINISTRATOR implies every permission, MANAGE_GUILD included, but Discord
// does not also set MANAGE_GUILD's bit for an administrator -- checking only
// MANAGE_GUILD would wrongly refuse a guild's own admins.
const ADMINISTRATOR = 0x8n;

// specs/0015: who may request adding the bot to a server that isn't
// allow-listed yet. `permissions` is a stringified bitfield (can exceed a
// safe JS integer, hence BigInt) or absent/malformed on anything that isn't
// a real Discord response -- either of those is "no", not a thrown error.
export function canAdministerGuild(guild: DiscordGuild): boolean {
  if (guild.owner) return true;
  try {
    const bits = BigInt(guild.permissions ?? '0');
    return (bits & (MANAGE_GUILD | ADMINISTRATOR)) !== 0n;
  } catch {
    return false;
  }
}

export interface DiscordVoiceChannel {
  id: string;
  name: string;
}

// Discord channel types: 2 = GUILD_VOICE, 13 = GUILD_STAGE_VOICE.
// https://discord.com/developers/docs/resources/channel#channel-object-channel-types
const VOICE_CHANNEL_TYPES = new Set([2, 13]);

// Lists the guild's voice/stage channels for the event-organizer's picker.
// Bots don't need any special permission beyond already being a member of the
// guild to list channels via this endpoint.
export async function fetchGuildVoiceChannels(botToken: string, guildId: string): Promise<DiscordVoiceChannel[]> {
  const res = await fetch(`${API_BASE}/guilds/${guildId}/channels`, {
    headers: { Authorization: `Bot ${botToken}` },
  });
  if (!res.ok) throw new Error(`Discord /guilds/${guildId}/channels failed: ${res.status}`);
  const channels = (await res.json()) as { id: string; name: string; type: number }[];
  return channels.filter((c) => VOICE_CHANNEL_TYPES.has(c.type)).map((c) => ({ id: c.id, name: c.name }));
}

// IDEAS item 58: the self-service add flow (specs/0015) gives an admin a
// one-click way to put the bot into their server; this is the other half.
// DELETE /users/@me/guilds/{id} with the *bot's own* token makes the bot
// remove itself -- no permission needed on anyone's Discord account, unlike
// the "Kick" the bot would otherwise need someone to have on it. A 204 and a
// 404 (bot already isn't in the guild -- e.g. a human already kicked it, or
// this is called twice) are both success from the caller's point of view.
export async function leaveGuild(botToken: string, guildId: string): Promise<void> {
  const res = await fetch(`${API_BASE}/users/@me/guilds/${guildId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bot ${botToken}` },
  });
  if (!res.ok && res.status !== 404) {
    throw new Error(`Discord DELETE /users/@me/guilds/${guildId} failed: ${res.status}`);
  }
}

// Deliberately more granular than "yes / no / dunno". Only `member` and
// `not_member` are answers about the *user*; the other two are answers about
// our own ability to ask the question, and they have very different
// operational meanings:
//
//   bot_unauthorized  the bot token is wrong/revoked (401), or the bot isn't
//                     in this guild any more (403). Persistent, and nothing
//                     resolves it except an operator fixing the Discord app.
//   temporarily_unavailable  rate limit (429), Discord 5xx, or a network
//                     failure. Expected to clear on its own.
//
// Collapsing these into one bucket is what made the previous version
// indistinguishable in logs: a permanently broken bot looked exactly like a
// thirty-second Discord blip. See docs/SETUP.md's operations note.
export type GuildMembershipStatus = 'member' | 'not_member' | 'bot_unauthorized' | 'temporarily_unavailable';

// Live check against Discord's own membership record, used to revalidate a
// stale cache entry (see isGuildMember in db.ts). This single REST lookup
// does not require the privileged GUILD_MEMBERS intent -- that's only needed
// for the gateway member list/events, not this per-user fetch.
export async function checkGuildMembership(
  botToken: string,
  guildId: string,
  userId: string,
): Promise<GuildMembershipStatus> {
  try {
    const res = await fetch(`${API_BASE}/guilds/${guildId}/members/${userId}`, {
      headers: { Authorization: `Bot ${botToken}` },
    });
    if (res.status === 200) return 'member';
    if (res.status === 404) return 'not_member';
    if (res.status === 401 || res.status === 403) {
      console.error(
        `Discord membership check rejected (${res.status}) for guild ${guildId}: ` +
          `the bot token is invalid or the bot is no longer in this server. ` +
          `Membership can no longer be verified until this is fixed.`,
      );
      return 'bot_unauthorized';
    }
    console.warn(`Discord membership check unavailable (${res.status}) for guild ${guildId}/user ${userId}`);
    return 'temporarily_unavailable';
  } catch (err) {
    console.warn(`Discord membership check failed for guild ${guildId}/user ${userId}:`, err);
    return 'temporarily_unavailable';
  }
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

// Discord's hard cap on a message's content field.
const DISCORD_MAX_CONTENT_LENGTH = 2000;

// User-controlled strings (event titles, group names, voice-channel names)
// get interpolated into DM content built elsewhere. Truncating here --
// rather than trusting callers to have already bounded everything -- is the
// one place that guarantees Discord never rejects a message for being too
// long, which would otherwise leave a notification permanently "sent" in our
// dedupe log (see notifyOnce) despite never actually reaching the recipient.
export function boundContent(content: string): string {
  return content.length > DISCORD_MAX_CONTENT_LENGTH
    ? `${content.slice(0, DISCORD_MAX_CONTENT_LENGTH - 1)}…`
    : content;
}

// Comfortably below the notification outbox's 5-minute lease (see
// lib/outbox.ts's LEASE_MS): the whole point of the lease is that a second
// invocation can safely reclaim a row once it expires, but that's only true
// if a first invocation can't still be mid-flight when it does. An unbounded
// fetch could hang past the lease and let both invocations' sends reach
// Discord. Two fetches (channel open + message send) both bounded by this
// keeps the worst case for one sendBotDm call well under the lease even if
// both hang.
export const DISCORD_FETCH_TIMEOUT_MS = 20_000;

// Rewrites a message the bot already sent (specs/0010, edit-on-resolve).
//
// Every failure here is an ordinary outcome rather than something to retry,
// and that is the whole design of this path. A message is editable only by
// the application that sent it, so a production id is not editable by the
// sandbox bot and vice versa; a recipient can delete a DM; a channel can go
// away. In all of those Discord answers 4xx and the right response is to
// leave the message alone -- which is exactly what the app did before this
// feature existed, so the fallback is the old behaviour rather than a broken
// one.
//
// Returns whether the edit landed, so the caller can record it and stop
// trying. `retryable` separates "Discord was briefly unavailable" from "this
// will never work", because only the first is worth another tick.
export async function editBotDm(
  botToken: string,
  channelId: string,
  messageId: string,
  content: string,
  components?: unknown[] | null,
): Promise<{ ok: boolean; status: number; retryable: boolean }> {
  const embeds = dmEmbeds(content, components);

  let res: Response;
  try {
    res = await fetch(`${API_BASE}/channels/${channelId}/messages/${messageId}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bot ${botToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        content: embeds ? '' : boundContent(content),
        // Always sent, for the same reason as `components` below: an edit that
        // strips the controls (a cancelled poll) must strip the embed with
        // them, and [] is how Discord is told to remove one.
        embeds: embeds ?? [],
        allowed_mentions: { parse: [] },
        // Always sent, unlike on create: [] is how Discord is told to *remove*
        // the controls, which is most of the point of editing at all.
        components: components ?? [],
      }),
      signal: AbortSignal.timeout(DISCORD_FETCH_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, status: 0, retryable: true };
  }

  if (res.ok) return { ok: true, status: res.status, retryable: false };
  const retryable = res.status === 429 || res.status >= 500;
  return { ok: false, status: res.status, retryable };
}

// Opens (or reuses) a DM channel with the given user and sends `content` via
// the bot. Returns enough info for the caller to decide whether to retry.
// Never throws for a network-level failure (including a timeout) -- those
// come back as the same shape a 5xx would, since to a caller deciding
// whether to retry, "Discord didn't answer" and "Discord errored" mean the
// same thing.
//
// `messageId` is the sent message's own id, read out of the create response
// (IDEAS.md item 32: it used to be discarded at the moment it arrived, which
// is what made specs/0010's edit-the-message-in-place feature a schema change
// rather than the freebie idea 19 assumed). It is null whenever the send did
// not succeed, and also whenever Discord answered 2xx with a body this can't
// read -- an id we are not sure of is worse than none, because the edit path
// treats "no id" as "leave the message alone" and would otherwise PATCH
// something arbitrary.
export async function sendBotDm(
  botToken: string,
  recipientUserId: string,
  content: string,
  existingChannelId?: string | null,
  // Discord message components (specs/0010) -- the buttons and selects that
  // let a DM be answered in place. Passed straight through as the caller
  // assembled them; this module does not build them (lib/dmComponents.ts
  // does) and does not interpret them.
  components?: unknown[] | null,
): Promise<{ result: DmSendResult; channelId: string | null; messageId: string | null }> {
  let channelId = existingChannelId ?? null;

  if (!channelId) {
    let channelRes: Response;
    try {
      channelRes = await fetch(`${API_BASE}/users/@me/channels`, {
        method: 'POST',
        headers: {
          Authorization: `Bot ${botToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ recipient_id: recipientUserId }),
        signal: AbortSignal.timeout(DISCORD_FETCH_TIMEOUT_MS),
      });
    } catch {
      return { result: { ok: false, status: 0 }, channelId: null, messageId: null };
    }
    if (!channelRes.ok) {
      return { result: { ok: false, status: channelRes.status }, channelId: null, messageId: null };
    }
    const channel = (await channelRes.json()) as { id: string };
    channelId = channel.id;
  }

  // Derived here rather than by the caller, so that every path into this
  // function -- a source sweep's first attempt and the retry consumer's
  // redelivery from the stored content -- produces identical embeds
  // (specs/0010, and see dmEmbeds for why that is what makes them free).
  const embeds = dmEmbeds(content, components);

  let messageRes: Response;
  try {
    messageRes = await fetch(`${API_BASE}/channels/${channelId}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bot ${botToken}`,
        'Content-Type': 'application/json',
      },
      // allowed_mentions suppresses @everyone/@here/user/role pings that
      // could otherwise be smuggled in through a user-controlled
      // event/group/channel name and fired off by the trusted bot account.
      body: JSON.stringify({
        // The text goes in the embed when there is one, and in `content`
        // otherwise. Never both: Discord renders each, so setting the two
        // would say everything twice.
        content: embeds ? '' : boundContent(content),
        ...(embeds ? { embeds } : {}),
        allowed_mentions: { parse: [] },
        // Omitted entirely rather than sent as [] when there are none: an
        // empty array is a meaningful value to Discord (it *clears*
        // components) and this is a message-create, where there is nothing
        // to clear.
        ...(components && components.length > 0 ? { components } : {}),
      }),
      signal: AbortSignal.timeout(DISCORD_FETCH_TIMEOUT_MS),
    });
  } catch {
    return { result: { ok: false, status: 0 }, channelId, messageId: null };
  }

  if (messageRes.status === 429) {
    // Discord reports the wait in the JSON body's `retry_after` (seconds), and
    // also in the standard Retry-After header. Read the body first, but fall
    // back to the header rather than defaulting to one second when the body
    // isn't the shape we expect -- a truncated or non-JSON error response
    // would otherwise turn a long rate-limit window into an immediate retry.
    const body = (await messageRes.json().catch(() => ({}))) as { retry_after?: number };
    const headerSeconds = Number(messageRes.headers.get('Retry-After'));
    const seconds =
      body.retry_after ?? (Number.isFinite(headerSeconds) && headerSeconds > 0 ? headerSeconds : 1);
    return {
      result: { ok: false, status: 429, retryAfterMs: seconds * 1000 },
      channelId,
      messageId: null,
    };
  }

  if (!messageRes.ok) {
    return { result: { ok: false, status: messageRes.status }, channelId, messageId: null };
  }

  // A body that doesn't parse, or parses without an id, is not a failed send
  // -- Discord accepted the message and the recipient has it. Only the
  // ability to edit it later is lost, so this degrades to null rather than
  // turning a delivered notification into a retry.
  const message = (await messageRes.json().catch(() => null)) as { id?: unknown } | null;
  const messageId = typeof message?.id === 'string' ? message.id : null;

  return { result: { ok: true, status: messageRes.status }, channelId, messageId };
}
