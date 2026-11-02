/**
 * Synthetic local seed — NO real client PII. Safe to run repeatedly (idempotent).
 *
 * Writes two data classes through two roles, mirroring production:
 *   - app.User   via the owner role (aoa / DIRECT_DATABASE_URL)
 *   - mirror.*   via the ingest role (ingest_rw) — this is how n8n will write it,
 *     and the only role allowed past the forced RLS on the mirror tables.
 *
 * Personas let you exercise RLS with the dev login:
 *   ADMIN / OPERATIONS  -> see the whole firm
 *   ADVISOR             -> see only their own book of business
 */
import { PrismaClient, Role } from "@prisma/client";
import type { DealInput } from "../lib/data/deal-types";
import { validateDealInput } from "../lib/data/deal-validate";
import {
  DEFAULT_TASKS,
  type TransferAccountStatus,
  type TransferDecisionChoice,
  type TransferInput,
  type TransferStage,
} from "../lib/data/transfer-types";
import { validateTransferInput } from "../lib/data/transfer-validate";
import { FIRM_HOUSEHOLD_ID } from "../lib/data/firm-household";
import { DEV_ASSET_MAP_FIXTURE } from "./fixtures/asset-map";
import { PERSONAS } from "../lib/demo/personas";

const directUrl = process.env.DIRECT_DATABASE_URL;
if (!directUrl) throw new Error("DIRECT_DATABASE_URL is required to seed.");

// app-owned data, written as the owner role.
const owner = new PrismaClient({ datasourceUrl: directUrl });
// mirror data, written as the ingestion role (only role past forced RLS).
const ingestUrl =
  process.env.SEED_INGEST_URL ?? directUrl.replace("://aoa@", "://ingest_rw@");
const ingest = new PrismaClient({ datasourceUrl: ingestUrl });

type Persona = { email: string; name: string; role: Role };

const STAFF: Persona[] = [
  { email: "admin@example.com", name: "Dana Admin", role: Role.ADMIN },
  { email: "ops@example.com", name: "Riley Ops", role: Role.OPERATIONS },
  { email: "avery@example.com", name: "Avery Stone", role: Role.ADVISOR },
  { email: "blake@example.com", name: "Gwen Kuhlman", role: Role.ADVISOR },
  { email: "view@example.com", name: "Val Viewer", role: Role.VIEWER },
  // The public demo's personas (lib/demo/personas.ts). Their books arrive with the universe seed.
  ...PERSONAS.map((p) => ({ email: p.email, name: p.name, role: Role[p.role] })),
];

// Two advisors with books of business; the rest is scoped against these.
const ADVISORS = [
  { sfId: "ADV-AVERY", name: "Avery Stone", email: "avery@example.com", title: "Financial Advisor" },
  { sfId: "ADV-BLAKE", name: "Gwen Kuhlman", email: "blake@example.com", title: "Financial Advisor" },
];

// `stage` mirrors Salesforce Entity_Client_Stage__c. A deliberate mix across all
// four lifecycle values so the Households stage filter/sort is exercisable in dev
// (synthetic data — no real client). Prospect/Lost rows keep an `aum` here, which
// also exercises the "Client AUM sums Clients only" KPI.
const HOUSEHOLDS = [
  { sfId: "HH-1001", name: "Stone Family Trust", lead: "avery@example.com", aum: 2450000, stage: "Client" },
  { sfId: "HH-1002", name: "Nguyen Household", lead: "avery@example.com", aum: 1180000, stage: "Client" },
  { sfId: "HH-1003", name: "Okafor Household", lead: "avery@example.com", aum: 875000, stage: "Prospect" },
  { sfId: "HH-2001", name: "Walker Household", lead: "blake@example.com", aum: 3320000, stage: "Lost Client" },
  { sfId: "HH-2002", name: "Patel Family", lead: "blake@example.com", aum: 1540000, stage: "Lost Prospect" },
];

const CLIENTS = [
  { sfId: "C-1", hh: "HH-1001", first: "Sam", last: "Stone" },
  { sfId: "C-2", hh: "HH-1001", first: "Jo", last: "Stone" },
  { sfId: "C-3", hh: "HH-1002", first: "Minh", last: "Nguyen" },
  { sfId: "C-4", hh: "HH-1003", first: "Ada", last: "Okafor" },
  { sfId: "C-5", hh: "HH-2001", first: "Neil", last: "Walker" },
  { sfId: "C-6", hh: "HH-2002", first: "Asha", last: "Patel" },
];

