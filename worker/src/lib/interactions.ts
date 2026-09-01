import type { Env } from '../env';
import { boundContent } from './discord';
import { recordRsvp, type RsvpStatus } from './attendance';
import { recordPollSelection } from './polls';
import { rsvpButtons } from './dmComponents';
import { CURRENT_POLICY_VERSION } from './policy';

// Discord interactions (specs/0010). This is the first thing in the app whose
// caller is not a browser holding one of our JWTs: there is no cookie, no
// Authorization header and no session, and the only reason to believe a
// request is Discord's is that it carries a valid Ed25519 signature over its
// own raw bytes.
//
// https://discord.com/developers/docs/interactions/receiving-and-responding

export const INTERACTION_TYPE = {
  PING: 1,
  APPLICATION_COMMAND: 2,
  MESSAGE_COMPONENT: 3,
  MODAL_SUBMIT: 5,
} as const;

export const RESPONSE_TYPE = {
  PONG: 1,
  CHANNEL_MESSAGE_WITH_SOURCE: 4,
  UPDATE_MESSAGE: 7,
} as const;

// Discord's message flag for "only the person who pressed it can see this".
const EPHEMERAL = 64;

// A signature proves who sent a request, never when. Without a bound on the
// timestamp, one captured request stays replayable for as long as the
// application's public key lives -- which for a button that records an RSVP
// means someone able to observe one press can repeat it indefinitely.
export const SIGNATURE_MAX_SKEW_MS = 5 * 60 * 1000;

export interface InteractionResponse {
  type: number;
  data?: {
    content?: string;
    components?: unknown[];
    flags?: number;
    allowed_mentions?: { parse: string[] };
  };
}

// Every message this endpoint emits carries it, for the same reason
// sendBotDm does: the content is assembled from user-controlled strings
// (event titles, group names), and without this an "@everyone" typed into an
// event title would be fired off by the trusted bot account. sendBotDm sets
// it on the way out; an interaction response is a *second* way for the same
// text to reach Discord, and it defaults to parsing mentions unless told
// otherwise.
const NO_MENTIONS = { parse: [] as string[] };

// Only the fields this endpoint reads. Everything Discord sends is untrusted
// input: the signature says the payload came from Discord, not that its
// contents describe something the sender is allowed to do.
export interface Interaction {
  type?: number;
  data?: { custom_id?: string; values?: string[] };
  member?: { user?: { id?: string } };
  user?: { id?: string };
  // The message the control is attached to, which Discord sends back in full.
  // Its components are how a select's own candidates are recovered without
  // re-querying them -- see keepSelection.
  message?: { content?: string; components?: unknown[] };
}

function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

// True only if `timestamp` (Discord sends unix *seconds*) is within the skew
// window in either direction. Future timestamps are rejected as well as old
// ones: a clock that disagrees by more than five minutes is a problem to see
// rather than to accommodate.
export function timestampWithinSkew(timestamp: string, now = Date.now()): boolean {
  const seconds = Number(timestamp);
  if (!Number.isFinite(seconds)) return false;
  return Math.abs(now - seconds * 1000) <= SIGNATURE_MAX_SKEW_MS;
}

// The verifying key is the Discord *application's* public key -- per
// application, so production and the sandbox have different ones, and not a
// secret, since it verifies rather than signs.
//
// Every failure path here returns false rather than throwing: Discord probes
// this endpoint with deliberately invalid signatures when the URL is saved
// and refuses an endpoint that answers them with anything but a 401, so a
// malformed key, a malformed signature and a wrong signature must all land on
// the same answer.
export async function verifyInteractionSignature(
  publicKeyHex: string | undefined,
  signatureHex: string,
  timestamp: string,
  rawBody: string,
): Promise<boolean> {
  if (!publicKeyHex) {
    console.error(
      'DISCORD_PUBLIC_KEY is not set, so every Discord interaction is being rejected. ' +
        'Paste the application public key into wrangler.toml -- see docs/SETUP.md.',
    );
    return false;
  }
  const keyBytes = hexToBytes(publicKeyHex);
  const signature = hexToBytes(signatureHex);
  if (!keyBytes || keyBytes.length !== 32 || !signature || signature.length !== 64) return false;

  try {
    const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'Ed25519' }, false, ['verify']);
    // Signed over timestamp + the raw body bytes, which is why the route
    // reads the body as text and hands it here unparsed. Re-serialising
    // parsed JSON changes the bytes, and the signature would never match
    // again -- for anyone, ever, in a way that looks like Discord being
    // broken rather than like our own mistake.
    const message = new TextEncoder().encode(timestamp + rawBody);
    return await crypto.subtle.verify({ name: 'Ed25519' }, key, signature, message);
  } catch (err) {
    console.warn('Discord interaction signature check could not run:', err);
    return false;
  }
}

