import assert from 'node:assert/strict';
import { test } from 'node:test';
import { APPS, appsFor, selectedApps } from './changed-apps.mjs';

const runs = (files) => [...appsFor(files)].sort();
const DEMOS = ['acat', 'helpdesk', 'statements', 'trade'];

test("an app's own files run only that app's jobs", () => {
  assert.deepEqual(runs(['apps/statements/server.py', 'apps/statements/worker/src/rules.js']), ['statements']);
  assert.deepEqual(runs(['apps/helpdesk/src/app/page.tsx', 'apps/helpdesk/package.json']), ['helpdesk']);
  assert.deepEqual(runs(['apps/helpdesk/worker/src/index.js']), ['helpdesk']);
  assert.deepEqual(runs(['apps/acat/src/lib/machine-auth.ts']), ['acat']);
  assert.deepEqual(runs(['apps/trade/server/src/index.ts']), ['trade']);
  assert.deepEqual(runs(['site/src/pages/index.astro']), ['site']);
  assert.deepEqual(runs(['.github/workflows/deploy-statements.yml']), ['statements']);
  assert.deepEqual(runs(['.github/workflows/reset-helpdesk.yml']), ['helpdesk']);
});

test('shared code runs every app that uses it', () => {
  assert.deepEqual(runs(['apps/demo-edge/theme-handoff.js']), DEMOS);
  assert.deepEqual(runs(['synthetic/out/universe.json']), ['synthetic', ...DEMOS].sort());
  for (const lockfileChange of ['apps/statements/frontend/package.json', 'apps/trade/shared/package.json', 'site/package.json']) {
    assert.deepEqual(runs([lockfileChange]), [...APPS].sort(), lockfileChange);
  }
});

test('docs, plans and guard files run only the guard', () => {
  assert.deepEqual(runs(['README.md', 'plans/portfolio.md', 'tools/guard/allow.txt', '.githooks/pre-commit']), []);
  assert.deepEqual(runs([]), []);
});

test("anything it can't place runs every job", () => {
  for (const file of [
    '.github/workflows/ci.yml',
    '.github/workflows/guard.yml',
    'tools/ci/changed-apps.mjs',
    'package.json',
    'package-lock.json',
    '.nvmrc',
    '.dockerignore',
    'newthing/x.js',
  ]) {
    assert.deepEqual(runs([file]), [...APPS].sort(), file);
  }
});

test('a manual run, or a push with nothing safe to compare with, runs every job', () => {
  const files = ['apps/statements/server.py'];
  assert.deepEqual([...selectedApps({ event: 'workflow_dispatch', files })].sort(), [...APPS].sort());
  assert.deepEqual([...selectedApps({ event: 'push', files: null })].sort(), [...APPS].sort());
  assert.deepEqual([...selectedApps({ event: 'push', files })], ['statements']);
});
