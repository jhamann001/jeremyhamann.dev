// The Worker's own test run, kept to its own folder (the shared apps/demo-edge tests run with the help desk Worker's).
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.js'],
  },
});
