import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { TradeRequestsCard } from "@/components/client-portrait/TradeRequestsCard";
import { ZendeskTicketsCard } from "@/components/client-portrait/ZendeskTicketsCard";
import { NewFundingCard } from "@/components/funding/NewFundingCard";
import { DealRollup } from "@/components/client-portrait/DealRollup";
import type { FundingSummary } from "@/lib/data/account-funding";
import type { ZendeskTicket } from "@/lib/data/types";

vi.mock("server-only", () => ({}));

const source = (path: string): string =>
  readFileSync(resolve(process.cwd(), path), "utf8");

describe("Client Portrait collapsible summaries", () => {
  it("keeps deal rollups visible while the deal rows start collapsed", () => {
    const html = renderToStaticMarkup(createElement(DealRollup, { deals: [] }));
    const summary = html.match(/<summary\b[^>]*>(.*?)<\/summary>/)?.[1];
    expect(html).toContain("<details");
    expect(html).not.toMatch(/<details[^>]*\sopen(?:[\s=>])/);
    expect(summary).toContain("Deals");
    expect(summary).toContain("outstanding");
    expect(summary).toContain("funded");
    expect(summary).toContain("$0");
    expect(html.indexOf("</summary>")).toBeLessThan(html.indexOf("No deals on file."));
  });

  it("leaves funding stats outside the collapsed transaction disclosure", () => {
    const card = source("components/funding/NewFundingCard.tsx");
    const detailsAt = card.indexOf("<details className={styles.details}>");

    expect(detailsAt).toBeGreaterThan(0);
    expect(card.indexOf("FUNDING_METHODS.map")).toBeLessThan(detailsAt);
    expect(card.indexOf("Year to date")).toBeLessThan(detailsAt);
    expect(card.indexOf("events.map")).toBeGreaterThan(detailsAt);
  });

  it("shows the trade-request count before revealing the existing rows", () => {
    const card = source("components/client-portrait/TradeRequestsCard.tsx");

    expect(card).toContain("<details className={styles.disclosure}>");
    expect(card).not.toContain("<details className={styles.disclosure} open>");
    expect(card).toContain(
      '<h2 className={styles.title}>Trade requests</h2>',
    );
    expect(card).toContain(
      '{sorted.length} {sorted.length === 1 ? "request" : "requests"}',
    );
    expect(card.indexOf("sorted.length === 1")).toBeLessThan(
      card.indexOf("sorted.map"),
    );
  });

  it("keeps zero-request and zero-funding summaries useful when collapsed", () => {
    const tradeHtml = renderToStaticMarkup(
      createElement(TradeRequestsCard, { requests: [] }),
    );
    expect(tradeHtml).toContain("0 requests");
    expect(tradeHtml).toContain("<details");
    expect(tradeHtml).not.toContain("<details open");

    const emptyFunding: FundingSummary = {
      asOf: "2026-08-19",
      windowStart: "2025-08-19",
      events: [],
      byMethod: {
        ACH: { amount: 0, count: 0 },
        Check: { amount: 0, count: 0 },
        Wire: { amount: 0, count: 0 },
      },
      total: { amount: 0, count: 0 },
      ytd: { amount: 0, count: 0 },
      skipped: 0,
    };
    const fundingHtml = renderToStaticMarkup(
      createElement(NewFundingCard, { summary: emptyFunding }),
    );
    expect(fundingHtml).toContain("ACH · 0 deposits");
    expect(fundingHtml).toContain("Check · 0 deposits");
    expect(fundingHtml).toContain("Wire · 0 deposits");
    expect(fundingHtml).toContain("Year to date");
    expect(fundingHtml).not.toContain("Transaction details");
  });

  it("makes each collapsed Zendesk conversation visibly expandable", () => {
    const ticket: ZendeskTicket = {
      zendesk_ticket_id: "12345",
      requester_id: "67890",
      subject: "Distribution request",
      description: "Initial request",
      status: "open",
      priority: "normal",
      ticket_type: "question",
      ticket_url: "https://example.zendesk.com/agent/tickets/12345",
      created_at: new Date("2026-08-30T12:00:00Z"),
      source_updated_at: new Date("2026-08-31T12:00:00Z"),
      comments_truncated: false,
      comments: [
        {
          zendesk_comment_id: "1",
          author_id: "67890",
          body: "Can you help?",
          created_at: new Date("2026-08-30T12:00:00Z"),
        },
        {
          zendesk_comment_id: "2",
          author_id: "11111",
          body: "Yes, we can help.",
          created_at: new Date("2026-08-30T13:00:00Z"),
        },
      ],
    };

    const html = renderToStaticMarkup(
      createElement(ZendeskTicketsCard, {
        tickets: [ticket],
        scope: "household",
      }),
    );

    expect(html).toContain("View 2 comments");
    expect(html).toContain("Hide comments");
    expect(html).toContain("Open in Zendesk");
    expect(html.match(/<details/g)).toHaveLength(2);
    expect(html).not.toContain("<details open");
  });

  it("reveals hidden detail rows when printing", () => {
    for (const path of [
      "components/deals/DealSummaryCard.module.css",
      "components/client-portrait/TradeRequestsCard.module.css",
      "components/funding/NewFundingCard.module.css",
    ]) {
      const css = source(path);
      expect(css).toContain("@media print");
      expect(css).toMatch(/display:\s*block(?:\s*!important)?/);
    }
  });
});
