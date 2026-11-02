import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { EmailSearchCoverage, EmailSearchResults, EmailEnvelopeDetails, Highlighted } from "@/components/client-portrait/EmailSearch";
import { IDLE_EMAIL_SEARCH, type EmailSearchState } from "@/lib/email-search/controller";

// Synthetic content only.
const noop = () => {};
const results = (over: Partial<EmailSearchState>) => renderToStaticMarkup(createElement(EmailSearchResults,
  { state: { ...IDLE_EMAIL_SEARCH, status: "ready", term: "fee", ...over }, onOpen: noop, onLoadMore: noop }));

describe("ticket search highlighting is markup-safe", () => {
  it("renders stored text and the term as escaped text, with matches in <mark>", () => {
    const html = renderToStaticMarkup(createElement(Highlighted, {
      text: "<img src=x onerror=alert(1)> fee <script>alert(2)</script> FEE", term: "fee",
    }));
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html.match(/<mark[^>]*>fee<\/mark>/gi)).toHaveLength(2);
  });

  it("escapes a term that looks like markup", () => {
    const html = renderToStaticMarkup(createElement(Highlighted, { text: "say <b>hi</b> now", term: "<b>" }));
    expect(html).toContain("&lt;b&gt;</mark>");
    expect(html).not.toContain("<b>");
  });
});

describe("ticket search results disclose coverage", () => {
  it("explains coverage when nothing matches", () => {
    const html = results({ total: 0, searched: 12, rows: [] });
    expect(html).toContain("No stored email matches.");
    expect(html).toContain("can exist without appearing here");
    for (const fact of ["January 1, 2026", "firm disclaimer", "Outlook reply divider", "8,000 characters", "marketing emails are not stored"]) {
      expect(html).toContain(fact);
    }
  });

  it("shows counts against the searched population, highlights, and offers more pages", () => {
    const html = results({
      total: 60, searched: 200, page: 1, pageCount: 2,
      rows: [{ sf_id: "S1", subject: "Synthetic fee review", body: "Body mentions the fee twice: fee.", sent_at: "2026-02-01T00:00:00.000Z", source_modified_at: null }],
    });
    expect(html).toContain("60 of 200 stored emails match.");
    expect(html).toContain("<mark");
    expect(html).toContain("Show more matches (1 of 60)");
    expect(renderToStaticMarkup(createElement(EmailSearchCoverage))).toContain("Sender and To/Cc names and addresses are searched where available.");
  });

  it("shows a changed-results notice and plain states without rows", () => {
    expect(results({ total: 1, searched: 1, notice: "changed", rows: [] })).toContain("Results changed");
    const revoked = renderToStaticMarkup(createElement(EmailSearchResults,
      { state: { ...IDLE_EMAIL_SEARCH, status: "unavailable", term: "fee" }, onOpen: noop, onLoadMore: noop }));
    expect(revoked).toContain("no longer available to you");
    expect(revoked).not.toContain("<li");
    expect(renderToStaticMarkup(createElement(EmailSearchResults, { state: IDLE_EMAIL_SEARCH, onOpen: noop, onLoadMore: noop }))).toBe("");
  });
});


describe("ticket source metadata rendering", () => {
  it("highlights source names and addresses as text and discloses missing metadata", () => {
    const envelope = { version: 1 as const, state: "MATCHED" as const, task_sf_id: "00TMAE265423797", message_sf_id: "02sENV000000001",
      observed_at: "2026-10-16T00:00:00.000Z", source_modified_at: null,
      sender: { name: "<script>Invented Sender</script>", address: "sender@example.invalid" },
      to: [{ name: null, address: "recipient@example.invalid" }], cc: [] };
    const html = renderToStaticMarkup(createElement(EmailEnvelopeDetails, { envelope, term: "sender", compact: false }));
    expect(html).not.toContain("<script>"); expect(html).toContain("&lt;script&gt;"); expect(html).toContain("<mark");
    expect(html).toContain("From:"); expect(html).toContain("To:");
    expect(renderToStaticMarkup(createElement(EmailEnvelopeDetails, { envelope: null, compact: false }))).toContain("unavailable for this email");
  });
  it("reports observed address coverage without inventing details for legacy emails", () => {
    const html = results({ searched: 12, metadataCoverage: { matched: 5, enriched: 4, missing: 2, unavailable: 1, ambiguous: 1, unknown: 3 } });
    expect(html).toContain("available for 4 of 12 stored emails"); expect(html).toContain("incomplete address coverage");
  });
});
