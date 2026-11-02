import { beforeEach, describe, expect, it, vi } from "vitest";

// Performance-report AUTHORIZED-ATTEMPT audit (compliance review 2026-07-28).
//
// Two layers, no DB — only the transaction seam (`withUserScope`), the row insert
// (`writeAudit`) and `next/headers` are mocked, so the REAL writer
// (lib/twr/report-audit.ts) runs in both layers:
//   A. The writer itself: the action vocabulary, the PII-free detail shape, the
//      router-prefetch skip, and fail-closed propagation.
//   B. Both /performance pages end-to-end: the ORDER property that is the actual
//      compliance control — a row is written when authorization SUCCEEDS, is NOT
//      written when it is refused (unauthenticated, coarse role gate, or RLS miss),
//      and is written BEFORE the custodial Warehouse fetch.
//
// The page layer imports the real server components; vitest.config.ts overrides the
// JSX runtime so a `.tsx` page is importable at all.

const {
  headersSpy,
  withUserScopeSpy,
  writeAuditSpy,
  authSpy,
  apexAccountByNumberSpy,
  householdHeaderSpy,
  apexAccountsForHouseholdSpy,
  fetchAccountReportDataSpy,
  fetchHouseholdReportDataSpy,
  computeTwrWithMarketRfSpy,
  recordCalculationSpy,
  notFoundSpy,
  redirectSpy,
} = vi.hoisted(() => ({
  headersSpy: vi.fn(),
  withUserScopeSpy: vi.fn(),
  writeAuditSpy: vi.fn(async () => {}),
  authSpy: vi.fn(),
  apexAccountByNumberSpy: vi.fn(),
  householdHeaderSpy: vi.fn(),
  apexAccountsForHouseholdSpy: vi.fn(),
  fetchAccountReportDataSpy: vi.fn(),
  fetchHouseholdReportDataSpy: vi.fn(),
  computeTwrWithMarketRfSpy: vi.fn(async () => ({ result: {}, rf: null })),
  recordCalculationSpy: vi.fn(async () => ({ payloadSha256: "a".repeat(64) })),
  notFoundSpy: vi.fn(() => {
    throw new Error("NOT_FOUND");
  }),
  redirectSpy: vi.fn(() => {
    throw new Error("REDIRECT");
  }),
}));

vi.mock("next/headers", () => ({ headers: headersSpy }));
vi.mock("@/lib/rls", () => ({ withUserScope: withUserScopeSpy }));
// PARTIAL mock — the action constants must stay REAL (they are what we assert on).
vi.mock("@/lib/audit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/audit")>();
  return { ...actual, writeAudit: writeAuditSpy };
});
vi.mock("@/auth", () => ({ auth: authSpy }));
vi.mock("next/navigation", () => ({ notFound: notFoundSpy, redirect: redirectSpy }));
vi.mock("@/lib/data/account-aum", () => ({
  apexAccountByNumber: apexAccountByNumberSpy,
  apexAccountsForHousehold: apexAccountsForHouseholdSpy,
}));
vi.mock("@/lib/data/households", () => ({ householdHeader: householdHeaderSpy }));
vi.mock("@/lib/twr/warehouse", () => ({
  fetchAccountReportData: fetchAccountReportDataSpy,
  TwrDataError: class TwrDataError extends Error {
    reason: string;
    constructor(reason: string) {
      super(reason);
      this.reason = reason;
    }
  },
}));
vi.mock("@/lib/twr/household", () => ({
  fetchHouseholdReportData: fetchHouseholdReportDataSpy,
}));
// The pages no longer call `computeTwr` directly: the risk-free rate is now fed
// from stored Treasury data, so both pages go through `computeTwrWithMarketRf`
// (lib/data/risk-free-rate.ts), which runs the pure engine and resolves the rate.
// Mocking it here also keeps the page graph free of that module's `server-only`
// import, which is unresolvable under the vitest node env.
vi.mock("@/lib/data/risk-free-rate", () => ({
  computeTwrWithMarketRf: computeTwrWithMarketRfSpy,
}));
vi.mock("@/lib/twr/report-record", () => ({
  recordPerformanceReportCalculation: recordCalculationSpy,
}));
vi.mock("@/components/twr", () => ({
  PerformanceReport: () => null,
  HouseholdPerformanceReport: () => null,
}));
vi.mock("@/components/ui", () => ({
  Card: () => null,
  CardHeader: () => null,
  CardBody: () => null,
  SectionLabel: () => null,
}));

