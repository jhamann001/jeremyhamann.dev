import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const IMPORT_RE = /(?:import|export)\s+(?:type\s+)?(?:[^'";]*?\sfrom\s+)?['"](\.{1,2}\/[^'"]+)['"]/g;

function closure(entry: string): string[] {
  const seen = new Set<string>();
  const stack = [path.join(SRC, entry)];
  while (stack.length) {
    const file = stack.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const m of fs.readFileSync(file, 'utf8').matchAll(IMPORT_RE)) {
      const target = path.resolve(path.dirname(file), m[1].replace(/\.js$/, '.ts'));
      if (fs.existsSync(target)) stack.push(target);
    }
  }
  return [...seen].map((f) => path.relative(SRC, f)).sort();
}

const FORBIDDEN = [
  'services/meridianRegistry.ts',
  'services/registryDrift.ts',
  'services/registryDriftAlert.ts',
  'services/assetLocationEngine.ts',
];

// The modules the weekday drift check may load: Warehouse, the Meridian feed readers, the drift settings,
// override and result stores, and their pure helpers. This list is also the port manifest for ticket.
const ALLOWED = [
  'data/fundCategory.ts',
  'data/instruments.ts',
  'data/sicToSector.ts',
  'lib/logger.ts',
  'lib/secrets.ts',
  'services/meridianActiveAccounts.ts',
  'services/meridianS3.ts',
  'services/meridianSnapshot.ts',
  'services/meridianTemplates.ts',
  'services/meridianTransitions.ts',
  'services/costBasisEnrichment.ts',
  'services/costBasisFreshness.ts',
  'services/costBasisFreshnessAlert.ts',
  'services/digest.ts',
  'services/driftContract.ts',
  'services/driftStatusOverrides.ts',
  'services/householdConfig.ts',
  'services/warehouse.ts',
  'services/positionDrift.ts',
  'services/positionDriftAccounts.ts',
  'services/positionDriftAccountsAlert.ts',
  'services/positionDriftAccountsPersistence.ts',
  'services/registryDriftAllowList.ts',
  'services/registryDriftRunner.ts',
  'services/sectorAllocation.ts',
  'services/securitySector.ts',
  'services/serviceModeState.ts',
  'services/slack.ts',
].sort();

describe('drift check import graph', () => {
  it('excludes the execution-plan registry modules and the asset location engine', () => {
    expect(closure('services/registryDriftRunner.ts').filter((m) => FORBIDDEN.includes(m))).toEqual([]);
  });
  it('loads exactly the drift-owned module set', () => {
    expect(closure('services/registryDriftRunner.ts')).toEqual(ALLOWED);
  });
  it('keeps the household comparator free of the registry modules', () => {
    expect(closure('services/positionDrift.ts').filter((m) => FORBIDDEN.includes(m))).toEqual([]);
  });
});
