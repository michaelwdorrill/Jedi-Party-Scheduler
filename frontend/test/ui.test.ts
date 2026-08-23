import { describe, expect, it } from 'vitest';
import { buttonClass, cardClass, cn, controlClass } from '../src/components/ui/styles';

describe('cn', () => {
  it('drops falsy parts so conditional classes do not leave gaps', () => {
    expect(cn('a', false, null, undefined, 'b')).toBe('a b');
  });
});

// Focus lives in one global `:focus-visible` rule in index.css, so these
// builders must stay out of its way. `outline-none` anywhere in them would
// silently suppress the app's focus style for every control built from them --
// which is exactly the bug this replaced, in reverse.
describe('nothing suppresses the global focus outline', () => {
  it.each([
    ['button', buttonClass()],
    ['secondary button', buttonClass('secondary', 'lg')],
    ['ghost button', buttonClass('ghost', 'sm')],
    ['control', controlClass()],
    ['small control', controlClass('xs')],
    ['title control', controlClass('lg-base')],
    ['card', cardClass()],
  ])('%s does not set outline-none', (_label, cls) => {
    expect(cls).not.toContain('outline-none');
    expect(cls).not.toContain('outline-0');
  });
});

describe('buttonClass', () => {
  it('defaults to a primary, medium button', () => {
    expect(buttonClass()).toBe(buttonClass('primary', 'md'));
  });

  it('keeps variant and size on separate axes', () => {
    expect(buttonClass('secondary', 'hero')).toContain('border-edge-strong');
    expect(buttonClass('secondary', 'hero')).toContain('px-5 py-3');
  });

  it('appends caller classes last so they win the cascade tie', () => {
    expect(buttonClass('primary', 'md', 'w-full').endsWith('w-full')).toBe(true);
  });

  it('always dims disabled controls', () => {
    expect(buttonClass('ghost', 'sm')).toContain('disabled:opacity-50');
  });
});

describe('controlClass', () => {
  it('defaults to the shape 24 of the 29 original inputs used', () => {
    expect(controlClass()).toBe(controlClass('lg'));
    expect(controlClass()).toContain('px-3 py-2 text-sm');
  });

  it('takes width from the caller rather than assuming full width', () => {
    expect(controlClass('lg')).not.toContain('w-full');
    expect(controlClass('lg', 'w-full')).toContain('w-full');
  });
});

describe('cardClass', () => {
  it('defaults to the p-4 box', () => {
    expect(cardClass()).toContain('p-4');
    expect(cardClass('sm')).toContain('p-3');
  });

  it('uses semantic tokens, never raw palette steps', () => {
    for (const cls of [cardClass(), buttonClass(), controlClass()]) {
      expect(cls).not.toMatch(/\b(slate|indigo)-\d{2,3}\b/);
    }
  });
});
