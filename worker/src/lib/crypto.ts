// Symmetric encryption at rest, for the one kind of value this app stores that
// it must be able to read back and must not store in the clear: a user's
// Google OAuth tokens (IDEAS item 2 / specs/0017).
//
// Everything else secret in this codebase is either signed rather than
// encrypted (lib/jwt.ts, lib/signedToken.ts -- an HMAC proves a value came
// from us, it does not hide it) or never persisted at all (Discord's tokens,
// discarded at login by design). A Google refresh token is neither: the cron
// has to present it to Google with nobody logged in, so it has to survive a
// round trip through D1 in a readable form.
//
// AES-GCM rather than AES-CBC or a hand-rolled construction, because it
// authenticates as well as encrypts -- a tampered ciphertext fails to decrypt
// rather than yielding plausible garbage that then gets sent to Google as
// somebody's credential.
//
// A dedicated secret, not JWT_SIGNING_KEY. That key already signs sessions and
// the guild-request capability tokens; if it also decrypted stored credentials
// then one leaked value would both forge a session and unlock every
// connection. Separate keys mean separate blast radii, and provisioning one
// more secret is a one-time cost (docs/SETUP.md section 7).

import { base64UrlDecode, base64UrlEncode } from './base64url';

// 96 bits, which is the IV size AES-GCM is specified around -- a different
// length is legal but forces the implementation through a slower derivation
// and buys nothing.
const IV_BYTES = 12;

export interface SealedValue {
  ciphertext: string;
  iv: string;
}

// The raw secret is an arbitrary-length string (a `wrangler secret put` value),
// so it is hashed to exactly the 256 bits AES-256 wants rather than being
// truncated or padded. SHA-256 over the secret is deterministic, so the same
// configured secret always yields the same key -- which is what makes a value
// sealed by one Worker invocation readable by the next.
async function importKey(secret: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
  return crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export async function seal(plaintext: string, secret: string): Promise<SealedValue> {
  // Fresh per record. AES-GCM's one hard requirement is that an IV is never
  // reused under the same key -- reuse is catastrophic for GCM specifically,
  // far worse than for CBC -- and 96 random bits per record is the standard
  // way to get that without coordinating a counter across invocations.
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await importKey(secret);
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(plaintext),
  );
  return { ciphertext: base64UrlEncode(new Uint8Array(encrypted)), iv: base64UrlEncode(iv) };
}

// Returns null rather than throwing on any failure -- a wrong key, a truncated
// row, a tampered ciphertext, a value written under a secret that has since
// been rotated. Callers treat that as "this connection can no longer be used"
// and tell the user to reconnect, which is the only recoverable answer; an
// exception here would take down whichever cron sweep touched it and, being
// per-row, would do so for everyone else's connections too.
export async function unseal(sealed: SealedValue, secret: string): Promise<string | null> {
  try {
    const key = await importKey(secret);
    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: base64UrlDecode(sealed.iv) },
      key,
      base64UrlDecode(sealed.ciphertext),
    );
    return new TextDecoder().decode(decrypted);
  } catch {
    return null;
  }
}
