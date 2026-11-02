import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = (path: string): string =>
  readFileSync(resolve(process.cwd(), path), "utf8");

describe("performance report UI safety pause", () => {
  it("does not expose report launch controls from household or client surfaces", () => {
    for (const path of [
      "components/households/HouseholdsTable.tsx",
      "components/households/HouseholdOverview.tsx",
      "components/client-portrait/AccountsSection.tsx",
    ]) {
      const contents = source(path);
      expect(contents).not.toMatch(/\/performance\//);
      expect(contents).not.toMatch(/performance report/i);
      expect(contents).not.toMatch(/household report/i);
    }
  });

  it("retains the protected report routes for future accuracy work", () => {
    expect(source("app/(authenticated)/performance/[accountId]/page.tsx"))
      .toContain("canOpenReport");
    expect(source("app/(authenticated)/performance/household/[householdId]/page.tsx"))
      .toContain("canOpenReport");
  });
});
