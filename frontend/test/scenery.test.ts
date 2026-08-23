import { describe, expect, it } from 'vitest';
import { resolveScenery } from '../src/lib/scenery';

// resolveScenery is duplicated by hand into the pre-paint script in
// index.html, which cannot import from the bundle because its whole job is to
// run before the bundle exists. These assertions are what keep the two honest.
describe('resolveScenery', () => {
  it('honours an explicit choice, in both directions', () => {
    expect(resolveScenery('twin-suns')).toBe('twin-suns');
    expect(resolveScenery('homestead')).toBe('homestead');
  });

  it('defaults to homestead, because nobody opens Settings to turn scenery on', () => {
    expect(resolveScenery(null)).toBe('homestead');
  });

  it('ignores a value it does not recognise rather than trusting storage', () => {
    expect(resolveScenery('tosche-station')).toBe('homestead');
    expect(resolveScenery('')).toBe('homestead');
  });
});
