import { beforeEach, describe, expect, it, vi } from "vitest";

const { scopeSpy } = vi.hoisted(() => ({ scopeSpy: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/flags", () => ({ crmIdentityReadsEnabled: () => true }));
vi.mock("@/lib/rls", () => ({ withUserScope: scopeSpy }));

import {
  allowedCrmParentTypes,
  confirmCrmParentOverride,
  crmParentSuggestionQuery,
  searchCrmParentCandidates,
  searchCrmParentCandidatesForReview,
} from "@/lib/data/crm-parent-resolution";

describe("CRM parent resolution seam", () => {
  beforeEach(() => {
    scopeSpy.mockReset();
  });

  it("limits each child record to valid parent types", () => {
    expect(allowedCrmParentTypes("APPOINTMENT")).toEqual(["CONTACT", "HOUSEHOLD"]);
    expect(allowedCrmParentTypes("CONTACT")).toEqual(["HOUSEHOLD"]);
    expect(allowedCrmParentTypes("EMAIL")).toEqual(["HOUSEHOLD"]);
    expect(allowedCrmParentTypes("HOUSEHOLD")).toEqual([]);
  });

  it("derives a conservative surname suggestion without persisting display text", () => {
    expect(crmParentSuggestionQuery("Mike and Alycia Reichert-Rosenbaum · Appointment"))
      .toBe("Reichert-Rosenbaum");
    expect(crmParentSuggestionQuery("Appointment")).toBe("");
    expect(crmParentSuggestionQuery(null)).toBe("");
  });

  it("searches only through the bounded RLS candidate query", async () => {
    const candidate = {
      crmId: "con_candidate", identityType: "CONTACT", displayName: "Alycia Reichert-Rosenbaum",
      sourceSystem: "CRM", sourceNamespace: "contact", sourceKey: "003candidate",
    };
    const tx = {
      $executeRaw: vi.fn().mockResolvedValue(1),
      $queryRaw: vi.fn().mockResolvedValue([candidate]),
    };
    scopeSpy.mockImplementation(async (...args: unknown[]) => {
      const fn = args.find((value) => typeof value === "function") as (value: typeof tx) => unknown;
      return fn(tx);
    });

    await expect(searchCrmParentCandidates(
      { role: "OPERATIONS", email: "ops@example.com" },
      "APPOINTMENT",
      "Reichert-Rosenbaum",
    )).resolves.toEqual([candidate]);
    expect(tx.$executeRaw).toHaveBeenCalledOnce();
    expect(tx.$queryRaw).toHaveBeenCalledOnce();
    const query = tx.$queryRaw.mock.calls[0]?.[0] as { strings?: string[] };
    const sql = query.strings?.join("?") ?? "";
    expect(sql).toContain("WITH source_matches AS MATERIALIZED");
    expect(sql).toContain("matching_mappings AS MATERIALIZED");
    expect(sql).toContain("JOIN LATERAL");
    expect(sql).toContain("UNION ALL");
    expect(sql).toContain("SELECT DISTINCT ON (candidate.crm_id)");
    expect(sql).toContain("i.identity_type = candidate.identity_type");
    expect(sql).not.toContain("m.identity_id ILIKE");
    expect(sql.indexOf("FROM mirror.household h"))
      .toBeLessThan(sql.indexOf("FROM app.crm_source_mapping candidate"));
    expect(sql).not.toContain("WHERE m.identity_id =");
  });

  it("uses the indexed identity lookup only for a typed internal parent ID", async () => {
    const tx = {
      $executeRaw: vi.fn().mockResolvedValue(1),
      $queryRaw: vi.fn().mockResolvedValue([]),
    };
    scopeSpy.mockImplementation(async (...args: unknown[]) => {
      const fn = args.find((value) => typeof value === "function") as (value: typeof tx) => unknown;
      return fn(tx);
    });

    await searchCrmParentCandidates(
      { role: "OPERATIONS", email: "ops@example.com" },
      "APPOINTMENT",
      "con_candidate",
    );

    const query = tx.$queryRaw.mock.calls[0]?.[0] as { strings?: string[] };
    const sql = query.strings?.join("?") ?? "";
    expect(sql).toContain("WHERE m.identity_id =");
  });

  it("distinguishes a completed search with no matches from a failed search", async () => {
    scopeSpy.mockResolvedValueOnce([]);
    await expect(searchCrmParentCandidatesForReview(
      { role: "OPERATIONS", email: "ops@example.com" },
      "APPOINTMENT",
      "No Match",
    )).resolves.toEqual({ status: "complete", candidates: [] });

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    scopeSpy.mockRejectedValueOnce(new Error("sensitive database detail"));
    await expect(searchCrmParentCandidatesForReview(
      { role: "OPERATIONS", email: "ops@example.com" },
      "APPOINTMENT",
      "Unavailable",
    )).resolves.toEqual({ status: "failed", candidates: [] });
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("crm_parent_candidate_search_failed"));
    expect(errorSpy).not.toHaveBeenCalledWith(expect.stringContaining("sensitive database detail"));
    errorSpy.mockRestore();
  });

  it("confirms through the constrained database function and fails closed", async () => {
    const tx = { $queryRaw: vi.fn().mockResolvedValue([{ saved_override_id: "c123", saved_relationship_code: "APPOINTMENT_TO_CONTACT" }]) };
    scopeSpy.mockImplementation(async (...args: unknown[]) => {
      const fn = args.find((value) => typeof value === "function") as (value: typeof tx) => unknown;
      return fn(tx);
    });
    const input = {
      exceptionId: "c_exception", childCrmId: "apt_child", parentCrmId: "con_parent",
    };
    await expect(confirmCrmParentOverride(
      { role: "OPERATIONS", email: "ops@example.com" }, input,
    )).resolves.toBe("saved");

    scopeSpy.mockRejectedValueOnce(new Error("hidden database detail"));
    await expect(confirmCrmParentOverride(
      { role: "OPERATIONS", email: "ops@example.com" }, input,
    )).resolves.toBe("invalid");
    await expect(confirmCrmParentOverride(
      { role: "VIEWER", email: "viewer@example.com" }, input,
    )).resolves.toBe("forbidden");
  });
});
