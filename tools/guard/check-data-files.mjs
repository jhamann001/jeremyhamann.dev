#!/usr/bin/env node
// Data-type files (spreadsheets, PDFs, database files) may only live in synthetic/out/,
// where the generator writes them, or on the explicit list in data-allow.txt.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const BLOCKED = /\.(csv|tsv|xlsx|xls|pdf|parquet|sqlite|sqlite3|db)$/i;
const allowFile = new URL('./data-allow.txt', import.meta.url);
const allow = new Set(
  existsSync(allowFile)
    ? readFileSync(allowFile, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
    : [],
);

const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
const bad = files.filter((f) => BLOCKED.test(f) && !f.startsWith('synthetic/out/') && !allow.has(f));

if (bad.length) {
  console.error('check-data-files: data files outside synthetic/out/:');
  for (const f of bad) console.error(`  ${f}`);
  process.exit(1);
}
console.log(`check-data-files: clean (${files.length} files)`);
