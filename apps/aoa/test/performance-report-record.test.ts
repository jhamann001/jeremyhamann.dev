import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TwrResult } from "@/lib/twr/engine";

vi.mock("server-only", () => ({}));

const { headersSpy, scopeSpy, createSpy, writeAuditSpy } = vi.hoisted(() => ({
  headersSpy: vi.fn(),
  scopeSpy: vi.fn(),
  createSpy: vi.fn(async () => ({})),
  writeAuditSpy: vi.fn(async () => {}),
}));

vi.mock("next/headers", () => ({ headers: headersSpy }));
vi.mock("@/lib/rls", () => ({ withUserScope: scopeSpy }));
vi.mock("@/lib/audit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/audit")>();
  return { ...actual, writeAudit: writeAuditSpy };
});

import {
  buildPerformanceReportSnapshot,
  canonicalJson,
  recordPerformanceReportCalculation,
  reportSnapshotSha256,
} from "@/lib/twr/report-record";

const IDENTITY = { role: "ADVISOR", email: "advisor@example.com" };
const RESULT: TwrResult = {
  inception: "2025-01-02",
  endDate: "2026-07-30",
  asOf: "2026-07-30",
  calDays: 574,
  rfAnnual: 0.039,
  netContributions: 100_000,
  columns: ["Q2 2026", "YTD", "Since Inception"],
  returns: [2.1, 4.2, 11.3],
  cells: [
    { label: "Q2 2026", value: 2.1 },
    { label: "YTD", value: 4.2 },
    { label: "Since Inception", value: 11.3 },
  ],
  twrSinceInception: 11.3,
  ytd: 4.2,
  growthOf100k: [{ label: "Incep", value: 100_000 }],
  waterfall: [{ label: "Ending value", value: 111_300, tone: "tot" }],
  cashflow: {
    contributionsYtd: 0,
    withdrawalsYtd: 0,
    netYtd: 0,
    contributionsIncep: 100_000,
    withdrawalsIncep: 0,
    netIncep: 100_000,
    inKind: false,
  },
  analytics: {
    currentValue: 111_300,
    costBasis: 100_000,
    costBasisAsOf: "2026-07-25",
    unrealizedGl: 11_300,
    unrealizedPct: 11.3,
    basisIncomplete: false,
    realizedSt: 100,
    realizedLt: 200,
    dividendTtm: 1_000,
    dividendYield: 0.9,
    advisoryFee: 500,
  },
  risk: {
    annReturn: 7.1,
    periodBasis: "annualized",
    vol: 9.2,
    sharpe: 0.35,
    sharpeEligible: true,
    sampleFrom: "2025-01-03",
    sampleTo: "2026-07-30",
    maxDrawdown: -4.3,
    bestDay: 1.2,
    worstDay: -1.4,
    positiveDays: 54,
    neutralizedDays: 0,
    riskSampleSize: 390,
  },
};

const INPUT = {
  reportId: "aoa-pr-11111111-1111-4111-8111-111111111111",
  scope: "account" as const,
  entityId: "01SYNTHQHQW58HE5527YB60922",
  reportDate: "2026-07-31",
  result: RESULT,
  rf: {
    from: "2025-01-03",
    to: "2026-07-30",
    tenor: "3M",
    source: "us-treasury-daily-par-yield",
    observations: 390,
    expectedBusinessDays: 410,
    coverage: 390 / 410,
    meanPct: 3.9,
    rfAnnual: 0.039,
    sufficient: true,
  },
  account: {
    accountLast4: "2345",
    accountType: "ROTH_IRA",
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  headersSpy.mockResolvedValue(new Headers());
  scopeSpy.mockImplementation(
    async (_identity: unknown, fn: (tx: unknown) => Promise<unknown>) =>
      fn({ performanceReportRecord: { create: createSpy } }),
  );
  process.env.AOA_SOURCE_COMMIT_SHA = "a".repeat(40);
});