import {
  PERFORMANCE_REPORT_GENERATE_ACCOUNT,
  PERFORMANCE_REPORT_GENERATE_HOUSEHOLD,
} from "@/lib/audit";
import {
  accountLast4,
  newPerformanceReportId,
  recordAccountReportGenerated,
  recordHouseholdReportGenerated,
} from "@/lib/twr/report-audit";
import { TwrInsufficientHistoryError } from "@/lib/twr/engine";
import AccountPage from "@/app/(authenticated)/performance/[accountId]/page";
import HouseholdPage from "@/app/(authenticated)/performance/household/[householdId]/page";

const ADVISOR = { role: "ADVISOR", email: "advisor@example.com" };

// A real-shaped mirror.client_account_aum row as apexAccountByNumber returns it.
const ACCOUNT = {
  custodianAccountId: "01SYNTHQHQW58HE5527YB60922",
  apexAccountNumber: "8ZY12345",
  accountType: "ROTH_IRA",
  isManaged: true,
  accountStatus: "ACTIVE",
  accountAum: 425_000,
  asOf: new Date("2026-07-28T00:00:00Z"),
  clientSfId: "0033461720MRCZK",
};

/** No prefetch header — an ordinary human request. */
function humanRequest() {
  headersSpy.mockResolvedValue(new Headers());
}

/** A Next.js router prefetch of the same route. */
function prefetchRequest() {
  headersSpy.mockResolvedValue(new Headers({ "Next-Router-Prefetch": "1" }));
}

function scopeRuns() {
  withUserScopeSpy.mockImplementation(
    async (_id: unknown, fn: (tx: unknown) => Promise<unknown>) => fn({}),
  );
}

/** The single audit entry writeAudit received: [tx, identity, entry]. */
function auditedEntry() {
  expect(writeAuditSpy).toHaveBeenCalledTimes(1);
  return writeAuditSpy.mock.calls[0] as unknown as [
    unknown,
    Record<string, unknown>,
    Record<string, unknown>,
  ];
}

beforeEach(() => {
  vi.clearAllMocks();
  computeTwrWithMarketRfSpy.mockResolvedValue({ result: {}, rf: null });
  recordCalculationSpy.mockResolvedValue({ payloadSha256: "a".repeat(64) });
  humanRequest();
  scopeRuns();
});

// ---------------------------------------------------------------- A. the writer

describe("recordAccountReportGenerated", () => {
  it("writes ONE row: the account action, entityType, the ULID as entityId", async () => {
    const reportId = await recordAccountReportGenerated(ADVISOR, ACCOUNT);

    expect(reportId).toMatch(/^aoa-pr-[0-9a-f-]{36}$/);
    expect(withUserScopeSpy).toHaveBeenCalledTimes(1);
    // Written under the HUMAN's own identity (app_rw + RLS GUCs), not a machine role.
    expect(withUserScopeSpy.mock.calls[0][0]).toEqual(ADVISOR);
    const [, identity, entry] = auditedEntry();
    expect(identity).toEqual(ADVISOR);
    expect(entry.action).toBe(PERFORMANCE_REPORT_GENERATE_ACCOUNT);
    expect(entry.action).toBe("performance_report.generate_account");
    expect(entry.entityType).toBe("performance_report");
    expect(entry.entityId).toBe(ACCOUNT.custodianAccountId);
  });

  it("carries ids + masked last-4 only — NEVER the Apex account number", async () => {
    const reportId = await recordAccountReportGenerated(ADVISOR, ACCOUNT);

    const [, , entry] = auditedEntry();
    expect(entry.detail).toEqual({
      reportId,
      phase: "authorized_attempt",
      clientSfId: "0033461720MRCZK",
      accountLast4: "2345",
      accountType: "ROTH_IRA",
    });
    // The house PII rule, asserted over the WHOLE serialized row.
    expect(JSON.stringify(entry)).not.toContain(ACCOUNT.apexAccountNumber);
  });

  it("tolerates a firm/unlinked account (null client id, null number)", async () => {
    await recordAccountReportGenerated(ADVISOR, {
      custodianAccountId: "01SYNTHQHQW58HE5527YB60922",
      apexAccountNumber: null,
      accountType: null,
      clientSfId: null,
    });

    const [, , entry] = auditedEntry();
    expect(entry.entityId).toBe("01SYNTHQHQW58HE5527YB60922");
    expect(entry.detail).toEqual({
      reportId: expect.stringMatching(/^aoa-pr-[0-9a-f-]{36}$/),
      phase: "authorized_attempt",
      clientSfId: null,
      accountLast4: null,
      accountType: null,
    });
  });

  it("writes NOTHING on a router prefetch (no phantom generations)", async () => {
    prefetchRequest();
    await recordAccountReportGenerated(ADVISOR, ACCOUNT);

    expect(withUserScopeSpy).not.toHaveBeenCalled();
    expect(writeAuditSpy).not.toHaveBeenCalled();
  });

  it("FAILS CLOSED: an audit-write failure propagates (the report is never assembled)", async () => {
    writeAuditSpy.mockRejectedValueOnce(new Error("insert failed"));
    await expect(recordAccountReportGenerated(ADVISOR, ACCOUNT)).rejects.toThrow("insert failed");
  });
});

