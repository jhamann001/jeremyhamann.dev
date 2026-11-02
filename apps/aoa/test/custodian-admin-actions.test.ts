import { beforeEach, describe, expect, it, vi } from "vitest";
import { markCase } from "./acat-book-flywheel";

const {
  auth, stale, revalidate,
  saveCustodianAuthority, readCustodianAuthorityProfiles, mergeCustodianAuthority,
  findManyDocuments, createDocument, transaction, writeAudit,
  listDocIds, reassignDocs, readBytes,
} = vi.hoisted(() => ({
  auth: vi.fn(), stale: vi.fn(), revalidate: vi.fn(),
  saveCustodianAuthority: vi.fn(),
  readCustodianAuthorityProfiles: vi.fn(),
  mergeCustodianAuthority: vi.fn(),
  findManyDocuments: vi.fn(),
  createDocument: vi.fn(),
  transaction: vi.fn(),
  writeAudit: vi.fn(),
  listDocIds: vi.fn(),
  reassignDocs: vi.fn(),
  readBytes: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/auth", () => ({ auth }));
vi.mock("next/cache", () => ({ revalidatePath: revalidate }));
vi.mock("@/lib/data/acat-workspace", () => ({ markCustodianLibraryStale: stale }));
vi.mock("@/lib/data/custodian-authority", async () => {
  const actual = await vi.importActual<typeof import("@/lib/data/custodian-authority")>("@/lib/data/custodian-authority");
  return {
    ...actual,
    saveCustodianAuthority,
    readCustodianAuthorityProfiles,
    mergeCustodianAuthority,
  };
});
vi.mock("@/lib/audit", () => ({ writeAudit }));
vi.mock("@/lib/db", () => ({
  prisma: {
    $transaction: (fn: (tx: unknown) => unknown) => transaction(fn),
    custodianFeeScheduleDocument: { findMany: findManyDocuments, create: createDocument },
  },
}));
vi.mock("@/lib/data/custodian-admin", async () => {
  const actual = await vi.importActual<typeof import("@/lib/data/custodian-admin")>("@/lib/data/custodian-admin");
  return {
    ...actual,
    listCustodianFeeScheduleDocumentIds: listDocIds,
    reassignCustodianFeeScheduleDocuments: reassignDocs,
    readCustodianFeeScheduleBytes: readBytes,
  };
});

import {
  addCustodianFee, createCustodian, deleteCustodianFee, downloadCustodianFeeSchedule, mergeCustodian,
  markCustodianReviewed, saveCustodianDetails, saveCustodianFeeSchedule, saveCustodianPlaybook,
} from "@/app/(authenticated)/acat-tracking/custodian-admin-actions";
import { BLANK_FEE, playbookDraftFrom } from "@/lib/data/custodian-admin-contract";
import { libraryFixture } from "./fixtures/custodian-library";
import { authorityRecord } from "./fixtures/custodian-authority-record";

const save = saveCustodianAuthority;
const merge = mergeCustodianAuthority;
const read = readCustodianAuthorityProfiles;
const profile = libraryFixture.custodians[0];
const admin = { user: { role: "ADMIN", email: "Admin@Example.test" } };

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("EPIC_ACAT_CUSTODIAN_ADMIN_TKT323", "1");
  vi.stubEnv("SHOW_ACAT_CUSTODIAN_ADMIN_TKT337", "1");
  vi.stubEnv("EPIC_CUSTODIAN_DATABASE_AUTHORITY_TKT397", "1");
  vi.stubEnv("SHOW_CUSTODIAN_AUTHORITY_LIBRARY_TKT400", "1");
  vi.stubEnv("ROLLOUT_CUSTODIAN_AUTHORITY_STORAGE_TKT399", "1");
  auth.mockResolvedValue(admin);
  transaction.mockImplementation(async (fn: (tx: {
    $executeRaw: ReturnType<typeof vi.fn>;
    custodianFeeScheduleDocument: { findMany: typeof findManyDocuments; create: typeof createDocument };
    auditLog: { create: ReturnType<typeof vi.fn> };
  }) => unknown) => fn({
    $executeRaw: vi.fn().mockResolvedValue(undefined),
    custodianFeeScheduleDocument: { findMany: findManyDocuments, create: createDocument },
    auditLog: { create: vi.fn().mockResolvedValue(undefined) },
  }));
  findManyDocuments.mockResolvedValue([]);
  createDocument.mockResolvedValue({});
  writeAudit.mockResolvedValue(undefined);
  listDocIds.mockResolvedValue([]);
  reassignDocs.mockResolvedValue(0);
  read.mockResolvedValue({ ok: true, value: [authorityRecord] });
});

describe("custodian admin actions", () => {
  it("refuses every action when the release is off and calls no tracker route", async () => {
    vi.stubEnv("SHOW_ACAT_CUSTODIAN_ADMIN_TKT337", "0");
    const results = [
      await createCustodian("Betterment"),
      await saveCustodianDetails(profile, { name: "x", avgProcessingDays: "7" }),
      await saveCustodianPlaybook(profile, { ...playbookDraftFrom(profile), dtcNumber: "1" }),
      await addCustodianFee(profile.id, { ...BLANK_FEE, feeType: "x" }),
      await deleteCustodianFee(profile.id, "fee-zero"),
      await mergeCustodian(profile.id, "other"),
    ];
    for (const result of results) expect(result).toEqual({ ok: false, reason: "Custodian editing is off.", retryable: false });
    expect(save).not.toHaveBeenCalled();
    expect(merge).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    markCase("custodian-admin-actions", "refuses every action when the release is off and calls no tracker route");
  });

  it("refuses an operations user", async () => {
    auth.mockResolvedValue({ user: { role: "OPERATIONS", email: "ops@example.test" } });
    expect(await createCustodian("Betterment")).toEqual({ ok: false, reason: "Only admins can change custodians.", retryable: false });
    expect(save).not.toHaveBeenCalled();
    expect(merge).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    markCase("custodian-admin-actions", "refuses an operations user");
  });

  it("blank create name, blank fee type and an invalid id return no-retry failures without a tracker call", async () => {
    expect(await createCustodian("   ")).toEqual({ ok: false, reason: "Name is required", retryable: false });
    expect(await addCustodianFee(profile.id, BLANK_FEE)).toEqual({ ok: false, reason: "Fee type is required", retryable: false });
    expect(await deleteCustodianFee("bad id!", "fee-zero")).toEqual({ ok: false, reason: "This custodian no longer exists in the tracker.", retryable: false });
    expect(save).not.toHaveBeenCalled();
    expect(merge).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    markCase("custodian-admin-actions", "blank create name, blank fee type and an invalid id return no-retry failures without a tracker call");
  });

  it("a save with no changed fields returns unchanged without a tracker call", async () => {
    expect(await saveCustodianPlaybook(profile, playbookDraftFrom(profile))).toEqual({ ok: true, unchanged: true });
    expect(await saveCustodianDetails(profile, { name: profile.name, avgProcessingDays: String(profile.configuredExpectedProcessingDays) })).toEqual({ ok: true, unchanged: true });
    expect(save).not.toHaveBeenCalled();
    expect(merge).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    markCase("custodian-admin-actions", "a save with no changed fields returns unchanged without a tracker call");
  });

  it("create returns the saved local custodian name", async () => {
    const saved = { ...authorityRecord, id: "created-1", name: "Betterment" };
    save.mockResolvedValue({ ok: true, value: { custodianId: "created-1", revision: 1n } });
    read.mockResolvedValue({ ok: true, value: [saved] });
    const result = await createCustodian("  Betterment ");
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0][0]).toMatchObject({ role: "ADMIN", email: "Admin@Example.test" });
    expect(save.mock.calls[0][1].profile.name).toBe("Betterment");
    expect(read).toHaveBeenCalled();
    expect(result).toMatchObject({
      ok: true,
      custodian: { name: "Betterment", configuredExpectedProcessingDays: 9 },
    });
    expect(stale).toHaveBeenCalledTimes(1);
    markCase("custodian-admin-actions", "create returns the saved local custodian name");
  });

  it("flag-on save returns the re-read profile", async () => {
    const record = { ...authorityRecord, id: "auth-1" };
    const docRow = {
      id: "doc-minted",
      filename: "schedule.pdf",
      contentType: "application/pdf" as const,
      byteSize: 12,
      sha256: "ab".repeat(32),
      createdAt: new Date("2026-09-20T12:00:00.000Z"),
    };
    save.mockResolvedValue({ ok: true, value: { custodianId: "auth-1", revision: 1n } });
    read.mockResolvedValue({ ok: true, value: [record] });
    findManyDocuments.mockResolvedValue([docRow]);
    const uuid = vi.spyOn(crypto, "randomUUID").mockReturnValue("doc-minted");

    const created = await createCustodian("Example Custodian");
    expect(save).toHaveBeenCalledWith(
      { role: "ADMIN", email: "Admin@Example.test" },
      { profile: { name: "Example Custodian" }, fees: [] },
    );
    expect(created).toMatchObject({
      ok: true,
      custodian: {
        name: "Example Custodian",
        fees: [{ id: "fee-1" }],
        feeSchedules: [{ filename: "schedule.pdf", id: "doc-minted", createdAt: "2026-09-20T12:00:00.000Z" }],
      },
    });
    expect(JSON.stringify(created)).not.toContain("%PDF");
    expect(stale).toHaveBeenCalledTimes(1);

    const uploaded = await saveCustodianFeeSchedule("auth-1", {
      filename: "schedule.pdf",
      contentType: "application/pdf",
      bytesBase64: Buffer.from("%PDF-1.4").toString("base64"),
    });
    expect(createDocument).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ id: "doc-minted", filename: "schedule.pdf" }),
    }));
    expect(uploaded).toMatchObject({
      ok: true,
      custodian: { feeSchedules: [{ filename: "schedule.pdf", id: "doc-minted" }] },
    });
    expect(stale).toHaveBeenCalledTimes(2);

    merge.mockResolvedValue({ ok: true, value: { custodianId: "auth-1", revision: 2n } });
    listDocIds.mockResolvedValue(["doc-minted"]);
    const merged = await mergeCustodian("source-1", "auth-1");
    expect(merged).toMatchObject({ ok: true, deletedId: "source-1", reassigned: 0 });
    expect(stale).toHaveBeenCalledTimes(3);

    vi.stubEnv("ROLLOUT_CUSTODIAN_AUTHORITY_STORAGE_TKT399", "");
    stale.mockClear();
    const disabled = await createCustodian("Other");
    expect(disabled).toEqual({
      ok: false,
      reason: "Custodian authority writes are off.",
      retryable: false,
    });
    expect(stale).not.toHaveBeenCalled();
    uuid.mockRestore();
    markCase("custodian-admin-actions", "flag-on save returns the re-read profile");
  });

  it("name-only and mark-reviewed saves preserve the fee id", async () => {
    const record = { ...authorityRecord, id: "auth-1" };
    read.mockResolvedValue({ ok: true, value: [record] });
    save.mockResolvedValue({ ok: true, value: { custodianId: "auth-1", revision: 2n } });
    findManyDocuments.mockResolvedValue([]);

    const renamed = await saveCustodianDetails(
      { ...profile, id: "auth-1", name: "Example Custodian", configuredExpectedProcessingDays: 9 },
      { name: "Renamed Custodian", avgProcessingDays: "9" },
    );
    expect(renamed).toMatchObject({ ok: true, custodian: { fees: [{ id: "fee-1" }] } });
    const detailsCall = save.mock.calls[0][1];
    expect(detailsCall.profile).toMatchObject({ name: "Renamed Custodian", avg_processing_days: 9 });
    expect(detailsCall.profile).not.toHaveProperty("avgProcessingDays");
    expect(detailsCall.profile).not.toHaveProperty("configured_expected_processing_days");
    expect(detailsCall.profile).not.toHaveProperty("createdAt");
    expect(detailsCall.profile).not.toHaveProperty("revision");
    expect(detailsCall.fees[0]).toMatchObject({ id: "fee-1", fee_type: "Transfer fee" });
    expect(detailsCall.fees[0]).not.toHaveProperty("feeType");
    expect(detailsCall.fees[0]).not.toHaveProperty("createdAt");
    expect(detailsCall.fees[0]).not.toHaveProperty("revision");
    expect(stale).toHaveBeenCalledTimes(1);

    const reviewed = await markCustodianReviewed("auth-1");
    expect(reviewed).toMatchObject({ ok: true, custodian: { fees: [{ id: "fee-1" }] } });
    const reviewCall = save.mock.calls[1][1];
    expect(reviewCall.profile).toMatchObject({ review_status: "VERIFIED", name: "Example Custodian", avg_processing_days: 9 });
    expect(reviewCall.profile).not.toHaveProperty("configured_expected_processing_days");
    expect(reviewCall.fees[0]).toMatchObject({ id: "fee-1", fee_type: "Transfer fee" });
    expect(reviewCall.fees[0]).not.toHaveProperty("feeType");
    expect(stale).toHaveBeenCalledTimes(2);
    markCase("custodian-admin-actions", "name-only and mark-reviewed saves preserve the fee id");
  });

  it("read switch off returns the library-off refusal for profile writes", async () => {
    vi.stubEnv("SHOW_CUSTODIAN_AUTHORITY_LIBRARY_TKT400", "0");
    expect(await createCustodian("Betterment")).toEqual({
      ok: false, reason: "Custodian authority library is off.", retryable: false,
    });
    expect(await saveCustodianPlaybook(profile, { ...playbookDraftFrom(profile), dtcNumber: "1" })).toEqual({
      ok: false, reason: "Custodian authority library is off.", retryable: false,
    });
    expect(await mergeCustodian("dupe", "synthetic-one")).toEqual({
      ok: false, reason: "Custodian authority library is off.", retryable: false,
    });
    expect(save).not.toHaveBeenCalled();
    expect(merge).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    expect(stale).not.toHaveBeenCalled();
    markCase("custodian-admin-actions", "read switch off returns the library-off refusal for profile writes");
  });

  it("the public demo refuses fee-schedule uploads and still downloads the stored files", async () => {
    vi.stubEnv("NEXT_PUBLIC_DEMO_MODE", "on");
    const refused = await saveCustodianFeeSchedule("auth-1", {
      filename: "schedule.pdf",
      contentType: "application/pdf",
      bytesBase64: Buffer.from("%PDF-1.4").toString("base64"),
    });
    expect(refused).toEqual({
      ok: false,
      reason: "Uploading fee-schedule files is off in the public demo. The custodians' stored files still download.",
      retryable: false,
    });
    expect(createDocument).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
    readBytes.mockResolvedValue({ filename: "seeded.pdf", contentType: "application/pdf", content: Buffer.from("%PDF-1.7") });
    expect(await downloadCustodianFeeSchedule("doc-seeded")).toEqual({
      ok: true, filename: "seeded.pdf", contentType: "application/pdf", bytesBase64: Buffer.from("%PDF-1.7").toString("base64"),
    });
    markCase("custodian-admin-actions", "the public demo refuses fee-schedule uploads and still downloads the stored files");
  });
});
