// Shared style fragments for the UI primitives.
//
// `focusRing` exists as one constant rather than a habit because the app went
// 27 files without a single focus style (see spec 0009's audit). Anything a
// keyboard can reach composes this in, so it can't be forgotten one component
// at a time again.

// The ring takes the accent-text step, not the base accent: the primary
// button is *filled* with accent, so an accent ring is the same colour as it
// is meant to be marking, separated only by the 2px offset band. It reads as
// an odd dark hairline rather than as a focus indicator. The lighter step
// contrasts against both the page ground and the accent fill.
//
// Worth recording why this replaces anything at all: the browser's own focus
// ring was never missing -- Chrome draws a two-tone one that is perfectly
// visible on a dark page. What the app lacked was *control* over it. That is
// what makes it consistent across elements and themeable in 0009, and it is a
// smaller claim than "the app had no focus indication".
export const focusRing =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-text ' +
  'focus-visible:ring-offset-2 focus-visible:ring-offset-ground';

/** Joins class names, dropping anything falsy. */
export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

// ---------------------------------------------------------------------------
// Class builders.
//
// These live here rather than beside their components so the component files
// export components and nothing else -- which is what React Fast Refresh
// needs, and what the lint rule was pointing at.
//
// They exist alongside <Button>/<TextInput> because the migration off 74
// hand-rolled class strings was mechanical: swapping a className for a call is
// a one-line, reviewable edit, where restructuring the JSX into components is
// not. New call sites should reach for the components; these keep the old ones
// honest in the meantime, and both read from the same definition.
// ---------------------------------------------------------------------------

export type ButtonVariant = 'primary' | 'secondary' | 'ghost';
export type ButtonSize = 'sm' | 'md' | 'lg' | 'hero';

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-on-accent font-medium hover:bg-accent-hover',
  secondary: 'border border-edge-strong text-ink hover:bg-raised',
  ghost: 'text-muted hover:bg-raised hover:text-ink',
};

const BUTTON_SIZES: Record<ButtonSize, string> = {
  sm: 'px-2 py-1 text-xs',
  md: 'px-3 py-1.5 text-sm',
  lg: 'px-4 py-2 text-sm',
  hero: 'px-5 py-3 font-semibold',
};

export function buttonClass(
  variant: ButtonVariant = 'primary',
  size: ButtonSize = 'md',
  className?: string,
) {
  return cn(
    'rounded-md disabled:opacity-50',
    BUTTON_VARIANTS[variant],
    BUTTON_SIZES[size],
    focusRing,
    className,
  );
}

const CONTROL_SIZES = {
  xs: 'px-2 py-1 text-xs',
  sm: 'px-2 py-1.5 text-sm',
  md: 'px-3 py-1.5 text-sm',
  lg: 'px-3 py-2 text-sm',
  // lg geometry, but leaves the font at the inherited 16px. Exactly two
  // inputs use it -- the event title and the personal-event title -- and they
  // are the reason it exists: they were the only controls in the app with no
  // text-size class, so folding them into `lg` would have shrunk them. That
  // made them the only two the first migration skipped, which made them the
  // only two with no focus ring, which is how it got spotted -- they fell
  // back to the browser's white outline while everything around them showed
  // the app's. Whether 16px there is intent or drift is a type-scale
  // question, and 0009's identity branch is where the scale gets decided.
  'lg-base': 'px-3 py-2',
  // Likewise preserved rather than rounded off: one recurrence control sits
  // at sm's type on xs's padding. A 2px difference, almost certainly drift
  // rather than intent -- but this branch's entire claim is that it changes
  // nothing on screen, and quietly restyling it would trade that for tidiness.
  // The hyphenated variants are exactly the drift 0009 collapses once there
  // is a real scale to collapse them onto.
  'sm-tight': 'px-2 py-1 text-sm',
} as const;

export type ControlSize = keyof typeof CONTROL_SIZES;

export function controlClass(size: ControlSize = 'lg', className?: string) {
  return cn(
    'rounded-md border border-edge-strong bg-raised text-ink disabled:opacity-50',
    CONTROL_SIZES[size],
    focusRing,
    className,
  );
}

const CARD_PADDING = { sm: 'p-3', md: 'p-4' } as const;

export type CardPadding = keyof typeof CARD_PADDING;

export function cardClass(padding: CardPadding = 'md', className?: string) {
  return cn('rounded-lg border border-edge bg-surface', CARD_PADDING[padding], className);
}
