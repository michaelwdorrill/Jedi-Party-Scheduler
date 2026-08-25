// The two pure pieces behind the Avatar primitive (IDEAS 35), kept out of the
// component so they can be tested the way lib/colors.ts is -- the frontend
// suite has no DOM environment, and these are where the decisions live.

// Discord serves avatars at power-of-two sizes. Ask for 2x the CSS size so it
// stays sharp on a retina screen without fetching something enormous.
export function avatarUrl(userId: string, hash: string, cssPx: number): string {
  const requested = cssPx <= 32 ? 64 : 128;
  return `https://cdn.discordapp.com/avatars/${userId}/${hash}.png?size=${requested}`;
}

// The fallback when there is no avatar hash, or when the one we hold has gone
// stale and 404'd. Both are ordinary rather than edge cases: a hash is null
// for anyone who never set a picture, and it is only refreshed at login, so
// anyone who changes their avatar keeps the old one here until they next log
// in.
export function initials(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return '?';
  // [...] iterates code points, not UTF-16 units. Discord display names very
  // often start with an emoji, and slicing one of those in half produces a
  // lone surrogate that renders as a replacement character.
  return [...trimmed][0].toUpperCase();
}
