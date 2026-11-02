import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const layout = readFileSync(join(root, "app/(authenticated)/layout.tsx"), "utf8");
const sidebar = readFileSync(join(root, "components/shell/Sidebar.tsx"), "utf8");
const action = readFileSync(
  join(root, "app/(authenticated)/nav-counts-action.ts"),
  "utf8",
);
const counts = readFileSync(join(root, "lib/data/nav-counts.ts"), "utf8");

describe("deferred sidebar navigation counts", () => {
  it("does not block the authenticated layout on badge queries", () => {
    expect(layout).not.toContain('from "@/lib/data/nav-counts"');
    expect(layout).not.toContain("navCounts(identity)");
    expect(sidebar).toContain('useSidebarCounts("/api/navigation/badges"');
    expect(sidebar).not.toContain("getLiveNavCounts");
    expect(sidebar).not.toContain("getLiveAcatCount");
    expect(sidebar).toContain('liveCounts?.[item.href]');
  });

  it("authenticates, preserves the scoped reader, and fails soft", () => {
    expect(action).toContain("const session = await auth()");
    expect(action).toContain("return await navCounts({ role, email })");
    expect(action).toContain('console.error("[nav-counts] unavailable")');
    expect(action).toContain("return null");
  });

  it("allows cold canonical-overlay counts to outlive Prisma's default", () => {
    expect(counts).toContain("{ timeout: 15_000, maxWait: 5_000 }");
    expect(counts).toContain("set_config('statement_timeout', '10000', true)");
    expect(counts).toContain("set_config('lock_timeout', '2000', true)");
  });
});
