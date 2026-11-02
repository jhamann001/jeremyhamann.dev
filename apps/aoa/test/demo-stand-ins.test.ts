// The demo's outside services, answered in-app. Every check runs AOA's own reader for the service, so the request
// goes through the real client (Google's request pipeline, or fetch for the warehouse) into the stand-in, and the
// answer through the same parser production uses. The store is an in-memory copy of demo.stand_in_record.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

vi.mock("server-only", () => ({}));
const { rows, outbox } = vi.hoisted(() => ({ rows: new Map<string, unknown>(), outbox: [] as unknown[] }));
vi.mock("@/lib/db", () => ({ prisma: {} }));
vi.mock("@/lib/demo/outbox", () => ({ recordOutbox: async (_db: unknown, entry: unknown) => { outbox.push(entry); } }));
vi.mock("@/lib/demo/stand-ins/store", () => {
  const key = (s: string, k: string, id: string) => `${s}|${k}|${id}`;
  const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v));
  return {
    listRecords: async (s: string, k: string) => [...rows.entries()]
      .filter(([id]) => id.startsWith(`${s}|${k}|`))
      .map(([id, doc]) => ({ id: id.split("|")[2], doc: copy(doc), updatedAt: new Date() })),
    readRecord: async (s: string, k: string, id: string) =>
      rows.has(key(s, k, id)) ? { id, doc: copy(rows.get(key(s, k, id))), updatedAt: new Date() } : null,
    saveRecord: async (s: string, k: string, id: string, doc: unknown) => { rows.set(key(s, k, id), copy(doc)); },
    changeRecord: async (s: string, k: string, id: string, change: (d: unknown) => unknown) => {
      if (!rows.has(key(s, k, id))) return null;
      const next = change(copy(rows.get(key(s, k, id))));
      if (next) rows.set(key(s, k, id), copy(next));
      return copy(next ?? rows.get(key(s, k, id)));
    },
  };
});

import { GoogleAuth } from "google-auth-library";
import { DemoOfflineError, ServiceAuth } from "@/lib/demo/service-auth";
import { matchRoute, standInFetch } from "@/lib/demo/stand-ins/fetch";
import { maskAccountNumber, type PipelineDestination, type PipelineHousehold } from "@/lib/demo/stand-ins/pipeline";
import { fetchAssetMapScheduleStatus, fetchHouseholdsPage, flattenHouseholds, sendAssetMapClientLink, sendAssetMapEdit } from "@/lib/data/asset-map";
import { fetchAssetMapDestinations, maskLikePipeline, sendAssetMapDestinationWrite } from "@/lib/data/asset-map-destinations";
import { fetchAssetMapHouseholdPdf, runAssetMapScan, saveAssetMapHouseholdToDrive } from "@/lib/data/asset-map-documents";
import { classifyHoldingsTransferability } from "@/lib/data/holdings-transferability-preview";
import { resolveAccount } from "@/lib/twr/warehouse";
import { checkExternalFundingAvailability, fetchAccountFunding, getExternalFundingSourceDate } from "@/lib/data/account-funding";
import { fetchLinkedHoldingsPreview } from "@/lib/data/linked-external-holdings-preview";
import { fetchTradeReconciliationSources } from "@/lib/operations/trade-reconciliation-source";

const PIPELINE = "https://statements.jeremyhamann.dev";
const RUN = "0b5c7f0e-3d1a-4c55-9a3e-6f1d2c8b9a01";
const ACCOUNT = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const POSITION = "2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e";
const FUND = "3c4d5e6f-7a8b-4c9d-8e1f-2a3b4c5d6e7f";
const FOLDER = "folder-okafor";

function household(): PipelineHousehold {
  return {
    id: RUN, client_name: "Okafor Household", run_number: 2, processed_at: "2026-10-20T14:05:00Z", superseded_by: null,
    source_folder_id: FOLDER, docs_total: 1, docs_extracted: 1, reviewed_at: null, reviewed_by: null, updated_at: null,
    accounts: [{
      id: ACCOUNT, custodian: "Fidelity", account_type: "IRA", account_number: "Z12-345678", account_holder: "Kofi Okafor",
      statement_date: "2026-09-30", total_value: 125000, is_rollover: false, is_inherited: false,
      assets: [
        { id: POSITION, symbol: "VTI", description: "Vanguard Total Stock Market ETF", quantity: 300, market_value: 90000,
          asset_type: "ETF", transfer_eligible: "ACAT", transfer_notes: "Standard security" },
        { id: FUND, symbol: "FCNTX", description: "Fidelity Contrafund", quantity: 1500, market_value: 35000,
          asset_type: "Mutual Fund", transfer_eligible: "REVIEW", transfer_notes: "Check the fund's omnibus status" },
      ],
    }],
  };
}

