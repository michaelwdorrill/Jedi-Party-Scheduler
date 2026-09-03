// Generic short-lived signed capability tokens (specs/0015), for the two
// places the guild-request flow hands someone a URL/value that has to carry
// its own proof rather than a session: the per-guild token minted after the
// Discord admin-verification round trip, and the approve/reject links in the
// owner's email.
//
// Deliberately not lib/jwt.ts's signJwt/verifyJwt: those are shaped
// specifically for the session/access-token pair (`sub`, `sid`), and forcing
// an unrelated payload (a guild id, a request id and an action) through that
// shape would mean either abusing `sub`/`sid` for something they don't mean
// or adding fields that pair doesn't use. Same primitive underneath (HMAC-
// SHA256 over a Base64URL header+payload, reusing lib/jwt.ts's key-import
// helper's shape) and the same signing key (`JWT_SIGNING_KEY` -- no new
// secret to provision for this).
//
// The `purpose` string is embedded in and checked against the signed payload
// so a token minted for one thing (say, the guild-verify handoff) can't be
// replayed where a different purpose is expected (the decision link) even
// though both are signed with the same key -- the two token *shapes* aren't
// otherwise distinguishable from bytes alone.

import { base64UrlDecode, base64UrlEncode, base64UrlToText, textToBase64Url } from './base64url';

async function importHmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

export async function signToken<T extends object>(
  purpose: string,
  payload: T,
  secret: string,
  ttlSeconds: number,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const envelope = { purpose, payload, iat: now, exp: now + ttlSeconds };
  const body = textToBase64Url(JSON.stringify(envelope));
  const key = await importHmacKey(secret);
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  return `${body}.${base64UrlEncode(new Uint8Array(signature))}`;
}

// Every failure mode -- malformed input, bad signature, wrong purpose,
// expired -- funnels through this one try/catch and returns null, so a bad
// token is always a clean "no" rather than an uncaught exception. Callers
// that need to tell "expired" apart from "invalid" (none currently do) would
// need a richer return type; nothing here has asked for that yet.
export async function verifyToken<T extends object = Record<string, unknown>>(
  token: string,
  purpose: string,
  secret: string,
): Promise<T | null> {
  try {
    const [body, signatureB64] = token.split('.');
    if (!body || !signatureB64) return null;

    const key = await importHmacKey(secret);
    const valid = await crypto.subtle.verify(
      'HMAC',
      key,
      base64UrlDecode(signatureB64),
      new TextEncoder().encode(body),
    );
    if (!valid) return null;

    const envelope = JSON.parse(base64UrlToText(body)) as {
      purpose?: string;
      payload?: T;
      iat?: number;
      exp?: number;
    };
    if (envelope.purpose !== purpose) return null;
    if (!Number.isFinite(envelope.iat) || !Number.isFinite(envelope.exp)) return null;
    if (envelope.exp! * 1000 < Date.now()) return null;
    if (envelope.payload === undefined) return null;

    return envelope.payload;
  } catch {
    return null;
  }
}
