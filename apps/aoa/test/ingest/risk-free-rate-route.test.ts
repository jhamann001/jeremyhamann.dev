import { beforeEach, describe, expect, it, vi } from "vitest";

// /api/ingest/risk-free-rate — the US Treasury daily par yield feed that replaced
// the hard-coded Sharpe risk-free rate. Auth, verb gating, validation, upsert
// semantics and dry-run, with the DB + audit mocked. The REAL normalizers
// (lib/ingest/risk-free-rate.ts) run.
vi.mock("server-only", () => ({}));

const { requireIngestTokenSpy, withIngestScopeSpy, execSpy, writeAuditSpy } = vi.hoisted(
  () => ({
    requireIngestTokenSpy: vi.fn(() => ({ ok: true }) as { ok: boolean }),
    withIngestScopeSpy: vi.fn(),
    execSpy: vi.fn(async (..._a: unknown[]) => 0),
    writeAuditSpy: vi.fn(async (..._a: unknown[]) => {}),
  }),
);
vi.mock("@/lib/ingest/auth", () => ({ requireIngestToken: requireIngestTokenSpy }));
vi.mock("@/lib/ingest/scope", () => ({
  withIngestScope: withIngestScopeSpy.mockImplementation(
    async (fn: (tx: unknown) => Promise<unknown>) => fn({ $executeRaw: execSpy }),
  ),
}));
vi.mock("@/lib/audit", () => ({
  INGEST_RISK_FREE_RATE: "ingest.risk_free_rate",
  writeAudit: writeAuditSpy,
}));

import { DELETE, GET, PATCH, POST, PUT } from "@/app/api/ingest/risk-free-rate/route";
import {
  RATE_PCT_MAX,
  RATE_PCT_MIN,
  normalizeRates,
  parseRateDate,
  parseRatePct,
} from "@/lib/ingest/risk-free-rate";

