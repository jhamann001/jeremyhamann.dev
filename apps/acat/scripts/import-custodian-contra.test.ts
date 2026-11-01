import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import {
  matchRecordToCard,
  planImport,
  buildData,
  type ContraRecord,
  type CardRef,
} from "./import-custodian-contra";
import { normalizeContra, ALIAS } from "../src/lib/contra-normalize";
import { demoFirms } from "../src/lib/demo/seed";
import { loadUniverse } from "../src/lib/demo/universe";

function makeRecord(overrides: Partial<ContraRecord> = {}): ContraRecord {
  return {
    contraFirm: "Test Firm",
    targetCustodianName: "Test Firm",
    dtcNumber: "0000",
    transferType: "ACAT_API",
    documentationStatus: "DOCUMENTED",
    signature: "DocuSign OK",
    letterOfAcceptance: "Not required",
    medallionRequired: "Not required",
    liquidationMethod: null,
    returnMethod: "N/A for a standard ACAT",
    paperworkOnFile: true,
    transfersToDate: 3,
    recentClients: "Smith, Jones",
    watchouts: "• first line\n  • second line",
    ...overrides,
  };
}

describe("matchRecordToCard", () => {
  it("matches an exact targetCustodianName (case-insensitive)", () => {
    const record = makeRecord({ targetCustodianName: "Fidelity" });
    const cards: CardRef[] = [
      { id: "a", name: "fidelity" },
      { id: "b", name: "Vanguard" },
    ];
    const match = matchRecordToCard(record, cards);
    expect(match?.id).toBe("a");
  });

  it("matches via the normalizeContra-equals leg (whitespace/case, NOT the ALIAS map)", () => {
    const record = makeRecord({ targetCustodianName: "Charles Schwab" });
    const card: CardRef = { id: "cs", name: "charles   SCHWAB" };
    // This name has no ALIAS entry — so the match must come from the
    // normalizeContra-equals leg, not the ALIAS-mapped form.
    expect(ALIAS[normalizeContra("Charles Schwab")]).toBeUndefined();
    expect(normalizeContra(card.name)).toBe(normalizeContra("Charles Schwab"));
    expect(matchRecordToCard(record, [card])?.id).toBe("cs");
  });

  it("matches via the ALIAS-map leg (variant the normalizer alone would miss)", () => {
    // Record side is the alias variant ("Sparrow Advisors"); card holds the canonical
    // "Sparrow Growth Funds". Plain normalizeContra would NOT equate them, so the
    // match can only come from the ALIAS map.
    const record = makeRecord({ targetCustodianName: "Sparrow Advisors" });
    const card: CardRef = { id: "spg", name: "Sparrow Growth Funds" };
    expect(normalizeContra("Sparrow Advisors")).not.toBe(normalizeContra("Sparrow Growth Funds"));
    expect(ALIAS[normalizeContra("Sparrow Advisors")]).toBe("Sparrow Growth Funds");
    expect(matchRecordToCard(record, [card])?.id).toBe("spg");
  });

  it("reports a record with no matching card as unmatched and never mints one", () => {
    const record = makeRecord({ targetCustodianName: "Ghost Custodian" });
    const cards: CardRef[] = [
      { id: "a", name: "Fidelity" },
      { id: "b", name: "Vanguard" },
    ];
    // Pure function: returning null is the "reported, not created" contract —
    // there is no prisma.create path here at all.
    expect(matchRecordToCard(record, cards)).toBeNull();
    const plan = planImport([record], cards);
    expect(plan.matched).toHaveLength(0);
    expect(plan.unmatched).toHaveLength(1);
    expect(plan.unmatched[0].targetCustodianName).toBe("Ghost Custodian");
  });
});

describe("planImport over the demo's custodian library", () => {
  // The demo has no contra-library export to import: the seed writes the playbook fields itself.
  // Its firms, written out as library records, check the crosswalk against the seeded cards.
  const firms = demoFirms(loadUniverse());
  const records: ContraRecord[] = firms
    .filter((f) => f.transferType && f.documentation && (f.signature || f.letterOfAcceptance || f.medallionRequired))
    .map((f) => ({
      contraFirm: f.name,
      targetCustodianName: f.name,
      dtcNumber: f.dtc,
      receivingAccountNumber: f.receivingAccountNumber ?? null,
      transferType: f.transferType!,
      documentationStatus: f.documentation!,
      signature: f.signature ?? null,
      letterOfAcceptance: f.letterOfAcceptance ?? null,
      medallionRequired: f.medallionRequired ?? null,
      liquidationMethod: f.liquidationMethod ?? null,
      returnMethod: f.returnMethod ?? null,
      paperworkOnFile: f.paperworkOnFile ?? null,
      transfersToDate: null,
      recentClients: null,
      watchouts: f.watchouts ?? null,
    }));
  const cards: CardRef[] = firms.map((f, i) => ({ id: `c${i}`, name: f.name }));

  it("matches every library record to its seeded card and names the cards without one", () => {
    expect(records.length).toBeGreaterThan(5);
    const plan = planImport(records, cards);
    expect(plan.unmatched).toEqual([]);
    expect(plan.matched).toHaveLength(records.length);
    expect(plan.noContra).toContain("Apex");
    expect(plan.noContra).toEqual(
      cards.map((c) => c.name).filter((name) => !records.some((r) => r.targetCustodianName === name)).sort()
    );
  });

  it("matches a library name the cards spell differently, through the alias map", () => {
    const sparrow = records.find((r) => r.targetCustodianName === "Sparrow Growth Funds")!;
    const plan = planImport([{ ...sparrow, contraFirm: "Sparrow Advisors", targetCustodianName: "Sparrow Advisors" }], cards);
    expect(plan.matched.map((m) => m.card.name)).toEqual(["Sparrow Growth Funds"]);
  });

  it("ships the Victory receiving account as a structured library field", () => {
    const migration = readFileSync(
      "prisma/migrations/20260904173000_add_custodian_receiving_account_number/migration.sql",
      "utf8"
    );

    expect(migration).toContain(
      'ALTER TABLE "Custodian" ADD COLUMN "receivingAccountNumber" TEXT'
    );
    expect(migration).toContain(
      '"receivingAccountNumber" = \'DEMOOMNI01\''
    );
  });
});

describe("buildData", () => {
  it("identity-maps all 12 playbook fields (incl. transfersToDate/recentClients)", () => {
    const record = makeRecord({
      dtcNumber: "0164",
      transferType: "MIXED",
      documentationStatus: "DOCUMENTED",
      paperworkOnFile: false,
      transfersToDate: 21,
      recentClients: "Browning, Dodd, Lindell",
      watchouts: null,
    });
    expect(buildData(record)).toEqual({
      dtcNumber: "0164",
      transferType: "MIXED",
      documentationStatus: "DOCUMENTED",
      signature: "DocuSign OK",
      letterOfAcceptance: "Not required",
      medallionRequired: "Not required",
      liquidationMethod: null,
      returnMethod: "N/A for a standard ACAT",
      watchouts: null,
      paperworkOnFile: false,
      transfersToDate: 21,
      recentClients: "Browning, Dodd, Lindell",
    });
  });
});
