import { writeFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

// Records what the standalone service returns, through AOA's delegated client, for every read-parity case
// (ticket). Runs only from scripts/trade-requests/capture-read-parity.sh, which seeds a scratch standalone
// database, starts the standalone service locally in HS256 mode and sets the variables below. Skipped
// everywhere else (including CI).
vi.mock("server-only", () => ({}));
const m = vi.hoisted(() => ({ auth: vi.fn() }));
vi.mock("@/auth", () => ({ auth: m.auth }));

import { callTradeRequestService, resetDelegatedClientState } from "@/lib/trade-requests/client";
import { tradeRequestWarehouseConfigured } from "@/lib/trade-requests/native/reads/sources";
import { blankFeedEnv } from "./fixtures/trade-request-feed-env";
import { PARITY_ACTORS, PARITY_CASES } from "./fixtures/trade-request-read-parity-cases";

const URL_ = process.env.TRADE_REQUEST_PARITY_CAPTURE_URL;
const OUT = process.env.TRADE_REQUEST_PARITY_OUT;

describe.skipIf(!URL_ || !OUT)("read-parity capture from the standalone service", () => {
  it("records one result per case", async () => {
    vi.stubEnv("TRADE_REQUEST_API_URL", URL_ ?? "");
    vi.stubEnv("TRADE_REQUEST_DELEGATED_AUDIENCE", "");
    vi.stubEnv("TRADE_REQUEST_DELEGATED_LOCAL_KEY", process.env.TRADE_REQUEST_PARITY_CAPTURE_KEY ?? "");
    vi.stubEnv("TRADE_REQUESTS_NATIVE", "");
    blankFeedEnv();
    expect(tradeRequestWarehouseConfigured()).toBe(false);
    const results: Record<string, unknown> = {};
    for (const entry of PARITY_CASES) {
      resetDelegatedClientState();
      const actor = PARITY_ACTORS[entry.actor];
      m.auth.mockResolvedValue({ user: { id: actor.id, email: actor.email } });
      results[entry.id] = await callTradeRequestService(entry.call);
    }
    vi.unstubAllEnvs();
    expect(Object.keys(results)).toHaveLength(PARITY_CASES.length);
    writeFileSync(OUT!, `${JSON.stringify({ source: "trade-request d41b6c9", cases: results }, null, 2)}\n`);
  });
});
