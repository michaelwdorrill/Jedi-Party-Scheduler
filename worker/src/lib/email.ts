// Outbound email (specs/0015) -- the one new dependency idea 9 brings, and
// the reason it waited for its own spec rather than riding along with idea
// 10. One function, mirroring how lib/discord.ts is the one place that knows
// the Discord API: a future provider swap touches this file alone.
//
// There is exactly one recipient this ever sends to: OWNER_DISCORD_ID's
// operator (Michael), notified of a pending guild-add request. This is not
// a general-purpose mailer, and it should not grow into one without a reason
// -- idea 9's capture and specs/0015 both scope it to owner notifications
// only; a requester is deliberately not emailed back (see that spec's "no
// requester notification" decision).

import type { Env } from '../env';

export interface OwnerEmail {
  subject: string;
  text: string;
}

// specs/0015's stubbing decision: EMAIL_MODE is per-environment
// (wrangler.toml), 'live' in production only. Everything else -- unset local
// dev, the sandbox's deliberate 'stub' -- logs instead of calling Resend, so
// iterating on this flow never pages Michael's own inbox and never needs a
// throwaway address.
function isLive(env: Env): boolean {
  return env.EMAIL_MODE === 'live';
}

// The recipient is always OWNER_DISCORD_ID's operator, but Resend (like
// every transactional provider) sends to an email address, not a Discord id
// -- and this app stores none. Rather than add a column for an address used
// by exactly one send path, the address is read from an env var set
// alongside EMAIL_MODE; see docs/SETUP.md for the one-time setup this needs.
export async function sendOwnerEmail(env: Env, message: OwnerEmail): Promise<void> {
  if (!isLive(env)) {
    console.log(`[email:stub] would send to owner -- subject: "${message.subject}"\n${message.text}`);
    return;
  }

  if (!env.RESEND_API_KEY || !env.OWNER_EMAIL_ADDRESS || !env.EMAIL_FROM_ADDRESS) {
    // Refuse loudly rather than silently no-op in 'live' mode: an
    // unconfigured 'live' environment is a deploy mistake, not a case to
    // degrade quietly the way the stub does on purpose.
    console.error('EMAIL_MODE is "live" but RESEND_API_KEY/OWNER_EMAIL_ADDRESS/EMAIL_FROM_ADDRESS is not set -- email not sent.');
    return;
  }

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: env.EMAIL_FROM_ADDRESS,
      to: [env.OWNER_EMAIL_ADDRESS],
      subject: message.subject,
      text: message.text,
    }),
  });

  if (!res.ok) {
    // Never throws: a failed owner notification must not fail the request
    // that triggered it (creating the pending row is the durable part -- the
    // admin fallback list in routes/admin.ts covers a lost email). Logged
    // with the body for diagnosis, not surfaced to the caller.
    console.error(`Resend send failed (${res.status}): ${await res.text()}`);
  }
}
