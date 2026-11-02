import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// QC LOW-1: the per-item map+validate runs OUTSIDE the route's sanitized-error
// try/catch, so a throw there would 500 with Next's default (UNsanitized) body
// and no audit row — and abort the whole batch. The route wraps each item in
// its own try/catch that turns a throw into a per-item `item_malformed`
// rejection. mapReportRow is provably non-throwing on JSON input today, so we
// SIMULATE a future non-total coercion by mocking it to throw; everything else
// in import-csv (reportRecordFromObject, dealInputToDbData) stays real.
vi.mock("@/lib/deals/import-csv", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/deals/import-csv")>();
  return {
    ...actual,
    mapReportRow: () => {
      throw new Error("simulated mapper throw");
    },
  };
});

import * as route from "../../app/api/ingest/deals/route";
import * as scope from "../../lib/ingest/scope";

const TOKEN = "test-d2-secret-token";

function post(body: unknown) {
  return new Request("https://x/api/ingest/deals", {
    method: "POST",
    headers: new Headers({
      "content-type": "application/json",
      authorization: `Bearer ${TOKEN}`,
    }),
    body: JSON.stringify(body),
  });
}

describe("POST /api/ingest/deals — a per-item map throw is contained (QC LOW-1)", () => {
  const original = process.env.INGEST_TOKEN;
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    process.env.INGEST_TOKEN = TOKEN;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    if (original === undefined) delete process.env.INGEST_TOKEN;
    else process.env.INGEST_TOKEN = original;
  });

  it("throw during mapping → item_malformed + 200 (not a 500), audit still written", async () => {
    const findMany = vi.fn(async () => []);
    const upsert = vi.fn(async () => ({}));
    const create = vi.fn(async () => undefined);
    const spy = vi
      .spyOn(scope, "withIngestScope")
      .mockImplementation(async (fn) => {
        const tx = {
          deal: { findMany, upsert },
          auditLog: { create },
        } as unknown as Parameters<typeof fn>[0];
        return fn(tx);
      });

    const res = await route.POST(
      post({
        source: "crm",
        run_id: "RUN-THROW",
        // A well-formed report row — it would map+validate fine but for the
        // mocked mapReportRow throw.
        items: [{ "Deal: ID": "SF-1", "AoA - New Stage": "Potential" }],
      }),
    );

    // Contained: 200, the row rejected per-item — NOT a 500, NOT an aborted batch.
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.upserted).toBe(0);
    expect(body.rejected).toEqual([{ index: 0, reason: "item_malformed" }]);
    // No ok items → the route skips the read + upsert; the counts-only audit
    // row is still written (the tx runs).
    expect(findMany).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});