describe("recordHouseholdReportGenerated", () => {
  it("writes ONE row: the household action, the sf_id as entityId, a member COUNT", async () => {
    const reportId = await recordHouseholdReportGenerated(ADVISOR, {
      householdSfId: "0010288600GSLRH",
      reportableAccounts: 6,
    });

    const [, identity, entry] = auditedEntry();
    expect(identity).toEqual(ADVISOR);
    expect(entry.action).toBe(PERFORMANCE_REPORT_GENERATE_HOUSEHOLD);
    expect(entry.action).toBe("performance_report.generate_household");
    expect(entry.entityType).toBe("performance_report");
    expect(entry.entityId).toBe("0010288600GSLRH");
    expect(entry.detail).toEqual({
      reportId,
      phase: "authorized_attempt",
      householdSfId: "0010288600GSLRH",
      reportableAccounts: 6,
    });
  });

  it("writes NOTHING on a router prefetch", async () => {
    prefetchRequest();
    await recordHouseholdReportGenerated(ADVISOR, {
      householdSfId: "0010288600GSLRH",
      reportableAccounts: 6,
    });

    expect(writeAuditSpy).not.toHaveBeenCalled();
  });

  it("FAILS CLOSED on an audit-write failure", async () => {
    writeAuditSpy.mockRejectedValueOnce(new Error("insert failed"));
    await expect(
      recordHouseholdReportGenerated(ADVISOR, {
        householdSfId: "0010288600GSLRH",
        reportableAccounts: 1,
      }),
    ).rejects.toThrow("insert failed");
  });
});

describe("accountLast4", () => {
  it("masks to the last four, and is null-safe", () => {
    expect(accountLast4("8ZY12345")).toBe("2345");
    expect(accountLast4(null)).toBeNull();
    expect(accountLast4(undefined)).toBeNull();
    expect(accountLast4("")).toBeNull();
  });
});

describe("newPerformanceReportId", () => {
  it("creates opaque generation-specific ids", () => {
    const ids = Array.from({ length: 100 }, () => newPerformanceReportId());
    expect(new Set(ids)).toHaveLength(100);
    for (const id of ids) expect(id).toMatch(/^aoa-pr-[0-9a-f-]{36}$/);
  });
});

// ------------------------------------------------- B. the pages' gating ORDER

