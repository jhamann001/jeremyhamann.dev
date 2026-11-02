import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const {
  readCustodianAuthorityProfiles, readObservedCustodianTiming,
  findManyDocuments, transaction,
} = vi.hoisted(() => ({
  readCustodianAuthorityProfiles: vi.fn(),
  readObservedCustodianTiming: vi.fn(),
  findManyDocuments: vi.fn(),
  transaction: vi.fn(),
}));
vi.mock("@/lib/data/custodian-authority", () => ({ readCustodianAuthorityProfiles }));
vi.mock("@/lib/data/custodian-timing", () => ({ readObservedCustodianTiming }));
vi.mock("@/lib/db", () => ({
  prisma: {
    $transaction: (fn: (tx: unknown) => unknown) => transaction(fn),
    custodianFeeScheduleDocument: { findMany: findManyDocuments },
  },
}));
import { getCustodianLibrary } from "@/lib/data/custodian-library";
import { custodianLibrarySchema, canReadCustodianLibrary, filterCustodians, feeDirectionLabel } from "@/lib/data/custodian-library-contract";
import { libraryFixture } from "./fixtures/custodian-library";
import { authorityRecord } from "./fixtures/custodian-authority-record";
import { markCase } from "./acat-book-flywheel";

beforeEach(() => {
  vi.clearAllMocks();
  readCustodianAuthorityProfiles.mockResolvedValue({ ok: true, value: [authorityRecord] });
  readObservedCustodianTiming.mockResolvedValue(new Map());
  transaction.mockImplementation(async (fn: (tx: {
    $executeRaw: ReturnType<typeof vi.fn>;
    custodianFeeScheduleDocument: { findMany: typeof findManyDocuments };
  }) => unknown) => fn({
    $executeRaw: vi.fn().mockResolvedValue(undefined),
    custodianFeeScheduleDocument: { findMany: findManyDocuments },
  }));
  findManyDocuments.mockResolvedValue([]);
});
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });

describe("live read-only custodian library", () => {
  it.each(["VIEWER", "ADVISOR", "CLIENT_SERVICE", "", "admin", "UNKNOWN"])("rejects %s before network access", async (role) => {
    expect(canReadCustodianLibrary(role)).toBe(false);
    await expect(getCustodianLibrary(role)).rejects.toMatchObject({ reason: "forbidden" });
    expect(readCustodianAuthorityProfiles).not.toHaveBeenCalled();
  });
  it("accepts a verified empty library", async () => {
    readCustodianAuthorityProfiles.mockResolvedValue({ ok: true, value: [] });
    expect((await getCustodianLibrary("ADMIN")).custodians).toEqual([]);
  });
});

