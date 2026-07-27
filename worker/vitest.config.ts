import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // The D1 shim wraps node:sqlite, which is synchronous and shares no state
    // between files -- each test builds its own in-memory database.
    environment: 'node',
  },
});
