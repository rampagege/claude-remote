import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    globals: true,
    environment: 'node',
    testTimeout: 10000,
    coverage: {
      provider: 'v8',
      include: ['server/**/*.ts'],
      exclude: ['server/index.ts'],
    },
  },
});