// ticket — synthetic per-account AUM (mirror.client_account_aum), keyed on a
// custodian ULID. Values are chosen so the local Households KPIs reproduce the
// validated parity numbers: Client AUM $25,248,316.42, Firm AUM $87,604.38,
// Total AUM $25,335,920.80 (ties to "Apex"). NO real client data.
//   • 6 client accounts (one per seed client) → their households.
//   • 4 firm corporate accounts → tagged with household_sf_id = the FIRM-CEDAR-RIDGE
//     sentinel. The Cedar Ridge Wealth household itself is NOT a mirror.household row
//     — it's app-synthetic (injected by listHouseholds from lib/data/firm-household).
//     In prod the live feed sets this sentinel by OVERRIDING the card's NULL household.
//   • 2 unlinked $0 accounts (no client, no household) → contribute $0, belong
//     nowhere (requirement 6).
const AS_OF = "2026-07-13T00:00:00.000Z";
const ACCOUNT_AUM = [
  // client accounts (custodian ULID, apex #, client, household, aum)
  { cust: "01SEEDCLIENTACCT0000000001", apex: "APX-C1-01", client: "C-1", hh: "HH-1001", type: "Individual", aum: 12000000.0 },
  { cust: "01SEEDCLIENTACCT0000000002", apex: "APX-C2-01", client: "C-2", hh: "HH-1001", type: "Roth IRA", aum: 3000000.0 },
  { cust: "01SEEDCLIENTACCT0000000003", apex: "APX-C3-01", client: "C-3", hh: "HH-1002", type: "Traditional IRA", aum: 6000000.0 },
  { cust: "01SEEDCLIENTACCT0000000004", apex: "APX-C4-01", client: "C-4", hh: "HH-1003", type: "Joint", aum: 2500000.0 },
  { cust: "01SEEDCLIENTACCT0000000005", apex: "APX-C5-01", client: "C-5", hh: "HH-2001", type: "Individual", aum: 1500000.0 },
  { cust: "01SEEDCLIENTACCT0000000006", apex: "APX-C6-01", client: "C-6", hh: "HH-2002", type: "SEP IRA", aum: 248316.42 },
] as const;
// The 4 firm corporate accounts (real ULIDs + titles). No apex #, no client.
const FIRM_ACCOUNTS = [
  { cust: "01SYNTH6BDYNAGTJ07KC0SFYGY", type: "Fee Account", aum: 40000.0 },
  { cust: "01SYNTH69JZYE3TD78SPZ4PBWK", type: "Deposit Account", aum: 30000.0 },
  { cust: "01SYNTH1B11MYXFS3Q5B5D2WNW", type: "Error Account", aum: 7604.38 },
  { cust: "01SYNTH85BR7BT1ZPYKBDZAC9C", type: "Allocation Account", aum: 10000.0 },
] as const;
// Unlinked $0 accounts — no client, no household (requirement 6).
const UNLINKED_ACCOUNTS = [
  { cust: "01SEEDUNLINKED000000000001", apex: "APX-U1-01" },
  { cust: "01SEEDUNLINKED000000000002", apex: "APX-U2-01" },
] as const;

