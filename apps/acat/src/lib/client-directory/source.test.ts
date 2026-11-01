// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { DirectorySourceError, fetchDirectoryRows, parseDirectoryRows } from "./source";
import { directoryRows, fingerprint, alice } from "./test-fixtures";

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("directory source integrity", () => {
  it("accepts legacy v1 client rows without CRM stage metadata", () => {
    expect(parseDirectoryRows(directoryRows()).clients.map((client) => client.crmStage)).toEqual([null, null]);
  });
  it.each([
    ["Client", "Client"], [" Lost Client ", "Lost Client"], ["Prospect", "Prospect"],
    [null, null], ["", null], [" \t ", null],
  ])("normalizes optional CRM stage %s without changing client eligibility or population", (stage, expected) => {
    const rows = directoryRows();
    rows[1].crm_stage = stage;
    const snapshot = parseDirectoryRows(rows);
    expect(snapshot.clients).toHaveLength(2);
    expect(snapshot.clients[0]).toMatchObject({ crmStage: expected, eligibility: "ACTIVE" });
    expect(snapshot.accounts).toHaveLength(1);
    expect(snapshot.memberships).toHaveLength(2);
  });
  it("includes a normalized stage change in the snapshot digest without altering other source facts", () => {
    const rows = directoryRows();
    const legacy = parseDirectoryRows(rows);
    rows[1].crm_stage = null;
    expect(parseDirectoryRows(rows).digest).toBe(legacy.digest);
    rows[1].crm_stage = "Client";
    const current = parseDirectoryRows(rows);
    expect(current.digest).not.toBe(legacy.digest);
    rows[1].crm_stage = " Client ";
    expect(parseDirectoryRows(rows).digest).toBe(current.digest);
    rows[1].crm_stage = "Lost Client";
    const lost = parseDirectoryRows(rows);
    expect(lost.digest).not.toBe(current.digest);
    const withoutStages = (snapshot: typeof current) => snapshot.clients.map((client) => ({ ...client, crmStage: null }));
    expect(withoutStages(lost)).toEqual(withoutStages(legacy));
    expect(lost.accounts).toEqual(legacy.accounts);
    expect(lost.memberships).toEqual(legacy.memberships);
  });
  it("keeps duplicate names and every joint member while preserving leading zero account numbers", () => {
    const snapshot = parseDirectoryRows(directoryRows());
    expect(snapshot.clients).toHaveLength(2);
    expect(snapshot.memberships).toHaveLength(2);
    expect(snapshot.accounts[0]).toMatchObject({ normalizedAccountNumber: "001ABC12", status: "OPEN" });
    expect(snapshot.digest).toBe(parseDirectoryRows(directoryRows(snapshot.sourceAsOf!)).digest);
    expect(parseDirectoryRows(directoryRows(snapshot.sourceAsOf!).reverse()).digest).toBe(snapshot.digest);
  });
  it.each([
    ["SOURCE_MANIFEST", (rows: Array<Record<string, unknown>>) => rows.filter((r) => r.row_kind !== "manifest")],
    ["SOURCE_MANIFEST", (rows: Array<Record<string, unknown>>) => [...rows, rows[0]]],
    ["SOURCE_EMPTY", (rows: Array<Record<string, unknown>>) => [rows[0]]],
    ["SOURCE_INCOMPLETE", (rows: Array<Record<string, unknown>>) => rows.slice(0, -1)],
    ["SOURCE_DUPLICATE_CLIENT", (rows: Array<Record<string, unknown>>) => { rows[2].cedar_ridge_user_id = alice; return rows; }],
    ["SOURCE_ORPHAN_MEMBERSHIP", (rows: Array<Record<string, unknown>>) => { rows[5].investment_account_id = "missing"; return rows; }],
    ["SOURCE_DUPLICATE_MEMBERSHIP", (rows: Array<Record<string, unknown>>) => { rows[5] = rows[4]; return rows; }],
    ["SOURCE_SHAPE", (rows: Array<Record<string, unknown>>) => { rows[0].complete = false; return rows; }],
    ["SOURCE_SHAPE", (rows: Array<Record<string, unknown>>) => { rows[0].expected_accounts = true; return rows; }],
    ["SOURCE_SHAPE", (rows: Array<Record<string, unknown>>) => { rows[1].cedar_ridge_user_id = "person-123"; return rows; }],
    ["SOURCE_SHAPE", (rows: Array<Record<string, unknown>>) => { rows[1].crm_stage = 123; return rows; }],
    ["SOURCE_SHAPE", (rows: Array<Record<string, unknown>>) => { rows[1].crm_stage = "x".repeat(501); return rows; }],
  ])("rejects %s", (code, change) => {
    expect(() => parseDirectoryRows(change(directoryRows()))).toThrow(code);
  });
  it("rejects collisions in account numbers without selecting an arbitrary account", () => {
    const rows = directoryRows(); rows[0].expected_accounts = 2;
    rows.push({ ...rows[3], investment_account_id: "different-account", account_number: "001abc12" });
    expect(() => parseDirectoryRows(rows)).toThrow("SOURCE_ACCOUNT_COLLISION");
  });
  it("normalizes timestamps by instant and does not infer freshness from fetch time", () => {
    const rows = directoryRows("2026-09-25T09:00:00-04:00");
    rows[0].source_health = "UNKNOWN"; rows[1].source_updated_at = "2026-07-02T10:00:00-04:00";
    const snapshot = parseDirectoryRows(rows);
    expect(snapshot.sourceHealth).toBe("UNKNOWN");
    expect(snapshot.sourceAsOf).toBe("2026-09-25T13:00:00.000Z");
    expect(snapshot.clients[0].sourceUpdatedAt).toBe("2026-07-02T14:00:00.000Z");
  });
});

