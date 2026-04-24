import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    setupFiles: ['src/tests/setup.ts'],
    // Single-threaded to avoid port conflicts with the test server
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
});
