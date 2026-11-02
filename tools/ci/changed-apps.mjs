#!/usr/bin/env node
// Which apps a push touches, so CI runs only their jobs (Actions minutes are capped). A push runs the apps changed
// since its branch's last green CI run; a red or cancelled run doesn't move that point, so the next push runs its
// apps again. A branch with no green run yet (or rebased past it) compares from where it left main. main without a
// usable green run, a manual run, or a change this can't place runs every job. Deploys trust only main's runs (see
// the deploy workflows): one after another, they have run every app's jobs on that app's current code.

import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const APPS = ['synthetic', 'site', 'trade', 'acat', 'helpdesk', 'statements', 'aoa'];
const DEMOS = ['trade', 'acat', 'helpdesk', 'statements', 'aoa'];

// First match wins. Anything unmatched runs every job: CI itself, this selector, the root package files, .nvmrc,
// .dockerignore, or a new top-level folder.
const RULES = [
  // Docs, plans and the guard's own files: the guard job, which always runs, is their check.
  [/^(plans\/|tools\/guard\/|\.githooks\/|README\.md$|\.editorconfig$|\.gitignore$|\.gitleaks\.toml$)/, []],
  // A workspace's package.json changes the shared lockfile, and the images copy each other's for npm ci.
  [/^(synthetic|site|apps\/trade(\/(shared|server|client|worker))?|apps\/acat(\/worker)?|apps\/helpdesk\/worker|apps\/statements\/(frontend|worker)|apps\/aoa\/worker)\/package\.json$/, APPS],
  // Each deploy or reset workflow: CI doesn't run it, so its app's jobs are the nearest check.
  [/^\.github\/workflows\/deploy-site\.yml$/, ['site']],
  [/^\.github\/workflows\/deploy-trade\.yml$/, ['trade']],
  [/^\.github\/workflows\/deploy-acat\.yml$/, ['acat']],
  [/^\.github\/workflows\/(deploy|reset)-helpdesk\.yml$/, ['helpdesk']],
  [/^\.github\/workflows\/deploy-statements\.yml$/, ['statements']],
  [/^\.github\/workflows\/(deploy|reset)-aoa\.yml$/, ['aoa']],
  // The demos' Workers share this code; the site only mentions it in a comment.
  [/^apps\/demo-edge\//, DEMOS],
  // Every demo's image and data come from the synthetic universe.
  [/^synthetic\//, ['synthetic', ...DEMOS]],
  [/^site\//, ['site']],
  [/^apps\/trade\//, ['trade']],
  [/^apps\/acat\//, ['acat']],
  // The help desk app keeps its own lockfile, so its package.json lands here, not in the workspace rule.
  [/^apps\/helpdesk\//, ['helpdesk']],
  [/^apps\/statements\//, ['statements']],
  // The advisor platform keeps its own lockfile too (its Worker's package.json is a workspace's, above).
  [/^apps\/aoa\//, ['aoa']],
];

/** The apps whose jobs a set of changed paths needs. */
export function appsFor(files) {
  const apps = new Set();
  for (const file of files) {
    const rule = RULES.find(([pattern]) => pattern.test(file));
    for (const app of rule ? rule[1] : APPS) apps.add(app);
  }
  return apps;
}

/** The apps to run for this event. files is null when there's nothing safe to compare with. */
export function selectedApps({ event, files }) {
  if (event !== 'push' || files === null) return new Set(APPS);
  return appsFor(files);
}

const run = (cmd, ...args) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** Where to compare from: the branch's last green CI commit if HEAD still builds on it, else where it left main. */
function branchBase(branch) {
  try {
    const green = run(
      'gh', 'run', 'list', '--repo', process.env.GITHUB_REPOSITORY, '--workflow', 'ci.yml', '--branch', branch,
      '--event', 'push', '--status', 'success', '--limit', '1', '--json', 'headSha', '--jq', '.[0].headSha // ""',
    );
    if (green) {
      run('git', 'merge-base', '--is-ancestor', green, 'HEAD'); // throws if a rebase or force push dropped it
      return { base: green, since: `its last green CI run (${green.slice(0, 7)})` };
    }
  } catch {
    // no usable green run: compare with main
  }
  // main compared with itself would find nothing changed; branchFiles turns this into every job.
  if (branch === 'main') throw new Error('main has no green run HEAD builds on');
  return { base: run('git', 'merge-base', 'origin/main', 'HEAD'), since: 'it left main' };
}

function branchFiles(branch) {
  try {
    const { base, since } = branchBase(branch);
    // Without rename detection a moved file counts against both its old and new place.
    const files = run('git', 'diff', '--name-only', '--no-renames', '-z', base, 'HEAD').split('\0').filter(Boolean);
    return { files, since };
  } catch {
    return { files: null };
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const event = process.env.GITHUB_EVENT_NAME;
  const branch = process.env.GITHUB_REF_NAME;
  const { files, since } = event === 'push' ? branchFiles(branch) : { files: null };
  const apps = selectedApps({ event, files });
  if (files) console.log(`changed-apps: ${files.length} file(s) changed on ${branch} since ${since}`);
  else if (event === 'push') console.log(`changed-apps: nothing safe to compare ${branch} with: every job runs`);
  else console.log(`changed-apps: ${event} on ${branch}: every job runs`);
  console.log(`changed-apps: running ${apps.size ? [...apps].join(', ') : 'only the guard'}`);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, APPS.map((app) => `${app}=${apps.has(app)}\n`).join(''));
  }
}
