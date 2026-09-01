import { rsvpCustomId, voteCustomId } from './interactions';
import type { RsvpStatus } from './attendance';

// The outbound half of specs/0010: the controls a bot DM carries, so that
// "I'm in" or "Thursday works" can be answered where the message is read
// rather than on the website. lib/interactions.ts handles what comes back;
// this module only builds what goes out, and the two share the custom_id
// helpers so a button can never be labelled with an id the handler cannot
// parse.
//
// https://discord.com/developers/docs/components/reference

const COMPONENT_TYPE = { ACTION_ROW: 1, BUTTON: 2, STRING_SELECT: 3 } as const;

// Discord button styles. 3/2/4 (success/secondary/danger) map onto yes/maybe/
// no, which is the one place in this app where colour is load-bearing rather
// than decorative: the three answers have to be distinguishable at a glance
// in a notification list.
const BUTTON_STYLE = { SECONDARY: 2, SUCCESS: 3, DANGER: 4, LINK: 5 } as const;

// Discord's own caps. The select's 25 is the binding one: validate.ts allows
// MAX_POLL_OPTIONS of 20 candidates, so a poll built within its own limits
// always fits -- but a poll that somehow carries more must lose candidates
// from the *control* rather than have the whole DM rejected, since a DM that
// never arrives is worse than one that says "see the site for the rest".
const MAX_SELECT_OPTIONS = 25;
const MAX_LABEL_LENGTH = 80;
const MAX_SELECT_LABEL_LENGTH = 100;
// Discord allows 4096 in an embed description, against 2000 for message
// content -- so moving the text into an embed can never truncate something
// that fit before.
const MAX_EMBED_DESCRIPTION = 4096;

// `#E8913A`, "Tatoo I" -- the accent the v0.4 palette already uses for the
// app's primary surfaces (frontend/tailwind.config). One colour for every DM
// rather than one per notification type: the job here is "this is Uncle
// Owen", which a consistent stripe does and a shifting one undoes. It is also
// one less input to the derivation below, and every input is something that
// could differ between a first delivery and a retry.
const EMBED_COLOR = 0xe8913a;

function bound(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

// specs/0010's deferred half: rich embeds on the DMs that grow components,
// and only those.
//
// **Derived from the content at send time rather than stored beside it**,
// which is what makes this cost no migration. The spec priced embeds as a
// choice between a third `notification_log` column (durable, beside `content`
// and `components`) and non-durable embeds that would make a retried DM look
// different from everyone else's. Both were answers to the same question --
// how does the retry consumer know what the source sweep rendered? -- and
// this sidesteps it: `sendBotDm` and `editBotDm` build the embed from the
// `content` they are handed, so `sweepDueNotificationRetries`, which
// redelivers from the stored `content`, reproduces it exactly without knowing
// embeds exist. Durability is inherited from a column that is already durable.
//
// The constraint that buys it: the embed can only re-present the text, never
// restructure it. Labelled When/Where/Who's-in fields are not derivable from
// a flat sentence and would need the column after all.
//
// The text moves *into* the embed rather than sitting above it, because
// Discord renders both and the message would otherwise say everything twice.
export function dmEmbeds(content: string, components: unknown[] | null | undefined): unknown[] | null {
  if (!components || components.length === 0) return null;
  return [{ description: bound(content, MAX_EMBED_DESCRIPTION), color: EMBED_COLOR }];
}

export interface SelectCandidate {
  id: string;
  label: string;
  description?: string;
}

// Up to three buttons that map onto event_attendance's rsvp_status for one
// occurrence (specs/0014) -- '' for a non-recurring event.
//
// `allowed` is specs/0014 stage 2's "a rung offers only the moves that make
// sense from where you are": a reminder ladder rung passes only the subset
// that applies to its status (e.g. an accepted person's rung is
// Can't-make-it only), while every stage-1 call site keeps passing nothing
// and getting the full three-button set it always has. Order follows
// `allowed`, not a fixed accepted/tentative/declined sequence, so a caller
// that wants a specific left-to-right order gets it -- though every current
// caller passes them in that order regardless.
export function rsvpButtons(
  eventId: string,
  occurrenceDate: string,
  allowed: RsvpStatus[] = ['accepted', 'tentative', 'declined'],
): unknown[] {
  const byStatus: Record<RsvpStatus, unknown> = {
    accepted: { type: COMPONENT_TYPE.BUTTON, style: BUTTON_STYLE.SUCCESS, label: "I'm in", custom_id: rsvpCustomId('accepted', eventId, occurrenceDate) },
    tentative: { type: COMPONENT_TYPE.BUTTON, style: BUTTON_STYLE.SECONDARY, label: 'Maybe', custom_id: rsvpCustomId('tentative', eventId, occurrenceDate) },
    declined: { type: COMPONENT_TYPE.BUTTON, style: BUTTON_STYLE.DANGER, label: "Can't make it", custom_id: rsvpCustomId('declined', eventId, occurrenceDate) },
  };
  const components = allowed.map((status) => byStatus[status]);
  return components.length === 0 ? [] : [{ type: COMPONENT_TYPE.ACTION_ROW, components }];
}

// One select of the candidate nights, `min_values: 0` so clearing your answer
// is expressible.
//
// What a select cannot express is the website's yes/**maybe**/no per
// candidate -- there is no third state in a picker. Rather than silently
// flattening that, the DM's own text says so in a line, and an unpicked
// candidate records no vote at all rather than a `no`.
export function pollSelect(eventId: string, candidates: SelectCandidate[]): unknown[] {
  const options = candidates.slice(0, MAX_SELECT_OPTIONS).map((c) => ({
    label: bound(c.label, MAX_SELECT_LABEL_LENGTH),
    value: c.id,
    ...(c.description ? { description: bound(c.description, MAX_SELECT_LABEL_LENGTH) } : {}),
  }));
  if (options.length === 0) return [];
  return [
    {
      type: COMPONENT_TYPE.ACTION_ROW,
      components: [
        {
          type: COMPONENT_TYPE.STRING_SELECT,
          custom_id: voteCustomId(eventId),
          placeholder: 'Pick every night that works',
          min_values: 0,
          max_values: options.length,
          options,
        },
      ],
    },
  ];
}

// A window poll gets a link and nothing else, and that is a considered answer
// rather than a gap. Picking a continuous sub-range at 15-minute granularity,
// possibly spanning several days, has no honest Discord primitive: two
// dropdowns break past 25 steps and a modal means parsing free text typed by
// someone into a scheduling app. A link button that admits where that
// interaction belongs beats a control that mangles it.
export function linkButton(label: string, url: string): unknown[] {
  return [
    {
      type: COMPONENT_TYPE.ACTION_ROW,
      components: [{ type: COMPONENT_TYPE.BUTTON, style: BUTTON_STYLE.LINK, label: bound(label, MAX_LABEL_LENGTH), url }],
    },
  ];
}
