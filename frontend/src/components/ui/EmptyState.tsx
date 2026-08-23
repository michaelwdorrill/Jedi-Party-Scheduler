import type { ReactNode } from 'react';
import { cn } from './styles';

// Deliberately still.
//
// An empty state is already a small disappointment, and animating it draws the
// eye to the emptiness rather than to the way out of it. The personality goes
// into the drawing and the words instead -- and unlike an animation, a screen
// reader can read those.

export default function EmptyState({
  title,
  children,
  action,
  className,
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('px-4 py-8 text-center', className)}>
      <svg
        viewBox="0 0 700 112"
        preserveAspectRatio="xMidYMax meet"
        className="mx-auto block h-24 w-full max-w-md"
        aria-hidden="true"
      >
        <circle cx="352" cy="74" r="21" fill="#E8913A" opacity="0.26" />
        <circle cx="392" cy="84" r="11" fill="#F2C879" opacity="0.22" />
        <g fill="currentColor" opacity="0.2">
          <rect x="150" y="60" width="3" height="52" />
          <ellipse cx="151.5" cy="57" rx="7" ry="8.5" />
          <rect x="548" y="68" width="2.5" height="44" />
          <ellipse cx="549" cy="65" rx="6" ry="7" />
        </g>
        <path
          d="M0 112 C 110 98, 250 108, 380 102 C 510 96, 610 110, 700 104 L700 112 Z"
          fill="currentColor"
          opacity="0.13"
        />
      </svg>
      <h3 className="mt-3 text-lg">{title}</h3>
      {children && <p className="mx-auto mt-1 max-w-sm text-sm text-muted">{children}</p>}
      {action && <div className="mt-4 flex justify-center">{action}</div>}
    </div>
  );
}
