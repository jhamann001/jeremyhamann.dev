import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  queryWarehouseCard,
  RUNTIME_WAREHOUSE_CARD_IDS,
  type RuntimeWarehouseCardId,
} from "@/lib/warehouse/client";

const makeError = (reason: "config_error" | "warehouse_error", message: string) =>
  Object.assign(new Error(message), { reason });

describe("runtime Warehouse boundary", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    process.env.WAREHOUSE_URL = "https://warehouse.example";
    process.env.WAREHOUSE_API_KEY = "secret-key";
    fetchMock.mockReset();
  });

  afterEach(() => vi.unstubAllGlobals());

  it("keeps the runtime Warehouse card allowlist explicit and bounded", () => {
    expect(RUNTIME_WAREHOUSE_CARD_IDS).toEqual([
      6469, 6470, 6471, 6472, 6502, 6634, 6601, 6700, 6898, 6899,
      6043, 6040, 6042, 6139,
    ]);
  });

  it("rejects a card outside the reviewed runtime allowlist before any request", async () => {
    await expect(
      queryWarehouseCard(
        9999 as RuntimeWarehouseCardId,
        [],
        "test:warehouse",
        makeError,
      ),
    ).rejects.toMatchObject({ reason: "warehouse_error" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("constructs only the fixed saved-card query endpoint and parameter body", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => [],
    } as unknown as Response);

    const parameters = [{ value: "bound-value" }];
    await queryWarehouseCard(6469, parameters, "test:warehouse", makeError);

    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://warehouse.example/api/card/6469/query/json");
    expect(options.method).toBe("POST"); // Warehouse's read-card API uses POST
    expect(options.redirect).toBe("error");
    expect(JSON.parse(options.body as string)).toEqual({ parameters });
  });

  it("refuses to send the API key over a non-HTTPS Warehouse URL", async () => {
    process.env.WAREHOUSE_URL = "http://warehouse.example";
    await expect(
      queryWarehouseCard(6469, [], "test:warehouse", makeError),
    ).rejects.toMatchObject({ reason: "config_error" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
