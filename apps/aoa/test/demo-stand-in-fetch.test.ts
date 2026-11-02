// The demo's stand-in fetch (lib/demo/stand-ins/fetch.ts) given a path it can't decode: a 400, as the real service
// would answer, not an uncaught URIError.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/demo/stand-ins/store", () => ({ listRecords: async () => [], readRecord: async () => null }));

import { matchRoute, standInFetch } from "@/lib/demo/stand-ins/fetch";

const WAREHOUSE = "https://warehouse.example";

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_DEMO_MODE", "on");
  vi.stubEnv("WAREHOUSE_URL", WAREHOUSE);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("a stand-in request whose path doesn't decode", () => {
  it("is a URIError to the route matcher", () => {
    expect(() => matchRoute("/api/card/:card/query/json", "/api/card/%E0%A4%A/query/json")).toThrow(URIError);
  });

  it("answers 400 with a static log line, not an error", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await standInFetch(`${WAREHOUSE}/api/card/%E0%A4%A/query/json`, { method: "POST", body: "{}" });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "bad_request" });
    expect(logged.mock.calls).toEqual([["[demo-stand-in] warehouse bad_path POST"]]);
  });

  it("still answers a well-formed one", async () => {
    const response = await standInFetch(`${WAREHOUSE}/api/card/6898/query/json`, { method: "POST", body: "{}" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([]);
  });
});