beforeEach(() => {
  rows.clear();
  outbox.length = 0;
  vi.stubEnv("NEXT_PUBLIC_DEMO_MODE", "on");
  vi.stubEnv("APP_ENV", "prod");
  vi.stubEnv("STATEMENT_PIPELINE_URL", PIPELINE);
  vi.stubEnv("WAREHOUSE_URL", "https://warehouse.example");
  vi.stubEnv("WAREHOUSE_API_KEY", "demo-stand-in");
  rows.set(`pipeline|household|${RUN}`, household());
  rows.set("pipeline|destination|d-1", {
    id: "d-1", source_folder_id: FOLDER, owner: "Kofi Okafor", target_account_type: "Traditional IRA",
    existing_apex_number: null, needs_to_be_opened: true,
    sources: [{ link_id: "link-1", custodian: "Fidelity", account_number: "Z12-345678" }],
  } satisfies PipelineDestination);
});
afterEach(() => vi.unstubAllEnvs());

describe("the switch point", () => {
  it("is a GoogleAuth whose other Google calls refuse in the demo", async () => {
    const auth = new ServiceAuth();
    expect(auth).toBeInstanceOf(GoogleAuth);
    await expect(auth.getClient()).rejects.toBeInstanceOf(DemoOfflineError);
    await expect(auth.getCredentials()).rejects.toBeInstanceOf(DemoOfflineError);
    await expect(auth.getAccessToken()).rejects.toBeInstanceOf(DemoOfflineError);
  });

  it("answers only in the demo, and 501s a service or route it doesn't stand in for", async () => {
    expect((await standInFetch("https://unknown.example/api/x")).status).toBe(501);
    expect((await standInFetch(`${PIPELINE}/api/nothing-here`)).status).toBe(501);
    vi.stubEnv("NEXT_PUBLIC_DEMO_MODE", "");
    await expect(standInFetch(`${PIPELINE}/api/schedule-status`)).rejects.toThrow("stand_in_outside_demo");
  });

  it("matches routes by segment, decoding parameters", () => {
    expect(matchRoute("/api/positions/:id/status", "/api/positions/a%20b/status")).toEqual({ id: "a b" });
    expect(matchRoute("/api/positions/:id", "/api/positions/x/status")).toBeNull();
    expect(matchRoute("/api/scan", "/api/scan/")).toEqual({});
  });

  it("is the only place the app builds a Google identity", () => {
    const SWITCH = join(process.cwd(), "lib/demo/service-auth.ts");
    // The Trade Request cutover command's transport: an operator runs it with tsx, outside the app and the demo.
    const OPERATOR_ONLY = new Set([join(process.cwd(), "lib/trade-requests/standalone-control.ts")]);
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.tsx?$/.test(name) && !name.includes(".test.") && path !== SWITCH && !OPERATOR_ONLY.has(path) && /new GoogleAuth\(/.test(readFileSync(path, "utf8"))) offenders.push(path);
      }
    };
    for (const dir of ["lib", "app", "components"]) walk(join(process.cwd(), dir));
    expect(offenders).toEqual([]);
  });
});

