// Stable colour assignment for calendar chips.
//
// A group's colour is derived from its id, so the same crew is always the same
// colour -- across sessions, devices, and months -- without storing a colour
// anywhere or coordinating between clients. Events with no group fall back to
// a neutral style, and personal events get their own dedicated look so your
// own commitments read differently from group sessions at a glance.

const GROUP_PALETTE = [
  { bg: 'bg-indigo-600', ring: 'ring-indigo-400' },
  { bg: 'bg-emerald-600', ring: 'ring-emerald-400' },
  { bg: 'bg-amber-600', ring: 'ring-amber-400' },
  { bg: 'bg-sky-600', ring: 'ring-sky-400' },
  { bg: 'bg-fuchsia-600', ring: 'ring-fuchsia-400' },
  { bg: 'bg-rose-600', ring: 'ring-rose-400' },
  { bg: 'bg-teal-600', ring: 'ring-teal-400' },
  { bg: 'bg-violet-600', ring: 'ring-violet-400' },
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

export function groupColor(groupId: string): { bg: string; ring: string } {
  return GROUP_PALETTE[hashString(groupId) % GROUP_PALETTE.length];
}

export const PERSONAL_COLOR = { bg: 'bg-slate-600', ring: 'ring-slate-400' };
export const UNGROUPED_COLOR = { bg: 'bg-indigo-600', ring: 'ring-indigo-400' };
