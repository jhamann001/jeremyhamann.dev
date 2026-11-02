import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PDF_YIELD_EVERY, buildCompliancePdf } from "@/components/trade-requests/export/compliance-pdf";
import { buildRequestPdf } from "@/lib/trade-requests/request-pdf";
import { pdfPageTexts } from "./helpers/pdf-text";
import { SYNTHETIC_EXPORTER, syntheticRequest } from "./helpers/export-requests";

// ticket: the Compliance Export Report follows the standalone
// buildCompliancePdf (trade-request shared/src/pdf.ts); statuses print as
// stored (D-01 Option A). Synthetic data only.

const NOW = new Date("2026-10-17T12:00:00.000Z");

describe("Compliance Export Report PDF (ticket, AC-141, AC-54)", () => {
  it("prints the cover, the summary by stored status, the notice, each request and the footer", async () => {
    const requests = [
      syntheticRequest({
        id: "REQ-SYN0003", clientId: "HH-901", clientIds: ["HH-901", "HH-902"], clientNames: ["Synthetic Family", "Sample Person"],
        status: "Pending Current Asset Liquidation", advisorExclusions: "SYNX", selectedAccounts: ["SYN-1001"],
        auditLog: [{ id: "a1", date: "2026-10-15T14:00:00.000Z", user: "Avery Stone", action: "Created Request", notes: "Initial submission" }],
      }),
      syntheticRequest({ id: "REQ-SYN0002", clientId: "HH-903", clientIds: ["HH-903"], status: "Approved", auditLog: [] }),
      syntheticRequest({ id: "REQ-SYN0001", clientId: "HH-904", clientIds: ["HH-904"], status: "Approved" }),
    ];
    const built = await buildCompliancePdf(requests, SYNTHETIC_EXPORTER, {
      "HH-901": [
        { id: "x1", clientId: "HH-901", ticker: "SYNA", kind: "advisor", reason: "Synthetic hold", noBuy: true, noSell: false },
        { id: "x2", clientId: "HH-901", ticker: "SYNC", kind: "client", reason: "", noBuy: true, noSell: true },
      ],
    }, {
      "REQ-SYN0003": [{ accountNumber: "SYN-1001", kind: "client", ticker: "SYND", reason: "", noBuy: false, noSell: true }],
    }, NOW);

    expect(built.filename).toBe("Compliance_Report_2026-10-17.pdf");
    const pages = await pdfPageTexts(built.bytes);
    const [cover, ...rest] = pages;
    expect(cover).toEqual(expect.arrayContaining([
      "Compliance Export Report", "Date: October 17, 2026", "Exported By: Riley Ops (ops@example.invalid)", "Total Records: 3",
      "Report ID: RPT-20261017120000", "Summary by Status", "Status", "Count",
      "CONFIDENTIAL",
      "This document contains confidential compliance data. Distribution is restricted to authorized personnel only.",
      "Unauthorized reproduction or distribution is prohibited.",
    ]));
    const summary = cover.slice(cover.indexOf("Count") + 1, cover.indexOf("CONFIDENTIAL"));
    expect(summary).toEqual(["Approved", "2", "Pending Current Asset Liquidation", "1"]);
    expect(cover).not.toContain("#1  REQ-SYN0003  —  Synthetic Family & Sample Person");

    const body = rest.flat();
    expect(body.slice(0, 2)).toEqual(["#1  REQ-SYN0003  —  Synthetic Family & Sample Person", "PENDING CURRENT ASSET LIQUIDATION"]);
    const first = body.slice(0, body.indexOf("#2  REQ-SYN0002  —  Synthetic Family"));
    expect(first).toEqual(expect.arrayContaining([
      "Request Details", "Advisor Exclusions:  ", "SYNX",
      "Standing Advisor Exclusions (current):  ", "SYNA (DNB - Synthetic hold)",
      "Standing Client Exclusions (current):  ", "SYNC (DNB+DNS)",
      "Standing Account Client Exclusions (current):  ", "SYN-1001: SYND (DNS)",
      "Audit Trail", "Created Request", "Initial submission",
    ]));
    expect(first.indexOf("Advisor Exclusions:  ")).toBeLessThan(first.indexOf("Standing Advisor Exclusions (current):  "));
    expect(first.indexOf("Standing Client Exclusions (current):  ")).toBeLessThan(first.indexOf("Standing Account Client Exclusions (current):  "));
    expect(body).toContain("APPROVED");
    expect(body).toContain("#3  REQ-SYN0001  —  Synthetic Family");
    const second = body.slice(body.indexOf("#2  REQ-SYN0002  —  Synthetic Family"), body.indexOf("#3  REQ-SYN0001  —  Synthetic Family"));
    expect(second).not.toContain("Standing Advisor Exclusions (current):  ");
    expect(second).not.toContain("Audit Trail");

    pages.forEach((page, index) => {
      expect(page).toContain("Exported: 2026-10-17T12:00:00.000Z");
      expect(page).toContain(`Page ${index + 1} of ${pages.length}`);
    });
  });

  it("flows a long export across pages with the footer on every page", async () => {
    const requests = Array.from({ length: 40 }, (_, n) => syntheticRequest({ id: `REQ-SYN${String(n).padStart(4, "0")}` }));
    const pages = await pdfPageTexts((await buildCompliancePdf(requests, SYNTHETIC_EXPORTER, {}, {}, NOW)).bytes);
    expect(pages.length).toBeGreaterThan(5);
    expect(pages[0]).toContain("Total Records: 40");
    expect(pages.flat().filter((text) => /^#\d+  REQ-SYN/.test(text))).toHaveLength(40);
    pages.forEach((page, index) => expect(page).toContain(`Page ${index + 1} of ${pages.length}`));
  });

  it("builds a 5,000-request report, yielding to the event loop between requests", async () => {
    const requests = Array.from({ length: 5000 }, (_, n) => syntheticRequest({ id: `REQ-BULK${String(n).padStart(5, "0")}`, clientId: `HH-${n % 40}` }));
    let ticks = 0;
    let running = true;
    const tick = () => { ticks += 1; if (running) setTimeout(tick, 0); };
    setTimeout(tick, 0);
    const built = await buildCompliancePdf(requests, SYNTHETIC_EXPORTER, {}, {}, NOW);
    running = false;
    expect(built.filename).toBe("Compliance_Report_2026-10-17.pdf");
    expect(built.bytes.length).toBeGreaterThan(1_000_000);
    expect(ticks).toBeGreaterThanOrEqual(5000 / PDF_YIELD_EVERY - 1);
  }, 120_000);

  it("an empty export is the cover and one blank page, as in the standalone", async () => {
    const pages = await pdfPageTexts((await buildCompliancePdf([], SYNTHETIC_EXPORTER, {}, {}, NOW)).bytes);
    expect(pages).toHaveLength(2);
    expect(pages[0]).toContain("Total Records: 0");
    expect(pages[1]).toEqual(["Exported: 2026-10-17T12:00:00.000Z", "Page 2 of 2"]);
  });
});

describe("Compliance Export Report bytes unchanged by yielding", () => {
  afterEach(() => vi.useRealTimers());

  it("matches the bytes built before the report yielded between requests", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    const requests = Array.from({ length: 120 }, (_, n) => syntheticRequest({
      id: `REQ-Y${n}`, clientId: `HH-${n % 7}`, status: ["Approved", "Pending Review", "Needs Info"][n % 3],
    }));
    const standing = { "HH-1": [{ id: "x", clientId: "HH-1", ticker: "SYNA", kind: "advisor" as const, reason: "r", noBuy: true, noSell: false }] };
    const built = await buildCompliancePdf(requests, SYNTHETIC_EXPORTER, standing, {}, NOW);
    expect(createHash("sha256").update(built.bytes).digest("hex")).toBe("ac910228b86abf0b2b418a83f8d4bdc905f7a854dc06cfe8125c8562dc92cd66");
  });
});

describe("request PDF unchanged by the shared helpers (TRW-07 soft conflict)", () => {
  afterEach(() => vi.useRealTimers());

  it("produces the same bytes as before the helpers were shared", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-17T05:30:00.000Z"));
    const request = syntheticRequest({
      id: "REQ-SYN0001", clientIds: ["HH-901", "HH-902"], clientNames: ["Synthetic Family", "Sample Person"],
      depositAccount: "D-1", status: "Pending Current Asset Liquidation", selectedAccounts: ["SYN-1001", "SYN-2002"],
      priority: "Urgent", advisorNotes: "Synthetic advisor note\n\n\nmore ".repeat(40), advisorExclusions: "SYNX", clientExclusions: "SYNY",
      esgFilters: { fossilFuels: true },
      equityStrategies: [
        { id: 1, benchmark: "Synthetic Core", allocation: 60, rationale: "Synthetic rationale. ".repeat(80) },
        { id: 2, benchmark: "B", allocation: 40, rationale: "" },
      ],
      auditLog: Array.from({ length: 30 }, (_, i) => ({
        date: "2026-10-15T15:00:00.000Z", user: "Riley Ops", action: `Status Changed ${i}`, notes: "Synthetic step ".repeat(i),
      })),
    });
    const built = await buildRequestPdf(request, SYNTHETIC_EXPORTER, [
      { accountNumber: "SYN-1001", kind: "advisor", ticker: "SYNA", reason: "x", noBuy: true, noSell: false },
      { accountNumber: "SYN-2002", kind: "client", ticker: "SYNB", reason: "", noBuy: true, noSell: true },
    ], new Date("2026-10-17T05:30:00.000Z"));
    expect(built.bytes.length).toBe(13915);
    expect(createHash("sha256").update(built.bytes).digest("hex")).toBe("dceeb4c35605ac3ba34e5b6f71405f98fec3c5f0258b6cd9171db327a0f5c29f");
  });
});
