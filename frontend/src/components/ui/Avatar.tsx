import { useState } from 'react';
import { avatarUrl, initials } from '../../lib/avatar';

// Someone's Discord profile picture, wherever people are listed (IDEAS 35).
//
// The data was already here and had been since the beginning: `avatar_hash` is
// written at login from Discord's /users/@me, and every member-listing route
// already returns it as `avatarHash`. Nothing rendered it, so an invitee
// picker was a wall of names.
//
// The Privacy Policy already covers this without amendment -- "your username,
// display name, and avatar are shown to other logged-in members of servers you
// share, so people can identify who they're inviting" -- which is exactly what
// this is for.
//
// Two failure modes, both ordinary rather than edge cases, and both handled by
// falling back to initials rather than a broken image:
//
//   - `avatarHash` is null for anyone who has never set a profile picture.
//   - A hash goes stale. It is only refreshed when someone logs in, so anyone
//     who changes their avatar keeps the old one here until their next login,
//     and Discord's CDN 404s the old hash. That is an `onError`, not a
//     hypothetical.

const SIZES = {
  sm: { px: 24, cls: 'h-6 w-6 text-[10px]' },
  md: { px: 32, cls: 'h-8 w-8 text-xs' },
} as const;


export default function Avatar({
  userId,
  name,
  avatarHash,
  size = 'sm',
}: {
  userId: string;
  name: string;
  avatarHash: string | null;
  size?: keyof typeof SIZES;
}) {
  const [failed, setFailed] = useState(false);
  const { px, cls } = SIZES[size];
  const shared = `${cls} shrink-0 rounded-full border border-edge-strong object-cover`;

  if (!avatarHash || failed) {
    return (
      <span
        aria-hidden="true"
        className={`${shared} flex items-center justify-center bg-raised font-medium text-ink-dim`}
      >
        {initials(name)}
      </span>
    );
  }

  return (
    <img
      // The name is already rendered as text beside every use of this, so the
      // image is decorative -- an alt would have a screen reader say it twice.
      alt=""
      aria-hidden="true"
      src={avatarUrl(userId, avatarHash, px)}
      onError={() => setFailed(true)}
      loading="lazy"
      decoding="async"
      className={`${shared} bg-raised`}
    />
  );
}
