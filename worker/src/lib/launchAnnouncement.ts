import type { Env } from '../env';
import { LAUNCH_IMAGE_BASE64 } from './launchAnnouncementImage';

// The 1.0 launch announcement (9 Nov 2026, Michael's request): a one-off DM
// with the "We've hit 1.0!" picture to everyone, and the same picture as a
// pop-up the first time each person opens the app afterwards.
//
// LAUNCH-ONLY. This is not a general announcements feature and should not
// grow into one: 1.1 deletes this file, its image, the sweep, the two /me
// additions and the pop-up, and unsets LAUNCH_ANNOUNCEMENT (docs/IDEAS.md
// item 105 has the list). 1.0.x patch releases keep it.
//
// Off unless LAUNCH_ANNOUNCEMENT in wrangler.toml names an entry below, which
// is also what keeps it out of every unrelated test: makeEnv sets no such var.

export interface LaunchAnnouncement {
  id: string;
  dm: string;
  imageFilename: string;
}

const ANNOUNCEMENTS: Record<string, LaunchAnnouncement> = {
  '1.0': {
    id: '1.0',
    // Michael's wording, verbatim.
    dm: 'Uncle Owen and Aunt Beru are proud to announce that we are feature complete! Feel free to use Uncle Owen for all your scheduling needs!',
    imageFilename: 'uncle-owen-1.0.webp',
  },
};

export function activeLaunchAnnouncement(env: Env): LaunchAnnouncement | null {
  const id = env.LAUNCH_ANNOUNCEMENT?.trim();
  return (id && ANNOUNCEMENTS[id]) || null;
}

export interface DmAttachment {
  filename: string;
  contentType: string;
  bytes: Uint8Array;
}

let decoded: Uint8Array | null = null;

export function launchAnnouncementImage(announcement: LaunchAnnouncement): DmAttachment {
  if (!decoded) {
    const binary = atob(LAUNCH_IMAGE_BASE64);
    decoded = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) decoded[i] = binary.charCodeAt(i);
  }
  return { filename: announcement.imageFilename, contentType: 'image/webp', bytes: decoded };
}
