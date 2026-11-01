#!/usr/bin/env node
// Every commit on every branch must carry the private GitHub address, never a personal or work email.
// The pre-commit hook only covers commits made on this Mac; this also catches commits GitHub creates
// (web merges, squash merges), which skip local hooks.
//
// Offending emails are printed masked, so a CI log never repeats them.

import { execFileSync } from 'node:child_process';

const PERSONAL_NOREPLY = '226341726+jhamann001@users.noreply.github.com';
const ALLOWED_AUTHORS = new Set([PERSONAL_NOREPLY]);
// GitHub records itself as committer on merges made in its web UI or API.
const ALLOWED_COMMITTERS = new Set([PERSONAL_NOREPLY, 'noreply@github.com']);

const mask = (email) => {
  const [user, domain = ''] = email.split('@');
  return `${user.slice(0, 1)}***@${domain}`;
};

let log = '';
try {
  log = execFileSync('git', ['log', '--all', '--format=%H%x09%ae%x09%ce'], { encoding: 'utf8' });
} catch {
  log = ''; // empty repo
}

const bad = [];
for (const line of log.split('\n').filter(Boolean)) {
  const [sha, author, committer] = line.split('\t');
  if (!ALLOWED_AUTHORS.has(author)) bad.push(`${sha.slice(0, 7)} author ${mask(author)}`);
  if (!ALLOWED_COMMITTERS.has(committer)) bad.push(`${sha.slice(0, 7)} committer ${mask(committer)}`);
}

if (bad.length) {
  console.error('check-commit-emails: commits with an email other than the private GitHub address:');
  for (const b of bad) console.error(`  ${b}`);
  console.error('Fix: amend or rewrite those commits, and keep "Keep my email addresses private" on in GitHub.');
  process.exit(1);
}
console.log(`check-commit-emails: clean (${log.split('\n').filter(Boolean).length} commits)`);
