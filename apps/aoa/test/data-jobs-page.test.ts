import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ auth: vi.fn(), healthEnabled: vi.fn(), jobsEnabled: vi.fn() }));
vi.mock("@/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/flags", () => ({ dataHealthEnabled: mocks.healthEnabled, dataJobMonitoringEnabled: mocks.jobsEnabled }));
vi.mock("@/lib/data/source-health", () => ({ canViewSourceHealth: (role: string) => role === "ADMIN" || role === "OPERATIONS" }));
vi.mock("next/navigation", () => ({ notFound: () => { throw new Error("NOT_FOUND"); }, redirect: () => { throw new Error("REDIRECT"); } }));

import DataJobsPage from "@/app/(authenticated)/data-health/jobs/page";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue({ user: { role: "OPERATIONS", email: "operator@example.invalid" } });
  mocks.healthEnabled.mockReturnValue(true);
  mocks.jobsEnabled.mockReturnValue(true);
});

describe("Data jobs page authorization", () => {
  it("redirects unauthenticated visitors before consulting feature flags", async () => {
    mocks.auth.mockResolvedValue(null);
    await expect(DataJobsPage()).rejects.toThrow("REDIRECT");
    expect(mocks.healthEnabled).not.toHaveBeenCalled();
    expect(mocks.jobsEnabled).not.toHaveBeenCalled();
  });

  it.each(["VIEWER", "ADVISOR", "CLIENT_SERVICE", "HEAD_OF_ADVISORY", "", undefined])("hides operational job metadata from role %s", async (role) => {
    mocks.auth.mockResolvedValue({ user: { role, email: "viewer@example.invalid" } });
    await expect(DataJobsPage()).rejects.toThrow("NOT_FOUND");
  });

  it.each(["ADMIN", "OPERATIONS"])("permits %s only with both feature flags enabled", async (role) => {
    mocks.auth.mockResolvedValue({ user: { role, email: "operator@example.invalid" } });
    expect(await DataJobsPage()).toBeTruthy();
    mocks.jobsEnabled.mockReturnValue(false);
    await expect(DataJobsPage()).rejects.toThrow("NOT_FOUND");
    mocks.jobsEnabled.mockReturnValue(true);
    mocks.healthEnabled.mockReturnValue(false);
    await expect(DataJobsPage()).rejects.toThrow("NOT_FOUND");
  });
});
