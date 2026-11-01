import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/__tests__/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/__tests__/**', 'src/db/seed-runner.ts'],
      thresholds: {
        lines: 55,
        functions: 55,
        branches: 45,
        statements: 55,
      },
    },
  },
});