async function seedAssetMapFixture(): Promise<void> {
  const fixture = DEV_ASSET_MAP_FIXTURE;
  const household = fixture.household;
  const account = fixture.account;
  const positions = fixture.positions;
  const statusTallies = JSON.stringify({
    acat: positions.filter((position) => position.effectiveStatus === "ACAT").length,
    unsupported: positions.filter(
      (position) => position.effectiveStatus !== "ACAT",
    ).length,
  });

  await ingest.$executeRaw`
    INSERT INTO mirror.acat_asset_map_household
      (id, client_name, run_number, processed_at, source_created_at,
       superseded_by, source_folder_id, total_value, total_accounts,
       total_positions, status_tallies, client_sf_id, cedar_ridge_user_id)
    VALUES
      (${household.id}, ${household.clientName}, ${household.runNumber},
       ${household.processedAt}::timestamptz, ${household.processedAt}::timestamptz,
       NULL, ${household.sourceFolderId}, ${household.totalValue}, 1,
       ${positions.length}, ${statusTallies}::jsonb, NULL, NULL)
    ON CONFLICT (id) DO UPDATE SET
      client_name       = EXCLUDED.client_name,
      run_number        = EXCLUDED.run_number,
      processed_at      = EXCLUDED.processed_at,
      source_created_at = EXCLUDED.source_created_at,
      superseded_by     = EXCLUDED.superseded_by,
      source_folder_id  = EXCLUDED.source_folder_id,
      total_value       = EXCLUDED.total_value,
      total_accounts    = EXCLUDED.total_accounts,
      total_positions   = EXCLUDED.total_positions,
      status_tallies    = EXCLUDED.status_tallies,
      client_sf_id      = EXCLUDED.client_sf_id,
      cedar_ridge_user_id = EXCLUDED.cedar_ridge_user_id,
      synced_at         = now()`;

  await ingest.$executeRaw`
    INSERT INTO mirror.acat_asset_map_account
      (id, household_id, custodian, account_type, account_number,
       account_holder, statement_date, cash_balance, total_value,
       validation_status, validation_issues, is_stale, is_deleted,
       custodian_intel)
    VALUES
      (${account.id}, ${household.id}, ${account.custodian},
       ${account.accountType}, ${account.accountNumber}, ${account.accountHolder},
       ${account.statementDate}::date, ${account.cashBalance}, ${account.totalValue},
       'VALID', '[]'::jsonb, false, false, '{}'::jsonb)
    ON CONFLICT (id) DO UPDATE SET
      household_id      = EXCLUDED.household_id,
      custodian         = EXCLUDED.custodian,
      account_type      = EXCLUDED.account_type,
      account_number    = EXCLUDED.account_number,
      account_holder    = EXCLUDED.account_holder,
      statement_date    = EXCLUDED.statement_date,
      cash_balance      = EXCLUDED.cash_balance,
      total_value       = EXCLUDED.total_value,
      validation_status = EXCLUDED.validation_status,
      validation_issues = EXCLUDED.validation_issues,
      is_stale          = EXCLUDED.is_stale,
      is_deleted        = EXCLUDED.is_deleted,
      custodian_intel   = EXCLUDED.custodian_intel,
      synced_at         = now()`;

  for (const position of positions) {
    await ingest.$executeRaw`
      INSERT INTO mirror.acat_asset_map_position
        (id, account_id, symbol, description, quantity, market_value,
         asset_type, transfer_eligible, classification_source, transfer_notes,
         effective_notes, cost_basis, cost_basis_granularity,
         original_transfer_eligible, transferring, effective_status)
      VALUES
        (${position.id}, ${account.id}, ${position.symbol}, ${position.description},
         ${position.quantity}, ${position.marketValue}, 'SECURITY',
         ${position.effectiveStatus}, 'DEV_FIXTURE',
         'Synthetic development fixture', 'Synthetic development fixture',
         ${position.costBasis}, 'POSITION', ${position.effectiveStatus},
         ${position.transferring}, ${position.effectiveStatus})
      ON CONFLICT (id) DO UPDATE SET
        account_id                  = EXCLUDED.account_id,
        symbol                      = EXCLUDED.symbol,
        description                 = EXCLUDED.description,
        quantity                    = EXCLUDED.quantity,
        market_value                = EXCLUDED.market_value,
        asset_type                  = EXCLUDED.asset_type,
        transfer_eligible           = EXCLUDED.transfer_eligible,
        classification_source       = EXCLUDED.classification_source,
        transfer_notes              = EXCLUDED.transfer_notes,
        effective_notes             = EXCLUDED.effective_notes,
        cost_basis                  = EXCLUDED.cost_basis,
        cost_basis_granularity      = EXCLUDED.cost_basis_granularity,
        original_transfer_eligible  = EXCLUDED.original_transfer_eligible,
        transferring                = EXCLUDED.transferring,
        effective_status            = EXCLUDED.effective_status,
        synced_at                   = now()`;
  }
}

// ---------------------------------------------------------------------------
// Synthetic deals (Phase Deals D1, TDD ticket §3/§7) — ALL INVENTED, no real
// client data. ~24 deals across the 5 seed households + both seed advisors,
// stage split 6/3/1/10/4 (scaled from the real file), 2 unassigned rows (both
// LOST — mirrors the real pattern), 2 prospect-shaped rows (null
// cedar_ridge_user_id, both POTENTIAL). Deal names follow the parseable
// "<Client> - <Firm> - <Account Type> - <last4>" convention so the D2 account
// columns and the D4 parser fixtures are exercised. Written as the owner role
// (the deal_owner_all policy is what lets the seed past FORCE RLS — the exact
// analogue of the ingest path above), upserted on the DEMO- sf_deal_id →
// idempotent. source=IMPORT + stage_raw on every row: the seed mirrors the D4
// demo-CSV import shape (APP rows arrive via the D3 form, not the seed).
// ---------------------------------------------------------------------------

const OWNERS = {
  A: { name: "Avery Stone", sf: "ADV-AVERY" },
  B: { name: "Gwen Kuhlman", sf: "ADV-BLAKE" },
} as const;

// Raw CRM provenance (invented labels; the real report has only 3
// distinct raw values — coarser than the curated five-stage enum).
const STAGE_RAW: Record<DealInput["stage"], string> = {
  POTENTIAL: "Open",
  COMMITTED: "Open",
  FUNDING: "Open",
  WON: "Closed Won",
  LOST: "Closed Lost",
};

type SeedDeal = {
  n: number; // -> sf_deal_id DEMO-000n
  first: string;
  last: string;
  hh: string; // seed household sfId (household_sf_id + household_name lookup)
  firm: string;
  acct: string;
  last4: string;
  amount: number;
  stage: DealInput["stage"];
  created: string;
  close?: string; // omitted -> null (the report has a few blank close dates)
  owner?: keyof typeof OWNERS; // omitted -> unassigned (null owner fields)
  secondary?: string;
  eu?: string; // omitted -> null cedar_ridge_user_id (prospect-shaped)
  personAum?: number;
  potentialAum?: number;
  statements?: boolean; // default true (report: Yes except a few flagged No)
  lastActivity?: string;
};

