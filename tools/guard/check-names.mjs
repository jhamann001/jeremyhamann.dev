#!/usr/bin/env node
// Blocks real firm, vendor and people names from entering this repo.
//
// The block list is deliberately NOT in the repo (committing it would publish the names it protects).
// It is read from the NAME_DENYLIST environment variable (CI secret) or from
// ~/.config/portfolio/denylist.txt (local). If neither exists the check fails closed.
//
// Modes:
//   --staged          staged file contents (pre-commit)
//   --all             every tracked file in the working tree
//   --history         every commit on every branch: message and diff. A commit that predates a term
//                     and can't be rewritten is excused for that term only, in history-allow.txt.
//                     A file's allow.txt entries hold for its diffs too; commit messages have none.
//   --message <file>  a commit message file (commit-msg hook)
//
// Hits are reported with the term masked, so a CI log never repeats a real name.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });

function loadTerms() {
  let raw = process.env.NAME_DENYLIST;
  if (!raw) {
    const file = process.env.PORTFOLIO_DENYLIST || join(homedir(), '.config', 'portfolio', 'denylist.txt');
    if (existsSync(file)) raw = readFileSync(file, 'utf8');
  }
  if (!raw) {
    console.error('check-names: no block list found (NAME_DENYLIST or ~/.config/portfolio/denylist.txt). Refusing to pass.');
    process.exit(2);
  }
  const terms = raw.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  if (terms.length === 0) {
    console.error('check-names: block list is empty. Refusing to pass.');
    process.exit(2);
  }
  return terms;
}

const mask = (t) => `${t[0]}${'*'.repeat(Math.max(t.length - 1, 2))}`;

// Each term is also checked in its other spellings: "a-b c" -> "a-b-c", "a_b_c", "a b c", "abc".
function variants(term) {
  const parts = term.toLowerCase().split(/[-_\s]+/).filter(Boolean);
  return [...new Set([term.toLowerCase(), parts.join('-'), parts.join('_'), parts.join(' '), parts.join('')])];
}

const isAlnum = (c) => c !== undefined && /[A-Za-z0-9]/.test(c);
// A match counts at a word boundary, a camelCase hump or a letter-to-digit change:
// `term`, `TERM_ID`, `fetchTermData`, `termAccount`, `REQ-TERM0001`.
function atBoundary(s, start, end) {
  const before = s[start - 1];
  const after = s[end];
  const first = s[start];
  const last = s[end - 1];
  const startOk = !isAlnum(before) || (/[a-z0-9]/.test(before) && /[A-Z]/.test(first)) || (/[0-9]/.test(before) && /[A-Za-z]/.test(first));
  const endOk = !isAlnum(after) || (/[a-z0-9]/.test(last) && /[A-Z]/.test(after)) || (/[A-Za-z]/.test(last) && /[0-9]/.test(after));
  return startOk && endOk;
}

// The code around a match: letters and digits, joined across hyphens, e.g. `TRM-001-X2` for a
// match inside `id: "TRM-001-X2"`.
function runAround(s, start, end) {
  const inCode = (i) => isAlnum(s[i]) || (s[i] === '-' && isAlnum(s[i - 1]) && isAlnum(s[i + 1]));
  let a = start;
  let b = end;
  while (inCode(a - 1)) a--;
  while (inCode(b)) b++;
  return s.slice(a, b);
}

// Places where an identifier has no visible boundary (tree scans only, see `strict`):
// inside an all-capitals code such as `TERMACCT` or `TRM001X`, and a term ending in a digit that
// runs on into more digits, such as a ticket key in `FLAG_KEY2401`. A three-letter term counts
// inside an all-capitals run only when the run has digits too, so words like `NEWCOMER` don't trip.
function hiddenInCode(line, start, end) {
  const run = runAround(line, start, end);
  if (run.length > end - start && !/[a-z]/.test(run) && /[A-Z]/.test(run) && (end - start >= 4 || /[0-9]/.test(run))) return true;
  return /[0-9]/.test(line[end - 1] ?? '') && /[0-9]/.test(line[end] ?? '') && !isAlnum(line[start - 1]);
}

// Distinctive terms (6+ letters) match anywhere, including inside identifiers such as `loadTermTemplates`.
// Short terms match only at word or camelCase boundaries, so ordinary words that contain them don't trip.
// `strict` (file scans) also catches short terms hidden in codes; history keeps the original rule.
function matches(line, forms, strict) {
  const lower = line.toLowerCase();
  for (const f of forms) {
    for (let i = lower.indexOf(f); i !== -1; i = lower.indexOf(f, i + 1)) {
      if (f.replace(/[^a-z0-9]/g, '').length >= 6 || atBoundary(line, i, i + f.length)) return true;
      if (strict && hiddenInCode(line, i, i + f.length)) return true;
    }
  }
  return false;
}

