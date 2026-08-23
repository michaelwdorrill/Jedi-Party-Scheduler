// Stable colour assignment for calendar chips.
//
// A group's colour is derived from its id, so the same crew is always the same
// colour -- across sessions, devices, and months -- without storing a colour
// anywhere or coordinating between clients. Events with no group fall back to
// a neutral style, and personal events get their own dedicated look so your
// own commitments read differently from group sessions at a glance.
//
// The eight below are spread deliberately rather than picked by eye. The first
// binary-sunset attempt put rust, clay and leather within 7 degrees of each
// other -- four of eight inside a 23-degree band, with the whole 200-360
// range empty -- so the first three groups a server created came out nearly
// identical. These sit at roughly 45-degree intervals around the wheel, with a
// smallest gap of 27 degrees.
//
// Each swatch also carries its own foreground, chosen by measured contrast
// rather than assumption: chip text is 12px, so WCAG AA wants 4.5:1, and every
// pair here clears 4.6:1. Brass, olive, moss and lagoon are light enough to
// need dark text; one blanket light foreground for all eight is how a warm
// palette ends up with unreadable chips.
//
// The hash and the stable-colour-per-group property are unchanged.

export type Swatch = { bg: string; fg: string; ring: string };

const GROUP_PALETTE: Swatch[] = [
  { bg: 'bg-[#B15139]', fg: 'text-[#FFF1E0]', ring: 'ring-[#C86A50]' }, //  12deg rust
  { bg: 'bg-[#C89434]', fg: 'text-[#1A1008]', ring: 'ring-[#DDAA4B]' }, //  39deg brass
  { bg: 'bg-[#7C8B3C]', fg: 'text-[#1A1008]', ring: 'ring-[#95A452]' }, //  71deg olive
  { bg: 'bg-[#408E64]', fg: 'text-[#1A1008]', ring: 'ring-[#58A77C]' }, // 148deg moss
  { bg: 'bg-[#308B96]', fg: 'text-[#1A1008]', ring: 'ring-[#47A4AF]' }, // 187deg lagoon
  { bg: 'bg-[#506CA6]', fg: 'text-[#FFF1E0]', ring: 'ring-[#6885BF]' }, // 220deg steel
  { bg: 'bg-[#8B5AA0]', fg: 'text-[#FFF1E0]', ring: 'ring-[#A473B9]' }, // 282deg plum
  { bg: 'bg-[#AE4E6D]', fg: 'text-[#FFF1E0]', ring: 'ring-[#C66686]' }, // 341deg rose
];

// FNV-1a. Cheap, and stable across JS engines -- unlike anything based on
// object ordering or Math.random, the same id always lands on the same swatch.
function hashString(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function groupColor(groupId: string): Swatch {
  return GROUP_PALETTE[hashString(groupId) % GROUP_PALETTE.length];
}

// Personal time is deliberately the odd one out: unfilled and cool, where every
// group session is filled. It is the one thing on the calendar nobody else is
// coming to, and it should not read as another crew's colour.
export const PERSONAL_COLOR: Swatch = {
  bg: 'bg-transparent border border-dashed border-moisture',
  fg: 'text-moisture',
  ring: 'ring-moisture',
};

export const UNGROUPED_COLOR: Swatch = {
  bg: 'bg-raised-hi',
  fg: 'text-ink-dim',
  ring: 'ring-edge-strong',
};

// Reserved, and deliberately NOT in GROUP_PALETTE -- so the hash can never
// hand it to a real group, and the day Google Calendar sync lands (IDEAS.md
// item 2) no existing crew is already wearing it.
//
// Cool and low-chroma on purpose. Every colour above is warm and saturated
// because it belongs to this app; imported time does not, and should read as
// weather rather than as a session. Idea 2 is also scoped to `freebusy.query`
// rather than full event read, so these carry no title to look at -- they are
// anonymous busy blocks, and styling them to compete with real events would
// misrepresent how much is known about them.
export const EXTERNAL_COLOR: Swatch = {
  bg: 'bg-[#4A5560]/70 border border-[#5E6B76]',
  fg: 'text-[#C3CDD6]',
  ring: 'ring-[#7C8B99]',
};
