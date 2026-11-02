// The Worker's own test run: without this file vitest would walk up to the app's config, whose patterns only match
// the app's TypeScript tests. The shared demo-edge module's tests run with the help desk Worker's.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.js'],
  },
});
