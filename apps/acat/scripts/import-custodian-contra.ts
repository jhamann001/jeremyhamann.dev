/**
 * ticket one-time importer: fold the 29 Notion Contra Library records
 * (prisma/migration-data/custodian-contra.json) onto the matching Custodian
 * cards, populating the new transfer-playbook fields.
 *
 * Defaults to DRY RUN; pass --apply to actually write. Mirrors the dry-run/tx
 * discipline of scripts/apply-csv-to-prod.ts:
 *   - own PrismaClient bound to an explicit DB URL
 *     (DATABASE_URL for dry-run, PROD_DATABASE_URL for --apply),
 *   - a full plan printed before any write,
 *   - writes wrapped in a single $transaction.
 *
 * Matching is exact `targetCustodianName` (case-insensitive) with the shared
 * pure normalizer (normalizeContra + ALIAS) as a SECONDARY fallback. The
 * importer NEVER creates a custodian (unlike custodian-resolve's mint path) —
 * unmatched records are reported, not minted.
 *
 * No AuditLog rows are written: AuditLog.acatRecordId is a non-null FK to
 * AcatRecord, and this importer writes to Custodian, so the console plan is the
 * audit trail (see the plan's refinement note).
 */
import { PrismaClient } from "@prisma/client";
import { readFileSync } from "fs";
import { resolve } from "path";
import { pathToFileURL } from "url";
import { normalizeContra, ALIAS } from "../src/lib/contra-normalize";

export interface ContraRecord {
  contraFirm: string;
  targetCustodianName: string;
  dtcNumber: string | null;
  receivingAccountNumber?: string | null;
  transferType: "ACAT_API" | "MANUAL" | "MIXED" | "INTERNAL" | "UNCONFIRMED";
  documentationStatus: "DOCUMENTED" | "PARTIAL" | "NEEDS_CALL";
  signature: string | null;
  letterOfAcceptance: string | null;
  medallionRequired: string | null;
  liquidationMethod: string | null;
  returnMethod: string | null;
  paperworkOnFile: boolean | null;
  transfersToDate: number | null;
  recentClients: string | null;
  watchouts: string | null;
}

export interface CardRef {
  id: string;
  name: string;
}

/**
 * Resolve one contra record to a Custodian card.
 *   1. Primary: exact case-insensitive equality of targetCustodianName vs card.name.
 *   2. Secondary: normalized-equals — compare normalizeContra(targetCustodianName),
 *      and its ALIAS-mapped-then-normalized form, against normalizeContra(card.name).
 * Returns the matched card, or null when no card matches (never creates one).
 */
export function matchRecordToCard(
  record: ContraRecord,
  cards: CardRef[]
): CardRef | null {
  // 1. Primary: exact, case-insensitive.
  const target = record.targetCustodianName.trim();
  const exact = cards.find(
    (c) => c.name.trim().toLowerCase() === target.toLowerCase()
  );
  if (exact) return exact;

  // 2. Secondary: normalized-equals + ALIAS-mapped form.
  const recNorm = normalizeContra(target);
  const aliasTarget = ALIAS[recNorm];
  const aliasNorm = aliasTarget ? normalizeContra(aliasTarget) : null;
  const fallback = cards.find((c) => {
    const n = normalizeContra(c.name);
    return n === recNorm || (aliasNorm !== null && n === aliasNorm);
  });
  return fallback ?? null;
}

export interface ImportPlan {
  matched: { record: ContraRecord; card: CardRef }[];
  unmatched: ContraRecord[];
  /** Card names not targeted by any matched record (the "no contra" cards). */
  noContra: string[];
}

/** Build the import plan (pure — no DB). */
export function planImport(records: ContraRecord[], cards: CardRef[]): ImportPlan {
  const matched: { record: ContraRecord; card: CardRef }[] = [];
  const unmatched: ContraRecord[] = [];
  const matchedCardIds = new Set<string>();

  for (const record of records) {
    const card = matchRecordToCard(record, cards);
    if (card) {
      matched.push({ record, card });
      matchedCardIds.add(card.id);
    } else {
      unmatched.push(record);
    }
  }

  const noContra = cards
    .filter((c) => !matchedCardIds.has(c.id))
    .map((c) => c.name)
    .sort();

  return { matched, unmatched, noContra };
}

/** Identity-map a record's playbook fields to the Custodian update payload. */
export function buildData(record: ContraRecord): Record<string, unknown> {
  return {
    dtcNumber: record.dtcNumber,
    ...(record.receivingAccountNumber !== undefined
      ? { receivingAccountNumber: record.receivingAccountNumber }
      : {}),
    transferType: record.transferType,
    documentationStatus: record.documentationStatus,
    signature: record.signature,
    letterOfAcceptance: record.letterOfAcceptance,
    medallionRequired: record.medallionRequired,
    liquidationMethod: record.liquidationMethod,
    returnMethod: record.returnMethod,
    watchouts: record.watchouts,
    paperworkOnFile: record.paperworkOnFile,
    transfersToDate: record.transfersToDate,
    recentClients: record.recentClients,
  };
}

