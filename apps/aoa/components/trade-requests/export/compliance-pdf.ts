import { householdLabel, type PdfAccountExclusion } from "@/lib/trade-requests/detail-view";
import type { TradeRequestClientExclusion } from "@/lib/trade-requests/export-model";
import {
  ACCENT, CONTENT_W, DARK_GRAY, LIGHT_GRAY, MARGIN_L, MARGIN_R, MARGIN_TOP, NAVY, PAGE_W, SECTION_GAP, WHITE,
  checkPage, createPdfDoc, drawFooter, drawTable, renderBody, standingSide, type Doc, type RGB, type TableColumn,
} from "@/lib/trade-requests/request-pdf";
import type { TradeRequest, TradeRequestExporter } from "@/lib/trade-requests/request-types";

// Port of the standalone "Compliance Export Report" (trade-request
// shared/src/pdf.ts buildCompliancePdf). Statuses print as stored (owner
// ruling D-01).

/** Requests drawn between yields to the event loop, so a large export keeps the tab responsive. */
export const PDF_YIELD_EVERY = 50;
const nextMacrotask = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const NOTICE_FILL: RGB = [254, 252, 232];
const NOTICE_TEXT: RGB = [146, 64, 14];

/** "{ticker} ({side} - {reason})" for each current client-level exclusion of a kind, joined with "; ". */
export function formatClientStanding(entries: TradeRequestClientExclusion[] = []): { advisor: string; client: string } {
  const format = (kind: "advisor" | "client") => entries
    .filter((entry) => entry.kind === kind)
    .map((entry) => entry.reason ? `${entry.ticker} (${standingSide(entry)} - ${entry.reason})` : `${entry.ticker} (${standingSide(entry)})`)
    .join("; ");
  return { advisor: format("advisor"), client: format("client") };
}

function renderRequest(
  doc: Doc, req: TradeRequest, y: number, index: number,
  standingByClient: Record<string, TradeRequestClientExclusion[]>,
  accountExclusionsByRequestId: Record<string, PdfAccountExclusion[]>,
): number {
  const BAR_H = 11;
  y = checkPage(doc, y, BAR_H + 20);
  doc.setFillColor(NAVY);
  doc.rect(MARGIN_L, y, CONTENT_W, BAR_H);
  const barTextY = y + BAR_H / 2 + 1.2;
  doc.setFontSize(9);
  doc.setFont("bold");
  doc.setTextColor(WHITE);
  doc.text(`#${index + 1}  ${req.id}  —  ${householdLabel(req)}`, MARGIN_L + 4, barTextY);
  doc.setFontSize(7);
  doc.text(req.status.toUpperCase(), PAGE_W - MARGIN_R - 4, barTextY, { align: "right" });
  y += BAR_H + SECTION_GAP;

  y = renderBody(doc, req, y, accountExclusionsByRequestId[req.id] ?? [], formatClientStanding(standingByClient[req.clientId]));

  y += SECTION_GAP;
  doc.setDrawColor(LIGHT_GRAY);
  doc.setLineWidth(0.4);
  y = checkPage(doc, y, 10);
  doc.line(MARGIN_L, y, PAGE_W - MARGIN_R, y);
  return y + SECTION_GAP + 4;
}

export type BuiltCompliancePdf = { bytes: Uint8Array; filename: string };

export async function buildCompliancePdf(
  requests: TradeRequest[],
  exporter: TradeRequestExporter,
  standingByClient: Record<string, TradeRequestClientExclusion[]> = {},
  accountExclusionsByRequestId: Record<string, PdfAccountExclusion[]> = {},
  now: Date = new Date(),
): Promise<BuiltCompliancePdf> {
  const { pdf, doc } = await createPdfDoc();
  const exportTimestamp = now.toISOString();
  const exportDate = now.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });

  let y = 30;
  doc.setFillColor(NAVY);
  doc.rect(0, 0, PAGE_W, 6);

  doc.setFontSize(22);
  doc.setFont("bold");
  doc.setTextColor(NAVY);
  doc.text("Compliance Export Report", MARGIN_L, y);
  y += 8;
  doc.setDrawColor(ACCENT);
  doc.setLineWidth(0.8);
  doc.line(MARGIN_L, y, MARGIN_L + 60, y);
  y += 12;

  doc.setFontSize(10);
  doc.setFont("normal");
  doc.setTextColor(DARK_GRAY);
  doc.text(`Date: ${exportDate}`, MARGIN_L, y);
  y += 6;
  doc.text(`Exported By: ${exporter.name} (${exporter.email})`, MARGIN_L, y);
  y += 6;
  doc.text(`Total Records: ${requests.length}`, MARGIN_L, y);
  y += 6;
  doc.text(`Report ID: RPT-${exportTimestamp.replace(/[^0-9]/g, "").slice(0, 14)}`, MARGIN_L, y);
  y += 14;

  const statusCounts = new Map<string, number>();
  for (const req of requests) statusCounts.set(req.status, (statusCounts.get(req.status) ?? 0) + 1);
  doc.setFontSize(10);
  doc.setFont("bold");
  doc.setTextColor(NAVY);
  doc.text("Summary by Status", MARGIN_L, y);
  y += 7;
  const summaryColumns: TableColumn[] = [
    { label: "Status", width: 60 },
    { label: "Count", width: 30, align: "right" },
  ];
  const summaryRows = Array.from(statusCounts.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([status, count]) => [status, String(count)]);
  y = drawTable(doc, y, summaryColumns, summaryRows);

  y += 10;
  const NOTICE_H = 16;
  doc.setFillColor(NOTICE_FILL);
  doc.rect(MARGIN_L, y, CONTENT_W, NOTICE_H);
  doc.setFontSize(7);
  doc.setFont("bold");
  doc.setTextColor(NOTICE_TEXT);
  doc.text("CONFIDENTIAL", MARGIN_L + 4, y + 5);
  doc.setFont("normal");
  doc.setFontSize(6.5);
  doc.text("This document contains confidential compliance data. Distribution is restricted to authorized personnel only.", MARGIN_L + 4, y + 9.5);
  doc.text("Unauthorized reproduction or distribution is prohibited.", MARGIN_L + 4, y + 13);

  doc.addPage();
  y = MARGIN_TOP;
  for (let index = 0; index < requests.length; index += 1) {
    if (index > 0 && index % PDF_YIELD_EVERY === 0) await nextMacrotask();
    y = renderRequest(doc, requests[index], y, index, standingByClient, accountExclusionsByRequestId);
  }

  drawFooter(doc, exportTimestamp);
  return { bytes: await pdf.save(), filename: `Compliance_Report_${exportTimestamp.split("T")[0]}.pdf` };
}
