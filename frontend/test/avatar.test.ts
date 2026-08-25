import { describe, expect, it } from 'vitest';
import { avatarUrl, initials } from '../src/lib/avatar';

describe('avatarUrl', () => {
  it('asks Discord for 2x the rendered size, at a power of two', () => {
    expect(avatarUrl('123', 'abc', 24)).toBe('https://cdn.discordapp.com/avatars/123/abc.png?size=64');
    expect(avatarUrl('123', 'abc', 32)).toBe('https://cdn.discordapp.com/avatars/123/abc.png?size=64');
    expect(avatarUrl('123', 'abc', 48)).toBe('https://cdn.discordapp.com/avatars/123/abc.png?size=128');
  });
});

describe('initials', () => {
  it('takes the first letter, uppercased', () => {
    expect(initials('luke')).toBe('L');
    expect(initials('Obi-Wan')).toBe('O');
  });

  it('does not split an emoji in half', () => {
    // A leading emoji is common in Discord display names. Taking name[0] here
    // yields a lone surrogate, which renders as a replacement character.
    expect(initials('🌅 Beru')).toBe('🌅');
    expect([...initials('🌅 Beru')]).toHaveLength(1);
  });

  it('has something to show for a blank or whitespace-only name', () => {
    expect(initials('')).toBe('?');
    expect(initials('   ')).toBe('?');
  });
});
