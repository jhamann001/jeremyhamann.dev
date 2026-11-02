import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TradeRequestStatusPill } from "@/components/trade-requests/status-pill";
import { resolveTradeRequestStatus } from "@/lib/data/trade-request-status-catalog";

const render = (status: string | null | undefined) => renderToStaticMarkup(createElement(TradeRequestStatusPill, { status }));

describe("TradeRequestStatusPill (AC-3)", () => {
  it("shows the catalog label and tone for each stored status", () => {
    const table: Array<[string, string, string, string]> = [
      ["Pending Review", "Pending Review", "amber", "Awaiting trader review"],
      ["Needs Info", "Needs Info", "red", "Returned to advisor for additional details"],
      ["Pending Current Asset Liquidation", "Pending Liquidation", "amber", "Waiting for existing positions to be sold"],
      ["Approved", "Approved", "green", "Approved and ready for execution"],
      ["Rejected", "Rejected", "red", "Permanently rejected — advisor must submit a new request"],
      ["Completed", "Completed", "blue", "Fully executed"],
    ];
    for (const [status, label, tone, title] of table) {
      const html = render(status);
      expect(resolveTradeRequestStatus(status)).toEqual({ label, tone });
      expect(html).toContain(`data-status-tone="${tone}"`);
      expect(html).toContain(`>${label}<`);
      expect(html).toContain(`title="${title}"`);
    }
    expect(render("Pending Current Asset Liquidation")).not.toContain(">Pending Current Asset Liquidation<");
  });

  it("blank or missing status shows Unknown status in gray", () => {
    for (const status of [null, undefined, "", "  "]) {
      const html = render(status);
      expect(html).toContain(">Unknown status<");
      expect(html).toContain('data-status-tone="gray"');
      expect(html).not.toContain("title=");
    }
  });

  it("any other status shows a readable gray label", () => {
    const html = render("On Hold");
    expect(html).toContain(`>${resolveTradeRequestStatus("On Hold").label}<`);
    expect(html).toContain('data-status-tone="gray"');
    expect(html).not.toContain("title=");
  });

  it("object property names from the service fall back like any other unknown status", () => {
    for (const status of ["constructor", "toString", "hasOwnProperty", "__proto__", "valueOf"]) {
      const meta = resolveTradeRequestStatus(status);
      expect(meta.tone).toBe("gray");
      expect(typeof meta.label).toBe("string");
      expect(meta.label.length).toBeGreaterThan(0);
      const html = render(status);
      expect(html).toContain('data-status-tone="gray"');
      expect(html).not.toContain("title=");
      expect(html).not.toContain("function");
    }
    expect(resolveTradeRequestStatus("constructor").label).toBe("Constructor");
  });
});