const DEALS: SeedDeal[] = [
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

/** Expand a compact seed row to the shared DealInput contract (ADR-8). */
function toDealInput(d: SeedDeal): DealInput {
  const household = HOUSEHOLDS.find((h) => h.sfId === d.hh);
  if (!household) throw new Error(`Seed deal DEMO-${d.n}: unknown household ${d.hh}`);
  const owner = d.owner ? OWNERS[d.owner] : null;
  return {
    source: "IMPORT",
    sf_deal_id: `DEMO-${String(d.n).padStart(4, "0")}`,
    name: `${d.first} ${d.last} - ${d.firm} - ${d.acct} - ${d.last4}`,
    client_first_name: d.first,
    client_last_name: d.last,
    household_name: household.name,
    household_sf_id: household.sfId,
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

/** DealInput -> Prisma row data (shared by upsert create + update). */
function toDealData(input: DealInput) {
  return {
    source: input.source,
    sf_deal_id: input.sf_deal_id ?? null,
    name: input.name,
    client_first_name: input.client_first_name,
    client_last_name: input.client_last_name,
    household_name: input.household_name ?? null,
    household_sf_id: input.household_sf_id ?? null,
    amount: input.amount,
    stage: input.stage,
    stage_raw: input.stage_raw ?? null,
    created_date: new Date(input.created_date),
    close_date: input.close_date ? new Date(input.close_date) : null,
    last_activity_date: input.last_activity_date
      ? new Date(input.last_activity_date)
      : null,
    owner_name: input.owner_name ?? null,
    owner_sf_user_id: input.owner_sf_user_id ?? null,
    secondary_owner: input.secondary_owner ?? null,
    person_aum: input.person_aum ?? null,
    potential_aum: input.potential_aum ?? null,
    cedar_ridge_user_id: input.cedar_ridge_user_id ?? null,
    statements: input.statements ?? true,
    plaid_linked: input.plaid_linked ?? false,
    account_last4: input.account_last4 ?? null,
    account_type: input.account_type ?? null,
    transferring_firm: input.transferring_firm ?? null,
  };
}

// ---------------------------------------------------------------------------
// Synthetic transfers (Phase Asset Transfer T1, TDD ticket §3/§7; stage
// model collapsed to 3 by ticket Slice 1) — ALL INVENTED, no real client
// data, no mockup personas. 12 transfers: 10 re-keyed to the 5 seed households
// (real C-*/HH-* sf_ids, so T4's nudge composition and deal rollup light up),
// plus 2 prospect-shaped rows (null client/household sf_ids). With the collapse
// the former DISCOVERY / DECISION / ACCOUNTS_OPEN rows all land in DECISION, so
// the spread is now 9 DECISION / 2 IN_TRANSFER / 1 FUNDED. 3 ADVISOR-owned
// active records so the derived bouncing stat (owner_kind = ADVISOR ∧ stage ≠
// FUNDED — locked, the owner 2026-07-02) is non-zero. Every record carries its
// stage's DEFAULT_TASKS checklist with mixed completion; 3 records carry
// decision rows (one >300%-gain lot, one low-basis lot, one null-basis lot);
// the ex-ACCOUNTS_OPEN records still carry receiving accounts (mixed
// TO_OPEN/OPEN). Written as the owner role (the
// transfer_*_owner_all policies let the seed past FORCE RLS — the
// deal_owner_all analogue). Idempotent: stable DEMO-T- primary-key ids (the
// deals DEMO- convention carried onto the PK — app.transfer deliberately has
// no external-id column until a real backfill lands, ADR-1); source=APP on
// every row (this phase writes only APP; IMPORT is reserved).
// ---------------------------------------------------------------------------

/** Days-ago timestamp (invented ages so derived days-in-stage is exercised). */
function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

type SeedTransferDecision = {
  symbol: string;
  desc: string;
  value: number;
  basis: number | null; // null -> "Basis needed"
  decision: TransferDecisionChoice;
};

type SeedTransferAccount = {
  label: string;
  status: TransferAccountStatus;
};

type SeedTransfer = {
  n: number; // -> id DEMO-T-000n
  first: string;
  last: string;
  client?: string; // seed client sfId; omitted -> prospect-shaped
  hh?: string; // seed household sfId; omitted -> prospect-shaped
  value: number;
  stage: TransferStage;
  days: number; // stage_entered_at = daysAgo(days)
  ownerKind: TransferInput["owner_kind"];
  ownerName?: string;
  doneTasks: number; // first N of the stage's DEFAULT_TASKS are done
  nextStep?: string;
  nextStepOwner?: string;
  nudge?: string; // pending_nudge label (action composes Smart Nudges)
  decisions?: SeedTransferDecision[];
  accounts?: SeedTransferAccount[];
  acat?: string; // acat_transfer_id — links the row to a tracker ACAT (ticket)
  by?: string; // created_by/updated_by; omitted -> null (prospect rows)
  // ticket Slice 2 deal-sourced columns (all optional; default off/null).
  fundingType?: TransferInput["funding_type"];
  accountsOpened?: boolean;
  fundingPlan?: boolean;
  fundingInitiated?: boolean;
  cashInFlight?: boolean;
  dealSfId?: string; // resolves deal_id via a lookup at seed time (sync key)
  firm?: string; // transferring_firm (seeded from the deal by the S4 sync)
  acatRecordId?: string; // tracker record PK (owner-approved column)
};

const OPS_EMAIL = "ops@example.com";

const TRANSFERS: SeedTransfer[] = [
  // DECISION — ex-DISCOVERY rows (ticket Slice 1 collapse): 2 household-keyed + 1 prospect
  { n: 1, first: "Sam", last: "Stone", client: "C-1", hh: "HH-1001", value: 1280000, stage: "DECISION", days: 5, ownerKind: "ADVISOR", ownerName: "Avery Stone", doneTasks: 1, nextStep: "Gentle check-in only — keep a receiving account ready.", nextStepOwner: "Client Service", by: "avery@example.com" },
  { n: 2, first: "Ada", last: "Okafor", client: "C-4", hh: "HH-1003", value: 640000, stage: "DECISION", days: 2, ownerKind: "OPERATIONS", doneTasks: 0, nextStep: "Request statements from the outside custodian.", nextStepOwner: "Operations", by: OPS_EMAIL },
  { n: 11, first: "Noor", last: "Haddad", value: 415000, stage: "DECISION", days: 1, ownerKind: "OPERATIONS", doneTasks: 1, nextStep: "Prospect intake — collect statements after the intro call.", nextStepOwner: "Operations" },
  // DECISION — native (3 household-keyed + 1 prospect)
  { n: 3, first: "Minh", last: "Nguyen", client: "C-3", hh: "HH-1002", value: 2125000, stage: "DECISION", days: 12, ownerKind: "ADVISOR", ownerName: "Avery Stone", doneTasks: 1, nextStep: "Send the asset-decision worksheet and own the follow-up.", nextStepOwner: "Operations", nudge: "Send asset-decision worksheet", by: OPS_EMAIL,
    decisions: [
      { symbol: "AAPL", desc: "Apple Inc", value: 181000, basis: 22000, decision: "LEAVE_GIFT" },
      { symbol: "VTI", desc: "Vanguard Total Stock Market ETF", value: 140000, basis: 128000, decision: "UNDECIDED" },
      { symbol: "VMFXX", desc: "Vanguard Federal Money Market", value: 35000, basis: 35000, decision: "BRING_IN" },
    ] },
  { n: 4, first: "Jo", last: "Stone", client: "C-2", hh: "HH-1001", value: 372000, stage: "DECISION", days: 9, ownerKind: "OPERATIONS", ownerName: "Riley Ops", doneTasks: 2, nextStep: "Chase the missing cost basis, then confirm final decisions.", nextStepOwner: "Client Service", nudge: "Confirm asset decisions", by: OPS_EMAIL,
    decisions: [
      { symbol: "ACWX", desc: "iShares MSCI ACWI ex US ETF", value: 96000, basis: null, decision: "UNDECIDED" },
      { symbol: "BND", desc: "Vanguard Total Bond Market ETF", value: 80000, basis: 79000, decision: "UNDECIDED" },
    ] },
  { n: 5, first: "Asha", last: "Patel", client: "C-6", hh: "HH-2002", value: 890000, stage: "DECISION", days: 11, ownerKind: "CLIENT_SERVICE", doneTasks: 1, nextStep: "Schedule the decision review with the household.", nextStepOwner: "Client Service", by: OPS_EMAIL },
  { n: 12, first: "Adaline", last: "Marsh", value: 285000, stage: "DECISION", days: 8, ownerKind: "CLIENT_SERVICE", doneTasks: 1, nextStep: "Walk the worksheet before account paperwork.", nextStepOwner: "Client Service" },
  // DECISION — ex-ACCOUNTS_OPEN rows (ticket Slice 1 collapse): carry receiving accounts (Slice 2 backfills accounts_opened_at_apex)
  { n: 6, first: "Neil", last: "Walker", client: "C-5", hh: "HH-2001", value: 4678000, stage: "DECISION", days: 6, ownerKind: "CLIENT_SERVICE", ownerName: "Kayden Altenwerth", doneTasks: 1, nextStep: "Open Roth + joint taxable, then submit the ACAT.", nextStepOwner: "Client Service", by: OPS_EMAIL,
    decisions: [
      { symbol: "NVDA", desc: "NVIDIA Corp", value: 96000, basis: 12000, decision: "LEAVE_GIFT" },
      { symbol: "VMFXX", desc: "Vanguard Federal Money Market", value: 25000, basis: 25000, decision: "BRING_IN" },
    ],
    accounts: [
      { label: "Traditional IRA rollover", status: "OPEN" },
      { label: "Roth IRA", status: "TO_OPEN" },
      { label: "Joint taxable (receiving)", status: "TO_OPEN" },
    ] },
  // n=7 doubles as the ticket deal-sourced fixture: a DECISION transfer
  // linked to the COMMITTED deal DEMO-0007 (Asha Patel, HH-2002, Fidelity),
  // funding_type = ACAT_FULL with two readiness booleans set and a synthetic tracker
  // record id. deal_id is resolved from dealSfId at seed time (the sync key).
  { n: 7, first: "Asha", last: "Patel", client: "C-6", hh: "HH-2002", value: 549000, stage: "DECISION", days: 7, ownerKind: "CLIENT_SERVICE", doneTasks: 2, nextStep: "Confirm account numbers, then queue the transfer.", nextStepOwner: "Client Service", nudge: "Open receiving accounts", by: OPS_EMAIL,
    fundingType: "ACAT_FULL", accountsOpened: true, fundingPlan: true, dealSfId: "DEMO-0007", firm: "Fidelity", acatRecordId: "ACATREC-DEMO-0007",
    accounts: [
      { label: "Traditional IRA", status: "OPEN" },
      { label: "Roth IRA", status: "TO_OPEN" },
    ] },
  // IN_TRANSFER (2)
  { n: 8, first: "Neil", last: "Walker", client: "C-5", hh: "HH-2001", value: 1871000, stage: "IN_TRANSFER", days: 4, ownerKind: "CLIENT_SERVICE", doneTasks: 2, nextStep: "Monitor ACAT; reconcile on settle.", nextStepOwner: "Operations", acat: "ACT-NEIL-8", by: OPS_EMAIL },
  { n: 9, first: "Sam", last: "Stone", client: "C-1", hh: "HH-1001", value: 2182000, stage: "IN_TRANSFER", days: 3, ownerKind: "ADVISOR", ownerName: "Avery Stone", doneTasks: 3, nextStep: "Hand to the trade desk on settle.", nextStepOwner: "Operations", acat: "ACT-SAM-9", by: "avery@example.com" },
  // FUNDED (1)
  { n: 10, first: "Minh", last: "Nguyen", client: "C-3", hh: "HH-1002", value: 332000, stage: "FUNDED", days: 2, ownerKind: "OPERATIONS", ownerName: "Riley Ops", doneTasks: 4, nextStep: "Closed.", nextStepOwner: "Operations", by: OPS_EMAIL },
];

/** Expand a compact seed row to the shared TransferInput contract. */
function toTransferInput(t: SeedTransfer): TransferInput {
  const household = t.hh ? HOUSEHOLDS.find((h) => h.sfId === t.hh) : null;
  if (t.hh && !household)
    throw new Error(`Seed transfer DEMO-T-${t.n}: unknown household ${t.hh}`);
  return {
    source: "APP",
    client_first_name: t.first,
    client_last_name: t.last,
    client_sf_id: t.client ?? null,
    household_name: household?.name ?? null,
    household_sf_id: household?.sfId ?? null,
    value: t.value,
    stage: t.stage,
    owner_kind: t.ownerKind,
    owner_name: t.ownerName ?? null,
    next_step: t.nextStep ?? null,
    next_step_owner: t.nextStepOwner ?? null,
    pending_nudge: t.nudge ?? null,
    acat_transfer_id: t.acat ?? null,
    // ticket Slice 2 — funding_type flows through the shared validator; the
    // rest are direct scalar columns applied in seedTransfers' data object.
    funding_type: t.fundingType ?? null,
  };
}

async function seedTransfers() {
  let tasks = 0;
  let decisions = 0;
  let accounts = 0;

  for (const t of TRANSFERS) {
    const input = toTransferInput(t);
    const check = validateTransferInput(input);
    if (!check.ok) {
      throw new Error(
        `Seed transfer DEMO-T-${t.n} fails validateTransferInput: ` +
          check.errors.map((e) => `${e.field}: ${e.message}`).join("; ")
      );
    }
    const id = `DEMO-T-${String(t.n).padStart(4, "0")}`;
    // ticket Slice 2 — resolve the sync key deal_id from the deal's DEMO
    // sf_deal_id (deals are seeded before transfers; the deal PK is a cuid, so
    // it is looked up rather than hard-coded).
    const linkedDeal = t.dealSfId
      ? await owner.deal.findUnique({ where: { sf_deal_id: t.dealSfId } })
      : null;
    if (t.dealSfId && !linkedDeal)
      throw new Error(
        `Seed transfer DEMO-T-${t.n}: unknown linked deal ${t.dealSfId}`,
      );
    const data = {
      source: input.source,
      client_first_name: input.client_first_name,
      client_last_name: input.client_last_name,
      client_sf_id: input.client_sf_id ?? null,
      household_name: input.household_name ?? null,
      household_sf_id: input.household_sf_id ?? null,
      value: input.value,
      stage: input.stage,
      stage_entered_at: daysAgo(t.days),
      owner_kind: input.owner_kind,
      owner_name: input.owner_name ?? null,
      next_step: input.next_step ?? null,
      next_step_owner: input.next_step_owner ?? null,
      pending_nudge: input.pending_nudge ?? null,
      acat_transfer_id: input.acat_transfer_id ?? null,
      // ticket Slice 2 deal-sourced columns.
      funding_type: input.funding_type ?? null,
      accounts_opened_at_apex: t.accountsOpened ?? false,
      funding_plan_complete: t.fundingPlan ?? false,
      funding_initiated: t.fundingInitiated ?? false,
      cash_in_flight: t.cashInFlight ?? false,
      deal_id: linkedDeal?.id ?? null,
      deal_sf_id: t.dealSfId ?? null,
      transferring_firm: t.firm ?? null,
      acat_record_id: t.acatRecordId ?? null,
      created_by: t.by ?? null,
      updated_by: t.by ?? null,
    };
    await owner.transfer.upsert({
      where: { id },
      update: data,
      create: { id, ...data },
    });

    // Checklist: the stage's DEFAULT_TASKS template with mixed completion —
    // the first `doneTasks` are done, stamped completed_at/completed_by.
    const template = DEFAULT_TASKS[t.stage];
    for (let i = 0; i < template.length; i++) {
      const done = i < t.doneTasks;
      const taskData = {
        transfer_id: id,
        title: template[i],
        sort_order: i,
        done,
        completed_at: done ? daysAgo(t.days + (t.doneTasks - i)) : null,
        completed_by: done ? (t.by ?? OPS_EMAIL) : null,
      };
      await owner.transferTask.upsert({
        where: { id: `${id}-TASK-${i + 1}` },
        update: taskData,
        create: { id: `${id}-TASK-${i + 1}`, ...taskData },
      });
      tasks++;
    }

    // Basis-aware decision rows (synthetic positions until Phase D ingest).
    for (let i = 0; i < (t.decisions?.length ?? 0); i++) {
      const d = t.decisions![i];
      const decided = d.decision !== "UNDECIDED";
      const decisionData = {
        transfer_id: id,
        symbol: d.symbol,
        description: d.desc,
        value: d.value,
        cost_basis: d.basis,
        decision: d.decision,
        decided_by: decided ? (t.by ?? OPS_EMAIL) : null,
        decided_at: decided ? daysAgo(t.days - 1) : null,
      };
      await owner.transferDecision.upsert({
        where: { id: `${id}-DEC-${i + 1}` },
        update: decisionData,
        create: { id: `${id}-DEC-${i + 1}`, ...decisionData },
      });
      decisions++;
    }

    // Receiving accounts (ACCOUNTS_OPEN records; feeds that stage's gate).
    for (let i = 0; i < (t.accounts?.length ?? 0); i++) {
      const a = t.accounts![i];
      const accountData = {
        transfer_id: id,
        label: a.label,
        status: a.status,
        opened_at: a.status === "OPEN" ? daysAgo(t.days - 1) : null,
      };
      await owner.transferAccount.upsert({
        where: { id: `${id}-ACCT-${i + 1}` },
        update: accountData,
        create: { id: `${id}-ACCT-${i + 1}`, ...accountData },
      });
      accounts++;
    }
  }

  return { transfers: TRANSFERS.length, tasks, decisions, accounts };
}

async function main() {
  // app.User — dev-login personas.
  for (const p of STAFF) {
    await owner.user.upsert({
      where: { email: p.email },
      update: { name: p.name, role: p.role },
      create: { email: p.email, name: p.name, role: p.role },
    });
  }

  // mirror.advisor (reference data — no RLS).
  for (const a of ADVISORS) {
    await ingest.$executeRaw`
      INSERT INTO mirror.advisor (sf_id, name, email, title, active)
      VALUES (${a.sfId}, ${a.name}, ${a.email}, ${a.title}, true)
      ON CONFLICT (sf_id) DO UPDATE
        SET name = EXCLUDED.name, email = EXCLUDED.email,
            title = EXCLUDED.title, synced_at = now()`;
  }

  // mirror.household (RLS-scoped by lead_advisor_email).
  for (const h of HOUSEHOLDS) {
    await ingest.$executeRaw`
      INSERT INTO mirror.household (sf_id, name, status, stage, lead_advisor_email, aum)
      VALUES (${h.sfId}, ${h.name}, 'Active', ${h.stage}, ${h.lead}, ${h.aum})
      ON CONFLICT (sf_id) DO UPDATE
        SET name = EXCLUDED.name, status = EXCLUDED.status, stage = EXCLUDED.stage,
            lead_advisor_email = EXCLUDED.lead_advisor_email,
            aum = EXCLUDED.aum, synced_at = now()`;
  }

  // mirror.client (RLS-scoped; lead_advisor_email denormalized from household).
  for (const c of CLIENTS) {
    const lead = HOUSEHOLDS.find((h) => h.sfId === c.hh)!.lead;
    await ingest.$executeRaw`
      INSERT INTO mirror.client (sf_id, household_id, first_name, last_name, email, lead_advisor_email)
      VALUES (${c.sfId}, ${c.hh}, ${c.first}, ${c.last},
              ${`${c.first.toLowerCase()}.${c.last.toLowerCase()}@example.com`}, ${lead})
      ON CONFLICT (sf_id) DO UPDATE
        SET household_id = EXCLUDED.household_id, first_name = EXCLUDED.first_name,
            last_name = EXCLUDED.last_name, lead_advisor_email = EXCLUDED.lead_advisor_email,
            synced_at = now()`;
  }

  // mirror.client_account_aum (ticket) — per-account AUM, written as ingest_rw
  // (the only role past FORCE RLS). Keyed on the custodian ULID. Client accounts
  // carry an apex number + client + household; firm accounts land under the
  // Cedar Ridge Wealth firm household (seeded here so the local Households page can
  // render it — the live feed instead OVERRIDES the card's NULL); the unlinked
  // rows carry no client/household and a genuine $0.
  const upsertAum = (
    cust: string,
    apex: string | null,
    client: string | null,
    hh: string | null,
    type: string,
    isManaged: boolean,
    status: string,
    aum: number,
  ) =>
    ingest.$executeRaw`
      INSERT INTO mirror.client_account_aum
        (custodian_account_id, apex_account_number, client_sf_id, household_sf_id,
         account_type, is_managed, account_status, account_aum, as_of)
      VALUES (${cust}, ${apex}, ${client}, ${hh}, ${type}, ${isManaged}, ${status}, ${aum}, ${AS_OF}::timestamptz)
      ON CONFLICT (custodian_account_id) DO UPDATE
        SET apex_account_number = EXCLUDED.apex_account_number,
            client_sf_id        = EXCLUDED.client_sf_id,
            household_sf_id     = EXCLUDED.household_sf_id,
            account_type        = EXCLUDED.account_type,
            is_managed          = EXCLUDED.is_managed,
            account_status      = EXCLUDED.account_status,
            account_aum         = EXCLUDED.account_aum,
            as_of               = EXCLUDED.as_of,
            synced_at           = now()`;

  for (const a of ACCOUNT_AUM) {
    await upsertAum(a.cust, a.apex, a.client, a.hh, a.type, true, "ACTIVE", a.aum);
  }
  for (const a of FIRM_ACCOUNTS) {
    await upsertAum(a.cust, null, null, FIRM_HOUSEHOLD_ID, a.type, false, "OPEN", a.aum);
  }
  for (const a of UNLINKED_ACCOUNTS) {
    await upsertAum(a.cust, a.apex, null, null, "Individual", false, "OPEN", 0);
  }

  // Synthetic asset-map account — makes the dev picker and partial-ACAT
  // decision handoff testable without copying production client data into dev.
  await seedAssetMapFixture();

  // app.deal — synthetic pipeline, written as the owner role past FORCE RLS
  // (deal_owner_all). Every row is asserted through the shared validation
  // contract before write, so the seed stays contract-exact by construction.
  for (const d of DEALS) {
    const input = toDealInput(d);
    const check = validateDealInput(input);
    if (!check.ok) {
      throw new Error(
        `Seed deal ${input.sf_deal_id} fails validateDealInput: ` +
          check.errors.map((e) => `${e.field}: ${e.message}`).join("; ")
      );
    }
    const data = toDealData(input);
    await owner.deal.upsert({
      where: { sf_deal_id: input.sf_deal_id! },
      update: data,
      create: data,
    });
  }

  // app.transfer + children — synthetic lifecycle book, written as the owner
  // role past FORCE RLS (transfer_*_owner_all).
  const t = await seedTransfers();

  const aumCount = ACCOUNT_AUM.length + FIRM_ACCOUNTS.length + UNLINKED_ACCOUNTS.length;
  console.log(
    `Seeded ${STAFF.length} users, ${ADVISORS.length} advisors, ` +
      `${HOUSEHOLDS.length} households, ${CLIENTS.length} clients, ` +
      `${aumCount} account-AUM rows (incl. ${FIRM_ACCOUNTS.length} firm), ` +
      `1 asset-map account (${DEV_ASSET_MAP_FIXTURE.positions.length} positions), ` +
      `${DEALS.length} deals, ${t.transfers} transfers ` +
      `(${t.tasks} tasks, ${t.decisions} decisions, ${t.accounts} accounts).`
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await owner.$disconnect();
    await ingest.$disconnect();
  });
