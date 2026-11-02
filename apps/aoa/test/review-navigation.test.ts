import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { NAV_GROUPS } from "@/components/shell/nav-config";

const assetTransferPage = readFileSync(
  resolve(process.cwd(), "app/(authenticated)/asset-transfer/page.tsx"),
  "utf8",
);
const sourceHealth = readFileSync(
  resolve(process.cwd(), "lib/data/source-health.ts"),
  "utf8",
);

describe("exception review navigation", () => {
  const navHrefs = NAV_GROUPS.flatMap((group) => group.items.map((item) => item.href));

  it("keeps redundant review surfaces out of the permanent sidebar", () => {
    expect(navHrefs).not.toContain("/review-queue");
    expect(navHrefs).not.toContain("/asset-mapping-review");
  });

  it("keeps asset mapping review available from Asset Transfer for authorized operators", () => {
    expect(assetTransferPage).toContain("canReviewAssetMapLinks(role)");
    expect(assetTransferPage).toContain('href="/asset-mapping-review"');
    expect(assetTransferPage).toContain("Review asset mapping");
  });

  it("routes CRM exception work directly to CRM Explorer while preserving the queue route", () => {
    expect(sourceHealth).toContain('"/crm?exceptions=open"');
    expect(sourceHealth).toContain("Open CRM exceptions");
    expect(existsSync(resolve(process.cwd(), "app/(authenticated)/review-queue/page.tsx"))).toBe(true);
  });
});
