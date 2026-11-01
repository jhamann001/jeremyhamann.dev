import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/prisma", () => import("@/lib/__mocks__/prisma"));

const mockPost = vi.fn();
vi.mock("@/lib/slack-webhook", async () => {
  const actual = await vi.importActual<typeof import("@/lib/slack-webhook")>(
    "@/lib/slack-webhook"
  );
  return {
    ...actual,
    postToSlack: (...args: unknown[]) => mockPost(...args),
  };
});

const { POST } = await import("./route");
const { prisma } = await import("@/lib/prisma");

const TOKEN = "test-cron-token";

function makeRequest(headers: Record<string, string> = {}): Parameters<typeof POST>[0] {
  return new Request("http://localhost/api/cron/daily-digest", {
    method: "POST",
    headers,
  }) as Parameters<typeof POST>[0];
}

const SAVED_TOKEN = process.env.DIGEST_CRON_TOKEN;

beforeEach(() => {
  process.env.DIGEST_CRON_TOKEN = TOKEN;
  vi.clearAllMocks();
  mockPost.mockResolvedValue(undefined);
  (prisma.acatRecord.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
    {
      id: "REC-1",
      clientName: "Test Client",
      apexAccountId: "A",
      status: "Submitted",
      crmDealId: "P",
      custodianId: "C",
      custodianName: "Schwab",
      acatDate: new Date(Date.now() - 86_400_000 * 3).toISOString(),
      slackAlerted: false,
      mappingSource: "",
      apexSource: "",
      assets: [],
      lastUpdated: new Date().toISOString(),
    },
  ]);
});

afterEach(() => {
  if (SAVED_TOKEN) process.env.DIGEST_CRON_TOKEN = SAVED_TOKEN;
  else delete process.env.DIGEST_CRON_TOKEN;
});

describe("POST /api/cron/daily-digest", () => {
  it("returns 500 when DIGEST_CRON_TOKEN is not configured", async () => {
    delete process.env.DIGEST_CRON_TOKEN;
    const res = await POST(makeRequest());
    expect(res.status).toBe(500);
    expect(mockPost).not.toHaveBeenCalled();
  });

  it("returns 401 when the Authorization header is missing", async () => {
    const res = await POST(makeRequest());
    expect(res.status).toBe(401);
    expect(mockPost).not.toHaveBeenCalled();
  });

  it("returns 401 when the bearer token doesn't match", async () => {
    const res = await POST(
      makeRequest({ authorization: "Bearer not-the-token" })
    );
    expect(res.status).toBe(401);
    expect(mockPost).not.toHaveBeenCalled();
  });

  it("returns 401 when the scheme is wrong (Basic instead of Bearer)", async () => {
    const res = await POST(makeRequest({ authorization: `Basic ${TOKEN}` }));
    expect(res.status).toBe(401);
    expect(mockPost).not.toHaveBeenCalled();
  });

  it("returns 200 + summary and posts to Slack on success", async () => {
    const res = await POST(makeRequest({ authorization: `Bearer ${TOKEN}` }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; sent: Record<string, number> };
    expect(body.ok).toBe(true);
    expect(body.sent.active).toBe(1);
    expect(mockPost).toHaveBeenCalledTimes(1);
  });

  it("filters out soft-deleted records (passes deletedAt: null)", async () => {
    await POST(makeRequest({ authorization: `Bearer ${TOKEN}` }));
    const args = (prisma.acatRecord.findMany as ReturnType<typeof vi.fn>).mock
      .calls[0][0];
    expect(args.where).toEqual({ deletedAt: null });
    expect(args.include).toEqual({ assets: true });
  });

  it("returns 500 on DB read failure without posting to Slack", async () => {
    (prisma.acatRecord.findMany as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("DB down")
    );
    const res = await POST(makeRequest({ authorization: `Bearer ${TOKEN}` }));
    expect(res.status).toBe(500);
    expect(mockPost).not.toHaveBeenCalled();
  });

  it("returns 502 when the Slack post fails", async () => {
    const { SlackWebhookError } = await import("@/lib/slack-webhook");
    mockPost.mockRejectedValue(new SlackWebhookError("invalid_payload", 400));
    const res = await POST(makeRequest({ authorization: `Bearer ${TOKEN}` }));
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string; status: number };
    expect(body.status).toBe(400);
  });
});