// `custom_id` is 100 characters and is the only state Discord hands back with
// a press. Event ids are crypto.randomUUID() (36 chars) and an occurrence
// date is 10 more, so the longest of these (v2's rsvp form) is about 67.
//
// Three rules, all of which matter more than the format itself:
//
//   * It is versioned. These messages sit in people's DMs indefinitely, so a
//     button pressed a year from now has to be recognisably old rather than
//     misinterpreted by whatever the format has become by then.
//   * It carries an occurrence date (specs/0014, v2). Attendance is per
//     *occurrence*, not per event -- a recurring series is answered one
//     session at a time -- so the id has to say which one. '' for a
//     non-recurring event, matching notification_log's convention. **Live v1
//     ids carry no date at all**, from when the schema had nowhere to put
//     one; a v1 press degrades to `stale` below rather than being
//     reinterpreted under v2 rules, which is exactly what versioning this id
//     is for.
//   * It carries no authorisation. It says what was pressed, never who may
//     press it. The presser is the signed payload's user, and permission is a
//     database read on every single press.
const CUSTOM_ID_PREFIX = 'uo';
const CUSTOM_ID_VERSION = 'v2';

export type ParsedCustomId =
  | { kind: 'rsvp'; status: RsvpStatus; eventId: string; occurrenceDate: string }
  | { kind: 'vote'; eventId: string }
  // specs/0014 stage 3, decision 4: the organizer's "cancel this session"
  // button. No occurrence date -- the minimum-attendees cascade only ever
  // applies to a non-recurring event (see validateEventWriteInput), so
  // there is no per-occurrence form of this id to speak of yet. Adding one
  // later for a recurring occurrence is a new kind, not a reinterpretation
  // of this one, the same discipline v1->v2 already established.
  | { kind: 'cancel'; eventId: string }
  // Ours, but from a format this build no longer speaks.
  | { kind: 'stale' }
  | null;

export function rsvpCustomId(status: RsvpStatus, eventId: string, occurrenceDate: string): string {
  return `${CUSTOM_ID_PREFIX}:${CUSTOM_ID_VERSION}:rsvp:${status}:${eventId}:${occurrenceDate}`;
}

export function voteCustomId(eventId: string): string {
  return `${CUSTOM_ID_PREFIX}:${CUSTOM_ID_VERSION}:vote:${eventId}`;
}

export function cancelCustomId(eventId: string): string {
  return `${CUSTOM_ID_PREFIX}:${CUSTOM_ID_VERSION}:cancel:${eventId}`;
}

export function parseCustomId(customId: string | undefined): ParsedCustomId {
  if (!customId) return null;
  const parts = customId.split(':');
  if (parts[0] !== CUSTOM_ID_PREFIX) return null;
  if (parts[1] !== CUSTOM_ID_VERSION) return { kind: 'stale' };

  if (parts[2] === 'rsvp' && parts.length === 6) {
    const status = parts[3];
    if (status !== 'accepted' && status !== 'declined' && status !== 'tentative') return { kind: 'stale' };
    // parts[5] (occurrenceDate) is checked for presence via the length test
    // above, not truthiness -- an empty trailing segment is the valid
    // non-recurring case and must not fall through to stale.
    return parts[4] ? { kind: 'rsvp', status, eventId: parts[4], occurrenceDate: parts[5] } : { kind: 'stale' };
  }
  if (parts[2] === 'vote' && parts.length === 4) {
    return parts[3] ? { kind: 'vote', eventId: parts[3] } : { kind: 'stale' };
  }
  if (parts[2] === 'cancel' && parts.length === 4) {
    return parts[3] ? { kind: 'cancel', eventId: parts[3] } : { kind: 'stale' };
  }
  return { kind: 'stale' };
}

