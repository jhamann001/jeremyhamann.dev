import { describe, it, expect, vi, beforeEach } from "vitest";
import { markCase } from "@/lib/test-flywheel";

const mockVerifyIdToken = vi.fn();
vi.mock("google-auth-library", () => ({
  OAuth2Client: class MockOAuth2Client {
    verifyIdToken = mockVerifyIdToken;
  },
}));

const searchClients = vi.fn();
vi.mock("@/lib/client-directory", () => ({
  searchClients: (...args: unknown[]) => searchClients(...args),
}));

vi.mock("@/lib/logger", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/rate-limit-redis", () => ({
  rateLimit: vi.fn().mockResolvedValue({ allowed: true, remaining: 59 }),
}));

const { GET } = await import("./route");

const ALLOWED_SA = "ops-portal-run@ops-portal.iam.gserviceaccount.com";
const SELECTED = "user-11111111-1111-1111-1111-111111111111";

function ticket(payload: Record<string, unknown> | undefined) {
  return { getPayload: () => payload };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockVerifyIdToken.mockResolvedValue(ticket({ email: ALLOWED_SA, email_verified: true }));
});

describe("GET /api/machine/clients/search", () => {
  it("machine client search without a bearer token is unauthorized", async () => {
    markCase("machine-client-search", "machine client search without a bearer token is unauthorized");
    const res = await GET(new Request("http://localhost/api/machine/clients/search?query=Sarah"));
    expect(res.status).toBe(401);
    expect(searchClients).not.toHaveBeenCalled();
  });

  it("machine client search rejects a query that is too short", async () => {
    markCase("machine-client-search", "machine client search rejects a query that is too short");
    const res = await GET(new Request("http://localhost/api/machine/clients/search?query=a", {
      headers: { authorization: "Bearer good" },
    }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "INVALID_REQUEST" });
    expect(searchClients).not.toHaveBeenCalled();
  });

  it("machine client search returns user-11111111-1111-1111-1111-111111111111", async () => {
    markCase("machine-client-search", "machine client search returns user-11111111-1111-1111-1111-111111111111");
    searchClients.mockResolvedValue({
      items: [{ cedarRidgeUserId: SELECTED, displayName: "Sarah", accountHints: [] }],
      hasMore: false,
      directory: { health: "FRESH" },
    });
    const res = await GET(new Request("http://localhost/api/machine/clients/search?query=Sarah", {
      headers: { authorization: "Bearer good" },
    }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items[0].cedarRidgeUserId).toBe(SELECTED);
  });
});
