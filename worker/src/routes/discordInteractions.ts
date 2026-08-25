import { Hono } from 'hono';
import type { Env } from '../env';
import { handleInteraction, timestampWithinSkew, verifyInteractionSignature, type Interaction } from '../lib/interactions';

export const discordInteractionRoutes = new Hono<{ Bindings: Env }>();

// The inbound half of the bot (specs/0010). Mounted outside every requireAuth
// group, because an interaction carries no cookie, no Authorization header and
// no session -- the signature is the entire authentication story, and the
// presser's identity comes from the payload it signs.
discordInteractionRoutes.post('/interactions', async (c) => {
  const signature = c.req.header('X-Signature-Ed25519');
  const timestamp = c.req.header('X-Signature-Timestamp');

  // The raw text, before anything parses it: the signature covers these exact
  // bytes, and JSON.parse followed by JSON.stringify does not reliably
  // reproduce them.
  const rawBody = await c.req.text();

  // Every rejection below is a 401 and happens before a single D1 statement.
  // Discord sends deliberately invalid signatures when the endpoint URL is
  // saved and refuses to accept an endpoint that answers them with anything
  // else -- so this is both the security boundary and the thing that makes
  // the URL saveable at all.
  if (!signature || !timestamp) return c.text('missing signature', 401);
  if (!timestampWithinSkew(timestamp)) return c.text('stale signature', 401);
  if (!(await verifyInteractionSignature(c.env.DISCORD_PUBLIC_KEY, signature, timestamp, rawBody))) {
    return c.text('bad signature', 401);
  }

  let interaction: Interaction;
  try {
    interaction = JSON.parse(rawBody) as Interaction;
  } catch {
    // Signed by Discord and still not JSON: not an attack, but nothing this
    // endpoint can act on either.
    return c.text('bad request', 400);
  }

  // Answered synchronously. Discord allows three seconds, and every path here
  // is a handful of statements -- deferring would cost a second outbound call
  // and buy nothing. Deliberately not ctx.waitUntil: a background write that
  // fails would leave someone looking at a DM that never changes, with
  // nothing recorded and nothing said.
  return c.json(await handleInteraction(c.env, interaction));
});
