import { describe, it, expect } from 'vitest';
import { pickNewestFeedFile } from '../meridianS3.js';

const PREFIX = 'Accounts-and-associations/';
const keys = [
  `${PREFIX}active_accounts_20260525.json`,
  `${PREFIX}active_accounts_20260601.json`,
  `${PREFIX}templates_20260525.json`,
  `${PREFIX}templates_20260601.json`,
  `${PREFIX}transitions_20260525.json`,
  `${PREFIX}transitions_20260601.json`,
  `${PREFIX}`, // the folder marker (0-byte key) — must be ignored
];

describe('pickNewestFeedFile', () => {
  it('selects the newest file for the requested feed only (no cross-feed bleed)', () => {
    expect(pickNewestFeedFile(keys, 'templates')?.key).toBe(`${PREFIX}templates_20260601.json`);
    expect(pickNewestFeedFile(keys, 'active_accounts')?.key).toBe(`${PREFIX}active_accounts_20260601.json`);
    expect(pickNewestFeedFile(keys, 'transitions')?.key).toBe(`${PREFIX}transitions_20260601.json`);
  });

  it('derives as-of from the YYYYMMDD in the filename', () => {
    expect(pickNewestFeedFile(keys, 'templates')?.asOf).toBe('2026-06-01T00:00:00.000Z');
  });

  it('does NOT let transitions_ outsort templates_ (the original bug)', () => {
    // Lexicographically "transitions..." > "templates...", so a naive .json sort
    // would have grabbed the transitions file for the templates feed.
    const picked = pickNewestFeedFile(keys, 'templates');
    expect(picked?.key).toContain('templates_');
    expect(picked?.key).not.toContain('transitions_');
  });

  it('returns null when no file matches the feed', () => {
    expect(pickNewestFeedFile([`${PREFIX}templates_20260601.json`], 'active_accounts')).toBeNull();
    expect(pickNewestFeedFile([], 'templates')).toBeNull();
  });

  it('ignores non-matching keys (folder markers, bad dates)', () => {
    const noisy = [
      `${PREFIX}`,
      `${PREFIX}templates_2026.json`,
      `${PREFIX}templates_20261301.json`,
      `${PREFIX}templates_20260601.json`,
    ];
    expect(pickNewestFeedFile(noisy, 'templates')?.key).toBe(`${PREFIX}templates_20260601.json`);
  });
});
