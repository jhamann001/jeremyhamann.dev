import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  CRM_EXPLORER_ROLES,
  CRM_EXPLORER_LOCK_TIMEOUT_MS,
  CRM_EXPLORER_STATEMENT_TIMEOUT_MS,
  CRM_EXPLORER_TRANSACTION_MAX_WAIT_MS,
  CRM_EXPLORER_TRANSACTION_TIMEOUT_MS,
  CRM_EXPLORER_TYPES,
  canReadCrmExplorer,
  crmExplorerAvailable,
  crmExplorerLikePattern,
  normalizeCrmExplorerType,
  normalizeCrmLifecycleState,
} from "@/lib/data/crm-explorer";
import { NAV_GROUPS } from "@/components/shell/nav-config";

afterEach(() => {
  delete process.env.CRM_IDENTITY_READS;
});

describe("CRM explorer authorization and activation", () => {
  it("uses a bounded transaction window above Prisma's five-second default", () => {
    expect(CRM_EXPLORER_TRANSACTION_TIMEOUT_MS).toBe(15_000);
    expect(CRM_EXPLORER_TRANSACTION_MAX_WAIT_MS).toBe(5_000);
    expect(CRM_EXPLORER_STATEMENT_TIMEOUT_MS).toBe(10_000);
    expect(CRM_EXPLORER_LOCK_TIMEOUT_MS).toBe(2_000);
  });

  it("permits exactly the two current firm-wide operations roles", () => {
    expect([...CRM_EXPLORER_ROLES].sort()).toEqual(["ADMIN", "OPERATIONS"]);
    for (const role of ["ADMIN", "OPERATIONS"]) expect(canReadCrmExplorer(role)).toBe(true);
    for (const role of ["HEAD_OF_ADVISORY", "ADVISOR", "CLIENT_SERVICE", "VIEWER", ""])
      expect(canReadCrmExplorer(role)).toBe(false);
    expect(canReadCrmExplorer(null)).toBe(false);
    expect(canReadCrmExplorer(undefined)).toBe(false);
  });

  it("requires both the role and the exact identity-read flag", () => {
    process.env.CRM_IDENTITY_READS = "1";
    expect(crmExplorerAvailable("OPERATIONS")).toBe(true);
    expect(crmExplorerAvailable("ADMIN")).toBe(true);
    expect(crmExplorerAvailable("ADVISOR")).toBe(false);

    process.env.CRM_IDENTITY_READS = "true";
    expect(crmExplorerAvailable("OPERATIONS")).toBe(false);
  });

  it("adds one gated CRM Explorer item to the Admin navigation group", () => {
    const item = NAV_GROUPS.flatMap((group) => group.items).find((entry) => entry.href === "/crm");
    expect(item).toMatchObject({
      label: "CRM Explorer",
      requiredRoles: ["ADMIN", "OPERATIONS"],
      requiresCrmIdentityReads: true,
    });
  });
});

describe("CRM explorer filters", () => {
  it("accepts only the eight registered CRM explorer types", () => {
    expect(CRM_EXPLORER_TYPES).toEqual([
      "HOUSEHOLD", "CONTACT", "DEAL", "TRANSFER", "TASK", "EMAIL", "ACTIVITY",
      "APPOINTMENT",
    ]);
    expect(normalizeCrmExplorerType("HOUSEHOLD")).toBe("HOUSEHOLD");
    expect(normalizeCrmExplorerType("ACCOUNT")).toBeNull();
    expect(normalizeCrmExplorerType("household")).toBeNull();
  });

  it("accepts only database lifecycle states", () => {
    expect(normalizeCrmLifecycleState("ACTIVE")).toBe("ACTIVE");
    expect(normalizeCrmLifecycleState("MERGED")).toBe("MERGED");
    expect(normalizeCrmLifecycleState("ARCHIVED")).toBe("ARCHIVED");
    expect(normalizeCrmLifecycleState("active")).toBeNull();
    expect(normalizeCrmLifecycleState("DELETED")).toBeNull();
  });

  it("escapes source IDs before using the contains search", () => {
    expect(crmExplorerLikePattern("50%_\\id")).toBe("%50\\%\\_\\\\id%");
  });
});
