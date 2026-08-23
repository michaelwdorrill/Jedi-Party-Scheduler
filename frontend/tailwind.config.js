/** @type {import('tailwindcss').Config} */

// Binary sunset — the v0.4 identity (docs/specs/0009-binary-sunset.md).
//
// Branch 1 put semantic tokens in front of every surface in the app so that
// this file would be the whole visual diff. This is that payoff: the values
// below moved, and nothing else had to.
//
// Dark-first, single theme. 0009 defines a light ("noon at the homestead")
// column too and the ramp below is built to accept it, but shipping and
// reviewing both doubles the surface, so light is deliberately out of v0.4.
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        // The ground runs warm black to lit sand. No cold grey anywhere in
        // the app -- that absence is most of what makes it read as desert.
        ground: '#1A1410', // page
        surface: '#241C16', // cards, bars, panels
        raised: '#2C231B', // input fills, hover states
        'raised-hi': '#3A2E24', // a step above raised

        edge: '#372B22', // hairline borders
        'edge-strong': '#4A3A2C', // control borders

        ink: '#F0E2CC', // primary text -- parchment, not white
        'ink-soft': '#E4D5BE',
        'ink-dim': '#D6C0A0',
        muted: '#A8927A', // secondary text
        faint: '#85715C', // tertiary text, footers
        fainter: '#6B5945', // barely-there text

        // The two suns. Tatoo I is the larger, warmer one and carries primary
        // actions; Tatoo II is smaller and paler and does the lighter-weight
        // work -- accent text, the second of the two shadows.
        accent: '#E8913A', // Tatoo I
        'accent-hover': '#F2A855',
        'accent-text': '#F0A34F',
        'on-accent': '#1A1008', // near-black on an orange fill, not white
        'accent-2': '#F2C879', // Tatoo II

        // The two counterpoints that stop this being a generic warm palette.
        // Vaporator teal is load-bearing rather than decorative: personal time
        // reads cool against warm group sessions, a distinction the old
        // slate-600 made only faintly.
        dusk: '#8B6BA0', // the violet band of the sunset
        moisture: '#6FA8A8', // vaporator condensate

        // Status, warmed to sit on sand rather than on slate.
        danger: '#C4432E',
        'danger-hover': '#D9553D',
        'danger-text': '#EE8A6E',
        'danger-surface': '#3A1D14',
        warning: '#C08A2A',
        'warning-text': '#E4B15C',
        'warning-surface': '#33260F',
        success: '#6E8C4A',
        'success-text': '#A8C077',
        'success-surface': '#222A15',
      },

      fontFamily: {
        // Saira Condensed for display: condensed and slightly stencilled, it
        // reads as equipment labelling. Barlow for everything read at length --
        // humanist, industrial lineage, holds up small. No serif anywhere: a
        // serif would read artisanal, and this is used-future.
        display: ['"Saira Condensed"', '"Barlow Condensed"', 'ui-sans-serif', 'sans-serif'],
        sans: ['Barlow', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'monospace'],
      },

      boxShadow: {
        // The signature. Two suns means two shadows: a hard warm one from
        // Tatoo I and a soft violet one from Tatoo II, at different angles.
        // Two values, applied once, and nothing else looks like it.
        lift: '3px 4px 0 -2px rgba(232, 145, 58, .16), -2px 3px 12px -3px rgba(0, 0, 0, .55)',
        'lift-lg':
          '6px 8px 0 -3px rgba(232, 145, 58, .13), -4px 8px 30px -8px rgba(0, 0, 0, .70)',
      },
    },
  },
  plugins: [],
};
