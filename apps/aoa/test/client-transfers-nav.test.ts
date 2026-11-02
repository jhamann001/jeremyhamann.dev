import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { markCase } from "./acat-book-flywheel";

const root = process.cwd();
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");

describe("Client Transfers navigation", () => {
  it("lists Client Transfers only when the advisor list flag is on", () => {
    const nav = read("components/shell/nav-config.ts");
    const sidebar = read("components/shell/Sidebar.tsx");
    const layout = read("app/(authenticated)/layout.tsx");
    expect(nav).toContain('label: "Client Transfers", href: "/client-transfers"');
    expect(nav).toMatch(/href: "\/client-transfers"[^}]*requiresAdvisorList: true/);
    expect(sidebar).toContain("!item.requiresAdvisorList || advisorList");
    expect(layout).toContain("advisorList={acatAdvisorListEnabled()}");
    markCase("client-transfers-nav", "lists Client Transfers only when the advisor list flag is on");
  });
});