// Everything the DM says after an answer is recorded goes after this marker,
// so a second press replaces the first line rather than stacking on it.
const ANSWER_PREFIX = 'Recorded: ';
const ANSWER_MARKER = `\n\n${ANSWER_PREFIX}`;

export function withAnswer(originalContent: string, answer: string): string {
  // What the message said before any answer was recorded. Two shapes reach
  // here, because v0.5.1 moved a DM's words into an embed when it carries
  // components:
  //
  // - **Words in `content`** (a DM sent before v0.5.1, and any that carries
  //   no components). Split at the marker; everything before it is the
  //   message.
  // - **Words in an embed**, so `content` is empty and the whole of it is a
  //   previous answer or nothing at all. There is no marker to split on --
  //   the answer *is* the content -- so splitting would keep the old answer
  //   and stack the new one under it.
  //
  // Testing `startsWith` separates them without having to know whether
  // Discord preserves the leading blank line that the marker puts in front
  // of an answer written into empty content. It renders trimmed either way,
  // and depending on which it stores is exactly the kind of assumption that
  // holds until it doesn't.
  const before = originalContent.startsWith(ANSWER_PREFIX)
    ? ''
    : originalContent.split(ANSWER_MARKER)[0];
  return boundContent(`${before}${ANSWER_MARKER}${answer}`);
}

function ephemeral(content: string): InteractionResponse {
  return {
    type: RESPONSE_TYPE.CHANNEL_MESSAGE_WITH_SOURCE,
    data: { content, flags: EPHEMERAL, allowed_mentions: NO_MENTIONS },
  };
}

// Rewrites the DM in place, which both acknowledges the interaction and shows
// what was recorded in one response. There is deliberately no second
// "thanks!" message and no ephemeral confirmation to dismiss.
//
// **The controls stay.** They did not at first, and that was wrong in a way
// only pressing them showed: clearing them made every DM a one-shot, so
// somebody who said "I'm in" and then couldn't make it had to go to the
// website — which is the exact journey this endpoint exists to remove. The
// app has always let you change a vote until the deadline and an RSVP
// whenever; the DM has to mean the same thing.
//
// It also made a whole code path unreachable. recordPollSelection clears the
// candidates you leave out precisely so a *second* answer replaces the first,
// and no second answer could ever arrive.
function updateMessage(
  originalContent: string,
  answer: string,
  components: unknown[],
): InteractionResponse {
  return {
    type: RESPONSE_TYPE.UPDATE_MESSAGE,
    data: { content: withAnswer(originalContent, answer), components, allowed_mentions: NO_MENTIONS },
  };
}

// The select as it came in, with the chosen candidates marked so it reopens
// showing what is on record rather than looking untouched.
//
// Rebuilt from the incoming message rather than from the database: Discord
// sends the components back with the interaction, and they already carry the
// candidate labels rendered in this recipient's timezone. Re-deriving them
// would mean another query and another chance to render them differently.
//
// Anything unexpected in that structure falls through to returning it
// unchanged. A select that reopens without its ticks is a small cosmetic
// loss; a malformed one that Discord rejects would take the whole edit down.
export function keepSelection(components: unknown[] | undefined, picked: string[]): unknown[] {
  if (!Array.isArray(components)) return [];
  const chosen = new Set(picked);
  try {
    return components.map((row) => {
      const r = row as { type?: number; components?: unknown[] };
      if (!Array.isArray(r.components)) return row;
      return {
        ...r,
        components: r.components.map((component) => {
          const c = component as { type?: number; options?: { value?: string }[] };
          if (c.type !== COMPONENT_TYPE_STRING_SELECT || !Array.isArray(c.options)) return component;
          return { ...c, options: c.options.map((o) => ({ ...o, default: chosen.has(String(o.value)) })) };
        }),
      };
    });
  } catch {
    return components;
  }
}

