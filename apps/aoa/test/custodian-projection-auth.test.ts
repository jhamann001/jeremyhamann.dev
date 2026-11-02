import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { markCase } from "./acat-book-flywheel";

const { verify } = vi.hoisted(() => ({ verify: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("google-auth-library", () => ({ OAuth2Client: class { verifyIdToken = verify; } }));
import { requireCustodianProjectionCronAuth } from "@/lib/cron/custodian-projection-auth";

const audience = "https://synthetic.example.invalid/api/cron/custodian-projection";
const request = (method = "POST") =>
  new Request(`http://internal.invalid/api/cron/custodian-projection`, {
    method,
    headers: { authorization: "Bearer synthetic-jwt" },
  });

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("AOA_WRITES_PAUSED", "0");
  vi.stubEnv("CUSTODIAN_PROJECTION_SCHEDULER_SERVICE_ACCOUNT", "service-account@example-project.iam.gserviceaccount.com");
  vi.stubEnv("CUSTODIAN_PROJECTION_SCHEDULER_AUDIENCE", "");
});
afterEach(() => vi.unstubAllEnvs());

describe("custodian projection scheduler authentication", () => {
  it("fails closed when the audience is unset", async () => {
    vi.stubEnv("CUSTODIAN_PROJECTION_SCHEDULER_AUDIENCE", "");
    expect(await requireCustodianProjectionCronAuth(request())).toBe(false);
    expect(verify).not.toHaveBeenCalled();
    markCase("custodian-projection-auth", "fails closed when the audience is unset");
  });

  it("rejects GET before verification", async () => {
    vi.stubEnv("CUSTODIAN_PROJECTION_SCHEDULER_AUDIENCE", audience);
    expect(await requireCustodianProjectionCronAuth(request("GET"))).toBe(false);
    expect(verify).not.toHaveBeenCalled();
    markCase("custodian-projection-auth", "rejects GET before verification");
  });

  it("rejects an audience with a query string before verification", async () => {
    vi.stubEnv("CUSTODIAN_PROJECTION_SCHEDULER_AUDIENCE", `${audience}?scope=all`);
    expect(await requireCustodianProjectionCronAuth(request())).toBe(false);
    expect(verify).not.toHaveBeenCalled();
    markCase("custodian-projection-auth", "rejects an audience with a query string before verification");
  });
});