describe("the statement pipeline", () => {
  it("serves household runs the import's parser accepts, with counts from the effective status", async () => {
    const page = await fetchHouseholdsPage(PIPELINE, 1, 200);
    expect(page).toMatchObject({ page: 1, total: 1 });
    const flat = flattenHouseholds(page.households, undefined, { transferringText: true });
    expect(flat.rejected).toEqual([]);
    expect(flat.households[0]).toMatchObject({ id: RUN, client_name: "Okafor Household", total_value: 125000, total_positions: 2 });
    expect(JSON.parse(flat.households[0].status_tallies!)).toMatchObject({ acat_count: 1, review_count: 1, liquidate_count: 0 });
    expect(flat.accounts[0]).toMatchObject({ account_number: "Z12-345678", custodian: "Fidelity" });
  });

  it("applies an override, then a removal and restore, as the pipeline does", async () => {
    expect(await sendAssetMapEdit(PIPELINE, { kind: "positionStatus", positionId: FUND, status: "LIQUIDATE" })).toMatchObject({ ok: true, body: { new_status: "LIQUIDATE" } });
    let flat = flattenHouseholds((await fetchHouseholdsPage(PIPELINE, 1, 200)).households);
    expect(flat.positions.find((p) => p.id === FUND)).toMatchObject({ override_status: "LIQUIDATE", effective_status: "LIQUIDATE", transfer_eligible: "REVIEW" });
    expect(await sendAssetMapEdit(PIPELINE, { kind: "removePosition", positionId: POSITION })).toMatchObject({ ok: true });
    flat = flattenHouseholds((await fetchHouseholdsPage(PIPELINE, 1, 200)).households);
    expect(flat.positions.map((p) => p.id)).toEqual([FUND]);
    expect(await sendAssetMapEdit(PIPELINE, { kind: "removePosition", positionId: POSITION })).toEqual({ ok: false, reason: "rejected" });
    expect(await sendAssetMapEdit(PIPELINE, { kind: "restorePosition", positionId: POSITION })).toMatchObject({ ok: true });
    expect(flattenHouseholds((await fetchHouseholdsPage(PIPELINE, 1, 200)).households).positions).toHaveLength(2);
  });

  it("refuses an account type the pipeline doesn't know and records one it does", async () => {
    expect(await sendAssetMapEdit(PIPELINE, { kind: "accountType", accountId: ACCOUNT, accountType: "Brokerage", accountTypeOther: null }))
      .toEqual({ ok: false, reason: "rejected" });
    expect(await sendAssetMapEdit(PIPELINE, { kind: "accountType", accountId: ACCOUNT, accountType: "Roth IRA", accountTypeOther: null }))
      .toMatchObject({ ok: true, body: { account_type: "Roth IRA", is_inherited: false } });
  });

  it("masks destination source numbers exactly as AOA does, and keeps the panel's rules", async () => {
    for (const n of ["Z12-345678", "1234", "12-3", "987654321", ""]) expect(maskAccountNumber(n)).toBe(maskLikePipeline(n));
    const destinations = await fetchAssetMapDestinations(PIPELINE, FOLDER);
    expect(destinations).toHaveLength(1);
    expect(destinations![0].sources[0].accountNumberMasked).toBe(maskLikePipeline("Z12-345678"));
    expect(await sendAssetMapDestinationWrite(PIPELINE, { kind: "remove", targetId: "d-1" })).toEqual({ ok: false, reason: "rejected" });
    const added = await sendAssetMapDestinationWrite(PIPELINE, { kind: "add", sourceFolderId: FOLDER, owner: "Kofi Okafor", targetAccountType: "Roth IRA" });
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    const newId = String(added.body.id);
    expect(await sendAssetMapDestinationWrite(PIPELINE, { kind: "reassign", linkId: "link-1", targetAccountId: newId })).toMatchObject({ ok: true });
    expect(await sendAssetMapDestinationWrite(PIPELINE, { kind: "remove", targetId: "d-1" })).toMatchObject({ ok: true });
    expect((await fetchAssetMapDestinations(PIPELINE, FOLDER))!.map((d) => d.id)).toEqual([newId]);
  });

  it("builds the household PDF and files Save to Drive in the Outbox, marking the run reviewed", async () => {
    const pdf = await fetchAssetMapHouseholdPdf(PIPELINE, RUN);
    expect(pdf.ok).toBe(true);
    if (!pdf.ok) return;
    expect(new TextDecoder().decode(pdf.data.bytes.slice(0, 5))).toBe("%PDF-");
    expect(pdf.data.filename).toMatch(/^Okafor_Household_report_\d{4}-\d{2}-\d{2}\.pdf$/);
    const saved = await saveAssetMapHouseholdToDrive(PIPELINE, RUN);
    expect(saved).toMatchObject({ ok: true, data: { filename: pdf.data.filename } });
    expect(outbox).toEqual([expect.objectContaining({ channel: "Google Drive", title: "Asset map saved for Okafor Household" })]);
    const live = (await fetchHouseholdsPage(PIPELINE, 1, 200)).households[0] as { reviewed_at: string; reviewed_by: string };
    expect(live.reviewed_at).toBeTruthy();
    expect(live.reviewed_by).toBe("aoa-run@ops-portal.iam.gserviceaccount.com");
  });

  it("answers the schedule, an empty scan and a client-linking config that keeps linking off", async () => {
    expect(await fetchAssetMapScheduleStatus(PIPELINE)).toMatchObject({ scanIntervalMinutes: 30, businessDays: "Mon–Fri" });
    expect(await runAssetMapScan(PIPELINE)).toMatchObject({ ok: true, clientsProcessed: 0 });
    expect(await sendAssetMapClientLink(PIPELINE, { kind: "config" } as never)).toMatchObject({ ok: true, body: { client_linking_enabled: false } });
  });

  it("classifies a holdings preview with the fund restriction list", async () => {
    rows.set("pipeline|fund_restriction|FCNTX", { symbol: "FCNTX", omni: true });
    const labels = await classifyHoldingsTransferability([
      { symbol: "VTI", name: "ETF", security_type: "etf" }, { symbol: "FCNTX", name: "Fund", security_type: "mutual fund" },
      { symbol: "XYZZX", name: "Fund", security_type: "mutual fund" }, { symbol: null, name: "Bond", security_type: "fixed income" },
      { symbol: "Q", name: null, security_type: "crypto" },
    ]);
    expect(labels.map((l) => `${l.label}:${l.reason}`)).toEqual([
      "likely_transferable:standard_security", "likely_transferable:omni", "unknown:mutual_fund_unlisted",
      "likely_not:fixed_income", "unknown:unrecognized_security_type",
    ]);
  });
});

