import type { Env } from '../env';

// IDEAS item 92 / release-bar clause 3: "every unauthenticated endpoint that
// consumes a metered third-party resource, sends mail, or writes durable state
// is bounded, in code or at the edge."
//
// The three OAuth callbacks are the unauthenticated spends. Each one, once its
// signed state verifies, pays for a POST to a provider's token endpoint --
// Discord's for /auth/callback and /guild-requests/callback, Google's for
// /google/callback. Discord rate-limits that per *client*, not per caller, so a
// sustained loop degrades login for everyone until the limit resets.
//
// F-59 made a fabricated state cost an HMAC instead of a token exchange, which
// raised the price without bounding the rate: an attacker calls /auth/login for
// a real signed state and pays two requests per exchange rather than one. This
// is the bound.
//
// WHY IN CODE RATHER THAN AT THE EDGE. A Cloudflare WAF rate limiting rule
// would be better -- it blocks before the Worker is invoked at all, and it is
// visible where it is configured. It needs a zone, rate limiting rules are
// zone-scoped, and this Worker is on *.workers.dev. Putting it on a zone means
// moving uncleowen.space's nameservers to Cloudflare, since a subdomain-only
// zone is an Enterprise feature -- and that drags a live GitHub Pages site and
// Namecheap email forwarding through a DNS migration for a control that has
// nothing to do with either. docs/SETUP.md has the full comparison; the edge
// rule stays available if the domain ever moves for its own reasons.
//
// THE CLOUDFLARE BINDING DID NOT WORK, SO THIS COUNTS IN D1. Until 9 November
// 2026 this called Cloudflare's rate-limiting binding. The walkthrough drove 25,
// then 60, then 25 real callbacks at it from one address; `wrangler tail` showed
// every call sharing one key and the binding answering "allowed" to all of them.
// Cloudflare documents that binding as approximate and per-location; for this
// Worker it did not limit anything, so it is gone rather than kept as a control
// that only looks like one. An exact count in the database the app already uses
// costs two small statements per callback -- a handful a day -- and is something
// the test suite can actually exercise.
//
// Deliberately generous. One human login spends one callback; a retry or two
// spends a few more. The cap only has to be low enough to matter to a loop and
// high enough that a whole friend group behind one NAT never notices it --
// twenty per minute is far outside ordinary use in both directions.
export const MAX_CALLBACKS_PER_MINUTE = 20;

// Cloudflare's advice is against keying rate limits on IP, because users share
// them. That advice is about fairness between legitimate users; on an
// unauthenticated callback there is no identity to key on yet, which is the
// whole reason the endpoint is worth bounding. The generous threshold above is
// what keeps the shared-IP case harmless.
const CONNECTING_IP = 'CF-Connecting-IP';
const NO_IP_BUCKET = 'no-connecting-ip';
const WINDOW_MS = 60 * 1000;

// Cloudflare sets CF-Connecting-IP at the edge and overwrites any client-
// supplied value, so a deployed Worker always has one. It is absent in local
// `wrangler dev` and in tests; those share a single bucket rather than skipping
// the limit, so the absent-header path can never be the more permissive one.
//
// The address is never stored. The bucket is an HMAC of it under the Worker's
// signing secret, domain-separated by a prefix so the value is useless for
// anything else: a plain hash of an IPv4 address can be reversed by trying all
// four billion, and a keyed one cannot without the key. Exported so the tests
// can address a bucket without knowing how it is derived.
export async function callbackBucket(env: Env, headers: Headers): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(env.JWT_SIGNING_KEY),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`oauth-callback-limit:${headers.get(CONNECTING_IP) ?? NO_IP_BUCKET}`),
  );
  return [...new Uint8Array(mac).slice(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * True if this callback may spend a token exchange.
 *
 * Call it AFTER the signed state verifies and BEFORE the exchange: a forged
 * state already costs nothing, so letting it consume the allowance would let an
 * attacker exhaust real logins from the same address without ever paying for a
 * valid state.
 *
 * Fixed one-minute windows: at most MAX_CALLBACKS_PER_MINUTE per address per
 * calendar minute, so a burst straddling a minute boundary can reach twice
 * that. Still a bound, and the simplest one a single atomic statement can hold.
 */
export async function oauthCallbackAllowed(env: Env, headers: Headers): Promise<boolean> {
  const bucket = await callbackBucket(env, headers);
  const now = Date.now();
  const windowStart = now - (now % WINDOW_MS);
  try {
    // The increment and the read are one statement, so two callbacks racing on
    // one address cannot both see 20. The DELETE keeps the table to the current
    // minute's callers, and is also what starts each address afresh in a new
    // minute; the CASE repeats that inside the write for the one case the
    // DELETE can't see, two callbacks straddling the minute boundary. Two plain
    // statements rather than a batch() because only a single statement's
    // .first() returns the RETURNING row the same way in D1 and in the test
    // harness.
    await env.DB.prepare(`DELETE FROM oauth_callback_counts WHERE window_start < ?`).bind(windowStart).run();
    const row = await env.DB.prepare(
      `INSERT INTO oauth_callback_counts (bucket, window_start, count) VALUES (?, ?, 1)
       ON CONFLICT(bucket) DO UPDATE SET
         count = CASE WHEN oauth_callback_counts.window_start = excluded.window_start
                      THEN oauth_callback_counts.count + 1 ELSE 1 END,
         window_start = excluded.window_start
       RETURNING count`,
    )
      .bind(bucket, windowStart)
      .first<{ count: number }>();
    // No row is a fault, not a count of zero: reading it as zero is exactly
    // how a limiter ends up allowing everything without anyone noticing.
    if (!row || typeof row.count !== 'number') throw new Error('counter returned no row');
    const count = row.count;
    return count <= MAX_CALLBACKS_PER_MINUTE;
  } catch (err) {
    // Fails open, as the binding did: a database that cannot take this write
    // cannot complete the login after it either, so refusing here would only
    // change the error, while allowing keeps a transient fault from looking
    // like an attack.
    console.error('OAuth callback limiter could not count; allowing:', err);
    return true;
  }
}

// The DELETE in oauthCallbackAllowed only runs when somebody calls back, so on
// a quiet day the last caller's row would sit here until the next login -- for
// hours or days, against a privacy policy that says how long it is kept. The
// cron tick calls this, so a row outlives its minute by at most one tick
// (fifteen minutes). It is one uncharged statement a tick, like the session
// prune it runs beside, and it is a no-op on an empty table.
export async function pruneOAuthCallbackCounts(env: Env): Promise<void> {
  const now = Date.now();
  await env.DB.prepare(`DELETE FROM oauth_callback_counts WHERE window_start < ?`)
    .bind(now - (now % WINDOW_MS))
    .run();
}
