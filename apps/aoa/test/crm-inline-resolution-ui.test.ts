import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("CRM Explorer inline resolution experience", () => {
  it("makes CRM Explorer the mapping decision surface", () => {
    const page = readFileSync("app/(authenticated)/crm/[id]/page.tsx", "utf8");
    expect(page).toContain("Relationship review");
    expect(page).toContain("Missing parent mapping");
    expect(page).toContain("Find the correct parent");
    expect(page).toContain("Find matches");
    expect(page).toContain("Use as parent");
    expect(page).toContain("Change parent");
    expect(page).toContain("confirmCrmParentMapping");
    expect(page).toContain("const parentSearchSubmitted = Boolean(requestedParentQuery)");
    expect(page).toContain("Find matches, then choose “Use as parent” to save and resolve this relationship.");
    expect(page).toContain("No matching active contacts or households were found.");
    expect(page).toContain("Production client records are not available in this environment.");
    expect(page).toContain("Search could not be completed. Try again.");
    expect(page).not.toContain("No matching active parent records. Try a client surname");
    expect(page).not.toContain("Resolve here →");
    expect(page).not.toContain("Review mapping →");
    expect(page).toContain("decision history can support safer suggestions later");
  });

  it("routes CRM review items to the inline panel and labels the queue as oversight", () => {
    const queue = readFileSync("app/(authenticated)/review-queue/page.tsx", "utf8");
    const materializer = readFileSync("lib/data/review-queue-materialize.ts", "utf8");
    expect(queue).toContain("Resolve in CRM Explorer →");
    expect(queue).toContain("this page tracks ownership, age, and history");
    expect(materializer).toContain("#resolve-parent-mapping");
  });

  it("puts the open CRM exception count on the CRM Explorer navigation item", () => {
    const sidebar = readFileSync("components/shell/Sidebar.tsx", "utf8");
    const counts = readFileSync("lib/data/nav-counts.ts", "utf8");
    expect(sidebar).toContain('"/crm": navigation.value.crmOpenExceptions');
    expect(counts).toContain("WHERE exception_state = 'OPEN'");
  });
});
