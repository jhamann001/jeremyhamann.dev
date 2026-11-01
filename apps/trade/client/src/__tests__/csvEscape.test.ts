import { describe, it, expect } from 'vitest';
import { csvEscape } from '../utils/csv';

describe('csvEscape', () => {
  it('wraps plain values in double quotes', () => {
    expect(csvEscape('hello')).toBe('"hello"');
  });

  it('escapes double quotes inside the value', () => {
    expect(csvEscape('say "hi"')).toBe('"say ""hi"""');
  });

  it('prefixes values starting with = to prevent formula injection', () => {
    expect(csvEscape('=SUM(A1:A10)')).toBe(`"'=SUM(A1:A10)"`);
  });

  it('prefixes values starting with + to prevent formula injection', () => {
    expect(csvEscape('+cmd|"...')).toBe(`"'+cmd|""..."`);
  });

  it('prefixes values starting with - to prevent formula injection', () => {
    expect(csvEscape('-1+1')).toBe(`"'-1+1"`);
  });

  it('prefixes values starting with @ to prevent formula injection', () => {
    expect(csvEscape('@SUM()')).toBe(`"'@SUM()"`);
  });

  it('prefixes values starting with tab character', () => {
    expect(csvEscape('\tdata')).toBe(`"'\tdata"`);
  });

  it('does not prefix normal text', () => {
    expect(csvEscape('Normal text')).toBe('"Normal text"');
  });

  it('handles empty string', () => {
    expect(csvEscape('')).toBe('""');
  });
});
