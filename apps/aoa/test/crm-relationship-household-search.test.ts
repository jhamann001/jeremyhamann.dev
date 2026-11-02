import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Relationships household/member search", () => {
  it("offers a bounded household/member search on the Relationships page", () => {
    const page = readFileSync("app/(authenticated)/relationships/page.tsx", "utf8");

    expect(page).toContain("Household or member name");
    expect(page).toContain('name="household"');
    expect(page).toContain("Search households");
    expect(page).toContain("No household matches found.");
    expect(page).toContain("CRM ID");
    expect(page).toContain("/relationships?root=");
  });

  it("keeps the lookup RLS-scoped, role-gated, active-only, and bounded", () => {
    const data = readFileSync("lib/data/crm-relationship-workspace.ts", "utf8");
    const search = data.slice(
      data.indexOf("export async function searchCrmRelationshipHouseholds("),
      data.indexOf("function semanticEndpoints("),
    );

    expect(search).toContain("canReadCrmRelationships(identity.role)");
    expect(search).toContain("crmRelationshipsEnabled()");
    expect(search).toContain("withUserScope(identity");
    expect(search).toContain("identity.identity_type = 'HOUSEHOLD'");
    expect(search).toContain("identity.lifecycle_state = 'ACTIVE'");
    expect(search).toContain("mapping.mapping_state = 'ACTIVE'");
    expect(search).toContain("household.display_name ILIKE");
    expect(search).toContain("LIMIT ${HOUSEHOLD_SEARCH_LIMIT}");
    expect(search).not.toContain("console.");
  });
});
