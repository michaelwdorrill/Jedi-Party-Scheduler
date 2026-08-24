import type { ReactNode } from 'react';
import { cn } from './styles';

// The counterpart to EmptyState, and deliberately not a recolour of it
// (idea 24).
//
// The two have to be told apart at a glance, because the whole bug was that
// they looked identical. EmptyState draws a calm horizon and says "nothing is
// scheduled"; this draws a vaporator that has come down, in danger tones, and
// says the request failed. Same desert, unmistakably worse day.
//
// It always offers the way out -- reloading is the correct response to most of
// what lands here -- and it states what actually failed underneath, because
// "something went wrong" is the message this exists to stop the app giving.

export default function ErrorState({
  title = 'Something came down out there',
  message,
  onRetry,
  className,
}: {
  title?: string;
  message: string;
  onRetry?: () => void;
  className?: string;
}) {
  return (
    <div className={cn('px-4 py-8 text-center', className)} role="alert">
      <svg
        viewBox="0 0 700 112"
        preserveAspectRatio="xMidYMax meet"
        className="mx-auto block h-24 w-full max-w-md text-danger-text"
        aria-hidden="true"
      >
        {/* The suns, dimmed further than the empty state's -- the light is the
            same, the day is not. */}
        <circle cx="352" cy="74" r="21" fill="#E8913A" opacity="0.14" />
        <circle cx="392" cy="84" r="11" fill="#F2C879" opacity="0.12" />
        {/* One vaporator still standing, one on its side with its dish thrown
            clear -- the asymmetry is what reads as "wrong" rather than
            "stylised". */}
        <g fill="currentColor" opacity="0.32">
          <rect x="150" y="60" width="3" height="52" />
          <ellipse cx="151.5" cy="57" rx="7" ry="8.5" />
          <g transform="rotate(74 549 96)">
            <rect x="548" y="68" width="2.5" height="44" />
          </g>
          <ellipse cx="512" cy="106" rx="7" ry="4" />
        </g>
        {/* Dust kicked up where it fell. */}
        <ellipse cx="536" cy="108" rx="46" ry="7" fill="currentColor" opacity="0.12" />
        <path
          d="M0 112 C 110 98, 250 108, 380 102 C 510 96, 610 110, 700 104 L700 112 Z"
          fill="currentColor"
          opacity="0.13"
        />
      </svg>
      <h3 className="mt-3 text-lg">{title}</h3>
      <p className="mx-auto mt-1 max-w-sm text-sm text-muted">{message}</p>
      {onRetry && (
        <div className="mt-4 flex justify-center">
          <button
            type="button"
            onClick={onRetry}
            className="rounded-md border border-danger/60 px-3 py-1.5 font-display text-sm uppercase tracking-wide text-danger-text hover:bg-danger-surface"
          >
            Try again
          </button>
        </div>
      )}
    </div>
  );
}

// The action-failure form: one line, next to the control that failed, leaving
// the page it interrupted on screen. A failed RSVP does not justify replacing
// the event you were looking at.
export function InlineError({
  message,
  onRetry,
  onDismiss,
  className,
}: {
  message: ReactNode;
  onRetry?: () => void;
  onDismiss?: () => void;
  className?: string;
}) {
  return (
    <div
      role="alert"
      className={cn(
        'flex items-start justify-between gap-3 rounded-md border border-danger/60 bg-danger-surface px-3 py-2 text-sm text-danger-text',
        className,
      )}
    >
      <span>{message}</span>
      <span className="flex shrink-0 items-center gap-3">
        {onRetry && (
          <button
            type="button"
            onClick={onRetry}
            className="font-display text-xs uppercase tracking-wide underline underline-offset-2 hover:no-underline"
          >
            Try again
          </button>
        )}
        {onDismiss && (
          <button
            type="button"
            onClick={onDismiss}
            aria-label="Dismiss"
            className="text-danger-text/70 hover:text-danger-text"
          >
            ✕
          </button>
        )}
      </span>
    </div>
  );
}
