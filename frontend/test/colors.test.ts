import { describe, expect, it } from 'vitest';
import {
  EXTERNAL_COLOR,
  groupColor,
  PERSONAL_COLOR,
  UNGROUPED_COLOR,
  type Swatch,
} from '../src/lib/colors';

// The palette's two design properties are measurable, so they are asserted
// rather than trusted. The first binary-sunset attempt had four of eight
// swatches inside a 23-degree band and four pairs below AA, and neither was
// visible in review -- it took someone creating three events to notice.

const hexOf = (cls: string) => cls.match(/#([0-9A-Fa-f]{6})/)?.[1] ?? '';

function rgb(hex: string) {
  return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
}

function luminance(hex: string) {
  const [r, g, b] = rgb(hex).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

function hue(hex: string) {
  const [r, g, b] = rgb(hex);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max === min) return 0;
  const d = max - min;
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}

// groupColor is a pure function of the id, so sampling ids recovers the whole
// palette without exporting the array and inviting someone to index it.
const palette: Swatch[] = (() => {
  const seen = new Map<string, Swatch>();
  for (let i = 0; i < 500 && seen.size < 32; i++) {
    const s = groupColor(`group-${i}`);
    if (!seen.has(s.bg)) seen.set(s.bg, s);
  }
  return [...seen.values()];
})();

describe('the group palette', () => {
  it('has eight swatches', () => {
    expect(palette).toHaveLength(8);
  });

  it('gives the same group the same colour every time', () => {
    expect(groupColor('the-cantina')).toEqual(groupColor('the-cantina'));
    expect(groupColor('a').bg).not.toBe(undefined);
  });

  // 12px chip text is small text, so AA is 4.5:1.
  it.each(palette.map((s) => [s.bg, s]))('%s clears AA against its own foreground', (_bg, s) => {
    const swatch = s as Swatch;
    expect(contrast(hexOf(swatch.bg), hexOf(swatch.fg))).toBeGreaterThanOrEqual(4.5);
  });

  it('spreads hues around the wheel rather than clustering', () => {
    const hues = palette.map((s) => hue(hexOf(s.bg))).sort((a, b) => a - b);
    const gaps = hues.map((h, i) => ((hues[(i + 1) % hues.length] - h + 360) % 360) || 360);
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(20);
  });
});

describe('the reserved swatches', () => {
  it('never hands the Google Calendar colour to a real group', () => {
    expect(palette.map((s) => s.bg)).not.toContain(EXTERNAL_COLOR.bg);
  });

  it('keeps personal time unfilled, so it cannot be mistaken for a crew', () => {
    expect(PERSONAL_COLOR.bg).toContain('bg-transparent');
    expect(PERSONAL_COLOR.bg).toContain('dashed');
  });

  it('keeps ungrouped events neutral rather than borrowing a group colour', () => {
    expect(palette.map((s) => s.bg)).not.toContain(UNGROUPED_COLOR.bg);
  });
});
