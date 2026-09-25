import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    pool: 'forks',
    testTimeout: 15_000,
    hookTimeout: 30_000,
    benchmark: { include: ['tests/bench/**/*.bench.ts'] },
  },
});
