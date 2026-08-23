// Stable colour assignment for calendar chips.
//
// A group's colour is derived from its id, so the same crew is always the same
// colour -- across sessions, devices, and months -- without storing a colour
// anywhere or coordinating between clients. Events with no group fall back to
// a neutral style, and personal events get their own dedicated look so your
// own commitments read differently from group sessions at a glance.
//
// Retuned for the binary-sunset ground (spec 0009). The previous eight were
// Tailwind defaults chosen against a blue-black page and go muddy on sand.
// These are picked to hold their separation on #1A1410, and each carries its
// own foreground: brass and olive want dark text where rust and plum want
// light, and one blanket light foreground for all eight is how a warm palette
// ends up with two unreadable chips.
//
// The hash and the stable-colour-per-group property are unchanged -- only the
// swatches moved.

export type Swatch = { bg: string; fg: string; ring: string };

const GROUP_PALETTE: Swatch[] = [
  { bg: 'bg-[#A84E2E]', fg: 'text-[#FFEDDC]', ring: 'ring-[#C4693F]' }, // rust
  { bg: 'bg-[#6E7F3E]', fg: 'text-[#F2F6E4]', ring: 'ring-[#8B9C55]' }, // olive
  { bg: 'bg-[#C08A2A]', fg: 'text-[#1F1608]', ring: 'ring-[#D9A445]' }, // brass
  { bg: 'bg-[#4A7C86]', fg: 'text-[#E8F6F8]', ring: 'ring-[#63959F]' }, // deep teal
  { bg: 'bg-[#7A5488]', fg: 'text-[#F5EAF8]', ring: 'ring-[#966BA4]' }, // plum
  { bg: 'bg-[#B5623F]', fg: 'text-[#FFF0E4]', ring: 'ring-[#CD7B55]' }, // clay
  { bg: 'bg-[#5F7A5A]', fg: 'text-[#EDF5EB]', ring: 'ring-[#789574]' }, // sage
  { bg: 'bg-[#96603F]', fg: 'text-[#FFF1E6]', ring: 'ring-[#B07A56]' }, // leather
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
// group session is filled and warm. It is the one thing on the calendar nobody
// else is coming to, and it should not read as another crew's colour.
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
