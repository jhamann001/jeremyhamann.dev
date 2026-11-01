import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { markCase } from "@/lib/test-flywheel";

const verifyAcatReadCaller = vi.fn();
vi.mock("@/lib/machine-auth", () => ({ verifyAcatReadCaller }));
vi.mock("@/lib/prisma", () => import("@/lib/__mocks__/prisma"));
vi.mock("@/lib/rate-limit-redis", () => ({
  rateLimit: vi.fn().mockResolvedValue({ allowed: true }),
}));
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { GET } = await import("./route");
const { prisma } = await import("@/lib/prisma");
const { rateLimit } = await import("@/lib/rate-limit-redis");
const { logger } = await import("@/lib/logger");

const CALLER = "ops-portal-run@ops-portal.iam.gserviceaccount.com";
const RECORD_ID = "REC-001";
const STAFF = "ops@example.com";

const findRecord = vi.mocked(prisma.acatRecord.findUnique);
const findHistory = vi.mocked(prisma.auditLog.findMany);

const request = () =>
  new Request(`http://localhost/api/machine/acats/by-record/${RECORD_ID}/history`);
const params = (id = RECORD_ID) => ({ params: Promise.resolve({ id }) });

function entry(overrides: Record<string, unknown>) {
  return {
    id: "LOG-1",
    action: "update",
    field: "status",
    oldValue: "Submitted",
    newValue: "InTransfer",
    performedBy: STAFF,
    timestamp: new Date("2026-10-13T14:32:00.000Z"),
    ...overrides,
  };
}

function loggedText(): string {
  return JSON.stringify([
    vi.mocked(logger.info).mock.calls,
    vi.mocked(logger.warn).mock.calls,
    vi.mocked(logger.error).mock.calls,
  ]);
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.ROLLOUT_ACAT_FIELD_HISTORY = "1";
  verifyAcatReadCaller.mockResolvedValue({ email: CALLER });
  vi.mocked(rateLimit).mockResolvedValue({ allowed: true, remaining: 119 });
  findRecord.mockResolvedValue({ id: RECORD_ID } as never);
  findHistory.mockResolvedValue([] as never);
});

afterEach(() => {
  delete process.env.ROLLOUT_ACAT_FIELD_HISTORY;
});