describe("performance report calculation record", () => {
  it("canonicalizes object keys and produces a stable sha256", () => {
    expect(canonicalJson({ z: 1, a: { y: 2, x: 3 } })).toBe(
      '{"a":{"x":3,"y":2},"z":1}',
    );
    expect(reportSnapshotSha256({ b: 2, a: 1 })).toBe(
      reportSnapshotSha256({ a: 1, b: 2 }),
    );
  });

  it("builds a provenance-rich numeric snapshot without a client name or full account number", () => {
    const snapshot = buildPerformanceReportSnapshot(INPUT);
    const serialized = JSON.stringify(snapshot);
    expect(snapshot).toMatchObject({
      snapshotVersion: 1,
      methodologyVersion: "1.9",
      sourceCommitSha: "a".repeat(40),
      report: { reportId: INPUT.reportId, scope: "account", asOf: RESULT.asOf },
      subject: { account: { accountLast4: "2345" } },
      calculation: { twrSinceInception: 11.3 },
    });
    expect(serialized).toContain("440eec285b8418df2414bee4f717ccfaa20e4153655651e5887f347b0bee61df");
    expect(serialized).not.toContain("8ZY12345");
    expect(serialized).not.toContain("Sample Client");
  });

  it("records a household member's stale-basis exclusion in the immutable snapshot", () => {
    const snapshot = buildPerformanceReportSnapshot({
      ...INPUT,
      scope: "household",
      account: undefined,
      householdMembers: [
        {
          accountLast4: "2345",
          endingValue: 412,
          weightPct: 0.04,
          sinceInceptionTwr: 8.91,
          costBasisExcluded: true,
        },
      ],
    });

    expect(snapshot.subject).toEqual({
      members: [
        expect.objectContaining({
          accountLast4: "2345",
          costBasisExcluded: true,
        }),
      ],
    });
  });

  it("stores the immutable snapshot and completion event in one scoped transaction", async () => {
    const result = await recordPerformanceReportCalculation(IDENTITY, INPUT);
    expect(result?.payloadSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(scopeSpy).toHaveBeenCalledWith(IDENTITY, expect.any(Function));
    expect(createSpy).toHaveBeenCalledOnce();
    const [{ data }] = createSpy.mock.calls[0] as unknown[] as [
      { data: Record<string, unknown> },
    ];
    expect(data).toMatchObject({
      reportId: INPUT.reportId,
      actorEmail: IDENTITY.email,
      actorRole: IDENTITY.role,
      scope: "account",
      entityId: INPUT.entityId,
      reportDate: "2026-07-31",
      asOf: "2026-07-30",
      snapshotVersion: 1,
      methodologyVersion: "1.9",
      sourceCommitSha: "a".repeat(40),
      payloadSha256: result?.payloadSha256,
    });
    expect(writeAuditSpy).toHaveBeenCalledOnce();
    const [, , entry] = writeAuditSpy.mock.calls[0] as unknown[] as [
      unknown,
      unknown,
      Record<string, unknown>,
    ];
    expect(entry).toMatchObject({
      action: "performance_report.calculated_account",
      entityType: "performance_report",
      entityId: INPUT.entityId,
      detail: {
        reportId: INPUT.reportId,
        phase: "calculation_complete",
        payloadSha256: result?.payloadSha256,
      },
    });
  });

  it("writes nothing for a router prefetch", async () => {
    headersSpy.mockResolvedValue(new Headers({ "Next-Router-Prefetch": "1" }));
    expect(await recordPerformanceReportCalculation(IDENTITY, INPUT)).toBeNull();
    expect(scopeSpy).not.toHaveBeenCalled();
  });

  it("fails closed and never writes a completion event when snapshot persistence fails", async () => {
    createSpy.mockRejectedValueOnce(new Error("archive down"));
    await expect(recordPerformanceReportCalculation(IDENTITY, INPUT)).rejects.toThrow(
      "archive down",
    );
    expect(writeAuditSpy).not.toHaveBeenCalled();
  });
});