function configure() {
  vi.stubEnv("CLIENT_DIRECTORY_WAREHOUSE_URL", "https://warehouse.example.test");
  vi.stubEnv("CLIENT_DIRECTORY_WAREHOUSE_API_KEY", "synthetic-private-key");
  vi.stubEnv("CLIENT_DIRECTORY_WAREHOUSE_CARD_ID", "123");
  vi.stubEnv("CLIENT_DIRECTORY_QUERY_FINGERPRINT", fingerprint);
}
describe("saved-card transport", () => {
  it("fails closed without runtime credentials", async () => {
    vi.stubEnv("CLIENT_DIRECTORY_WAREHOUSE_API_KEY", "");
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    await expect(fetchDirectoryRows()).rejects.toThrow("SOURCE_NOT_CONFIGURED");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("uses only its configured saved question and prohibits credential redirects", async () => {
    configure(); const fetch = vi.fn().mockResolvedValue(Response.json(directoryRows())); vi.stubGlobal("fetch", fetch);
    await fetchDirectoryRows();
    expect(fetch.mock.calls[0][0].toString()).toBe("https://warehouse.example.test/api/card/123/query/json");
    expect(fetch.mock.calls[0][1]).toMatchObject({ method: "POST", body: JSON.stringify({ format_rows: false }), cache: "no-store", redirect: "error" });
  });
  it.each(["http://warehouse.example.test", "https://user:password@warehouse.example.test", "https://warehouse.example.test?token=private"]) (
    "refuses unsafe source URL %s", async (url) => {
      configure(); vi.stubEnv("CLIENT_DIRECTORY_WAREHOUSE_URL", url);
      await expect(fetchDirectoryRows()).rejects.toThrow("SOURCE_NOT_CONFIGURED");
    });
  it("rejects changed provenance and partial/unparseable exports without leaking provider text", async () => {
    configure(); vi.stubEnv("CLIENT_DIRECTORY_QUERY_FINGERPRINT", "b".repeat(64));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(directoryRows())));
    await expect(fetchDirectoryRows()).rejects.toThrow("SOURCE_QUERY_CHANGED");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("private upstream error", { status: 500 })));
    await expect(fetchDirectoryRows()).rejects.toEqual(new DirectorySourceError("SOURCE_HTTP_ERROR"));
  });
  it("caps body size before accepting any snapshot", async () => {
    configure(); vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("[]", { headers: { "content-length": "10485761" } })));
    await expect(fetchDirectoryRows()).rejects.toThrow("SOURCE_TOO_LARGE");
  });
  it("aborts after 30 seconds", async () => {
    configure(); vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn((_url, options: RequestInit) => new Promise((_resolve, reject) => {
      options.signal!.addEventListener("abort", () => reject(new Error("aborted")));
    })));
    const result = expect(fetchDirectoryRows()).rejects.toThrow("SOURCE_TIMEOUT");
    await vi.advanceTimersByTimeAsync(30_000); await result;
  });
});
