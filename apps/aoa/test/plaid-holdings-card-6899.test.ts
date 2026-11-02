import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { RUNTIME_WAREHOUSE_CARD_IDS } from "@/lib/warehouse/client";
import {
  fetchLinkedHoldingsPreview,
  HOLDINGS_PREVIEW_CARD_ID,
  HOLDINGS_PREVIEW_EXTERNAL_ACCOUNT_ID_PARAM_ID,
  normalizeHoldingsPreview,
} from "@/lib/data/linked-external-holdings-preview";

const FORBIDDEN = ["access_token", "isin", "cusip", "cost_basis"];

describe("holdings preview card 6899", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("WAREHOUSE_URL", "https://warehouse.example");
    vi.stubEnv("WAREHOUSE_API_KEY", "secret-key");
    fetchMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("is on the runtime allowlist", () => {
    expect(HOLDINGS_PREVIEW_CARD_ID).toBe(6899);
    expect(RUNTIME_WAREHOUSE_CARD_IDS).toContain(6899);
  });

  it("queries only the saved card 6899 endpoint with the external_account_id template tag", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => [] } as unknown as Response);

    await fetchLinkedHoldingsPreview("ext-synthetic-1");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://warehouse.example/api/card/6899/query/json");
    expect(options.method).toBe("POST");
    expect(JSON.parse(options.body as string)).toEqual({
      parameters: [
        {
          id: "fe1f5565-cc0f-4338-865c-bd1a66475f5c",
          type: "string/=",
          target: ["variable", ["template-tag", "external_account_id"]],
          value: "ext-synthetic-1",
        },
      ],
    });
    expect(HOLDINGS_PREVIEW_EXTERNAL_ACCOUNT_ID_PARAM_ID).toBe("fe1f5565-cc0f-4338-865c-bd1a66475f5c");
  });

  it("rejects with warehouse_error on a non-OK response without exposing the body", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    fetchMock.mockResolvedValue({
      ok: false,
      status: 502,
      json: async () => ({ query: "SELECT secret" }),
    } as unknown as Response);

    await expect(fetchLinkedHoldingsPreview("ext-synthetic-1")).rejects.toMatchObject({
      reason: "warehouse_error",
    });
    expect(JSON.stringify(errors.mock.calls)).not.toContain("SELECT");
    errors.mockRestore();
  });

  it("maps ticker, else security_id, security_name, quantity and market_value and drops every other column", () => {
    const result = normalizeHoldingsPreview([
      {
        ticker: "VTI", security_id: "sec-1", security_name: "Vanguard Total", security_type: "etf", quantity: "10.5",
        market_value: "2500.25", institution_price: "238.12", institution_balance: "3000", as_of: "2026-10-01",
        access_token: "access-sandbox-secret", isin: "US0000000001", cusip: "000000001", cost_basis: 1000,
      },
      { ticker: null, security_id: "sec-cash", security_name: "Cash", security_type: "cash", quantity: 499.75, market_value: 499.75 },
    ]);

    expect(result).toEqual({
      asOf: "2026-10-01",
      holdingsTotal: 3000,
      institutionBalance: 3000,
      difference: 0,
      rows: [
        { symbol: "VTI", name: "Vanguard Total", quantity: 10.5, value: 2500.25 },
        { symbol: "sec-cash", name: "Cash", quantity: 499.75, value: 499.75 },
      ],
    });
    const serialized = JSON.stringify(result);
    for (const field of FORBIDDEN) expect(serialized).not.toContain(field);
    expect(serialized).not.toContain("access-sandbox-secret");
    expect(serialized).not.toContain("US0000000001");
  });

  it("withholds the holdings sum and difference when any value is unknown", () => {
    const result = normalizeHoldingsPreview([
      { ticker: "AAA", market_value: 10, institution_balance: 20, institution_price_datetime: "2026-10-02T00:00:00Z" },
      { ticker: "BBB", market_value: null },
    ]);
    expect(result.holdingsTotal).toBeNull();
    expect(result.difference).toBeNull();
    expect(result.institutionBalance).toBe(20);
    expect(result.asOf).toBe("2026-10-02T00:00:00Z");
  });

  it("treats the card's no-holdings row as an empty holdings list, not a holding", () => {
    const result = normalizeHoldingsPreview([
      {
        security_id: null, ticker: null, security_name: null, quantity: null, market_value: null,
        holdings_total: null, institution_balance: "75", as_of: "2026-10-03",
      },
    ]);
    expect(result.rows).toEqual([]);
    expect(result.holdingsTotal).toBe(0);
    expect(result.institutionBalance).toBe(75);
    expect(result.difference).toBe(-75);
    expect(result.asOf).toBe("2026-10-03");
  });

  it("rejects a non-array payload as a Warehouse error shape", () => {
    expect(() => normalizeHoldingsPreview({ error: "boom" })).toThrow(
      expect.objectContaining({ reason: "warehouse_error" }),
    );
  });

  it("has no persistence or logging path in the preview module", () => {
    const source = readFileSync("lib/data/linked-external-holdings-preview.ts", "utf8");
    expect(source).toMatch(/^import "server-only";/);
    expect(source).not.toMatch(/@\/lib\/(rls|db|prisma|audit)|@prisma\/client|asset-mapping|account-aum/);
    expect(source).not.toMatch(/\$executeRaw|\$queryRaw|\.create\(|\.upsert\(|\.update\(/);
    expect(source).not.toMatch(/console\./);
    expect(source).not.toMatch(/\/api\/dataset/);
  });
});
