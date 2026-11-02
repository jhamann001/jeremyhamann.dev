// The DEMO dataset (Phase Deals D4, TDD ticket §7 step 3 / ADR-6) — ALL
// INVENTED, no real client data. These are the SAME 24 rows as the D1 seed
// (`prisma/seed.ts` DEALS — same DEMO-0001…0024 sf ids, names, amounts): the
// TDD locks "the D4 demo CSV generator reuses this same fixture shape so local
// dev and the prod demo stay coherent". prisma/seed.ts is frozen and does not
// export its fixtures, so the rows are re-declared here; if the seed's DEALS
// ever change, change this file in the same PR.
//
// The generated CSV is the prod demo dataset AND the dress rehearsal of the
// real, gated import — it flows through the exact same recordsFromCsv →
// mapReportRow → validateDealInput → upsert path the real CSV will use.
//
// Shape (TDD §7): stage split 6/3/1/10/4 · 2 unassigned rows (both LOST —
// mirrors the real pattern) · 2 null cedar_ridge_user_id (prospect-shaped) ·
// parseable "<Client> - <Firm> - <Account Type> - <last4>" names.

import type { DealInput, DealStage } from "@/lib/data/deal-types";
import { REPORT_HEADERS, toCsv } from "./import-csv";

export const DEMO_SF_ID_PREFIX = "DEMO-";

const HOUSEHOLDS: Record<string, string> = {
  "HH-1001": "Stone Family Trust",
  "HH-1002": "Nguyen Household",
  "HH-1003": "Okafor Household",
  "HH-2001": "Walker Household",
  "HH-2002": "Patel Family",
};

const OWNERS = {
  A: { name: "Avery Stone", sf: "ADV-AVERY" },
  B: { name: "Gwen Kuhlman", sf: "ADV-BLAKE" },
} as const;

// Raw CRM provenance (invented labels — the real report's raw "Stage"
// column is coarser than the curated five-stage enum, ADR-3).
const STAGE_RAW: Record<DealStage, string> = {
  POTENTIAL: "Open",
  COMMITTED: "Open",
  FUNDING: "Open",
  WON: "Closed Won",
  LOST: "Closed Lost",
};

// The curated "AoA - New Stage" label as the report carries it — the TKT
// relabel vocabulary (matches STAGE_LABEL in lib/data/deal-types.ts), so the
// generated demo CSV is a faithful dress rehearsal of the real gated export.
const STAGE_LABEL_CSV: Record<DealStage, string> = {
  POTENTIAL: "Potential",
  COMMITTED: "Potential-Committed",
  FUNDING: "Potential-In Process",
  WON: "Funded",
  LOST: "Lost",
};

type DemoDeal = {
  n: number; // -> sf_deal_id DEMO-000n
  first: string;
  last: string;
  hh: keyof typeof HOUSEHOLDS & string;
  firm: string;
  acct: string;
  last4: string;
  amount: number;
  stage: DealStage;
  created: string;
  close?: string;
  owner?: keyof typeof OWNERS;
  secondary?: string;
  eu?: string;
  personAum?: number;
  potentialAum?: number;
  statements?: boolean;
  lastActivity?: string;
};

