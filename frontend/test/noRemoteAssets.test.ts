import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// R14 from the Pass-11 security review, kept fixed.
//
// index.html used to carry a preconnect pair and a stylesheet <link> to
// fonts.googleapis.com, so every visitor's browser contacted Google -- and
// disclosed at least its public IP -- before login and before any Calendar
// choice was made. The Privacy Policy says, in as many words, that nothing is
// sent to Google for anyone who has not connected an account, which made this
// a plainly false statement rather than an under-documented one.
//
// The fonts are self-hosted now (src/fonts.css, public/fonts/). This test
// exists because that is a one-line thing to undo: pasting the Google Fonts
// snippet back in is the normal way to add a typeface, it would look entirely
// reasonable in review, and nothing else in the app would notice.
const ROOT = join(__dirname, '..');

// Matched on the host, not on a whole URL, so a differently-shaped embed --
// a preconnect, an @import, a preload -- is caught the same way a <link> is.
const REMOTE_ASSET_HOSTS = [
  'fonts.googleapis.com',
  'fonts.gstatic.com',
  'cdn.jsdelivr.net',
  'unpkg.com',
  'cdnjs.cloudflare.com',
];

function withoutComments(html: string): string {
  return html.replace(/<!--[\s\S]*?-->/g, '');
}

describe('the page loads no third-party assets', () => {
  it('has no remote asset host in index.html', () => {
    // Comments stripped first: index.html explains at that spot why the
    // Google Fonts links are gone, and naming the host in prose is the point
    // of the note rather than a violation of it.
    const html = withoutComments(readFileSync(join(ROOT, 'index.html'), 'utf8'));
    for (const host of REMOTE_ASSET_HOSTS) {
      expect(html, `index.html must not reference ${host}`).not.toContain(host);
    }
  });

  it('serves every @font-face from this origin', () => {
    const css = readFileSync(join(ROOT, 'src', 'fonts.css'), 'utf8');
    const urls = [...css.matchAll(/url\(([^)]+)\)/g)].map((m) => m[1]);

    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) {
      expect(url, 'every font must be served from this origin').toMatch(/^\/fonts\//);
    }
  });

  it('has the file behind every @font-face it declares', () => {
    const css = readFileSync(join(ROOT, 'src', 'fonts.css'), 'utf8');
    const referenced = new Set(
      [...css.matchAll(/url\(\/fonts\/([^)]+)\)/g)].map((m) => m[1]),
    );
    const present = new Set(readdirSync(join(ROOT, 'public', 'fonts')));

    // A declaration with no file is a silent fallback to the system stack --
    // the page still renders, so nothing would flag it.
    for (const file of referenced) {
      expect(present.has(file), `public/fonts/${file} is declared but missing`).toBe(true);
    }
  });

  it('ships the licence the fonts are redistributed under', () => {
    const ofl = readFileSync(join(ROOT, 'public', 'fonts', 'OFL.txt'), 'utf8');
    expect(ofl).toContain('SIL Open Font License');
  });
});
