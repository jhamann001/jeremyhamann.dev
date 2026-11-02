import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const householdsData = readFileSync(join(process.cwd(), "lib/data/households.ts"), "utf8");
const displayData = readFileSync(join(process.cwd(), "lib/data/household-display.ts"), "utf8");
const clientsData = readFileSync(join(process.cwd(), "lib/data/clients.ts"), "utf8");
const navCounts = readFileSync(join(process.cwd(), "lib/data/nav-counts.ts"), "utf8");
const crmExplorer = readFileSync(join(process.cwd(), "lib/data/crm-explorer.ts"), "utf8");
const householdPage = readFileSync(join(
  process.cwd(), "app/(authenticated)/households/[id]/page.tsx",
), "utf8");
const canonicalHouseholdRoute = readFileSync(join(
  process.cwd(), "components/households/CanonicalHouseholdRoute.tsx",
), "utf8");
const crmPage = readFileSync(join(
  process.cwd(), "app/(authenticated)/crm/[id]/page.tsx",
), "utf8");

describe("AOA canonical household read overlay", () => {
  it("hides only confirmed shells from the directory and action counts", () => {
    expect(householdsData).toContain("householdDisplayCtes");
    expect(clientsData).toContain("householdDisplayCtes");
    expect(displayData).toContain("resolve_crm_canonical_household_overlays");
    expect(navCounts).toContain("resolve_crm_canonical_household_overlays");
    expect(householdsData).not.toContain("resolve_crm_canonical_household_source_key(h.sf_id)");
    expect(clientsData).not.toContain("resolve_crm_canonical_household_source_key(c.household_id)");
    expect(navCounts).not.toContain("resolve_crm_canonical_household_source_key(sf_id)");
    expect(navCounts).toContain("candidate.status = 'NEW'");
    expect(crmExplorer).toContain("candidate.status = 'NEW'");
    expect(navCounts).not.toContain("candidate.status IN ('NEW', 'READY_FOR_FOLLOW_UP')");
    expect(crmExplorer).not.toContain("candidate.status IN ('NEW', 'READY_FOR_FOLLOW_UP')");
  });

  it("resolves suppressed household and CRM routes to the selected survivor", () => {
    expect(householdPage).toContain("canonicalRouteId !== id");
    expect(householdPage).toContain("<CanonicalHouseholdRoute canonicalId={canonicalRouteId} />");
    expect(canonicalHouseholdRoute).toContain("window.history.replaceState");
    expect(canonicalHouseholdRoute).toContain("encodeURIComponent(canonicalId)");
    expect(householdPage).not.toContain("redirect(`/households/${encodeURIComponent(canonicalRouteId)}`)");
    expect(crmPage).toContain("resolveCrmDuplicateCanonicalIdentity");
    expect(crmPage).toContain("canonicalCrmId !== requestedCrmId");
  });

  it("combines confirmed source records across the household operating view", () => {
    expect(householdsData).toContain("crmCanonicalHouseholdSourceKeys");
    expect(householdsData).toContain("householdInvestmentAumStateForSources");
    expect(householdPage).toContain('getHouseholdHistoryPage(identity, householdId, "tasks"');
    expect(householdPage).toContain('getHouseholdHistoryPage(identity, householdId, "email"');
    expect(householdPage).toContain('getHouseholdHistoryPage(identity, householdId, "activity"');
    expect(householdPage).toContain("source records combined in AOA");
  });
});
