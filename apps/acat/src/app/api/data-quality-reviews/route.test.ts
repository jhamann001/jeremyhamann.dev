import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockAuth = vi.fn();
vi.mock("@/lib/auth", () => ({ auth: (...args: unknown[]) => mockAuth(...args) }));
vi.mock("@/lib/prisma", () => import("@/lib/__mocks__/prisma"));

const { GET, POST } = await import("./route");
const { prisma } = await import("@/lib/prisma");

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue({ user: { email: "ops@example.com" } });
});

describe("data-quality reviews API", () => {
  it("returns saved reviews", async () => {
    (prisma.dataQualityReview.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([{ id: "review-1" }]);
    const response = await GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([{ id: "review-1" }]);
  });

  it("requires a note for false positives", async () => {
    const response = await POST(new Request("http://localhost/api/data-quality-reviews", {
      method: "POST",
      body: JSON.stringify({
        acatRecordId: "record-1",
        ruleKey: "duplicate_control",
        fingerprint: "C1|2",
        status: "CLOSED",
        resolution: "FALSE_POSITIVE",
      }),
    }) as Parameters<typeof POST>[0]);
    expect(response.status).toBe(400);
    expect(prisma.dataQualityReview.upsert).not.toHaveBeenCalled();
  });

  it("upserts a closed exception instance", async () => {
    (prisma.acatRecord.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "record-1" });
    (prisma.dataQualityReview.upsert as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "review-1", status: "CLOSED" });
    const response = await POST(new Request("http://localhost/api/data-quality-reviews", {
      method: "POST",
      body: JSON.stringify({
        acatRecordId: "record-1",
        ruleKey: "duplicate_control",
        fingerprint: "C1|2",
        status: "CLOSED",
        resolution: "FALSE_POSITIVE",
        note: "Known source-system reuse",
      }),
    }) as Parameters<typeof POST>[0]);
    expect(response.status).toBe(200);
    expect(prisma.dataQualityReview.upsert).toHaveBeenCalled();
  });

  it("rejects unauthenticated callers", async () => {
    mockAuth.mockResolvedValue(null);
    expect((await GET()).status).toBe(401);
  });
});

describe("data-quality reviews in the public demo", () => {
  const close = () => POST(new Request("http://localhost/api/data-quality-reviews", {
    method: "POST",
    body: JSON.stringify({ acatRecordId: "record-1", ruleKey: "duplicate_control", fingerprint: "C1|2", status: "IN_REVIEW" }),
  }) as Parameters<typeof POST>[0]);
  beforeEach(() => {
    vi.stubEnv("PERSONA_SIGN_IN", "on");
    (prisma.acatRecord.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "record-1" });
    vi.mocked(prisma.dataQualityReview.count).mockResolvedValue(300);
  });
  afterEach(() => vi.unstubAllEnvs());

  it("refuses a new review once the demo holds its cap", async () => {
    vi.mocked(prisma.dataQualityReview.findUnique).mockResolvedValue(null);
    const response = await close();
    expect(response.status).toBe(429);
    expect((await response.json()).error).toMatch(/^The demo holds up to 300 data-quality reviews/);
    expect(prisma.dataQualityReview.upsert).not.toHaveBeenCalled();
  });

  it("still updates an existing review at the cap, which adds no row", async () => {
    vi.mocked(prisma.dataQualityReview.findUnique).mockResolvedValue({ id: "review-1" } as never);
    vi.mocked(prisma.dataQualityReview.upsert).mockResolvedValue({ id: "review-1" } as never);
    expect((await close()).status).toBe(200);
  });
});
