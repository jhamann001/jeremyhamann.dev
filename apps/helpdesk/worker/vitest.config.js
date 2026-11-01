// The Worker's own test run: without this file vitest would walk up to the help desk's config, whose patterns
// only match the app's TypeScript tests. It also runs the tests of the module every demo Worker shares
// (apps/demo-edge), since that folder has no package of its own.
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    dir: fileURLToPath(new URL('../..', import.meta.url)),
    include: ['helpdesk/worker/src/**/*.test.js', 'demo-edge/**/*.test.js'],
  },
});
