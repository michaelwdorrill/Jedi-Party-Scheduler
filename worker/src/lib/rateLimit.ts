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
// THE LIMITS ARE PER-COLOCATION, NOT GLOBAL. Cloudflare documents this
// plainly, and it is a real weakness rather than a footnote: a caller spread
// across N Cloudflare locations gets N x MAX_CALLBACKS_PER_MINUTE. It is still
// a bound -- unbounded became bounded-per-source-per-location, and a single
// attacker no longer costs an unlimited number of token exchanges. Stated here
// so nobody later reads this file and believes it is a global cap.

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

// Cloudflare sets CF-Connecting-IP at the edge and overwrites any client-
// supplied value, so a deployed Worker always has one. It is absent in local
// `wrangler dev` and in tests. Those share a single bucket rather than
// skipping the limiter, so the absent-header path can never be the more
// permissive one -- if this assumption about the edge is ever wrong, the
// failure is a shared cap, not an open door.
const NO_IP_BUCKET = 'no-connecting-ip';

/**
 * True if this callback may spend a token exchange.
 *
 * Call it AFTER the signed state verifies and BEFORE the exchange: a forged
 * state already costs nothing, so letting it consume limiter budget would let
 * an attacker exhaust the allowance for real logins from the same address
 * without ever paying for a valid state.
 */
export async function oauthCallbackAllowed(env: Env, headers: Headers): Promise<boolean> {
  const limiter = env.OAUTH_CALLBACK_LIMITER;
  // Absent only when the binding is missing from wrangler.toml. Fail open, so
  // a configuration slip degrades the control rather than breaking every
  // login -- and scripts/check-env-parity.mjs fails CI if the binding stops
  // being declared for either environment, which is what keeps "fail open"
  // from quietly meaning "no limit in production".
  if (!limiter) return true;
  const { success } = await limiter.limit({ key: headers.get(CONNECTING_IP) ?? NO_IP_BUCKET });
  return success;
}