function loadAllow() {
  const file = new URL('./allow.txt', import.meta.url);
  if (!existsSync(file)) return new Set();
  return new Set(
    readFileSync(file, 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'))
      .map((l) => l.toLowerCase()),
  );
}

// History exemptions, one per line: `<commit sha> <sha256 of the lowercased term>`. Only the hash is
// stored, so the file never names the term it excuses. An exemption counts only for a commit already
// on main, so a branch can't excuse its own new commits; an entry for any other commit in this repo
// fails the check. An entry for a commit this repo doesn't have (the public snapshot) excuses nothing.
function loadHistoryAllow() {
  const file = new URL('./history-allow.txt', import.meta.url);
  if (process.argv[2] !== '--history' || !existsSync(file)) return new Set();
  const entries = readFileSync(file, 'utf8')
    .split('\n')
    .map((l) => l.replace(/#.*/, '').trim())
    .filter(Boolean)
    .map((l) => l.split(/\s+/).slice(0, 2).join(' ').toLowerCase());
  const main = ['origin/main', 'main'].find((ref) => {
    try {
      git('rev-parse', '--verify', '--quiet', `${ref}^{commit}`);
      return true;
    } catch {
      return false;
    }
  });
  const present = (sha) => {
    try {
      git('cat-file', '-e', `${sha}^{commit}`);
      return true;
    } catch {
      return false;
    }
  };
  for (const entry of entries) {
    const [sha, hash] = entry.split(' ');
    if (/^[0-9a-f]{40}$/.test(sha) && !present(sha)) continue;
    let onMain = Boolean(main) && /^[0-9a-f]{40}$/.test(sha) && /^[0-9a-f]{64}$/.test(hash ?? '');
    if (onMain) {
      try {
        git('merge-base', '--is-ancestor', sha, main);
      } catch {
        onMain = false;
      }
    }
    if (!onMain) {
      console.error(`check-names: history-allow.txt entry for ${sha.slice(0, 7)} is not a commit on main. Refusing to pass.`);
      process.exit(2);
    }
  }
  return new Set(entries);
}
const termHash = (term) => createHash('sha256').update(term.toLowerCase()).digest('hex');

const terms = loadTerms();
const patterns = terms.map((t) => ({ term: t, forms: variants(t), hash: termHash(t) }));
const allow = loadAllow();
const historyAllow = loadHistoryAllow();
const hits = [];

// Base64 integrity hashes (lockfiles) can contain any short letter run by chance; they never carry names.
const INTEGRITY = /sha(?:1|256|384|512)-[A-Za-z0-9+/=]+/g;

// Binary content is skipped. A text file can still hold a NUL or two (test input for a header-injection
// check, say), and skipping those hid a firm name from this check once, so the test is how much of the
// content is NULs or undecodable bytes, not whether any are present.
const BINARY_EXT = /\.(png|jpe?g|gif|webp|ico|pdf|woff2?|ttf|otf|zip|gz|tgz|br|mp4|mov|webm|wasm)$/i;
function isBinary(path, text) {
  if (path && BINARY_EXT.test(path)) return true;
  let odd = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 0 || c === 0xfffd) odd++;
  }
  return text.length > 0 && odd / text.length > 0.01;
}

function scanText(label, path, text) {
  if (isBinary(path, text)) return;
  const lines = text.replace(INTEGRITY, 'sha-hash').split('\n');
  let commit = null; // in --history, the commit the current line belongs to
  let file = path; // in --history, the file whose diff the current line is in (null in a commit message)
  for (let i = 0; i < lines.length; i++) {
    const header = mode === '--history' && /^commit ([0-9a-f]{40})$/.exec(lines[i]);
    if (header) [commit, file] = [header[1], null];
    const diff = mode === '--history' && /^diff --git a\/.+ b\/(.+)$/.exec(lines[i]);
    if (diff) file = diff[1];
    for (const { term, forms, hash } of patterns) {
      if (commit && historyAllow.has(`${commit} ${hash}`)) continue;
      if (matches(lines[i], forms, mode !== '--history') && !(file && allow.has(`${file}\t${term}`.toLowerCase()))) {
        hits.push(`${label}${path ? `${path}:${i + 1}` : `line ${i + 1}`}  [${mask(term)}]`);
      }
    }
  }
}

const mode = process.argv[2];
if (mode === '--staged') {
  const files = git('diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z').split('\0').filter(Boolean);
  scanText('path ', null, files.join('\n'));
  for (const f of files) scanText('', f, git('show', `:${f}`));
} else if (mode === '--all') {
  const files = git('ls-files', '-z').split('\0').filter(Boolean);
  scanText('path ', null, files.join('\n'));
  for (const f of files) if (existsSync(f)) scanText('', f, readFileSync(f, 'utf8'));
} else if (mode === '--history') {
  let log = '';
  try {
    log = git('log', '--all', '-p', '--no-color', '--format=commit %H%n%an <%ae>%n%B');
  } catch {
    log = ''; // empty repo
  }
  scanText('history ', null, log);
} else if (mode === '--message') {
  scanText('commit message ', null, readFileSync(process.argv[3], 'utf8'));
} else {
  console.error('usage: check-names.mjs --staged | --all | --history | --message <file>');
  process.exit(2);
}

if (hits.length) {
  console.error(`check-names: ${hits.length} blocked term(s) found:`);
  for (const h of hits.slice(0, 50)) console.error(`  ${h}`);
  if (hits.length > 50) console.error(`  ...and ${hits.length - 50} more`);
  process.exit(1);
}
console.log(`check-names: clean (${mode}, ${terms.length} terms)`);