describe("the warehouse", () => {
  beforeEach(() => {
    rows.set("warehouse|account|5WK10001", { account_id: "01HZOKAFORIRA0000000000001", apex_acct: "5WK10001", account_type: "IRA", account_nickname: null, client_name: "Kofi Okafor" });
    rows.set("warehouse|funding|act-1", { account_id: "01HZOKAFORIRA0000000000001", activity_id: "act-1", activity_date: "2026-08-04", settle_date: "2026-08-05", net_amount: 6500, funding_method: "ACH", activity_description: "ACH deposit", source_application_id: null, generation: 1 });
    rows.set("warehouse|funding|act-0", { account_id: "01HZOKAFORIRA0000000000001", activity_id: "act-0", activity_date: "2024-01-04", settle_date: null, net_amount: 100, funding_method: "Check", activity_description: null, source_application_id: null, generation: 1 });
  });

  it("resolves an account and its trailing-year funding through AOA's own readers", async () => {
    expect(await resolveAccount("5WK10001")).toMatchObject({ accountId: "01HZOKAFORIRA0000000000001", clientName: "Kofi Okafor" });
    expect(await resolveAccount("NOPE")).toBeNull();
    const funding = await fetchAccountFunding("01HZOKAFORIRA0000000000001", { startDate: "2025-10-30" });
    expect(funding).toHaveLength(1);
    await expect(checkExternalFundingAvailability()).resolves.toBeUndefined();
    expect(await getExternalFundingSourceDate()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("returns a linked account's holdings and the reconciliation's two sources for a day", async () => {
    rows.set("warehouse|linked_holdings|ext-1", { rows: [{ ticker: "AAPL", security_name: "Apple Inc.", security_type: "equity", quantity: 10, market_value: 2300, current: 2300, as_of: "2026-10-29" }] });
    expect(await fetchLinkedHoldingsPreview("ext-1")).toMatchObject({ asOf: "2026-10-29", institutionBalance: 2300, rows: [expect.anything()] });
    rows.set("warehouse|apex_trade|t-1", { activity_id: "t-1", process_date: "2026-10-29", account_id: "5WK10001", asset_type: "EQUITY", symbol: "VTI", side: "BUY", quantity: 10, net_amount: 3000, gross_amount: 3000, client_order_id: "o-1", activity_time: "2026-10-29T14:31:00Z" });
    rows.set("warehouse|rebalancer_order|o-1", { rebalancer_order_id: "o-1", apex_account_id: "5WK10001", asset_type: "EQUITY", symbol: "VTI", side: "BUY", quantity: 10, notional_amount: 3000, initiated_timestamp: "2026-10-29T14:30:00Z", client_basket_id: null, apex_basket_id: null });
    const sources = await fetchTradeReconciliationSources("2026-10-29");
    expect(sources.apex).toHaveLength(1);
    expect(sources.meridian).toHaveLength(1);
    expect(await fetchTradeReconciliationSources("2026-10-28")).toEqual({ apex: [], meridian: [] });
  });
});