describe("GET /api/machine/acats/by-record/[id]/history", () => {
  it("returns 404 while the field history flag is off", async () => {
    markCase("machine-acat-history", "returns 404 while the field history flag is off");
    for (const value of [undefined, "0"]) {
      if (value === undefined) delete process.env.ROLLOUT_ACAT_FIELD_HISTORY;
      else process.env.ROLLOUT_ACAT_FIELD_HISTORY = value;
      const res = await GET(request(), params());
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "not_found" });
    }
    expect(verifyAcatReadCaller).not.toHaveBeenCalled();
    expect(rateLimit).not.toHaveBeenCalled();
    expect(findRecord).not.toHaveBeenCalled();
    expect(findHistory).not.toHaveBeenCalled();
  });

  it("passes the literal history scope to the verifier", async () => {
    markCase("machine-acat-history", "passes the literal history scope to the verifier");
    const req = request();
    await GET(req, params());
    expect(verifyAcatReadCaller).toHaveBeenCalledWith(req, "history");
  });

  it("returns unauthorized without querying Prisma", async () => {
    markCase("machine-acat-history", "returns unauthorized without querying Prisma");
    verifyAcatReadCaller.mockResolvedValue(null);
    const res = await GET(request(), params());
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
    expect(findRecord).not.toHaveBeenCalled();
    expect(findHistory).not.toHaveBeenCalled();
  });

  it("returns rate_limited without querying Prisma", async () => {
    markCase("machine-acat-history", "returns rate_limited without querying Prisma");
    vi.mocked(rateLimit).mockResolvedValue({ allowed: false, remaining: 0 });
    const res = await GET(request(), params());
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "rate_limited" });
    expect(findRecord).not.toHaveBeenCalled();
    expect(findHistory).not.toHaveBeenCalled();
  });

  it("returns not_found for a missing or deleted record", async () => {
    markCase("machine-acat-history", "returns not_found for a missing or deleted record");
    findRecord.mockResolvedValue(null);
    const res = await GET(request(), params());
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
    expect(findRecord).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: RECORD_ID, deletedAt: null } })
    );
    expect(findHistory).not.toHaveBeenCalled();
  });

  it("returns the newest 100 non-read entries with the tracker query", async () => {
    markCase("machine-acat-history", "returns the newest 100 non-read entries with the tracker query");
    findHistory.mockResolvedValue([
      entry({ id: "LOG-2", timestamp: new Date("2026-10-13T14:32:00.000Z") }),
      entry({ id: "LOG-1", field: "feeAmount", oldValue: "$50.00", newValue: "$75.00", timestamp: new Date("2026-10-12T09:05:00.000Z") }),
    ] as never);
    const res = await GET(request(), params());
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(findHistory).toHaveBeenCalledWith({
      where: { acatRecordId: RECORD_ID, action: { not: "read" } },
      orderBy: { timestamp: "desc" },
      take: 100,
      select: {
        id: true,
        action: true,
        field: true,
        oldValue: true,
        newValue: true,
        performedBy: true,
        timestamp: true,
      },
    });
    expect(await res.json()).toEqual([
      { id: "LOG-2", action: "update", field: "status", oldValue: "Submitted", newValue: "InTransfer", performedBy: STAFF, timestamp: "2026-10-13T14:32:00.000Z" },
      { id: "LOG-1", action: "update", field: "feeAmount", oldValue: "$50.00", newValue: "$75.00", performedBy: STAFF, timestamp: "2026-10-12T09:05:00.000Z" },
    ]);
  });

  it("returns an empty list when the record has no history", async () => {
    markCase("machine-acat-history", "returns an empty list when the record has no history");
    const res = await GET(request(), params());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it("returns stored account numbers raw and keeps them out of logs", async () => {
    markCase("machine-acat-history", "returns stored account numbers raw and keeps them out of logs");
    findHistory.mockResolvedValue([
      entry({ id: "LOG-4", field: "statementAccountNumber", oldValue: null, newValue: "123456789" }),
      entry({ id: "LOG-3", field: "apexAccountId", oldValue: null, newValue: "9ZZ12345" }),
      entry({ id: "LOG-2", field: "dtccNumber", oldValue: null, newValue: "0226" }),
      entry({ id: "LOG-1", field: "clientName", oldValue: "Sara", newValue: "Sarah" }),
    ] as never);
    const res = await GET(request(), params());
    const body = await res.json();
    expect(body.map((row: { newValue: string | null }) => row.newValue)).toEqual([
      "123456789",
      "9ZZ12345",
      "0226",
      "Sarah",
    ]);
    expect(body[3].oldValue).toBe("Sara");
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ id: RECORD_ID, count: 4, status: 200 }),
      "machine ACAT history: ok"
    );
    const logged = loggedText();
    for (const secret of ["123456789", "Sarah", STAFF]) {
      expect(logged).not.toContain(secret);
    }
  });

  it("keeps missing values and system entries as stored", async () => {
    markCase("machine-acat-history", "keeps missing values and system entries as stored");
    findHistory.mockResolvedValue([
      entry({ id: "LOG-2", field: "notes", oldValue: null, newValue: "called custodian", performedBy: null }),
      entry({ id: "LOG-1", action: "delete", field: null, oldValue: null, newValue: null }),
    ] as never);
    const res = await GET(request(), params());
    expect(await res.json()).toEqual([
      { id: "LOG-2", action: "update", field: "notes", oldValue: null, newValue: "called custodian", performedBy: null, timestamp: "2026-10-13T14:32:00.000Z" },
      { id: "LOG-1", action: "delete", field: null, oldValue: null, newValue: null, performedBy: STAFF, timestamp: "2026-10-13T14:32:00.000Z" },
    ]);
  });

  it("returns internal_error when storage fails", async () => {
    markCase("machine-acat-history", "returns internal_error when storage fails");
    findHistory.mockRejectedValue(new Error("connection reset"));
    const res = await GET(request(), params());
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "internal_error" });
  });
});
