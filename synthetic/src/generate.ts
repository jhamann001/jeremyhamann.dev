// Writes synthetic/out/universe.json. Run with: npm run generate -w synthetic
import { mkdirSync, writeFileSync } from 'node:fs';
import { buildUniverse, serialize } from './build.js';

const out = new URL('../out/', import.meta.url);
mkdirSync(out, { recursive: true });
const universe = buildUniverse();
writeFileSync(new URL('universe.json', out), serialize(universe));
console.log(
  `universe.json: ${universe.households.length} households, ${universe.people.length} people, ` +
    `${universe.accounts.length} accounts, ${universe.holdings.length} holdings`,
);
