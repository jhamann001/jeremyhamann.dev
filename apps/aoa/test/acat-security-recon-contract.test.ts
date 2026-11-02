import { afterEach, describe, expect, it, vi } from "vitest";
import { markCase } from "./acat-book-flywheel";
import {
  RECON_ACCOUNTS_FAILURE,
  RECON_INVALID,
  RECON_MAPPING_TOO_LARGE,
  RECON_NOT_CSV,
  RECON_NO_STATEMENT,
  RECON_STATUSES,
  RECON_UNAVAILABLE,
  buildReconCsv,
  buildSaveRequest,
  buildUploadRequest,
  formatMappingSync,
  formatReconCash,
  isCashSymbol,
  mapReconPreview,
  mapReconSnapshot,
  parseAccountsEnvelope,
  parseReconAccounts,
  parseReconEnvelope,
  reconCsvFilename,
  reconResultFromUpstream,
  reconStatusHue,
  reconVariance,
  type ReconPosition,
} from "@/lib/data/acat-security-recon-contract";
import {
  acatSecurityReconEnabled,
  epicAcatSecurityReconEnabled,
  showAcatSecurityReconEnabled,
} from "@/lib/flags";

const SUITE = "acat-security-recon-contract";

const DRAWER_ENV: Record<string, string> = {
  EPIC_ACAT_OPS_WORKSPACE_TKT290: "1",
  SHOW_ACAT_OPS_BOOK_TKT293: "1",
  EPIC_ACAT_TRANSFER_DRAWER_TKT319: "1",
  SHOW_ACAT_TRANSFER_DRAWER_TKT332: "1",
};
const RECON_ENV: Record<string, string> = {
  EPIC_ACAT_SECURITY_RECON_TKT320: "1",
  SHOW_ACAT_SECURITY_RECON_TKT334: "1",
};

function stubAll(env: Record<string, string>) {
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
}

afterEach(() => { vi.unstubAllEnvs(); });

const MAPPING = {
  mappingTransferStatus: "Transferable",
  mappingTransferNotes: "Move in kind",
  mappingTransferring: true,
  mappingStatementDate: "2026-09-30",
  mappingStatementAgeDays: 12,
  mappingStatementIsStale: false,
  mappingSyncedAt: "2026-10-12T15:04:00.000Z",
};

function rawPosition(over: Record<string, unknown> = {}) {
  return {
    id: "asset-1", symbol: "VTI", description: "Vanguard Total Market", cusip: "922908769", expectedQty: 100,
    actualQty: 100, amount: 25000, assetClass: "ETF", status: "Matched", issue: null, notes: null,
    mapping: { id: "asset-1", symbol: "VTI", mapStatus: "Mapped", extra: "ignored", ...MAPPING },
    ...over,
  };
}

function rawSnapshot(over: Record<string, unknown> = {}) {
  return {
    acatId: "rec-1", mappingSource: "GCP Project API", apexSource: "Uploaded", lastSynced: "2026-10-12T15:04:00.000Z",
    sourceAccount: {
      id: "src-1", clientName: "Pat Example", holder: "Pat Example", registration: "Individual", custodian: "Fidelity",
      accountNumberLast4: "4321", statementDate: "2026-09-30", isHistorical: false,
    },
    hasStatementAccount: true,
    positions: [rawPosition()],
    counts: { total: 1, matched: 1, issues: 0, reconRate: 100 },
    unknownKey: "ignored",
    ...over,
  };
}

function position(over: Partial<ReconPosition> = {}): ReconPosition {
  const mapped = mapReconSnapshot(rawSnapshot({ positions: [rawPosition()] }))!.positions[0];
  return { ...mapped, ...over };
}