// Mirrors prisma/seed.ts DEALS exactly (see header note).
const DEALS: DemoDeal[] = [
  // POTENTIAL (6) — incl. the 2 prospect-shaped rows (no cedar_ridge_user_id).
  { n: 1, first: "Sam", last: "Stone", hh: "HH-1001", firm: "Fidelity", acct: "Roth IRA", last4: "5349", amount: 85000, stage: "POTENTIAL", created: "2026-05-18", close: "2026-08-15", owner: "A", eu: "EU-1001", personAum: 900000, potentialAum: 150000 },
  { n: 2, first: "Minh", last: "Nguyen", hh: "HH-1002", firm: "Vanguard", acct: "Traditional IRA", last4: "8277", amount: 150000, stage: "POTENTIAL", created: "2026-06-02", owner: "A", eu: "EU-1003", personAum: 1180000 },
  { n: 3, first: "Tomi", last: "Okafor", hh: "HH-1003", firm: "Empower", acct: "401(k) Rollover", last4: "9452", amount: 310000, stage: "POTENTIAL", created: "2026-06-10", close: "2026-09-30", owner: "A", potentialAum: 500000 },
  { n: 4, first: "Neil", last: "Walker", hh: "HH-2001", firm: "Schwab", acct: "Joint", last4: "2481", amount: 95000, stage: "POTENTIAL", created: "2026-05-27", owner: "B", eu: "EU-2001", personAum: 2100000 },
  { n: 5, first: "Abagail", last: "Patel", hh: "HH-2002", firm: "Betterment", acct: "Individual", last4: "2026", amount: 47500, stage: "POTENTIAL", created: "2026-06-15", close: "2026-08-01", owner: "B", potentialAum: 90000 },
  { n: 6, first: "Jo", last: "Stone", hh: "HH-1001", firm: "Schwab", acct: "Individual", last4: "2275", amount: 42000, stage: "POTENTIAL", created: "2026-06-20", close: "2026-07-31", owner: "A", secondary: "Gwen Kuhlman", eu: "EU-1002" },
  // COMMITTED (3)
  { n: 7, first: "Asha", last: "Patel", hh: "HH-2002", firm: "Fidelity", acct: "Roth IRA", last4: "5063", amount: 120000, stage: "COMMITTED", created: "2026-04-22", close: "2026-07-15", owner: "B", secondary: "Avery Stone", eu: "EU-2002", personAum: 1540000 },
  { n: 8, first: "Ada", last: "Okafor", hh: "HH-1003", firm: "Vanguard", acct: "SEP IRA", last4: "0801", amount: 210000, stage: "COMMITTED", created: "2026-05-05", close: "2026-07-20", owner: "A", eu: "EU-1004", personAum: 875000 },
  { n: 9, first: "Sam", last: "Stone", hh: "HH-1001", firm: "Merrill", acct: "Trust", last4: "2072", amount: 560000, stage: "COMMITTED", created: "2026-04-30", close: "2026-07-10", owner: "A", secondary: "Gwen Kuhlman", eu: "EU-1001", personAum: 900000, potentialAum: 700000 },
  // FUNDING (1)
  { n: 10, first: "Neil", last: "Walker", hh: "HH-2001", firm: "Pershing", acct: "Inherited IRA", last4: "3868", amount: 275000, stage: "FUNDING", created: "2026-04-08", close: "2026-07-05", owner: "B", eu: "EU-2001", personAum: 2100000, lastActivity: "2026-06-28" },
  // WON (10)
  { n: 11, first: "Sam", last: "Stone", hh: "HH-1001", firm: "Fidelity", acct: "Traditional IRA", last4: "0322", amount: 180000, stage: "WON", created: "2026-01-12", close: "2026-02-28", owner: "A", eu: "EU-1001" },
  { n: 12, first: "Jo", last: "Stone", hh: "HH-1001", firm: "Schwab", acct: "Roth IRA", last4: "7746", amount: 64000, stage: "WON", created: "2026-01-25", close: "2026-03-10", owner: "A", secondary: "Gwen Kuhlman", eu: "EU-1002" },
  { n: 13, first: "Minh", last: "Nguyen", hh: "HH-1002", firm: "Vanguard", acct: "Individual", last4: "5658", amount: 230000, stage: "WON", created: "2026-02-03", close: "2026-03-20", owner: "A", eu: "EU-1003" },
  { n: 14, first: "Minh", last: "Nguyen", hh: "HH-1002", firm: "Fidelity", acct: "401(k) Rollover", last4: "0571", amount: 410000, stage: "WON", created: "2026-02-14", close: "2026-04-15", owner: "A", eu: "EU-1003", personAum: 1180000 },
  { n: 15, first: "Ada", last: "Okafor", hh: "HH-1003", firm: "Schwab", acct: "Joint", last4: "0175", amount: 88000, stage: "WON", created: "2026-03-01", close: "2026-04-22", owner: "A", eu: "EU-1004" },
  { n: 16, first: "Neil", last: "Walker", hh: "HH-2001", firm: "Fidelity", acct: "Individual", last4: "1266", amount: 520000, stage: "WON", created: "2026-01-08", close: "2026-02-14", owner: "B", secondary: "Avery Stone", eu: "EU-2001", personAum: 2100000 },
  { n: 17, first: "Neil", last: "Walker", hh: "HH-2001", firm: "Vanguard", acct: "Roth IRA", last4: "8776", amount: 76000, stage: "WON", created: "2026-03-11", close: "2026-05-01", owner: "B", eu: "EU-2001" },
  { n: 18, first: "Asha", last: "Patel", hh: "HH-2002", firm: "Schwab", acct: "Traditional IRA", last4: "9794", amount: 145000, stage: "WON", created: "2026-02-20", close: "2026-04-05", owner: "B", eu: "EU-2002" },
  { n: 19, first: "Asha", last: "Patel", hh: "HH-2002", firm: "Empower", acct: "401(k) Rollover", last4: "7532", amount: 390000, stage: "WON", created: "2026-03-18", close: "2026-05-29", owner: "B", eu: "EU-2002", lastActivity: "2026-05-29" },
  { n: 20, first: "Ravi", last: "Patel", hh: "HH-2002", firm: "Fidelity", acct: "Joint", last4: "7753", amount: 205000, stage: "WON", created: "2026-04-02", close: "2026-06-12", owner: "B", secondary: "Avery Stone", eu: "EU-2003" },
  // LOST (4) — incl. the 2 unassigned rows (no owner — mirrors the real
  // pattern: every unassigned deal in the real file is LOST).
  { n: 21, first: "Jo", last: "Stone", hh: "HH-1001", firm: "Betterment", acct: "Individual", last4: "1034", amount: 38000, stage: "LOST", created: "2026-02-09", close: "2026-03-30", owner: "A", eu: "EU-1002", statements: false },
  { n: 22, first: "Minh", last: "Nguyen", hh: "HH-1002", firm: "Merrill", acct: "Trust", last4: "8018", amount: 290000, stage: "LOST", created: "2026-01-30", close: "2026-03-15", owner: "A", eu: "EU-1003" },
  { n: 23, first: "Kai", last: "Walker", hh: "HH-2001", firm: "Schwab", acct: "Individual", last4: "9426", amount: 54000, stage: "LOST", created: "2026-02-25", close: "2026-04-10", eu: "EU-2004", statements: false },
  { n: 24, first: "Devi", last: "Patel", hh: "HH-2002", firm: "Pershing", acct: "Roth IRA", last4: "2697", amount: 61000, stage: "LOST", created: "2026-03-09", close: "2026-04-28", eu: "EU-2005" },
];