describe("account report page — audit written only for an AUTHORIZED request", () => {
  const run = () =>
    AccountPage({
      params: Promise.resolve({ accountId: "8ZY12345" }),
      searchParams: Promise.resolve({}),
    });

  it("records the authorized attempt once, BEFORE the custodial fetch", async () => {
    authSpy.mockResolvedValue({ user: { email: ADVISOR.email, role: ADVISOR.role } });
    apexAccountByNumberSpy.mockResolvedValue(ACCOUNT);
    fetchAccountReportDataSpy.mockResolvedValue({ identity: {}, input: {} });

    await run();

    const [, identity, entry] = auditedEntry();
    expect(identity).toEqual({ role: ADVISOR.role, email: ADVISOR.email });
    expect(entry.action).toBe(PERFORMANCE_REPORT_GENERATE_ACCOUNT);
    expect(entry.entityId).toBe(ACCOUNT.custodianAccountId);
    expect(entry.detail).toEqual({
      reportId: expect.stringMatching(/^aoa-pr-[0-9a-f-]{36}$/),
      phase: "authorized_attempt",
      clientSfId: ACCOUNT.clientSfId,
      accountLast4: "2345",
      accountType: ACCOUNT.accountType,
    });
    // Order is the compliance property: record, THEN read custodial data.
    expect(writeAuditSpy.mock.invocationCallOrder[0]).toBeLessThan(
      fetchAccountReportDataSpy.mock.invocationCallOrder[0],
    );
    expect(recordCalculationSpy).toHaveBeenCalledOnce();
    expect(computeTwrWithMarketRfSpy.mock.invocationCallOrder[0]).toBeLessThan(
      recordCalculationSpy.mock.invocationCallOrder[0],
    );
  });

  it("writes NOTHING when the coarse role gate refuses (VIEWER)", async () => {
    authSpy.mockResolvedValue({ user: { email: "viewer@example.com", role: "VIEWER" } });

    await expect(run()).rejects.toThrow("NOT_FOUND");

    expect(writeAuditSpy).not.toHaveBeenCalled();
    expect(apexAccountByNumberSpy).not.toHaveBeenCalled();
    expect(fetchAccountReportDataSpy).not.toHaveBeenCalled();
  });

  it("writes NOTHING when RLS refuses the account (out-of-book → no row)", async () => {
    authSpy.mockResolvedValue({ user: { email: ADVISOR.email, role: ADVISOR.role } });
    apexAccountByNumberSpy.mockResolvedValue(null);

    await expect(run()).rejects.toThrow("NOT_FOUND");

    expect(writeAuditSpy).not.toHaveBeenCalled();
    expect(fetchAccountReportDataSpy).not.toHaveBeenCalled();
  });

  it("writes NOTHING for an unauthenticated request", async () => {
    authSpy.mockResolvedValue(null);

    await expect(run()).rejects.toThrow("REDIRECT");

    expect(writeAuditSpy).not.toHaveBeenCalled();
  });

  it("still records the attempt when the custodial fetch then fails", async () => {
    authSpy.mockResolvedValue({ user: { email: ADVISOR.email, role: ADVISOR.role } });
    apexAccountByNumberSpy.mockResolvedValue(ACCOUNT);
    fetchAccountReportDataSpy.mockRejectedValue(new Error("warehouse down"));

    await run(); // renders the honest "unavailable" card

    expect(writeAuditSpy).toHaveBeenCalledTimes(1);
    expect(recordCalculationSpy).not.toHaveBeenCalled();
  });

  it("renders a controlled state instead of throwing when funded history is insufficient", async () => {
    authSpy.mockResolvedValue({ user: { email: ADVISOR.email, role: ADVISOR.role } });
    apexAccountByNumberSpy.mockResolvedValue(ACCOUNT);
    fetchAccountReportDataSpy.mockResolvedValue({ identity: {}, input: {} });
    computeTwrWithMarketRfSpy.mockRejectedValueOnce(new TwrInsufficientHistoryError());

    await expect(run()).resolves.toBeTruthy();
    expect(writeAuditSpy).toHaveBeenCalledTimes(1);
    expect(recordCalculationSpy).not.toHaveBeenCalled();
  });

  it("does not mislabel an unexpected computation failure as insufficient history", async () => {
    authSpy.mockResolvedValue({ user: { email: ADVISOR.email, role: ADVISOR.role } });
    apexAccountByNumberSpy.mockResolvedValue(ACCOUNT);
    fetchAccountReportDataSpy.mockResolvedValue({ identity: {}, input: {} });
    computeTwrWithMarketRfSpy.mockRejectedValueOnce(new Error("unexpected defect"));

    await expect(run()).rejects.toThrow("unexpected defect");
  });

  it("writes NOTHING on a prefetch of an authorized account", async () => {
    prefetchRequest();
    authSpy.mockResolvedValue({ user: { email: ADVISOR.email, role: ADVISOR.role } });
    apexAccountByNumberSpy.mockResolvedValue(ACCOUNT);
    fetchAccountReportDataSpy.mockResolvedValue({ identity: {}, input: {} });

    await run();

    expect(writeAuditSpy).not.toHaveBeenCalled();
  });
});

