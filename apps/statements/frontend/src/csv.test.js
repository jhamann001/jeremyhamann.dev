// Run with `npm test -w statement-analyzer` (Node's own test runner; no extra dependencies).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { csvCell, csvRow } from './csv.js';

test('formula-looking text is neutralized', () => {
  for (const text of ['=HYPERLINK("https://example.invalid","x")', '+1+1', '-2+3', '@SUM(A1)', '\t=1', '\r=1']) {
    assert.ok(csvCell(text).replace(/^"/, '').startsWith("'"), text);
  }
});

test('numbers stay numbers', () => {
  for (const value of [0, 812, -3140, '236616.80', '-42.5', '2104.330']) {
    assert.equal(csvCell(value), String(value));
  }
});

test('quoting', () => {
  assert.equal(csvCell('Okafor, Kofi'), '"Okafor, Kofi"');
  assert.equal(csvCell('a "quoted" note'), '"a ""quoted"" note"');
  assert.equal(csvCell('two\nlines'), '"two\nlines"');
  assert.equal(csvCell('=x, y'), `"'=x, y"`);
  assert.equal(csvCell(null), '');
  assert.equal(csvCell(undefined), '');
  assert.equal(csvRow(['VTI', 812, null, '=1']), "VTI,812,,'=1");
});
