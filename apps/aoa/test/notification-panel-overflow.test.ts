import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fitNotificationPanel } from "@/components/shell/NotificationPanel";

const css = readFileSync("components/shell/Topbar.module.css", "utf8");
const desktop = css.slice(0, css.indexOf("@media"));
const rule = (source: string, selector: string) => {
  const match = source.match(new RegExp(`(?:^|\\n)${selector.replace(/\./g, "\\.")} \\{([^}]*)\\}`));
  if (!match) throw new Error(`missing ${selector}`);
  return match[1];
};

function panelAt(top: number) {
  const set: Record<string, string> = {};
  fitNotificationPanel({
    getBoundingClientRect: () => ({ top }) as DOMRect,
    style: { setProperty: (name: string, value: string | null) => { set[name] = value ?? ""; } },
  });
  return set;
}

describe("notification panel overflow", () => {
  it("records the panel's measured top for the viewport cap", () => {
    expect(panelAt(58.4)).toEqual({ "--notification-panel-top": "59px" });
    expect(panelAt(171.6)).toEqual({ "--notification-panel-top": "172px" });
    expect(panelAt(-20)).toEqual({ "--notification-panel-top": "0px" });
  });

  it("caps the panel to the visible viewport below its measured top, not to a fixed height", () => {
    const panel = rule(desktop, ".notificationPanel");
    expect(panel).toContain("max-height: calc(100dvh - var(--notification-panel-top, 74px) - 16px);");
    expect(panel).toContain("max-height: calc(100vh - var(--notification-panel-top, 74px) - 16px);");
    expect(panel).not.toMatch(/max-height:\s*\d+px/);
    expect(panel).toMatch(/display: flex;\s*flex-direction: column;/);
    expect(panel).toContain("overflow-y: auto;");
    expect(panel).toContain("overscroll-behavior: contain;");
  });

  it("scrolls the grouped list inside the panel while the header and its controls stay put", () => {
    const body = rule(desktop, ".notificationBody");
    expect(body).toContain("min-height: 0;");
    expect(body).toContain("overflow-y: auto;");
    expect(body).toContain("overscroll-behavior: contain;");
    expect(body).toContain("scroll-padding-top: 3.25rem;");
    expect(rule(desktop, ".notificationHeader")).toMatch(/position: sticky;\s*top: 0;\s*z-index: 2;\s*flex: none;\s*background: var\(--panel\);/);
    expect(rule(desktop, ".bellGroupHeading")).toMatch(/position: sticky;\s*top: 0;\s*z-index: 1;\s*background: var\(--panel\);/);
  });

  it("keeps the phone body cap and 44px targets", () => {
    const phone = css.slice(css.indexOf("@media (max-width: 640px)"));
    expect(phone).toMatch(/\.notificationBody \{\s*max-height: min\(70dvh, 560px\);\s*overflow-y: auto;/);
    expect(phone).toContain("min-height: 44px;");
  });
});