describe("household report page — audit written only for an AUTHORIZED request", () => {
  const run = () =>
    HouseholdPage({ params: Promise.resolve({ householdId: "0010288600GSLRH" }) });
  const HH = { sf_id: "0010288600GSLRH", name: "Sample Household" };

  it("records the attempt once, with the reportable-member count, BEFORE the fetch", async () => {
    authSpy.mockResolvedValue({ user: { email: ADVISOR.email, role: ADVISOR.role } });
    householdHeaderSpy.mockResolvedValue(HH);
    apexAccountsForHouseholdSpy.mockResolvedValue([
      { apexAccountNumber: "8ZY12345" },
      { apexAccountNumber: "3FZ33531" },
      { apexAccountNumber: null }, // firm/corporate account — not reportable
    ]);
    fetchHouseholdReportDataSpy.mockResolvedValue({
      input: {},
      warnings: [],
      memberCount: 2,
      members: [],
    });

    await run();

    const [, identity, entry] = auditedEntry();
    expect(identity).toEqual({ role: ADVISOR.role, email: ADVISOR.email });
    expect(entry.action).toBe(PERFORMANCE_REPORT_GENERATE_HOUSEHOLD);
    expect(entry.entityId).toBe(HH.sf_id);
    expect(entry.detail).toEqual({
      reportId: expect.stringMatching(/^aoa-pr-[0-9a-f-]{36}$/),
      phase: "authorized_attempt",
      householdSfId: HH.sf_id,
      reportableAccounts: 2,
    });
    // No household NAME anywhere in the row.
    expect(JSON.stringify(entry)).not.toContain(HH.name);
    expect(writeAuditSpy.mock.invocationCallOrder[0]).toBeLessThan(
      fetchHouseholdReportDataSpy.mock.invocationCallOrder[0],
    );
    expect(recordCalculationSpy).toHaveBeenCalledOnce();
  });

  it("records the access even when the household has nothing reportable (0 count)", async () => {
    authSpy.mockResolvedValue({ user: { email: ADVISOR.email, role: ADVISOR.role } });
    householdHeaderSpy.mockResolvedValue(HH);
    apexAccountsForHouseholdSpy.mockResolvedValue([]);

    await run(); // renders "No reportable accounts"

    const [, , entry] = auditedEntry();
    expect(entry.detail).toEqual({
      reportId: expect.stringMatching(/^aoa-pr-[0-9a-f-]{36}$/),
      phase: "authorized_attempt",
      householdSfId: HH.sf_id,
      reportableAccounts: 0,
    });
    expect(fetchHouseholdReportDataSpy).not.toHaveBeenCalled();
  });

  it("writes NOTHING when the coarse role gate refuses (VIEWER)", async () => {
    authSpy.mockResolvedValue({ user: { email: "viewer@example.com", role: "VIEWER" } });

    await expect(run()).rejects.toThrow("NOT_FOUND");

    expect(writeAuditSpy).not.toHaveBeenCalled();
    expect(householdHeaderSpy).not.toHaveBeenCalled();
    expect(fetchHouseholdReportDataSpy).not.toHaveBeenCalled();
  });

  it("writes NOTHING when RLS refuses the household (out-of-book → no row)", async () => {
    authSpy.mockResolvedValue({ user: { email: ADVISOR.email, role: ADVISOR.role } });
    householdHeaderSpy.mockResolvedValue(null);

    await expect(run()).rejects.toThrow("NOT_FOUND");

    expect(writeAuditSpy).not.toHaveBeenCalled();
    expect(apexAccountsForHouseholdSpy).not.toHaveBeenCalled();
    expect(fetchHouseholdReportDataSpy).not.toHaveBeenCalled();
  });

  it("writes NOTHING for an unauthenticated request", async () => {
    authSpy.mockResolvedValue(null);

    await expect(run()).rejects.toThrow("REDIRECT");

    expect(writeAuditSpy).not.toHaveBeenCalled();
  });
});
