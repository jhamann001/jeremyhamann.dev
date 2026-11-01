import { readFileSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';

const SECRETS_DIR = '/secrets';

/**
 * Read a secret value, preferring a file mount at /secrets/<name>/secret
 * (Cloud Run volume mount) and falling back to the environment variable
 * (local dev).  Each secret gets its own subdirectory because Cloud Run
 * creates one volume per mount directory.
 */
export function readSecret(envKey: string, filePath?: string): string | undefined {
  const file = filePath ?? `${SECRETS_DIR}/${envKey}/secret`;
  try {
    return readFileSync(file, 'utf-8').trim();
  } catch {
    return process.env[envKey];
  }
}

/** Constant-time comparison of a presented secret with the expected one. False when either is missing. */
export function sameSecret(given: string | undefined, expected: string | undefined): boolean {
  if (!given || !expected) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
