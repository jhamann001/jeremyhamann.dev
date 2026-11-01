import { afterEach, describe, expect, it, vi } from "vitest";
import { markCase } from "@/lib/test-flywheel";

vi.mock("@/lib/prisma", () => import("@/lib/__mocks__/prisma"));
vi.mock("@/lib/machine-auth", () => ({ verifyCustodianAdminCaller: vi.fn() }));
vi.mock("@/lib/rate-limit-redis", () => ({ rateLimit: vi.fn() }));
vi.mock("@/lib/custodian-timing-data", () => ({
  loadObservedCustodianTimings: vi.fn().mockResolvedValue(new Map()),
}));

import {
  custodianEditsRetiredResponse,
  trackerCustodianEditsRetired,
} from "@/lib/custodian-admin";

const SWITCH = "ENFORCE_CUSTODIAN_TRACKER_READ_ONLY";

afterEach(() => vi.unstubAllEnvs());

describe("tracker custodian edit retirement", () => {
  it("is off unless the retirement switch is exactly 1", () => {
    expect(trackerCustodianEditsRetired()).toBe(false);
    vi.stubEnv(SWITCH, "0");
    expect(trackerCustodianEditsRetired()).toBe(false);
    vi.stubEnv(SWITCH, "true");
    expect(trackerCustodianEditsRetired()).toBe(false);
    vi.stubEnv(SWITCH, "1");
    expect(trackerCustodianEditsRetired()).toBe(true);
    markCase("custodian-edit-retirement", "is off unless the retirement switch is exactly 1");
  });

  it("retired response is 405 custodian_edits_retired", async () => {
    const response = custodianEditsRetiredResponse();
    expect(response.status).toBe(405);
    expect(await response.json()).toEqual({ error: "custodian_edits_retired" });
    markCase("custodian-edit-retirement", "retired response is 405 custodian_edits_retired");
  });
});