function toDealInput(d: DemoDeal): DealInput {
  const owner = d.owner ? OWNERS[d.owner] : null;
  return {
    source: "IMPORT",
    sf_deal_id: `${DEMO_SF_ID_PREFIX}${String(d.n).padStart(4, "0")}`,
    name: `${d.first} ${d.last} - ${d.firm} - ${d.acct} - ${d.last4}`,
    client_first_name: d.first,
    client_last_name: d.last,
    household_name: HOUSEHOLDS[d.hh],
    household_sf_id: d.hh,
    // The demo dataset mirrors the frozen prisma/seed.ts DEALS, which carry no
    // per-client linkage — and the generated demo CSV omits the "Person:
    // Contact ID" column, so the recordsFromCsv → mapReportRow round trip yields
    // null here. Explicit null keeps that round trip (demoDealInputs === mapped)
    // exact (tkt-deals-client-link).
    client_sf_id: null,
    amount: d.amount,
    stage: d.stage,
    stage_raw: STAGE_RAW[d.stage],
    created_date: d.created,
    close_date: d.close ?? null,
    last_activity_date: d.lastActivity ?? null,
    owner_name: owner?.name ?? null,
    owner_sf_user_id: owner?.sf ?? null,
    secondary_owner: d.secondary ?? null,
    person_aum: d.personAum ?? null,
    potential_aum: d.potentialAum ?? null,
    cedar_ridge_user_id: d.eu ?? null,
    statements: d.statements ?? true,
    plaid_linked: false, // "no for everyone right now"
    account_last4: d.last4,
    account_type: d.acct,
    transferring_firm: d.firm,
  };
}

/** The 24 demo rows as validated-shape DealInputs (tests + generator). */
export function demoDealInputs(): DealInput[] {
  return DEALS.map(toDealInput);
}

/** The demo dataset as CSV text in the EXACT import format (canonical headers). */
export function demoDealCsvText(): string {
  const headers = [
    REPORT_HEADERS.sfDealId[0],
    REPORT_HEADERS.name[0],
    REPORT_HEADERS.firstName[0],
    REPORT_HEADERS.lastName[0],
    REPORT_HEADERS.householdName[0],
    REPORT_HEADERS.householdSfId[0],
    REPORT_HEADERS.amount[0],
    REPORT_HEADERS.stage[0],
    REPORT_HEADERS.stageRaw[0],
    REPORT_HEADERS.createdDate[0],
    REPORT_HEADERS.closeDate[0],
    REPORT_HEADERS.lastActivityDate[0],
    REPORT_HEADERS.ownerName[0],
    REPORT_HEADERS.ownerSfUserId[0],
    REPORT_HEADERS.secondaryOwner[0],
    REPORT_HEADERS.personAum[0],
    REPORT_HEADERS.potentialAum[0],
    REPORT_HEADERS.cedarRidgeUserId[0],
    REPORT_HEADERS.statements[0],
    REPORT_HEADERS.plaidLinked[0],
  ];
  const rows: string[][] = [headers];
  for (const input of demoDealInputs()) {
    rows.push([
      input.sf_deal_id ?? "",
      input.name,
      input.client_first_name,
      input.client_last_name,
      input.household_name ?? "",
      input.household_sf_id ?? "",
      String(input.amount),
      STAGE_LABEL_CSV[input.stage],
      input.stage_raw ?? "",
      input.created_date,
      input.close_date ?? "",
      input.last_activity_date ?? "",
      input.owner_name ?? "",
      input.owner_sf_user_id ?? "",
      input.secondary_owner ?? "",
      input.person_aum == null ? "" : String(input.person_aum),
      input.potential_aum == null ? "" : String(input.potential_aum),
      input.cedar_ridge_user_id ?? "",
      input.statements ? "Yes" : "No",
      input.plaid_linked ? "Yes" : "No",
    ]);
  }
  return toCsv(rows);
}
