module.exports = {
  root: true,
  env: { browser: true, es2020: true },
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:react-hooks/recommended',
  ],
  ignorePatterns: ['dist', '.eslintrc.cjs'],
  parser: '@typescript-eslint/parser',
  plugins: ['react-refresh'],
  rules: {
    // Pass-19 review (P19-04). `exhaustive-deps` only inspects hooks it knows
    // about, so `useAsync` -- this app's own data loader, and the hook that
    // actually fetches on nearly every page -- was never checked at all. An
    // EventDetailPage loader that read `occurrenceDate` from the URL but
    // listed only `[eventId]` therefore went unflagged through nineteen
    // review passes, and shipped a page that RSVP'd to a different occurrence
    // than the one on screen.
    //
    // Naming it here is the systemic half of that fix: the one-line dependency
    // correction stops this instance, and this stops the next one.
    'react-hooks/exhaustive-deps': ['error', { additionalHooks: '(useAsync)' }],
    'react-refresh/only-export-components': [
      'warn',
      { allowConstantExport: true },
    ],
  },
};
