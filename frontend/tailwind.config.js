/** @type {import('tailwindcss').Config} */

// Semantic tokens, not raw palette steps.
//
// The point of naming these by role rather than by colour is that the *next*
// restyle is a change to this file instead of a change to 27 components. The
// values below are exactly the slate/indigo steps the app already used, so
// introducing them changed nothing on screen; spec 0009 repoints them at the
// binary-sunset palette, and that is meant to be the whole visual diff.
//
// Two pairs share a value today and are still worth separating, because they
// stop sharing one in 0009:
//   raised / edge          both #1e293b (slate-800) -- a fill and a hairline
//   raised-hi / edge-strong both #334155 (slate-700) -- likewise
//
// The nine slate steps the app had drifted into are preserved here as nine
// tokens rather than collapsed, because collapsing them would change colours
// and this branch deliberately changes none. 0009 collapses the ramp in the
// identity branch, where the values move anyway.
//
// Not tokenised yet, on purpose: the group-chip palette in lib/colors.ts
// (0009 retunes it for a warm ground) and the tinted status banners in red /
// amber / emerald. Both are branch-2 work and both would have meant judgement
// calls about colour in a branch whose whole claim is that it makes none.
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        ground: '#020617', // page background          (was slate-950)
        surface: '#0f172a', // cards, bars, panels      (was slate-900)
        raised: '#1e293b', // input fills, hover states (was slate-800)
        'raised-hi': '#334155', // a step above raised   (was slate-700)

        edge: '#1e293b', // hairline borders           (was slate-800)
        'edge-strong': '#334155', // control borders   (was slate-700)

        ink: '#f1f5f9', // primary text                (was slate-100)
        'ink-soft': '#e2e8f0', //                        (was slate-200)
        'ink-dim': '#cbd5e1', // de-emphasised text    (was slate-300)
        muted: '#94a3b8', // secondary text            (was slate-400)
        faint: '#64748b', // tertiary text, footers    (was slate-500)
        fainter: '#475569', // barely-there text       (was slate-600)

        accent: '#4f46e5', // primary actions          (was indigo-600)
        'accent-hover': '#6366f1', //                  (was indigo-500)
        'accent-text': '#818cf8', // accent on a dark ground (was indigo-400)
        'on-accent': '#ffffff', // text on an accent fill

        danger: '#dc2626', // destructive actions      (was red-600)
        'danger-hover': '#ef4444', //                  (was red-500)
        'danger-text': '#f87171', //                   (was red-400)
      },
    },
  },
  plugins: [],
};