describe("security recon flags", () => {
  it("tkt334 flags: both switches and the drawer are required, exact 1 only", () => {
    stubAll({ ...DRAWER_ENV, ...RECON_ENV });
    expect(epicAcatSecurityReconEnabled()).toBe(true);
    expect(showAcatSecurityReconEnabled()).toBe(true);
    expect(acatSecurityReconEnabled()).toBe(true);
    for (const key of Object.keys({ ...DRAWER_ENV, ...RECON_ENV })) {
      for (const bad of ["true", "01", " 1", "0", "", "yes"]) {
        vi.stubEnv(key, bad);
        expect(acatSecurityReconEnabled()).toBe(false);
      }
      vi.stubEnv(key, "1");
    }
    vi.unstubAllEnvs();
    stubAll(DRAWER_ENV);
    expect(acatSecurityReconEnabled()).toBe(false);
    markCase(SUITE, "tkt334 flags: both switches and the drawer are required, exact 1 only");
  });

  it("tkt334 flags: the section is off while the drawer is off", () => {
    stubAll(RECON_ENV);
    expect(epicAcatSecurityReconEnabled()).toBe(true);
    expect(showAcatSecurityReconEnabled()).toBe(true);
    expect(acatSecurityReconEnabled()).toBe(false);
    stubAll({ ...DRAWER_ENV, SHOW_ACAT_TRANSFER_DRAWER_TKT332: "0" });
    expect(acatSecurityReconEnabled()).toBe(false);
    markCase(SUITE, "tkt334 flags: the section is off while the drawer is off");
  });
});

