import { describe, expect, it } from 'vitest';
import {
  buttonClass,
  cardClass,
  cn,
  controlClass,
  focusRing,
} from '../src/components/ui/styles';

describe('cn', () => {
  it('drops falsy parts so conditional classes do not leave gaps', () => {
    expect(cn('a', false, null, undefined, 'b')).toBe('a b');
  });
});

// The app shipped 27 files with no focus styling at all (spec 0009's audit).
// These assertions are the guardrail: anything a keyboard can reach is built
// from one of these, so a missing ring becomes a failing test rather than a
// thing nobody notices.
describe('focus is never optional', () => {
  it.each([
    ['button', buttonClass()],
    ['secondary button', buttonClass('secondary', 'lg')],
    ['ghost button', buttonClass('ghost', 'sm')],
    ['control', controlClass()],
    ['small control', controlClass('xs')],
  ])('%s carries the shared focus ring', (_label, cls) => {
    for (const part of focusRing.split(' ')) {
      expect(cls).toContain(part);
    }
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
