import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// account-funding.ts imports "server-only", which throws outside an RSC bundle —
// stub it so the module loads under the vitest node env (mirrors twr-warehouse.test).
vi.mock("server-only", () => ({}));

import {
  summarizeFunding,
  checkExternalFundingAvailability,
  getExternalFundingSourceDate,
  fetchAccountFunding,
  fetchClientFunding,
  yearAgo,
  FundingDataError,
  type FundingRow,
} from "@/lib/data/account-funding";

// Build a normalized FundingRow (the shape summarizeFunding consumes). All
// fixture values invented.
function row(
  activityDate: string,
  method: string,
  amount: number,
  extra: Partial<FundingRow> = {},
): FundingRow {
  const activityId = `${activityDate}-${method}-${amount}`;
  return {
    accountId: "01SYNTHPBYDPXJNESTY8FBF45Z",
    activityDate,
    settleDate: activityDate,
    amount,
    method,
    description: `${method} funding`,
    activityId,
    sourceApplicationId: activityId,
    generation: 0,
    ...extra,
  };
}

describe("summarizeFunding — trailing-12mo + YTD aggregation (pure)", () => {
  // As-of 2026-07-13 → trailing window is (2025-07-13, 2026-07-13];
  // YTD window is 2026-01-01 .. 2026-07-13.
  const AS_OF = "2026-07-13";

  it("computes per-method totals + counts and the grand total over the window", () => {
    const out = summarizeFunding(
      [
        row("2026-06-01", "ACH", 1000),
        row("2026-05-01", "ACH", 250.5),
        row("2026-04-15", "Check", 500),
        row("2026-03-10", "Wire", 10000),
      ],
      AS_OF,
    );
    expect(out.byMethod.ACH).toEqual({ amount: 1250.5, count: 2 });
    expect(out.byMethod.Check).toEqual({ amount: 500, count: 1 });
    expect(out.byMethod.Wire).toEqual({ amount: 10000, count: 1 });
    expect(out.total).toEqual({ amount: 11750.5, count: 4 });
    expect(out.skipped).toBe(0);
    // events sorted DESC by activity date
    expect(out.events.map((e) => e.activityDate)).toEqual([
      "2026-06-01",
      "2026-05-01",
      "2026-04-15",
      "2026-03-10",
    ]);
  });

  it("applies the trailing-12mo boundary: start exclusive, as-of inclusive", () => {
    const out = summarizeFunding(
      [
        row("2025-07-13", "ACH", 111), // == windowStart → EXCLUDED (exclusive)
        row("2025-07-14", "ACH", 222), // just inside → included
        row("2026-07-13", "ACH", 333), // == as-of → included (inclusive)
        row("2026-07-14", "ACH", 444), // after as-of → excluded
      ],
      AS_OF,
    );
    expect(out.windowStart).toBe(yearAgo(AS_OF)); // 2025-07-13
    expect(out.total.count).toBe(2);
    expect(out.total.amount).toBe(555); // 222 + 333
    expect(out.events.map((e) => e.amount)).toEqual([333, 222]);
  });

  it("computes YTD as same-calendar-year (of as-of) on/before as-of — in-year vs prior-year vs future", () => {
    const out = summarizeFunding(
      [
        row("2025-12-31", "ACH", 900), // prior calendar year → not YTD (but in 12mo window)
        row("2026-01-01", "Check", 100), // in-year, on Jan 1 → YTD
        row("2026-07-13", "Wire", 200), // as-of day → YTD
        row("2026-07-20", "ACH", 300), // same year but AFTER as-of → not YTD (and outside window)
      ],
      AS_OF,
    );
    expect(out.ytd).toEqual({ amount: 300, count: 2 }); // 100 + 200
    // sanity: the prior-year row is still counted in the trailing-12mo total.
    expect(out.total.count).toBe(3); // 900 + 100 + 200 are all in the window; 300 is after as-of
    expect(out.total.amount).toBe(1200);
  });

  it("treats zero matching rows as a real $0 (counts 0), never null", () => {
    const out = summarizeFunding([], AS_OF);
    expect(out.total).toEqual({ amount: 0, count: 0 });
    expect(out.ytd).toEqual({ amount: 0, count: 0 });
    expect(out.byMethod.ACH).toEqual({ amount: 0, count: 0 });
    expect(out.byMethod.Check).toEqual({ amount: 0, count: 0 });
    expect(out.byMethod.Wire).toEqual({ amount: 0, count: 0 });
    expect(out.events).toEqual([]);
    expect(out.skipped).toBe(0);
  });

  it("skips (and counts) malformed rows: bad amount, negative amount, unknown method, bad date", () => {
    const out = summarizeFunding(
      [
        row("2026-06-01", "ACH", NaN), // non-finite amount
        row("2026-06-02", "ACH", -50), // negative amount
        row("2026-06-03", "Venmo", 100), // unknown funding_method
        row("not-a-date", "ACH", 100), // unparseable date
        row("2026-06-05", "ACH", 400), // the one good row
      ],
      AS_OF,
    );
    expect(out.total).toEqual({ amount: 400, count: 1 });
    expect(out.skipped).toBe(4);
    expect(out.events).toHaveLength(1);
  });

  it("canonicalizes funding_method case-insensitively (ach/CHECK/wire)", () => {
    const out = summarizeFunding(
      [
        row("2026-06-01", "ach", 10),
        row("2026-06-02", "CHECK", 20),
        row("2026-06-03", "wire", 30),
      ],
      AS_OF,
    );
    expect(out.byMethod.ACH.count).toBe(1);
    expect(out.byMethod.Check.count).toBe(1);
    expect(out.byMethod.Wire.count).toBe(1);
    expect(out.total.amount).toBe(60);
  });

  it("stores the CANONICAL method on each in-window event so the table and tiles agree by construction", () => {
    const out = summarizeFunding(
      [
        row("2026-06-01", "ach", 10),
        row("2026-06-02", "CHECK", 20),
        row("2026-06-03", "wire", 30),
      ],
      AS_OF,
    );
    // events are sorted DESC by date: wire(06-03), check(06-02), ach(06-01)
    expect(out.events.map((e) => e.method)).toEqual(["Wire", "Check", "ACH"]);
  });

  it("counts a rebook lineage once while preserving legitimate same-day same-amount deposits", () => {
    const out = summarizeFunding(
      [
        row("2025-12-24", "ACH", 100, {
          activityId: "ach-a",
          sourceApplicationId: "ach-source-a",
        }),
        row("2025-12-24", "ACH", 100, {
          activityId: "ach-b",
          sourceApplicationId: "ach-source-b",
        }),
        row("2026-01-29", "Check", 1110, {
          activityId: "check-original",
          sourceApplicationId: "check-source",
          generation: 0,
        }),
        row("2026-01-29", "Check", 1110, {
          activityId: "check-replacement",
          sourceApplicationId: "check-source",
          generation: 2,
        }),
      ],
      AS_OF,
    );

    expect(out.byMethod.ACH).toEqual({ amount: 200, count: 2 });
    expect(out.byMethod.Check).toEqual({ amount: 1110, count: 1 });
    expect(out.total).toEqual({ amount: 1310, count: 3 });
    expect(out.ytd).toEqual({ amount: 1110, count: 1 });
    expect(out.events.map((event) => event.activityId)).toContain("check-replacement");
    expect(out.events.map((event) => event.activityId)).not.toContain("check-original");
  });
});

