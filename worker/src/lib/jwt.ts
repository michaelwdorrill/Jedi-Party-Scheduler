// Minimal HS256 JWT sign/verify using Web Crypto (available natively in the
// Workers runtime) -- avoids pulling in a full JWT library for two functions.

import { base64UrlDecode, base64UrlEncode, textToBase64Url } from './base64url';

export interface JwtPayload {
  sub: string; // discord user id
  sid: string; // session id -- looked up in the `sessions` table on every request
  iat: number;
  exp: number;
}

// Short-lived on purpose: real revocation (logout, account deletion, guild
// departure) happens at the session layer, not by waiting out the JWT. This
// TTL just bounds how long a captured-but-not-yet-revoked token is usable.
export const ACCESS_TOKEN_TTL_SECONDS = 30 * 60;

// Defense-in-depth sanity ceiling on any token's claimed lifetime, independent
// of which TTL constant signed it -- catches a malformed/forged payload that
// slipped past signature verification some other way.
const MAX_TOKEN_LIFETIME_SECONDS = 24 * 60 * 60;

async function importHmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

export async function signJwt(
  sub: string,
  sid: string,
  secret: string,
  expiresInSeconds: number = ACCESS_TOKEN_TTL_SECONDS,
): Promise<string> {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const payload: JwtPayload = { sub, sid, iat: now, exp: now + expiresInSeconds };

  const headerB64 = textToBase64Url(JSON.stringify(header));
  const payloadB64 = textToBase64Url(JSON.stringify(payload));
  const signingInput = `${headerB64}.${payloadB64}`;

  const key = await importHmacKey(secret);
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signingInput));
  const signatureB64 = base64UrlEncode(new Uint8Array(signature));

  return `${signingInput}.${signatureB64}`;
}

export interface VerifyJwtOptions {
  // Used only by /auth/refresh: a token past its `exp` must still be
  // verifiable so an active *session* (checked separately) can mint a new
  // one, without forcing a full Discord re-login every ACCESS_TOKEN_TTL.
  ignoreExpiration?: boolean;
}

// Every failure mode -- malformed Base64URL, invalid JSON, wrong segment
// count, wrong algorithm, missing/wrong-typed claims -- funnels through this
// one try/catch and returns null, so a bad token is always a clean 401, never
// an uncaught exception.
export async function verifyJwt(token: string, secret: string, opts: VerifyJwtOptions = {}): Promise<JwtPayload | null> {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [headerB64, payloadB64, signatureB64] = parts;

    const header = JSON.parse(new TextDecoder().decode(base64UrlDecode(headerB64))) as {
      alg?: string;
      typ?: string;
    };
    if (header.alg !== 'HS256' || header.typ !== 'JWT') return null;

    const key = await importHmacKey(secret);
    const valid = await crypto.subtle.verify(
      'HMAC',
      key,
      base64UrlDecode(signatureB64),
      new TextEncoder().encode(`${headerB64}.${payloadB64}`),
    );
    if (!valid) return null;

    const payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(payloadB64))) as Partial<JwtPayload>;
    if (typeof payload.sub !== 'string' || !payload.sub) return null;
    if (typeof payload.sid !== 'string' || !payload.sid) return null;
    if (!Number.isFinite(payload.iat) || !Number.isFinite(payload.exp)) return null;
    if (payload.exp! <= payload.iat!) return null;
    if (payload.exp! - payload.iat! > MAX_TOKEN_LIFETIME_SECONDS) return null;
    if (!opts.ignoreExpiration && payload.exp! * 1000 < Date.now()) return null;

    return payload as JwtPayload;
  } catch {
    return null;
  }
}
