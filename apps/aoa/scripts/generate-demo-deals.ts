/**
 * DEMO CSV generator (Phase Deals D4 — TDD ticket §7 step 3 / ADR-6).
 *
 *   npx tsx scripts/generate-demo-deals.ts --out /tmp/aoa-demo-deals.csv
 *
 * Writes the 24-row DEMO dataset (ALL INVENTED — the same fixture shape as the
 * D1 seed, DEMO- sf ids, realistic 6/3/1/10/4 stage spread, 2 unassigned LOST
 * rows, 2 prospect-shaped rows) as a CSV in the EXACT import format. This file
 * is the prod demo dataset AND the dress rehearsal: importing it exercises the
 * same CSV → validate → upsert path the real, gated export will use.
 *
 * The output is a RUNTIME artifact — never committed (the script refuses an
 * --out inside the repo). Every row is asserted through the frozen
 * validateDealInput before writing (the seed's posture).
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { validateDealInput } from "../lib/data/deal-validate";
import { demoDealCsvText, demoDealInputs } from "../lib/deals/demo-deals";

function argValue(flag: string): string | null {
  const idx = process.argv.indexOf(flag);
  return idx !== -1 && process.argv[idx + 1] ? process.argv[idx + 1] : null;
}

function fail(message: string): never {
  console.error(`ERROR: ${message}`);
  console.error(
    "Usage: npx tsx scripts/generate-demo-deals.ts --out </path/outside/repo/aoa-demo-deals.csv>",
  );
  process.exit(1);
}

const outArg = argValue("--out") ?? process.argv[2];
if (!outArg || outArg.startsWith("--")) fail("--out <path.csv> is required.");

const outPath = path.resolve(outArg);

// Runtime-path rule: generated datasets are never committed. Run from the
// repo root (the documented invocation).
const rel = path.relative(process.cwd(), outPath);
if (!rel.startsWith("..") && !path.isAbsolute(rel)) {
  fail(
    `--out resolves inside the repo (${rel}). Generated CSVs are runtime artifacts — write them outside the checkout (e.g. /tmp/aoa-demo-deals.csv).`,
  );
}

const inputs = demoDealInputs();
for (const input of inputs) {
  const check = validateDealInput(input);
  if (!check.ok) {
    fail(
      `demo row ${input.sf_deal_id} fails validateDealInput: ` +
        check.errors.map((e) => `${e.field}: ${e.message}`).join("; "),
    );
  }
}

writeFileSync(outPath, demoDealCsvText(), "utf8");
console.log(`Wrote ${inputs.length} DEMO deals (all invented, DEMO- sf ids) to:`);
console.log(`  ${outPath}`);
console.log(
  `Next: npx tsx scripts/import-deals.ts --file ${outPath} --dry-run   (see docs/deals-import-runbook.md, mode A)`,
);