// Resolved from the repo root (cwd) — the convention used by the other scripts
// (apply-csv-to-prod.ts) and stable under both `tsx` and vitest.
const DATA_PATH = resolve(
  process.cwd(),
  "prisma/migration-data/custodian-contra.json"
);

export function loadRecords(): ContraRecord[] {
  return JSON.parse(readFileSync(DATA_PATH, "utf8")) as ContraRecord[];
}

async function main() {
  const apply = process.argv.includes("--apply");
  const dbUrl = apply ? process.env.PROD_DATABASE_URL : process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error(
      apply
        ? "PROD_DATABASE_URL must be set to --apply"
        : "DATABASE_URL must be set for the dry-run"
    );
    process.exit(1);
  }

  const records = loadRecords();
  const prisma = new PrismaClient({ datasourceUrl: dbUrl });

  try {
    const dbCards = await prisma.custodian.findMany({
      select: {
        id: true, name: true,
        dtcNumber: true, transferType: true, documentationStatus: true,
        receivingAccountNumber: true,
        signature: true, letterOfAcceptance: true, medallionRequired: true,
        liquidationMethod: true, returnMethod: true, watchouts: true,
        paperworkOnFile: true, transfersToDate: true, recentClients: true,
      },
    });
    const cards: CardRef[] = dbCards.map((c) => ({ id: c.id, name: c.name }));
    const plan = planImport(records, cards);

    // Re-run safety: flag matched cards that ALREADY hold playbook data, so a
    // human re-running --apply after manual edits sees exactly what will be
    // overwritten. A clean first import onto empty cards prints none.
    const PLAYBOOK_KEYS = [
      "dtcNumber", "transferType", "documentationStatus", "signature",
      "receivingAccountNumber",
      "letterOfAcceptance", "medallionRequired", "liquidationMethod",
      "returnMethod", "watchouts", "paperworkOnFile", "transfersToDate",
      "recentClients",
    ] as const;
    const dbById = new Map(
      dbCards.map((c) => [c.id, c as Record<string, unknown>])
    );
    const overwrites = plan.matched
      .map(({ card }) => {
        const row = dbById.get(card.id) ?? {};
        const populated = PLAYBOOK_KEYS.filter(
          (k) => row[k] !== null && row[k] !== undefined
        );
        return { name: card.name, populated };
      })
      .filter((o) => o.populated.length > 0);

    console.log("=".repeat(80));
    console.log(
      apply ? "CONTRA IMPORT (will write)" : "CONTRA IMPORT (DRY RUN — no writes)"
    );
    console.log("=".repeat(80));
    console.log(`Records in JSON: ${records.length}`);
    console.log(`Custodian cards in DB: ${cards.length}`);
    console.log(`Matched: ${plan.matched.length}`);
    console.log(`Unmatched: ${plan.unmatched.length}`);
    console.log("");

    console.log("Matched (contraFirm → card):");
    for (const { record, card } of plan.matched) {
      console.log(
        `  ${record.contraFirm.padEnd(48)} → ${card.name.padEnd(40)} ` +
          `DTC ${String(record.dtcNumber ?? "—").padEnd(28)} ` +
          `${record.transferType.padEnd(12)} ${record.documentationStatus}`
      );
    }
    console.log("");

    if (plan.unmatched.length > 0) {
      console.log("UNMATCHED (no card — reported, NOT created):");
      for (const r of plan.unmatched) {
        console.log(`  ${r.contraFirm}  (targetCustodianName: ${r.targetCustodianName})`);
      }
      console.log("");
    } else {
      console.log("Unmatched: none.");
      console.log("");
    }

    console.log(`Cards that will remain WITHOUT contra data (${plan.noContra.length}):`);
    for (const name of plan.noContra) {
      console.log(`  ${name}`);
    }
    console.log("");

    if (overwrites.length > 0) {
      console.log(
        `⚠ ${overwrites.length} matched card(s) ALREADY have playbook data — ` +
          `--apply will OVERWRITE the fields the JSON sets. Review before applying:`
      );
      for (const o of overwrites) {
        console.log(`  ${o.name.padEnd(40)} ${o.populated.join(", ")}`);
      }
      console.log("");
    } else {
      console.log(
        "No matched card has pre-existing playbook data (clean first import)."
      );
      console.log("");
    }

    if (!apply) {
      console.log("DRY RUN — no writes. Re-run with --apply to execute.");
      return;
    }

    console.log("Applying...");
    await prisma.$transaction(
      plan.matched.map(({ record, card }) =>
        prisma.custodian.update({
          where: { id: card.id },
          data: buildData(record),
        })
      )
    );
    console.log(`Done. ${plan.matched.length} custodian cards updated.`);
  } finally {
    await prisma.$disconnect();
  }
}

// Only run the DB flow when invoked directly (not when imported by tests).
const invokedDirectly =
  !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
