// Shared style fragments for the UI primitives.
//
// Focus is handled globally in index.css, not here -- see the note on the
// `:focus-visible` rule for why the per-builder version was withdrawn. What
// matters for these builders is only that they must never emit a utility that
// clears the outline, which would suppress it. There is a test for exactly
// that -- and the token is spelled out only there, because Tailwind scans
// source text for class-like strings and writing it here emits a real rule.

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
    className,
  );
}

const CARD_PADDING = { sm: 'p-3', md: 'p-4' } as const;

export type CardPadding = keyof typeof CARD_PADDING;

export function cardClass(padding: CardPadding = 'md', className?: string) {
  return cn('rounded-lg border border-edge bg-surface', CARD_PADDING[padding], className);
}
