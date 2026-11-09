import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';

// The 1.0 launch pop-up (Michael, 9 Nov 2026): the "We've hit 1.0!" picture,
// once per account, the first time it opens the app after the release. Closed
// with the X, a click anywhere outside the picture, or Escape.
//
// LAUNCH-ONLY. 1.1 deletes this component, its image under
// public/announcements/, `unseenAnnouncement` on User, and the worker half
// (docs/IDEAS.md item 105). Not a general announcements feature.
//
// The server says which announcement this account hasn't seen; the picture is
// ours, keyed by that id, so an id this build doesn't know shows nothing.
const ANNOUNCEMENTS: Record<string, { src: string; alt: string }> = {
  '1.0': {
    src: '/announcements/uncle-owen-1.0.webp',
    alt: "Uncle Owen and Aunt Beru cheering outside their desert homestead under a banner reading \"We've hit 1.0!\"",
  },
};

export default function LaunchAnnouncement() {
  const { user } = useAuth();
  const id = user?.unseenAnnouncement ?? null;
  const announcement = id ? ANNOUNCEMENTS[id] : undefined;
  const [closed, setClosed] = useState(false);
  const recorded = useRef<string | null>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const open = !!announcement && !closed;

  // Recorded when it appears, not when it's closed, so it shows once even if
  // the tab is shut with it still up. The ref keeps StrictMode's doubled
  // effect in development from posting twice.
  useEffect(() => {
    if (!open || !id || recorded.current === id) return;
    recorded.current = id;
    void api.post('/me/announcement-seen', { id }).catch(() => {
      // Not worth interrupting anyone over: the worst case is seeing it again.
    });
  }, [open, id]);

  useEffect(() => {
    if (!open) return;
    closeButton.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setClosed(true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  if (!open || !announcement) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4"
      onClick={() => setClosed(true)}
      role="dialog"
      aria-modal="true"
      aria-label="Uncle Owen 1.0"
    >
      <div className="relative max-h-full max-w-full" onClick={(e) => e.stopPropagation()}>
        <img
          src={announcement.src}
          alt={announcement.alt}
          className="block max-h-[85vh] w-auto max-w-full rounded-lg shadow-2xl"
        />
        <button
          ref={closeButton}
          type="button"
          onClick={() => setClosed(true)}
          aria-label="Close"
          className="absolute right-2 top-2 flex h-9 w-9 items-center justify-center rounded-full bg-black/60 text-xl leading-none text-white hover:bg-black/80 focus:outline-none focus-visible:ring-2 focus-visible:ring-white"
        >
          ×
        </button>
      </div>
    </div>
  );
}
