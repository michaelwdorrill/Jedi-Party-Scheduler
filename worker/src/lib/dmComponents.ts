import { rsvpCustomId, voteCustomId } from './interactions';

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

function bound(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export interface SelectCandidate {
  id: string;
  label: string;
  description?: string;
}

// Three buttons that map exactly onto event_invites.rsvp_status, which is why
// this is full fidelity: there is nothing the website can record for a
// fixed-time event that these cannot.
export function rsvpButtons(eventId: string): unknown[] {
  return [
    {
      type: COMPONENT_TYPE.ACTION_ROW,
      components: [
        { type: COMPONENT_TYPE.BUTTON, style: BUTTON_STYLE.SUCCESS, label: "I'm in", custom_id: rsvpCustomId('accepted', eventId) },
        { type: COMPONENT_TYPE.BUTTON, style: BUTTON_STYLE.SECONDARY, label: 'Maybe', custom_id: rsvpCustomId('tentative', eventId) },
        { type: COMPONENT_TYPE.BUTTON, style: BUTTON_STYLE.DANGER, label: "Can't make it", custom_id: rsvpCustomId('declined', eventId) },
      ],
    },
  ];
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