// Discord's string select. Named here rather than imported from
// lib/dmComponents so the receiving half does not depend on the sending half
// for a protocol constant.
const COMPONENT_TYPE_STRING_SELECT = 3;

// The buttons as they came in, or a fresh full set if the payload did not
// carry any.
//
// Echoed rather than rebuilt because the sender does not always attach all
// three: specs/0014's reminder ladder drops "Maybe" from a reminder to
// somebody who already said maybe, and rebuilding here would quietly put it
// back. What arrives has already been through signature verification and the
// custom_id parse that got us into this branch, so echoing it is not trust in
// Discord's payload so much as reuse of a structure we authored one message
// ago.
export function keepButtons(components: unknown[] | undefined, eventId: string, occurrenceDate: string): unknown[] {
  return Array.isArray(components) && components.length > 0 ? components : rsvpButtons(eventId, occurrenceDate);
}

const RSVP_ANSWER: Record<RsvpStatus, string> = {
  accepted: "you're in.",
  tentative: 'maybe.',
  declined: "you can't make it.",
};

function siteLink(env: Env): string {
  return `Open it on the site: ${env.FRONTEND_URL}`;
}

// users.id *is* the Discord user id (migrations/0001, written from
// discordUser.id at login), so the payload's user maps to ours with no lookup
// table and no new column. DMs populate `user`; a guild context populates
// `member.user`.
function pressedBy(interaction: Interaction): string | null {
  return interaction.member?.user?.id ?? interaction.user?.id ?? null;
}

