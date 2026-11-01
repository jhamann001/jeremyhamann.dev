import { beforeEach, describe, expect, it, vi } from "vitest";
import { markCase } from "@/lib/test-flywheel";

const mockVerifyIdToken = vi.fn();
vi.mock("google-auth-library", () => ({
  OAuth2Client: class MockOAuth2Client {
    verifyIdToken = mockVerifyIdToken;
  },
}));

vi.mock("@/lib/logger", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

const PROD_WRITE_SA = "ops-portal-run@ops-portal.iam.gserviceaccount.com";
const DEV_WRITE_SA = "ops-portal-dev-run@ops-portal-dev.iam.gserviceaccount.com";

function request(path: string, method: string, email: string): Request {
  mockVerifyIdToken.mockResolvedValue({
    getPayload: () => ({ email, email_verified: true }),
  });
  return new Request(`https://tracker.test${path}`, {
    method,
    headers: { authorization: "Bearer synthetic" },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  delete process.env.MACHINE_AUTH_AUDIENCE;
  delete process.env.MACHINE_AUTH_ALLOWED_SAS;
  delete process.env.TRANSFER_LINKAGE_ENABLED;
  delete process.env.TRANSFER_LINKAGE_ALLOWED_SAS;
  delete process.env.TRANSFER_LINKAGE_ENVIRONMENT;
});

describe("verifyCustodianProjectionCaller", () => {
  it("prod service account may POST the projection path", async () => {
    markCase("machine-auth-projection", "prod service account may POST the projection path");
    const { verifyCustodianProjectionCaller } = await import("./machine-auth");
    await expect(verifyCustodianProjectionCaller(
      request("/api/machine/custodians/projection", "POST", PROD_WRITE_SA),
    )).resolves.toEqual({ email: PROD_WRITE_SA });
  });

  it("dev write service account may POST the projection path", async () => {
    markCase("machine-auth-projection", "dev write service account may POST the projection path");
    const { verifyCustodianProjectionCaller } = await import("./machine-auth");
    await expect(verifyCustodianProjectionCaller(
      request("/api/machine/custodians/projection", "POST", DEV_WRITE_SA),
    )).resolves.toEqual({ email: DEV_WRITE_SA });
  });

  it("an unlisted service account is refused", async () => {
    markCase("machine-auth-projection", "an unlisted service account is refused");
    const { verifyCustodianProjectionCaller } = await import("./machine-auth");
    await expect(verifyCustodianProjectionCaller(
      request("/api/machine/custodians/projection", "POST", "other@example.com"),
    )).resolves.toBeNull();
  });

  it("GET on the projection path is refused", async () => {
    markCase("machine-auth-projection", "GET on the projection path is refused");
    const { verifyCustodianProjectionCaller } = await import("./machine-auth");
    await expect(verifyCustodianProjectionCaller(
      request("/api/machine/custodians/projection", "GET", PROD_WRITE_SA),
    )).resolves.toBeNull();
  });

  it("POST on the custodian library path is refused", async () => {
    markCase("machine-auth-projection", "POST on the custodian library path is refused");
    const { verifyCustodianProjectionCaller } = await import("./machine-auth");
    await expect(verifyCustodianProjectionCaller(
      request("/api/machine/custodians", "POST", PROD_WRITE_SA),
    )).resolves.toBeNull();
  });

  it("an allow-list that drops the prod identity refuses every caller", async () => {
    markCase("machine-auth-projection", "an allow-list that drops the prod identity refuses every caller");
    process.env.MACHINE_AUTH_ALLOWED_SAS = DEV_WRITE_SA;
    const { verifyCustodianProjectionCaller } = await import("./machine-auth");
    await expect(verifyCustodianProjectionCaller(
      request("/api/machine/custodians/projection", "POST", PROD_WRITE_SA),
    )).resolves.toBeNull();
    await expect(verifyCustodianProjectionCaller(
      request("/api/machine/custodians/projection", "POST", DEV_WRITE_SA),
    )).resolves.toBeNull();
  });
});
