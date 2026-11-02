import { describe, it, expect, vi, afterEach } from "vitest";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

vi.mock("server-only", () => ({}));
import { RUNTIME_WAREHOUSE_CARD_IDS } from "@/lib/warehouse/client";
import { TRADE_REQUEST_WAREHOUSE_CARD_IDS } from "@/lib/trade-requests/sources/warehouse";

// ticket structural guards for the ported drift code.
const ROOT = process.cwd();
const PORTED = ["lib/trade-requests/drift", "lib/trade-requests/sources", "app/api/trade-requests/drift", "app/api/cron/trade-request-drift"];
const files = (dirs: string[], ext: RegExp) =>
  dirs.flatMap((d) =>
    fs.readdirSync(path.join(ROOT, d), { recursive: true }).map(String).filter((f) => ext.test(f)).map((f) => path.join(d, f)),
  );
const CATALOG = ["users", "clients", "accounts", "trade_requests", "audit_logs", "notifications", "client_exclusions", "account_exclusions", "digest_runs", "registry_drift_runs", "position_drift_accounts", "drift_alert_sends", "drift_status_overrides", "security_sector"];
// Whole-file, case-insensitive: a keyword at the end of one line and the table on the next is still caught.
const UNQUALIFIED = new RegExp(`\\b(FROM|JOIN|INTO|UPDATE|TRUNCATE(?:\\s+TABLE)?)\\s+(${CATALOG.join("|")})\\b`, "gi");
// sha256 prefixes of client-like names removed from the standalone fixtures by the port (never the names).
const REMOVED_NAME_HASHES = new Set(["890dc1c865ef00f6", "c17323fc0b1bab00", "807a09440428c0a8", "4acea7f8ec4ebd3b", "39fdbdb8ddf75a00", "25fe55d1ddd96912", "64d1db7d4a686c95", "ffa7b8b8e80a9879", "208ad55e4c4200ca", "0522a55e2d5f0993", "919e680ee460849a", "0b25af3500b177e7", "d743dbca8fb5f001", "94aec9fbed989ece", "21dafa5eab70fe93", "e7f0293cfebd9a0b", "1c805fb986d76594", "dbb27d214f4d08c4", "bc12b8f31ccdb4f7", "0357513deb903a05", "5d702eb07928ed7b", "205556f14222038a", "8ce1256e785e2c8a"]);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("drift port guards", () => {
  it("qualifies every Trade Request catalog table in ported SQL with trade_request.", () => {
    const hits = files(PORTED, /\.ts$/).flatMap((f) => {
      const text = fs.readFileSync(path.join(ROOT, f), "utf8");
      return [...text.matchAll(UNQUALIFIED)].map((m) => `${f}:${text.slice(0, m.index).split("\n").length}`);
    });
    expect(hits).toEqual([]);
    expect("SELECT 1 FROM\n  position_drift_accounts".match(UNQUALIFIED)).not.toBeNull();
  });

  it("ports nothing from the execution-plan registry or the asset location engine", () => {
    const forbidden = /(?:from|import\()\s*['"][^'"]*(?:meridian-?registry|\/registry-?drift['"]|registry-?drift-?alert|asset-?location)/i;
    const hits = files(PORTED, /\.ts$/).filter((f) => forbidden.test(fs.readFileSync(path.join(ROOT, f), "utf8")));
    expect(hits).toEqual([]);
  });

  it("allows only the reviewed Trade Request cards, all of them in the runtime card allowlist", () => {
    expect([...TRADE_REQUEST_WAREHOUSE_CARD_IDS]).toEqual([6043, 6040, 6042, 6139]);
    for (const id of TRADE_REQUEST_WAREHOUSE_CARD_IDS) expect(RUNTIME_WAREHOUSE_CARD_IDS as readonly number[]).toContain(id);
  });

  it("refuses an unlisted card (both card transports), a non-HTTPS Warehouse URL and an unlisted warehouse database before any request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    process.env.WAREHOUSE_API_KEY = "test-key";
    process.env.WAREHOUSE_URL = "https://warehouse.example.test";
    process.env.WAREHOUSE_BALANCES_QUESTION_ID = "9998";
    process.env.WAREHOUSE_STOCK_RECORD_QUESTION_ID = "9999";
    let mb = await import("@/lib/trade-requests/sources/warehouse");
    await expect(mb.fetchAccountPositions()).rejects.toThrow(/not allowed/);
    process.env.WAREHOUSE_COST_BASIS_DB_ID = "7";
    vi.resetModules();
    mb = await import("@/lib/trade-requests/sources/warehouse");
    await expect(mb.fetchOwnershipTypes()).rejects.toThrow(/database 7 is not allowed/);
    process.env.WAREHOUSE_CONTACTS_QUESTION_ID = "9997";
    process.env.WAREHOUSE_INVESTMENTS_QUESTION_ID = "9996";
    await expect(mb.getMachineAccountIdMap(["ACCT-1"])).rejects.toThrow(/unavailable/);
    process.env.WAREHOUSE_URL = "http://warehouse.example.test";
    process.env.WAREHOUSE_STOCK_RECORD_QUESTION_ID = "6139";
    process.env.WAREHOUSE_BALANCES_QUESTION_ID = "6042";
    await expect(mb.fetchAccountPositions()).rejects.toThrow(/HTTPS/);
    expect(fetchMock).not.toHaveBeenCalled();
    for (const k of ["WAREHOUSE_API_KEY", "WAREHOUSE_URL", "WAREHOUSE_BALANCES_QUESTION_ID", "WAREHOUSE_STOCK_RECORD_QUESTION_ID", "WAREHOUSE_COST_BASIS_DB_ID", "WAREHOUSE_CONTACTS_QUESTION_ID", "WAREHOUSE_INVESTMENTS_QUESTION_ID"]) delete process.env[k];
  });

  it("carries none of the client-like names removed from the standalone sources and fixtures", () => {
    const scanned = files([...PORTED.slice(0, 2), "test/trade-request-drift"], /\.(ts|json)$/);
    const hits = scanned.filter((f) =>
      (fs.readFileSync(path.join(ROOT, f), "utf8").match(/[A-Za-z]+/g) ?? []).some((w) => REMOVED_NAME_HASHES.has(createHash("sha256").update(w.toLowerCase()).digest("hex").slice(0, 16))),
    );
    expect(scanned.length).toBeGreaterThan(40);
    expect(hits).toEqual([]);
  });

  it("logs no account identifier or validation detail", async () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { default: logger } = await import("@/lib/trade-requests/log");
    logger.warn(
      {
        event: "drift_balance_mismatch",
        accountId: "01SYNTH14F7HAYDP2AD4SNVNAX",
        account: "EXT-ACCT-1",
        external_account_no: "EXT-ACCT-2",
        tradingAccountNo: "01SYNTHT9KFB1CZSTTP2VYY61K",
        accounts: [{ tradingAccountNo: "01E", accountTitle: "Sample Client - Brokerage" }],
        errors: [{ received: "x" }],
        unmappedSnapshotAccounts: ["01B", "01C"],
        templateNames: ["Model A"],
        deltaUsd: 3,
        message: "violates check\nFailing row contains (Sample Client)",
      },
      "mismatch",
    );
    const line = String(spy.mock.calls[0][0]);
    for (const leaked of ["01SYNTH14F7HAYDP2AD4SNVNAX", "EXT-ACCT", "53QYQX", "01E", "01B", "Sample Client"]) expect(line).not.toContain(leaked);
    expect(JSON.parse(line)).toMatchObject({
      severity: "WARNING", event: "drift_balance_mismatch", accountId: "[redacted]", account: "[redacted]", external_account_no: "[redacted]",
      tradingAccountNo: "[redacted]", accounts: "[1 redacted]", errors: "[redacted]", unmappedSnapshotAccounts: "[2 redacted]",
      templateNames: ["Model A"], deltaUsd: 3, error_message: "violates check", message: "mismatch",
    });
    spy.mockRestore();
  });
});