describe("security recon contract", () => {
  it("tkt334 contract: a tracker snapshot maps with positions, counts, source account, and mapping fields", () => {
    const snapshot = mapReconSnapshot(rawSnapshot())!;
    expect(snapshot.acatId).toBe("rec-1");
    expect(snapshot.mappingSource).toBe("GCP Project API");
    expect(snapshot.apexSource).toBe("Uploaded");
    expect(snapshot.lastSynced).toBe("2026-10-12T15:04:00.000Z");
    expect(snapshot.hasStatementAccount).toBe(true);
    expect(snapshot.counts).toEqual({ total: 1, matched: 1, issues: 0, reconRate: 100 });
    expect(snapshot.sourceAccount).toEqual({
      id: "src-1", clientName: "Pat Example", holder: "Pat Example", registration: "Individual", custodian: "Fidelity",
      accountNumberLast4: "4321", statementDate: "2026-09-30", isHistorical: false,
    });
    expect(snapshot.positions[0]).toEqual({
      id: "asset-1", symbol: "VTI", description: "Vanguard Total Market", cusip: "922908769", expectedQty: 100,
      actualQty: 100, amount: 25000, assetClass: "ETF", status: "Matched", issue: null, notes: null,
      mapping: MAPPING,
    });
    expect(JSON.stringify(snapshot)).not.toContain("ignored");
    markCase(SUITE, "tkt334 contract: a tracker snapshot maps with positions, counts, source account, and mapping fields");
  });

  it("tkt334 contract: a snapshot with a missing id, a bad status, no counts, or a row without a symbol or description maps to null", () => {
    expect(mapReconSnapshot(null)).toBeNull();
    expect(mapReconSnapshot(rawSnapshot({ acatId: "" }))).toBeNull();
    expect(mapReconSnapshot(rawSnapshot({ acatId: undefined }))).toBeNull();
    expect(mapReconSnapshot(rawSnapshot({ positions: "nope" }))).toBeNull();
    expect(mapReconSnapshot(rawSnapshot({ positions: [rawPosition({ status: "Mapped" })] }))).toBeNull();
    expect(mapReconSnapshot(rawSnapshot({ counts: { total: 1 } }))).toBeNull();
    expect(mapReconSnapshot(rawSnapshot({ counts: undefined }))).toBeNull();
    expect(mapReconSnapshot(rawSnapshot({ positions: [rawPosition({ symbol: undefined })] }))).toBeNull();
    expect(mapReconSnapshot(rawSnapshot({ positions: [rawPosition({ description: null })] }))).toBeNull();
    expect(mapReconSnapshot(rawSnapshot({ positions: [rawPosition({ actualQty: "100" })] }))).toBeNull();
    markCase(SUITE, "tkt334 contract: a snapshot with a missing id, a bad status, no counts, or a row without a symbol or description maps to null");
  });

  it("tkt334 contract: an empty transfer maps to no positions", () => {
    const snapshot = mapReconSnapshot(rawSnapshot({
      positions: [], counts: { total: 0, matched: 0, issues: 0, reconRate: 0 }, sourceAccount: null, hasStatementAccount: false,
      mappingSource: null, lastSynced: null,
    }))!;
    expect(snapshot.positions).toEqual([]);
    expect(snapshot.sourceAccount).toBeNull();
    expect(snapshot.hasStatementAccount).toBe(false);
    expect(snapshot.lastSynced).toBeNull();
    markCase(SUITE, "tkt334 contract: an empty transfer maps to no positions");
  });

  it("tkt334 contract: a preview maps with its format and counts", () => {
    const preview = mapReconPreview({
      apexFormat: "activities", positions: [rawPosition({ id: "apex-extra-0", status: "Unexpected" })],
      counts: { total: 1, matched: 0, issues: 1, reconRate: 0 },
    })!;
    expect(preview.apexFormat).toBe("activities");
    expect(preview.positions[0].status).toBe("Unexpected");
    expect(preview.counts.issues).toBe(1);
    expect(mapReconPreview({ apexFormat: "csv", positions: [], counts: { total: 0, matched: 0, issues: 0, reconRate: 0 } })).toBeNull();
    expect(mapReconPreview({ apexFormat: "acat", positions: [], counts: null })).toBeNull();
    markCase(SUITE, "tkt334 contract: a preview maps with its format and counts");
  });

  it("tkt334 contract: the seven statuses take the tracker hues", () => {
    expect([...RECON_STATUSES]).toEqual(["Matched", "Mismatch", "Missing", "Unexpected", "Pending", "Expected", "Info"]);
    expect(reconStatusHue("Matched")).toBe("emerald");
    expect(reconStatusHue("Info")).toBe("emerald");
    expect(reconStatusHue("Pending")).toBe("blue");
    expect(reconStatusHue("Expected")).toBe("violet");
    expect(reconStatusHue("Mismatch")).toBe("amber");
    expect(reconStatusHue("Missing")).toBe("amber");
    expect(reconStatusHue("Unexpected")).toBe("amber");
    markCase(SUITE, "tkt334 contract: the seven statuses take the tracker hues");
  });

  it("tkt334 contract: upload requests refuse non-csv, a large mapping file, a missing statement account", () => {
    const base = { filename: "map.csv", text: "a,b\n1,2\n", size: 10, hasStatementAccount: true };
    expect(buildUploadRequest({ ...base, kind: "mapping" })).toEqual({
      ok: true, body: { action: "upload", kind: "mapping", filename: "map.csv", text: base.text },
    });
    expect(buildUploadRequest({ ...base, kind: "apex", filename: "ACTIVITY.CSV" }).ok).toBe(true);
    expect(buildUploadRequest({ ...base, kind: "apex", filename: "notes.txt" })).toEqual({ ok: false, reason: RECON_NOT_CSV });
    expect(buildUploadRequest({ ...base, kind: "mapping", size: 2 * 1024 * 1024 + 1 })).toEqual({ ok: false, reason: RECON_MAPPING_TOO_LARGE });
    expect(buildUploadRequest({ ...base, kind: "mapping", size: 2 * 1024 * 1024 }).ok).toBe(true);
    expect(buildUploadRequest({ ...base, kind: "mapping", hasStatementAccount: false })).toEqual({ ok: false, reason: RECON_NO_STATEMENT });
    expect(buildUploadRequest({ ...base, kind: "apex", hasStatementAccount: false, size: 5 * 1024 * 1024 }).ok).toBe(true);
    expect(buildUploadRequest({ ...base, kind: "apex", text: "x".repeat(5_000_001) })).toEqual({ ok: false, reason: RECON_INVALID });
    markCase(SUITE, "tkt334 contract: upload requests refuse non-csv, a large mapping file, a missing statement account");
  });

  it("tkt334 contract: a save sends only the tracker fields and the overridden ids", () => {
    const row = position({ id: "apex-extra-1", status: "Unexpected", issue: "Not in expected positions", notes: "checked", expectedQty: 0 });
    const built = buildSaveRequest({ rows: [row], apexUploaded: true, overriddenIds: ["apex-extra-1", "apex-extra-1"] });
    expect(built).toEqual({
      ok: true,
      body: {
        action: "save",
        rows: [{
          id: "apex-extra-1", symbol: "VTI", description: "Vanguard Total Market", cusip: "922908769", actualQty: 100,
          amount: 25000, assetClass: "ETF", status: "Unexpected", issue: "Not in expected positions", notes: "checked",
        }],
        apexUploaded: true,
        overriddenIds: ["apex-extra-1"],
      },
    });
    const sent = JSON.stringify(built);
    expect(sent).not.toContain("expectedQty");
    expect(sent).not.toContain("mapping");
    markCase(SUITE, "tkt334 contract: a save sends only the tracker fields and the overridden ids");
  });

  it("tkt334 contract: a save refuses more than 500 rows or a non-finite quantity and allows an empty grid", () => {
    expect(buildSaveRequest({ rows: Array.from({ length: 501 }, (_, i) => position({ id: `a${i}` })), apexUploaded: false, overriddenIds: [] }))
      .toEqual({ ok: false, reason: RECON_INVALID });
    expect(buildSaveRequest({ rows: Array.from({ length: 500 }, (_, i) => position({ id: `a${i}` })), apexUploaded: false, overriddenIds: [] }).ok).toBe(true);
    expect(buildSaveRequest({ rows: [position({ actualQty: Number.NaN })], apexUploaded: false, overriddenIds: [] }))
      .toEqual({ ok: false, reason: RECON_INVALID });
    expect(buildSaveRequest({ rows: [position()], apexUploaded: false, overriddenIds: Array.from({ length: 501 }, (_, i) => `x${i}`) }).ok).toBe(false);
    expect(buildSaveRequest({ rows: [], apexUploaded: true, overriddenIds: [] })).toEqual({
      ok: true, body: { action: "save", rows: [], apexUploaded: true, overriddenIds: [] },
    });
    markCase(SUITE, "tkt334 contract: a save refuses more than 500 rows or a non-finite quantity and allows an empty grid");
  });

  it("tkt334 contract: cash formatting and variance follow the tracker", () => {
    expect(isCashSymbol("CASH")).toBe(true);
    expect(isCashSymbol("usd")).toBe(true);
    expect(isCashSymbol("BRK.B")).toBe(false);
    expect(formatReconCash(1234.5)).toBe("$1,234.50");
    expect(formatReconCash(-12.345)).toBe("-$12.35");
    expect(formatReconCash(5, true)).toBe("+$5.00");
    expect(formatReconCash(-5, true)).toBe("-$5.00");
    expect(reconVariance({ actualQty: 90, expectedQty: 100 })).toBe(-10);
    expect(reconVariance({ actualQty: 100.5, expectedQty: 100 })).toBe(0.5);
    markCase(SUITE, "tkt334 contract: cash formatting and variance follow the tracker");
  });

  it("tkt334 contract: the sync time shows Not yet recorded for a blank or unparsable value", () => {
    expect(formatMappingSync(null)).toBe("Not yet recorded");
    expect(formatMappingSync("")).toBe("Not yet recorded");
    expect(formatMappingSync("not a date")).toBe("Not yet recorded");
    const shown = formatMappingSync("2026-10-12T15:04:00.000Z");
    expect(shown).not.toBe("Not yet recorded");
    expect(shown).toBe(new Date("2026-10-12T15:04:00.000Z").toLocaleString("en-US", {
      month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
    }));
    markCase(SUITE, "tkt334 contract: the sync time shows Not yet recorded for a blank or unparsable value");
  });

  it("tkt334 contract: the csv has the tracker header, escaping, and all 600 rows of a long grid", () => {
    const rows = Array.from({ length: 600 }, (_, i) => position({
      id: `a${i}`, symbol: `S${i}`, description: i === 0 ? 'Fund, "A"' : `Fund ${i}`, expectedQty: i + 1, actualQty: i,
    }));
    const csv = buildReconCsv(rows);
    const lines = csv.split("\n");
    expect(lines[0]).toBe([
      "Symbol", "Description", "CUSIP", "Expected Qty (DB)", "Actual Qty (Apex)", "Variance", "Status", "Issue", "Notes",
      "Transfer Eligibility", "Transfer Eligibility Notes", "Transferring? (Asset Mapping)", "Statement Date",
      "Reported Statement Age (Days)", "Reported Statement Stale", "Asset Mapping Synced At",
    ].join(","));
    expect(lines).toHaveLength(601);
    expect(lines[1]).toBe('S0,"Fund, ""A""",922908769,1,0,-1,Matched,,,Transferable,Move in kind,Yes,2026-09-30,12,No,2026-10-12T15:04:00.000Z');
    expect(lines[600].startsWith("S599,Fund 599,")).toBe(true);
    expect(buildReconCsv([])).toBe(lines[0]);
    const noMapping = buildReconCsv([position({ mapping: {
      mappingTransferStatus: null, mappingTransferNotes: null, mappingTransferring: null, mappingStatementDate: null,
      mappingStatementAgeDays: null, mappingStatementIsStale: null, mappingSyncedAt: null,
    }, cusip: null })]).split("\n")[1];
    expect(noMapping).toBe("VTI,Vanguard Total Market,,100,100,0,Matched,,,,,,,,,");
    markCase(SUITE, "tkt334 contract: the csv has the tracker header, escaping, and all 600 rows of a long grid");
  });

  it("tkt334 contract: the csv file name uses the control number or the client slug", () => {
    const now = new Date("2026-10-13T20:00:00.000Z");
    expect(reconCsvFilename({ controlNumber: "CTRL-9", clientName: "Pat Example" }, now)).toBe("acat-CTRL-9-recon-2026-10-13.csv");
    expect(reconCsvFilename({ controlNumber: "", clientName: "Pat O'Example Jr." }, now)).toBe("acat-pat-o-example-jr--recon-2026-10-13.csv");
    markCase(SUITE, "tkt334 contract: the csv file name uses the control number or the client slug");
  });

  it("tkt334 contract: tracker outcomes become ok, refused with positions, or an opaque failure", () => {
    const ok = reconResultFromUpstream({ status: 200, data: rawSnapshot(), refusal: null });
    expect(ok.ok && ok.preview).toBeNull();
    const withPreview = reconResultFromUpstream({
      status: 200,
      data: { ...rawSnapshot(), preview: { apexFormat: "acat", positions: [rawPosition()], counts: { total: 1, matched: 1, issues: 0, reconRate: 100 } } },
      refusal: null,
    });
    expect(withPreview.ok && withPreview.preview?.apexFormat).toBe("acat");
    for (const status of [400, 404, 409, 422, 502, 503]) {
      const refused = reconResultFromUpstream({ status, data: rawSnapshot(), refusal: "The tracker said no" });
      expect(refused).toMatchObject({ ok: false, refused: true, status, message: "The tracker said no" });
      expect(!refused.ok && refused.refused && refused.snapshot.positions).toHaveLength(1);
    }
    const opaque = [
      { status: 500, data: { error: "internal_error" }, refusal: null },
      { status: 401, data: { error: "unauthorized" }, refusal: null },
      { status: 429, data: { error: "rate_limited" }, refusal: null },
      { status: 404, data: { error: "not_found" }, refusal: null },
      { status: 422, data: rawSnapshot(), refusal: null },
      { status: 500, data: rawSnapshot(), refusal: "tracker failure text" },
      { status: 200, data: { nope: true }, refusal: null },
      { status: null, data: null, refusal: null },
    ].map((input) => reconResultFromUpstream(input));
    for (const result of opaque) {
      expect(result).toMatchObject({ ok: false, refused: false, reason: RECON_UNAVAILABLE });
      expect(JSON.stringify(result)).not.toContain("positions");
    }
    expect(opaque.map((r) => !r.ok && !r.refused && r.retryable)).toEqual([true, false, true, false, false, true, false, true]);
    markCase(SUITE, "tkt334 contract: tracker outcomes become ok, refused with positions, or an opaque failure");
  });

  it("tkt334 contract: the route envelope parses to ok, refused, failure, or an unavailable fallback", () => {
    const snapshot = rawSnapshot();
    const ok = parseReconEnvelope(200, { ok: true, snapshot });
    expect(ok.ok && ok.snapshot.acatId).toBe("rec-1");
    expect(ok.ok && ok.preview).toBeNull();
    const withPreview = parseReconEnvelope(200, {
      ok: true, snapshot, preview: { apexFormat: "activities", positions: [], counts: { total: 0, matched: 0, issues: 0, reconRate: 0 } },
    });
    expect(withPreview.ok && withPreview.preview?.apexFormat).toBe("activities");
    expect(parseReconEnvelope(200, { ok: false, refused: true, status: 409, message: "Choose the source account", snapshot }))
      .toMatchObject({ ok: false, refused: true, status: 409, message: "Choose the source account" });
    expect(parseReconEnvelope(502, { ok: false, refused: false, reason: "Try again", retryable: true }))
      .toEqual({ ok: false, refused: false, reason: "Try again", retryable: true });
    expect(parseReconEnvelope(422, { ok: false, refused: false, reason: "Final", retryable: false }))
      .toEqual({ ok: false, refused: false, reason: "Final", retryable: false });
    for (const bad of [null, "<html>sign in</html>", { error: "not_found" }, { ok: true }, { ok: true, snapshot: { acatId: "x" } },
      { ok: false, refused: true, message: "m", status: 404 }, { ok: false, refused: false }]) {
      expect(parseReconEnvelope(200, bad)).toEqual({ ok: false, refused: false, reason: RECON_UNAVAILABLE, retryable: true });
    }
    markCase(SUITE, "tkt334 contract: the route envelope parses to ok, refused, failure, or an unavailable fallback");
  });

  it("tkt334 contract: account results map from the tracker body, rows without an id are dropped, and the accounts envelope parses to ok, failure, or the fallback", () => {
    const account = {
      id: "src-1", clientName: "Pat Example", holder: "Pat Example", custodian: "Fidelity", registration: "Individual",
      accountNumberLast4: "4321", investorNumberLast4: null, statementDate: "2026-09-30", isHistorical: true, positionCount: 12, extra: 1,
    };
    const mapped = parseReconAccounts({ accounts: [account, { clientName: "No id" }, null], truncated: true })!;
    expect(mapped.truncated).toBe(true);
    expect(mapped.accounts).toEqual([{
      id: "src-1", clientName: "Pat Example", holder: "Pat Example", custodian: "Fidelity", registration: "Individual",
      accountNumberLast4: "4321", investorNumberLast4: null, statementDate: "2026-09-30", isHistorical: true, positionCount: 12,
    }]);
    expect(parseReconAccounts({ accounts: "x" })).toBeNull();
    expect(parseAccountsEnvelope(200, { ok: true, accounts: [account], truncated: false }))
      .toMatchObject({ ok: true, truncated: false, accounts: [{ id: "src-1" }] });
    expect(parseAccountsEnvelope(200, { ok: true, accounts: [], truncated: false })).toEqual({ ok: true, accounts: [], truncated: false });
    expect(parseAccountsEnvelope(400, { ok: false, reason: "Enter a client name", retryable: false }))
      .toEqual({ ok: false, reason: "Enter a client name", retryable: false });
    for (const bad of [null, "<html/>", { ok: true }, { error: "not_found" }]) {
      expect(parseAccountsEnvelope(200, bad)).toEqual({ ok: false, reason: RECON_ACCOUNTS_FAILURE, retryable: true });
    }
    markCase(SUITE, "tkt334 contract: account results map from the tracker body, rows without an id are dropped, and the accounts envelope parses to ok, failure, or the fallback");
  });
});
