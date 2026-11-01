import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('../../', import.meta.url));
const ENGINE_SPECIFIER = /['"][^'"]*assetLocationEngine(?:\.js)?['"]/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sourceFiles(full);
    return entry.name.endsWith('.ts') ? [full] : [];
  });
}

describe('asset location engine import guard', () => {
  it('only the engine-use module, the archived registry and the demo seed import the engine', () => {
    const importers = sourceFiles(SRC)
      .filter((file) => ENGINE_SPECIFIER.test(readFileSync(file, 'utf8')))
      .map((file) => path.relative(SRC, file).split(path.sep).join('/'))
      .sort();
    // The demo seed builds the stored plans of its fixture requests directly: those runs are data setup, not
    // engine use, and counting them would fill the usage report the reset has just cleared.
    expect(importers).toEqual(['db/demoSeed.ts', 'services/engineUse.ts', 'services/meridianRegistry.ts']);
  });
});