async function handleComponent(env: Env, interaction: Interaction): Promise<InteractionResponse> {
  const parsed = parseCustomId(interaction.data?.custom_id);
  if (!parsed) return ephemeral(`That control isn't one of mine. ${siteLink(env)}`);
  if (parsed.kind === 'stale') {
    return ephemeral(`This message is out of date -- it was sent by an older version of the bot. ${siteLink(env)}`);
  }

  const userId = pressedBy(interaction);
  if (!userId) return ephemeral(`I couldn't tell who pressed that. ${siteLink(env)}`);

  // Anyone who received a DM from us was a user when we sent it, but accounts
  // can be deleted while the DM stays in someone's client forever. That is an
  // ordinary outcome with an answer, not a 500.
  const known = await env.DB.prepare(`SELECT accepted_policy_version AS v FROM users WHERE id = ?`)
    .bind(userId)
    .first<{ v: number }>();
  if (!known) {
    return ephemeral(`I don't have an account for you any more, so I can't record that. ${siteLink(env)}`);
  }

  // IDEAS.md item 45. requirePolicyAcceptance is middleware on the
  // authenticated route groups, and this endpoint is outside every one of
  // them by construction -- there is no session to gate. Without this, a
  // button would record an answer from someone the website is currently
  // refusing to serve, which is a hole in a consent gate rather than a
  // convenience.
  //
  // Refusing rather than recording, because a gate works by showing someone
  // the documents and letting them agree, and a DM has nowhere to show them.
  // The refusal costs the person nothing: the message and its buttons are
  // still sitting there once they have agreed on the site.
  if (known.v < CURRENT_POLICY_VERSION) {
    return ephemeral(
      `The Terms and Privacy Policy have changed since you last agreed, so I can't record that yet. ` +
        `Agree on the site and this button will work again: ${env.FRONTEND_URL}`,
    );
  }

  const original = interaction.message?.content ?? '';

  if (parsed.kind === 'rsvp') {
    const outcome = await recordRsvp(env, userId, parsed.eventId, parsed.occurrenceDate, parsed.status);
    if (outcome === 'no_such_event') return ephemeral(`That event no longer exists. ${siteLink(env)}`);
    if (outcome === 'not_invited') {
      return ephemeral(`You're not on the invite list for that one any more. ${siteLink(env)}`);
    }
    // specs/0014 stage 3: the minimum-attendees cascade can cancel an event
    // between when this DM was sent and when someone presses it.
    if (outcome === 'event_not_active') {
      return ephemeral(`That session isn't happening any more. ${siteLink(env)}`);
    }
    // Defensive: unreachable from a bot-authored button, since every id we
    // ever emit pairs a real occurrence date with the event's own
    // is_recurring. A genuine mismatch here means the message itself is
    // corrupted rather than merely out of date.
    if (outcome === 'invalid_occurrence') {
      return ephemeral(`That control looks corrupted. ${siteLink(env)}`);
    }
    return updateMessage(
      original,
      RSVP_ANSWER[parsed.status],
      keepButtons(interaction.message?.components, parsed.eventId, parsed.occurrenceDate),
    );
  }

  if (parsed.kind === 'cancel') {
    const event = await env.DB.prepare(`SELECT organizer_id, status FROM events WHERE id = ?`)
      .bind(parsed.eventId)
      .first<{ organizer_id: string; status: string }>();
    if (!event) return ephemeral(`That event no longer exists. ${siteLink(env)}`);
    // Re-checked from the database rather than trusted from the fact that
    // this DM was only ever sent to the organizer -- the presser is the
    // signed payload's user, and every other press in this handler is
    // authorised the same way: by asking the database, not by who the
    // message was addressed to.
    if (event.organizer_id !== userId) {
      return ephemeral(`Only the organizer can cancel this one. ${siteLink(env)}`);
    }
    if (event.status !== 'active') {
      return ephemeral(`That session isn't active any more. ${siteLink(env)}`);
    }
    await env.DB.prepare(
      `UPDATE events SET status = 'cancelled', updated_at = ? WHERE id = ? AND organizer_id = ? AND status = 'active'`,
    )
      .bind(Date.now(), parsed.eventId, userId)
      .run();
    // No components after -- a fired cancel button must not be pressable
    // twice. Everyone still marked as coming is told through the outbox
    // (sweepCancelledEventNotices), same as an auto-cancel.
    return updateMessage(original, 'this session is cancelled.', []);
  }

  const picked = interaction.data?.values ?? [];
  const outcome = await recordPollSelection(env, userId, parsed.eventId, picked);
  switch (outcome.status) {
    case 'no_such_poll':
      return ephemeral(`That poll no longer exists. ${siteLink(env)}`);
    case 'invalid_option':
      return ephemeral(`Those options aren't on that poll any more. ${siteLink(env)}`);
    case 'closed':
      return ephemeral(`${outcome.reason}. ${siteLink(env)}`);
    case 'forbidden':
      return ephemeral(`You're not on the invite list for that one any more. ${siteLink(env)}`);
  }

  // Deliberately short, and deliberately not repeating the "anything you
  // don't pick is left blank" line. That sentence is in the DM's own text,
  // which stays visible above this one after the edit -- saying it twice in
  // a message this small reads like the bot is arguing with itself.
  const answer = picked.length === 0 ? 'none of these work for you.' : `${picked.length} of these work for you.`;
  return updateMessage(original, answer, keepSelection(interaction.message?.components, picked));
}

export async function handleInteraction(env: Env, interaction: Interaction): Promise<InteractionResponse> {
  // PING is what Discord's "Save Changes" on the Interactions Endpoint URL
  // actually tests, and it arrives before the endpoint has ever been used for
  // anything real.
  if (interaction.type === INTERACTION_TYPE.PING) return { type: RESPONSE_TYPE.PONG };
  if (interaction.type === INTERACTION_TYPE.MESSAGE_COMPONENT) return handleComponent(env, interaction);

  // Slash commands and modals are deliberately out of this release
  // (specs/0010). Answering rather than erroring means that if one ever
  // arrives -- a command registered by hand, a modal from a future build --
  // the person sees a sentence instead of Discord's "this interaction
  // failed".
  return ephemeral(`I can't do that here yet. ${siteLink(env)}`);
}