describe("authority library read (ticket)", () => {
  it("flag on keeps the local profile when observed timing cannot be read", async () => {
    readCustodianAuthorityProfiles.mockResolvedValue({ ok: true, value: [authorityRecord] });
    readObservedCustodianTiming.mockRejectedValue(new Error("timing down"));
    const library = await getCustodianLibrary("ADMIN");
    expect(library.custodians[0].name).toBe("Example Custodian");
    expect(library.custodians[0].configuredExpectedProcessingDays).toBe(9);
    expect(library.custodians[0].fees[0].feeType).toBe("Transfer fee");
    expect(library.custodians[0].observedTimingAvailable).toBe(false);
    expect(library.custodians[0].observedAvgProcessingBusinessDays).toBeNull();
    expect(library.custodians[0].observedCompletedTransfers).toBe(0);
    markCase("custodian-library", "flag on keeps the local profile when observed timing cannot be read");
  });

  it("timing failure sets a zero completed count", async () => {
    readCustodianAuthorityProfiles.mockResolvedValue({ ok: true, value: [authorityRecord] });
    readObservedCustodianTiming.mockRejectedValue(new Error("timing down"));
    const library = await getCustodianLibrary("ADMIN");
    expect(library.custodians[0].name).toBe("Example Custodian");
    expect(library.custodians[0].configuredExpectedProcessingDays).toBe(9);
    expect(library.custodians[0].fees[0].feeType).toBe("Transfer fee");
    expect(library.custodians[0].observedTimingAvailable).toBe(false);
    expect(library.custodians[0].observedAvgProcessingBusinessDays).toBeNull();
    expect(library.custodians[0].observedCompletedTransfers).toBe(0);
    markCase("custodian-library", "timing failure sets a zero completed count");
  });

  it("saved profile fee and file are what the library returns", async () => {
    readCustodianAuthorityProfiles.mockResolvedValue({ ok: true, value: [authorityRecord] });
    readObservedCustodianTiming.mockResolvedValue(new Map());
    findManyDocuments.mockResolvedValue([{
      id: "doc-1",
      custodianId: "synthetic-one",
      filename: "schedule.pdf",
      contentType: "application/pdf",
      byteSize: 12,
      sha256: "ab".repeat(32),
      createdAt: new Date("2026-09-20T12:00:00.000Z"),
    }]);
    const result = await getCustodianLibrary("ADMIN");
    const profile = result.custodians[0];
    expect(profile.name).toBe("Example Custodian");
    expect(profile.configuredExpectedProcessingDays).toBe(9);
    expect(profile.fees[0]).toMatchObject({
      id: "fee-1",
      feeType: "Transfer fee",
      accountType: "IRA",
      amount: 0,
    });
    expect(profile.feeSchedules?.[0]).toMatchObject({
      filename: "schedule.pdf",
      createdAt: "2026-09-20T12:00:00.000Z",
    });
    expect(JSON.stringify(result)).not.toContain("%PDF");
    expect(transaction).toHaveBeenCalled();
    markCase("custodian-library", "saved profile fee and file are what the library returns");
  });
});

describe("custodian contract and search", () => {
  it("strips unexpected/history fields instead of passing raw payloads into the browser", () => {
    const c = libraryFixture.custodians[0];
    const parsed = custodianLibrarySchema.parse({ ...libraryFixture, secret: "omit", custodians: [{ ...c, recentClients: "omit", requiresManualReview: true, fees: c.fees.map((f) => ({ ...f, secret: "omit" })) }] });
    expect(parsed).toEqual(libraryFixture);
  });
  it("preserves unknown and zero fees independently", () => {
    const fees = custodianLibrarySchema.parse(libraryFixture).custodians[0].fees;
    expect(fees[0].amount).toBe(0);
    expect(fees[1].amount).toBeNull();
    expect(fees[1].amountText).toBe("Varies");
  });
  it("rejects invalid numbers and duplicate identities", () => {
    const c = libraryFixture.custodians[0];
    for (const custodians of [[{ ...c, acatFeeAmount: NaN }], [c, c], [{ ...c, fees: [c.fees[0], c.fees[0]] }]]) {
      expect(custodianLibrarySchema.safeParse({ ...libraryFixture, custodians }).success).toBe(false);
    }
  });
  it.each(["example", " DEMO-1234 ", "mixed", "transfer fee", "ops@example.test", ""])("searches %s without mutation", (query) => {
    expect(filterCustodians(libraryFixture.custodians, query)).toHaveLength(1);
  });
  it("handles no search matches", () => expect(filterCustodians(libraryFixture.custodians, "absent")).toEqual([]));
  it("labels fee direction relative to Apex without changing stored values", () => {
    expect(feeDirectionLabel("OUT")).toBe("Transfer into Apex");
    expect(feeDirectionLabel("IN")).toBe("Transfer out of Apex");
    expect(feeDirectionLabel("ANY")).toBe("Both directions");
    expect(feeDirectionLabel("NEW")).toBe("NEW");
  });
  it("accepts a library response that omits the post-PR-181 contact fields", () => {
    const legacy = { ...libraryFixture.custodians[0] };
    delete (legacy as { contactMethod?: string }).contactMethod;
    delete (legacy as { contactDetails?: string }).contactDetails;
    expect(custodianLibrarySchema.parse({
      ...libraryFixture, custodians: [legacy],
    }).custodians[0]).toMatchObject({ contactEmail: "ops@example.test" });
  });
});
