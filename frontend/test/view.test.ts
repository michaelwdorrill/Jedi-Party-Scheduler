import { describe, expect, it } from 'vitest';
import { AGENDA_BREAKPOINT, resolveView } from '../src/lib/view';

// The view preference is what settles idea 20's mobile question: a rail beside
// a month grid does not fit a phone, and rather than designing a second layout
// the agenda simply becomes the phone default. These assertions are that rule.
describe('resolveView', () => {
  it('honours an explicit choice at any width', () => {
    expect(resolveView('agenda', 1600)).toBe('agenda');
    expect(resolveView('month', 320)).toBe('month');
  });

  it('defaults a narrow screen to the agenda, which works in one column', () => {
    expect(resolveView(null, 375)).toBe('agenda');
    expect(resolveView(null, AGENDA_BREAKPOINT - 1)).toBe('agenda');
  });

  it('defaults a wide screen to the month grid', () => {
    expect(resolveView(null, AGENDA_BREAKPOINT)).toBe('month');
    expect(resolveView(null, 1440)).toBe('month');
  });

  it('ignores a value it does not recognise rather than trusting storage', () => {
    expect(resolveView('tosche', 1440)).toBe('month');
    expect(resolveView('', 375)).toBe('agenda');
  });
});