function post(body: unknown, qs = ""): Request {
  return new Request(`http://x/api/ingest/risk-free-rate${qs}`, {
    method: "POST",
    headers: { Authorization: "Bearer t", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Real Treasury rows (2026-07-24..28, "3 Mo" column), in the CSV's own format. */
const TREASURY = [
  { date: "07/28/2026", ratePct: 3.9 },
  { date: "07/27/2026", ratePct: 3.89 },
  { date: "07/24/2026", ratePct: 3.91 },
];

/** Concatenated SQL of every $executeRaw call (tagged-template strings). */
const sqlOf = (i: number) =>
  (execSpy.mock.calls[i]![0] as unknown as TemplateStringsArray).join(" ");

beforeEach(() => {
  requireIngestTokenSpy.mockReturnValue({ ok: true });
  execSpy.mockClear();
  withIngestScopeSpy.mockClear();
  writeAuditSpy.mockClear();
});

describe("normalizers (pure) — the blank-is-never-zero rule", () => {
  it("parses BOTH Treasury MM/DD/YYYY and ISO YYYY-MM-DD", () => {
    expect(parseRateDate("07/28/2026")).toBe("2026-07-28");
    expect(parseRateDate("7/4/2026")).toBe("2026-07-04"); // unpadded
    expect(parseRateDate("2026-07-28")).toBe("2026-07-28");
    expect(parseRateDate("  2026-07-28 ")).toBe("2026-07-28");
  });

  it("rejects impossible / malformed / non-string dates — never guesses one", () => {
    for (const bad of [
      "02/30/2026",
      "2026-02-30",
      "13/01/2026",
      "2026-13-01",
      "28-07-2026",
      "Jul 28, 2026",
      "",
      null,
      undefined,
      20260728,
      {},
    ]) {
      expect(parseRateDate(bad)).toBeNull();
    }
  });

  it("treats an EMPTY cell as blank (skip) — NEVER as 0.00%", () => {
    for (const blank of [null, undefined, "", "   "]) {
      expect(parseRatePct(blank)).toEqual({ kind: "blank" });
    }
    // A genuine zero is still a real, storable rate — distinct from blank.
    expect(parseRatePct(0)).toEqual({ kind: "ok", ratePct: 0 });
    expect(parseRatePct("0.00")).toEqual({ kind: "ok", ratePct: 0 });
  });

  it("rejects non-finite, non-numeric and out-of-range rates", () => {
    for (const bad of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      "abc",
      RATE_PCT_MAX + 1,
      RATE_PCT_MIN - 1,
      {},
      [],
      true,
    ]) {
      expect(parseRatePct(bad).kind).toBe("bad");
    }
  });

  it("scale guard: a percent sent as a DECIMAL (3.90% → 0.039) is rejected, not stored as 0.04%", () => {
    expect(parseRatePct(0.039).kind).toBe("bad");
    expect(parseRatePct(0.0425).kind).toBe("bad");
    // Legitimate near-zero ZIRP prints (2 decimals) still pass.
    expect(parseRatePct(0.02)).toEqual({ kind: "ok", ratePct: 0.02 });
    expect(parseRatePct(3.9)).toEqual({ kind: "ok", ratePct: 3.9 });
    expect(parseRatePct(-0.05)).toEqual({ kind: "ok", ratePct: -0.05 });
  });

  it("normalizeRates sorts by date, counts skips vs rejects, and never lets one bad row abort", () => {
    const n = normalizeRates([
      { date: "07/28/2026", ratePct: 3.9 },
      { date: "07/27/2026", ratePct: null }, // blank → skipped
      { date: "07/24/2026", ratePct: "" }, // blank → skipped
      { date: "99/99/2026", ratePct: 3.9 }, // bad date → rejected
      { date: "07/23/2026", ratePct: "nope" }, // bad rate → rejected
      { date: "07/28/2026", ratePct: 4.5 }, // duplicate date → rejected
      "not an object", // → rejected
      { date: "07/22/2026", ratePct: 3.88 },
    ]);
    expect(n.rows).toEqual([
      { rateDate: "2026-07-22", ratePct: 3.88 },
      { rateDate: "2026-07-28", ratePct: 3.9 },
    ]);
    expect(n.skipped).toBe(2);
    expect(n.rejected).toBe(4);
  });
});

describe("/api/ingest/risk-free-rate", () => {
  it("GET/PUT/PATCH/DELETE → 405", async () => {
    for (const h of [GET, PUT, PATCH, DELETE]) {
      const res = await h();
      expect(res.status).toBe(405);
      expect(await res.json()).toEqual({ error: "method_not_allowed" });
    }
  });

  it("no token → 401, no DB touch", async () => {
    requireIngestTokenSpy.mockReturnValue({ ok: false });
    const res = await POST(post({ rates: TREASURY }));
    expect(res.status).toBe(401);
    expect(withIngestScopeSpy).not.toHaveBeenCalled();
  });

  it("malformed JSON → 400", async () => {
    const req = new Request("http://x/api/ingest/risk-free-rate", {
      method: "POST",
      headers: { Authorization: "Bearer t" },
      body: "{not json",
    });
    expect((await POST(req)).status).toBe(400);
  });

  it("missing / non-array `rates` → 400", async () => {
    expect((await POST(post({ source: "s" }))).status).toBe(400);
    expect((await POST(post({ rates: "nope" }))).status).toBe(400);
  });

  it("over the row cap → 413 BEFORE any per-item work", async () => {
    const rates = Array.from({ length: 5001 }, (_, i) => ({
      date: "2026-01-05",
      ratePct: i % 5,
    }));
    const res = await POST(post({ rates }));
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "too_large" });
    expect(withIngestScopeSpy).not.toHaveBeenCalled();
  });

  it("an oversized content-length → 413", async () => {
    const req = new Request("http://x/api/ingest/risk-free-rate", {
      method: "POST",
      headers: { Authorization: "Bearer t", "content-length": String(9 * 1024 * 1024) },
      body: JSON.stringify({ rates: TREASURY }),
    });
    expect((await POST(req)).status).toBe(413);
  });

  it("a payload with NO storable row → 422 no-op (never silently 200s)", async () => {
    const res = await POST(post({ rates: [{ date: "2026-07-28", ratePct: null }] }));
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: "no_valid_rates" });
    expect(withIngestScopeSpy).not.toHaveBeenCalled();
    expect((await POST(post({ rates: [] }))).status).toBe(422);
  });

  it("valid payload → 200 with the upsert-by-date contract and one audit row", async () => {
    const res = await POST(post({ rates: TREASURY }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      upserted: 3,
      skipped: 0,
      rejected: 0,
      source: "us-treasury-daily-par-yield", // defaults
      tenor: "3M",
      from: "2026-07-24", // sorted span, not payload order
      to: "2026-07-28",
    });
    expect(execSpy).toHaveBeenCalledTimes(3); // one upsert per row
    // UPSERT, never a replace — and NO DELETE anywhere (ingest_rw has no grant).
    expect(sqlOf(0)).toContain("INSERT INTO mirror.risk_free_rate");
    expect(sqlOf(0)).toContain("ON CONFLICT (rate_date) DO UPDATE");
    for (let i = 0; i < 3; i++) expect(sqlOf(i)).not.toContain("DELETE");
    // Values bound as parameters (date, tenor, rate, source) — never concatenated.
    expect(execSpy.mock.calls[0]!.slice(1)).toEqual([
      "2026-07-24",
      "3M",
      "3.91",
      "us-treasury-daily-par-yield",
    ]);
    expect(writeAuditSpy).toHaveBeenCalledOnce();
    expect(writeAuditSpy.mock.calls[0]![2]).toMatchObject({
      action: "ingest.risk_free_rate",
      detail: { received: 3, upserted: 3, skipped: 0, rejected: 0, dry_run: false },
    });
  });

  it("is IDEMPOTENT: re-POSTing the same payload issues the same upserts", async () => {
    const first = await (await POST(post({ rates: TREASURY }))).json();
    const firstSql = [0, 1, 2].map(sqlOf);
    const firstArgs = [0, 1, 2].map((i) => execSpy.mock.calls[i]!.slice(1));
    execSpy.mockClear();
    const second = await (await POST(post({ rates: TREASURY }))).json();
    expect(second).toEqual(first);
    expect([0, 1, 2].map(sqlOf)).toEqual(firstSql);
    expect([0, 1, 2].map((i) => execSpy.mock.calls[i]!.slice(1))).toEqual(firstArgs);
  });

  it("a revised Treasury value updates the SAME date (revision, not a new row)", async () => {
    await POST(post({ rates: [{ date: "07/28/2026", ratePct: 3.92 }] }));
    expect(execSpy).toHaveBeenCalledTimes(1);
    expect(sqlOf(0)).toContain("rate_pct  = EXCLUDED.rate_pct");
    expect(execSpy.mock.calls[0]!.slice(1)).toEqual([
      "2026-07-28",
      "3M",
      "3.92",
      "us-treasury-daily-par-yield",
    ]);
  });

  it("BLANK cells are skipped, never written as 0.00%", async () => {
    const res = await POST(
      post({
        rates: [
          { date: "07/28/2026", ratePct: 3.9 },
          { date: "07/27/2026", ratePct: null },
          { date: "07/24/2026", ratePct: "" },
        ],
      }),
    );
    expect(await res.json()).toMatchObject({ upserted: 1, skipped: 2, rejected: 0 });
    expect(execSpy).toHaveBeenCalledTimes(1);
    // The only rate written is the real one — no 0 anywhere in the bound values.
    expect(execSpy.mock.calls[0]!.slice(1)).toContain("3.9");
    expect(execSpy.mock.calls[0]!.slice(1)).not.toContain("0");
  });

  it("bad dates and bad rates are counted and dropped; good rows still land", async () => {
    const res = await POST(
      post({
        rates: [
          { date: "2026-02-30", ratePct: 3.9 }, // impossible date
          { date: "07/28/2026", ratePct: 999 }, // out of range
          { date: "07/27/2026", ratePct: 0.039 }, // decimal-scaled
          { date: "07/24/2026", ratePct: 3.91 }, // good
        ],
      }),
    );
    expect(await res.json()).toMatchObject({
      upserted: 1,
      skipped: 0,
      rejected: 3,
      from: "2026-07-24",
      to: "2026-07-24",
    });
    expect(execSpy).toHaveBeenCalledTimes(1);
  });

  it("dryRun=1 → would_upsert, audit only, NO writes", async () => {
    const res = await POST(post({ rates: TREASURY }, "?dryRun=1"));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ would_upsert: 3, from: "2026-07-24" });
    expect(execSpy).not.toHaveBeenCalled();
    expect(writeAuditSpy).toHaveBeenCalledOnce();
    expect(writeAuditSpy.mock.calls[0]![2]).toMatchObject({ detail: { dry_run: true } });
  });

  it("honours explicit source + tenor", async () => {
    const res = await POST(post({ source: "treasury-backfill", tenor: "1M", rates: TREASURY }));
    expect(await res.json()).toMatchObject({ source: "treasury-backfill", tenor: "1M" });
    expect(execSpy.mock.calls[0]!.slice(1)).toEqual([
      "2026-07-24",
      "1M",
      "3.91",
      "treasury-backfill",
    ]);
  });

  it("a transaction failure → 500 with a counts-only log (no payload contents)", async () => {
    withIngestScopeSpy.mockRejectedValueOnce(new Error("42501"));
    const err = vi.spyOn(console, "error").mockImplementation((..._a: unknown[]) => {});
    const res = await POST(post({ rates: TREASURY }));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "internal" });
    const line = String(err.mock.calls[0]![0]);
    expect(line).toContain("tx_failed");
    expect(line).not.toContain("3.9");
    expect(line).not.toContain("2026-07-28");
    err.mockRestore();
  });
});