// --- transport / parameterization (mirrors twr-warehouse.test conventions) ---

function cardResponse(rows: unknown[]) {
  return { ok: true, status: 200, json: async () => rows } as unknown as Response;
}

describe("fetchAccountFunding — card 6634 parameterization + error handling", () => {
  const fetchMock = vi.fn();
  const ULID = "01SYNTHPBYDPXJNESTY8FBF45Z";

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    process.env.WAREHOUSE_URL = "https://warehouse.example";
    process.env.WAREHOUSE_API_KEY = "secret-key";
    fetchMock.mockReset();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("binds account_id + start_date as template-tag params on card 6634 (never inline, no secret in URL)", async () => {
    fetchMock.mockResolvedValue(
      cardResponse([
        {
          account_id: ULID,
          activity_date: "2026-06-01",
          settle_date: "2026-06-02",
          net_amount: 1000,
          funding_method: "ACH",
          activity_description: "ACH deposit",
          activity_id: "act-1",
          source_application_id: "source-1",
          generation: 0,
        },
      ]),
    );

    const rows = await fetchAccountFunding(ULID, { startDate: "2025-07-13" });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ accountId: ULID, amount: 1000, method: "ACH" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe("https://warehouse.example/api/card/6634/query/json");
    expect(String(url)).not.toContain(ULID);
    expect(String(url)).not.toContain("secret-key");
    const body = JSON.parse((opts as RequestInit).body as string);
    expect(body.native).toBeUndefined();
    expect(body.parameters).toHaveLength(2);
    expect(body.parameters[0].id).toBe("97a51ec7-bf66-4a41-8681-eafba99e1dc3");
    expect(body.parameters[0].target).toEqual([
      "variable",
      ["template-tag", "account_id"],
    ]);
    expect(body.parameters[0].value).toBe(ULID);
    expect(body.parameters[1].id).toBe("2d59758c-1d07-41fe-b126-36c976d0c05f");
    expect(body.parameters[1].target).toEqual([
      "variable",
      ["template-tag", "start_date"],
    ]);
    expect(body.parameters[1].value).toBe("2025-07-13");
    expect((opts as RequestInit).headers).toMatchObject({ "x-api-key": "secret-key" });
  });

  it("runs a PII-free availability probe with a fixed impossible account id", async () => {
    fetchMock.mockResolvedValue(cardResponse([]));

    await expect(checkExternalFundingAvailability()).resolves.toBeUndefined();

    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe("https://warehouse.example/api/card/6634/query/json");
    const body = JSON.parse((opts as RequestInit).body as string);
    expect(body.parameters[0].value).toBe("AOA-DATA-HEALTH-PROBE-NO-ACCOUNT");
    expect(body.parameters[0].value).not.toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(body.parameters[1].value).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("reads the PII-free activity-feed source date from card 6700", async () => {
    fetchMock.mockResolvedValue(cardResponse([{ as_of: "2026-08-19" }]));

    await expect(getExternalFundingSourceDate()).resolves.toBe("2026-08-19");

    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe("https://warehouse.example/api/card/6700/query/json");
    expect(JSON.parse((opts as RequestInit).body as string)).toEqual({ parameters: [] });
  });

  it.each([
    ["missing row", []],
    ["invalid date", [{ as_of: "2026-02-30" }]],
    ["malformed date", [{ as_of: "not-a-date" }]],
    ["multiple rows", [{ as_of: "2026-08-19" }, { as_of: "2026-08-18" }]],
  ])("rejects a non-authoritative source-date result: %s", async (_label, rows) => {
    fetchMock.mockResolvedValue(cardResponse(rows as unknown[]));
    await expect(getExternalFundingSourceDate()).rejects.toMatchObject({
      reason: "bad_shape",
    });
  });

  it("throws bad_shape on a non-array payload", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ error: "nope" }),
    } as unknown as Response);
    await expect(fetchAccountFunding(ULID)).rejects.toMatchObject({ reason: "bad_shape" });
  });

  it("throws config_error (via FundingDataError) when the Warehouse env is missing", async () => {
    delete process.env.WAREHOUSE_URL;
    await expect(fetchAccountFunding(ULID)).rejects.toBeInstanceOf(FundingDataError);
    await expect(fetchAccountFunding(ULID)).rejects.toMatchObject({ reason: "config_error" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws warehouse_error on a non-200 response", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 502,
      json: async () => ({}),
    } as unknown as Response);
    await expect(fetchAccountFunding(ULID)).rejects.toMatchObject({ reason: "warehouse_error" });
  });

  it("rejects a malformed start_date literal before any fetch (no SQL/param injection)", async () => {
    await expect(
      fetchAccountFunding(ULID, { startDate: "2026-06-01'; DROP TABLE" }),
    ).rejects.toMatchObject({ reason: "bad_shape" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// --- client-level aggregation (pure) ---

describe("summarizeFunding — client-level merge across multiple accounts", () => {
  const AS_OF = "2026-07-13";

  it("combines by-method totals + YTD across accounts and preserves per-account tags", () => {
    // Rows from two accounts, tagged with their source account NUMBER (the
    // shape fetchClientFunding produces before folding through summarizeFunding).
    const merged: FundingRow[] = [
      row("2026-06-01", "ACH", 1000, { account: "AAA111" }),
      row("2025-12-31", "Wire", 5000, { account: "AAA111" }), // prior year → in window, not YTD
      row("2026-05-01", "ACH", 250, { account: "BBB222" }),
      row("2026-02-01", "Check", 750, { account: "BBB222" }), // YTD
    ];
    const out = summarizeFunding(merged, AS_OF);

    // by-method is client-wide (both accounts folded together)
    expect(out.byMethod.ACH).toEqual({ amount: 1250, count: 2 });
    expect(out.byMethod.Check).toEqual({ amount: 750, count: 1 });
    expect(out.byMethod.Wire).toEqual({ amount: 5000, count: 1 });
    expect(out.total).toEqual({ amount: 7000, count: 4 });
    // YTD excludes the prior-year Wire (5000): 1000 + 250 + 750
    expect(out.ytd).toEqual({ amount: 2000, count: 3 });

    // per-account tag survives the fold onto each in-window event
    const byDate = Object.fromEntries(out.events.map((e) => [e.activityDate, e.account]));
    expect(byDate).toEqual({
      "2026-06-01": "AAA111",
      "2025-12-31": "AAA111",
      "2026-05-01": "BBB222",
      "2026-02-01": "BBB222",
    });
  });
});

describe("fetchClientFunding — resolve+fetch fan-out, merge + skip-on-failure", () => {
  const fetchMock = vi.fn();
  const AS_OF = "2026-07-13";
  // account NUMBER → resolved ULID
  const ULID_A = "01SYNTH14F7HAYDP2AD4SNVNAX";
  const ULID_B = "01SYNTHPK50T47E6KZ9NPQ66XH";

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    process.env.WAREHOUSE_URL = "https://warehouse.example";
    process.env.WAREHOUSE_API_KEY = "secret-key";
    fetchMock.mockReset();
  });
  afterEach(() => vi.unstubAllGlobals());

  // Route the mocked transport by card id in the request URL: 6472 = resolver
  // (account NUMBER → ULID), 6634 = funding rows for a ULID.
  function routeBy(
    resolve: Record<string, { account_id: string } | null>,
    funding: Record<string, unknown[] | "error">,
  ) {
    return (url: string, opts: RequestInit) => {
      const body = JSON.parse(opts.body as string);
      if (String(url).includes("/api/card/6472/")) {
        const number = body.parameters[0].value as string;
        const hit = resolve[number];
        return Promise.resolve(cardResponse(hit ? [{
          ...hit,
          apex_acct: number,
          account_type: null,
          account_nickname: null,
          client_name: null,
        }] : []));
      }
      if (String(url).includes("/api/card/6634/")) {
        const ulid = body.parameters[0].value as string;
        const rows = funding[ulid];
        if (rows === "error") {
          return Promise.resolve({ ok: false, status: 502, json: async () => ({}) } as unknown as Response);
        }
        return Promise.resolve(cardResponse(rows ?? []));
      }
      throw new Error(`unexpected url ${url}`);
    };
  }

  const fundingRow = (ulid: string, date: string, method: string, amount: number) => ({
    account_id: ulid,
    activity_date: date,
    settle_date: date,
    net_amount: amount,
    funding_method: method,
    activity_description: `${method} deposit`,
    activity_id: `${ulid}-${date}`,
  });

  it("merges rows across accounts and tags each with its source account NUMBER", async () => {
    fetchMock.mockImplementation(
      routeBy(
        { AAA111: { account_id: ULID_A }, BBB222: { account_id: ULID_B } },
        {
          [ULID_A]: [fundingRow(ULID_A, "2026-06-01", "ACH", 1000)],
          [ULID_B]: [fundingRow(ULID_B, "2026-05-01", "Wire", 4000)],
        },
      ),
    );

    const out = await fetchClientFunding(["AAA111", "BBB222"], AS_OF);
    expect(out.total).toEqual({ amount: 5000, count: 2 });
    expect(out.byMethod.ACH.amount).toBe(1000);
    expect(out.byMethod.Wire.amount).toBe(4000);
    const tags = out.events.map((e) => e.account).sort();
    expect(tags).toEqual(["AAA111", "BBB222"]);
  });

  it("skips an account whose resolve MISSES (no ULID) without killing the section", async () => {
    fetchMock.mockImplementation(
      routeBy(
        { AAA111: { account_id: ULID_A }, GHOST: null }, // GHOST resolves to nothing
        { [ULID_A]: [fundingRow(ULID_A, "2026-06-01", "ACH", 1000)] },
      ),
    );

    const out = await fetchClientFunding(["AAA111", "GHOST"], AS_OF);
    expect(out.total).toEqual({ amount: 1000, count: 1 });
    expect(out.events.map((e) => e.account)).toEqual(["AAA111"]);
  });

  it("skips an account whose funding FETCH errors without killing the section", async () => {
    fetchMock.mockImplementation(
      routeBy(
        { AAA111: { account_id: ULID_A }, BBB222: { account_id: ULID_B } },
        {
          [ULID_A]: [fundingRow(ULID_A, "2026-06-01", "ACH", 1000)],
          [ULID_B]: "error", // card 6634 returns 502 for account B
        },
      ),
    );

    const out = await fetchClientFunding(["AAA111", "BBB222"], AS_OF);
    expect(out.total).toEqual({ amount: 1000, count: 1 });
    expect(out.events.map((e) => e.account)).toEqual(["AAA111"]);
  });

  it("THROWS when EVERY attempted account fails to fetch (outage → caller shows 'unavailable', never a misleading $0)", async () => {
    fetchMock.mockImplementation(
      routeBy(
        { AAA111: { account_id: ULID_A }, BBB222: { account_id: ULID_B } },
        { [ULID_A]: "error", [ULID_B]: "error" }, // both card 6634 pulls 502
      ),
    );
    await expect(fetchClientFunding(["AAA111", "BBB222"], AS_OF)).rejects.toThrow(
      /all client funding accounts failed/,
    );
  });

  it("treats a resolver (6472) transport error as an outage for that account only (partial → still aggregates the rest, no throw)", async () => {
    fetchMock.mockImplementation((url: string, opts: RequestInit) => {
      const body = JSON.parse(opts.body as string);
      if (String(url).includes("/api/card/6472/")) {
        const number = body.parameters[0].value as string;
        if (number === "AAA111") {
          return Promise.resolve({ ok: false, status: 502, json: async () => ({}) } as unknown as Response);
        }
        return Promise.resolve(cardResponse([{
          account_id: ULID_B,
          apex_acct: number,
          account_type: null,
          account_nickname: null,
          client_name: null,
        }]));
      }
      return Promise.resolve(cardResponse([fundingRow(ULID_B, "2026-06-01", "ACH", 1000)]));
    });
    const out = await fetchClientFunding(["AAA111", "BBB222"], AS_OF);
    expect(out.total).toEqual({ amount: 1000, count: 1 });
    expect(out.events.map((e) => e.account)).toEqual(["BBB222"]);
  });

  it("all-resolver-MISS is a real empty result (no funding), NOT an outage — does not throw", async () => {
    fetchMock.mockImplementation(routeBy({ AAA111: null, BBB222: null }, {}));
    const out = await fetchClientFunding(["AAA111", "BBB222"], AS_OF);
    expect(out.total).toEqual({ amount: 0, count: 0 });
  });

  it("empty account list makes NO Warehouse call and returns an empty summary", async () => {
    const out = await fetchClientFunding([], AS_OF);
    expect(out.total.count).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("de-duplicates repeated account numbers so funding isn't counted twice", async () => {
    fetchMock.mockImplementation(
      routeBy(
        { AAA111: { account_id: ULID_A } },
        { [ULID_A]: [fundingRow(ULID_A, "2026-06-01", "ACH", 1000)] },
      ),
    );
    const out = await fetchClientFunding(["AAA111", "AAA111"], AS_OF);
    expect(out.total).toEqual({ amount: 1000, count: 1 });
  });
});
