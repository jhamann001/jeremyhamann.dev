// Named import (NOT default): jsPDF's `node` export condition resolves the
// default export to a namespace object, so only the named `jsPDF` binding is
// the constructor in Node. The named binding also exists in the browser build,
// so this works under both Vite and server-side Node.
import { jsPDF } from 'jspdf';
import type { ClientExclusion, TradeRequest } from './types.js';

// ─── Public types ─────────────────────────────────────────────────────────────

export interface ExportAccountExclusion {
  accountNumber: string;
  kind: 'advisor' | 'client';
  ticker: string;
  reason: string;
  noBuy: boolean;
  noSell: boolean;
}

export interface ExportIdentity {
  name: string;
  email: string;
}

export interface BuiltPdf {
  /** The jsPDF document. Call `doc.save(filename)` in the browser, or
   *  `doc.output('arraybuffer')` on the server. */
  doc: jsPDF;
  /** Suggested download filename, keyed to the same timestamp stamped in the footer. */
  filename: string;
}

// ─── formatCurrency (inlined so this module is self-contained) ─────────────────
// Mirrors client/src/utils/format.ts exactly.
const currencyFormatter = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
});

function formatCurrency(value: number): string {
  if (!Number.isFinite(value)) return '$0';
  return currencyFormatter.format(value);
}

// ─── Standing-exclusion formatting ─────────────────────────────────────────────

/**
 * Compose the "current standing exclusions (advisor)" / "(client)" lines for
 * an export row. Returns two pre-formatted strings (empty if none). The
 * per-request snapshot fields (`req.advisorExclusions`, `req.clientExclusions`)
 * remain unchanged and are rendered separately — exports must always show
 * BOTH for compliance. Plan §4G.
 */
// v3.4 — PDF rows include the DNB/DNS side prefix, matching the
// AdvisorForm textarea auto-fill format and the CSV export format in
// TradingQueue.tsx. Server-side `formatSide` helpers in
// `routes/exclusions.ts` and `services/slack.ts` use the same vocabulary
// so the trader sees consistent labels everywhere.
function formatPdfStandingSide(e: Pick<ClientExclusion, 'noBuy' | 'noSell'>): string {
  if (e.noBuy && e.noSell) return 'DNB+DNS';
  if (e.noBuy) return 'DNB';
  return 'DNS';
}

function formatStandingForExport(entries: ClientExclusion[] = []): { advisor: string; client: string } {
  const fmt = (kind: 'advisor' | 'client') =>
    entries
      .filter((e) => e.kind === kind)
      .map((e) => {
        const side = formatPdfStandingSide(e);
        return e.reason ? `${e.ticker} (${side} - ${e.reason})` : `${e.ticker} (${side})`;
      })
      .join('; ');
  return { advisor: fmt('advisor'), client: fmt('client') };
}

function formatAccountStandingForExport(entries: ExportAccountExclusion[] = []): { advisor: string; client: string } {
  const fmt = (kind: 'advisor' | 'client') => {
    const byAccount = new Map<string, string[]>();
    for (const e of entries) {
      if (e.kind !== kind) continue;
      const side = formatPdfStandingSide(e);
      const rendered = e.reason ? `${e.ticker} (${side} - ${e.reason})` : `${e.ticker} (${side})`;
      const list = byAccount.get(e.accountNumber) ?? [];
      list.push(rendered);
      byAccount.set(e.accountNumber, list);
    }
    return Array.from(byAccount.entries())
      .map(([accountNumber, values]) => `${accountNumber}: ${values.join('; ')}`)
      .join(' || ');
  };
  return { advisor: fmt('advisor'), client: fmt('client') };
}

// ─── Color palette ───────────────────────────────────────────────────────────
const NAVY = [15, 30, 61] as const;
const DARK_GRAY = [55, 65, 81] as const;
const MEDIUM_GRAY = [107, 114, 128] as const;
const LIGHT_GRAY = [229, 231, 235] as const;
const TABLE_STRIPE = [249, 250, 251] as const;
const WHITE = [255, 255, 255] as const;
const ACCENT = [37, 99, 235] as const;

// ─── Layout constants ────────────────────────────────────────────────────────
const PAGE_W = 210;
const MARGIN_L = 18;
const MARGIN_R = 18;
const MARGIN_TOP = 18;
const MARGIN_BOTTOM = 22;
const CONTENT_W = PAGE_W - MARGIN_L - MARGIN_R;
const FOOTER_Y = 297 - 14;

const SECTION_GAP = 8;
const ELEMENT_GAP = 5;

type RGB = readonly [number, number, number];

function setColor(doc: jsPDF, color: RGB) {
  doc.setTextColor(color[0], color[1], color[2]);
}

function setFillColor(doc: jsPDF, color: RGB) {
  doc.setFillColor(color[0], color[1], color[2]);
}

function setDrawColor(doc: jsPDF, color: RGB) {
  doc.setDrawColor(color[0], color[1], color[2]);
}

function checkPage(doc: jsPDF, y: number, needed: number): number {
  if (y + needed > 297 - MARGIN_BOTTOM) {
    doc.addPage();
    return MARGIN_TOP;
  }
  return y;
}

function drawFooter(doc: jsPDF, exportTimestamp: string) {
  const pageCount = doc.getNumberOfPages();
  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i);
    setColor(doc, MEDIUM_GRAY);
    doc.setFontSize(7.5);
    doc.setFont('helvetica', 'normal');
    doc.text(`Exported: ${exportTimestamp}`, MARGIN_L, FOOTER_Y);
    doc.text(`Page ${i} of ${pageCount}`, PAGE_W - MARGIN_R, FOOTER_Y, { align: 'right' });
    setDrawColor(doc, LIGHT_GRAY);
    doc.setLineWidth(0.3);
    doc.line(MARGIN_L, FOOTER_Y - 4, PAGE_W - MARGIN_R, FOOTER_Y - 4);
  }
}

function normalizeText(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ─── Section helpers ─────────────────────────────────────────────────────────

function sectionHeading(doc: jsPDF, y: number, label: string): number {
  y = checkPage(doc, y, 16);
  y += SECTION_GAP;
  setColor(doc, NAVY);
  doc.setFontSize(10);
  doc.setFont('helvetica', 'bold');
  doc.text(label, MARGIN_L, y);
  y += 2.5;
  setDrawColor(doc, ACCENT);
  doc.setLineWidth(0.6);
  doc.line(MARGIN_L, y, MARGIN_L + CONTENT_W, y);
  return y + ELEMENT_GAP;
}

function labelValue(doc: jsPDF, y: number, label: string, value: string): number {
  y = checkPage(doc, y, 10);
  doc.setFontSize(8);
  doc.setFont('helvetica', 'bold');
  setColor(doc, DARK_GRAY);
  const labelStr = `${label}:  `;
  doc.text(labelStr, MARGIN_L, y);
  const labelWidth = doc.getTextWidth(labelStr);
  doc.setFont('helvetica', 'normal');
  setColor(doc, DARK_GRAY);
  const valWidth = CONTENT_W - labelWidth;
  const lines = doc.splitTextToSize(value || 'N/A', valWidth);
  doc.text(lines, MARGIN_L + labelWidth, y);
  return y + lines.length * 4 + 2.5;
}

function wrappedBlock(doc: jsPDF, y: number, text: string, indent = 0): number {
  const normalized = normalizeText(text);
  doc.setFontSize(8);
  doc.setFont('helvetica', 'normal');
  setColor(doc, DARK_GRAY);
  const lines = doc.splitTextToSize(normalized, CONTENT_W - indent);
  const lineHeight = 3.8;
  const blockHeight = lines.length * lineHeight + 2;
  y = checkPage(doc, y, Math.min(blockHeight, 40));
  for (const line of lines) {
    y = checkPage(doc, y, lineHeight + 1);
    doc.text(line, MARGIN_L + indent, y);
    y += lineHeight;
  }
  return y + 2;
}

// ─── Table drawing ───────────────────────────────────────────────────────────

interface TableColumn {
  label: string;
  width: number;
  align?: 'left' | 'right';
}

function drawTable(doc: jsPDF, y: number, columns: TableColumn[], rows: string[][]): number {
  const MIN_ROW_H = 7;
  const HEADER_H = 8;
  const PAD_X = 2.5;
  const PAD_Y = 2.5;
  const LINE_H = 3.2;

  // Pre-wrap every cell so we know line counts and row heights up front
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7);
  const wrappedRows: string[][][] = rows.map((row) =>
    row.map((cell, c) => {
      const maxW = columns[c].width - PAD_X * 2;
      return doc.splitTextToSize(cell ?? '', maxW) as string[];
    }),
  );
  const rowHeights = wrappedRows.map((cells) => {
    const maxLines = Math.max(1, ...cells.map((lines) => lines.length));
    return Math.max(MIN_ROW_H, maxLines * LINE_H + PAD_Y * 2);
  });

  y = checkPage(doc, y, HEADER_H + (rowHeights[0] ?? MIN_ROW_H) + 4);

  // Header background
  const headerTop = y;
  setFillColor(doc, NAVY);
  doc.rect(MARGIN_L, headerTop, CONTENT_W, HEADER_H, 'F');

  // Header text — vertically centered
  const headerTextY = headerTop + HEADER_H / 2 + 1.2;
  doc.setFontSize(7);
  doc.setFont('helvetica', 'bold');
  setColor(doc, WHITE);
  let xPos = MARGIN_L + PAD_X;
  for (const col of columns) {
    if (col.align === 'right') {
      doc.text(col.label, xPos + col.width - PAD_X * 2, headerTextY, { align: 'right' });
    } else {
      doc.text(col.label, xPos, headerTextY);
    }
    xPos += col.width;
  }

  y = headerTop + HEADER_H;

  // Data rows
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7);
  for (let r = 0; r < wrappedRows.length; r++) {
    const rh = rowHeights[r];
    y = checkPage(doc, y, rh + 1);

    const rowTop = y;
    if (r % 2 === 0) {
      setFillColor(doc, TABLE_STRIPE);
      doc.rect(MARGIN_L, rowTop, CONTENT_W, rh, 'F');
    }

    setColor(doc, DARK_GRAY);
    xPos = MARGIN_L + PAD_X;
    for (let c = 0; c < columns.length; c++) {
      const cellLines = wrappedRows[r][c];
      const cellX = columns[c].align === 'right' ? xPos + columns[c].width - PAD_X * 2 : xPos;
      const alignOpt = columns[c].align === 'right' ? ({ align: 'right' } as const) : undefined;

      let lineY = rowTop + PAD_Y + LINE_H * 0.7;
      for (const line of cellLines) {
        doc.text(line, cellX, lineY, alignOpt);
        lineY += LINE_H;
      }
      xPos += columns[c].width;
    }
    y += rh;
  }

  return y + ELEMENT_GAP;
}

// ─── Per-request rendering ───────────────────────────────────────────────────

function renderRequest(
  doc: jsPDF,
  req: TradeRequest,
  y: number,
  index: number,
  standingByClient: Record<string, ClientExclusion[]> = {},
  accountExclusionsByRequestId: Record<string, ExportAccountExclusion[]> = {},
): number {
  const BAR_H = 11;

  // Request header bar
  y = checkPage(doc, y, BAR_H + 20);
  setFillColor(doc, NAVY);
  doc.rect(MARGIN_L, y, CONTENT_W, BAR_H, 'F');

  const barTextY = y + BAR_H / 2 + 1.2;
  doc.setFontSize(9);
  doc.setFont('helvetica', 'bold');
  setColor(doc, WHITE);
  const household = req.clientNames?.length > 1 ? req.clientNames.join(' & ') : req.clientName;
  doc.text(`#${index + 1}  ${req.id}  —  ${household}`, MARGIN_L + 4, barTextY);

  doc.setFontSize(7);
  doc.text(req.status.toUpperCase(), PAGE_W - MARGIN_R - 4, barTextY, { align: 'right' });

  y += BAR_H + SECTION_GAP;

  // ── Request Details ──
  y = sectionHeading(doc, y, 'Request Details');
  y = labelValue(doc, y, 'Trade Type', req.tradeType);
  y = labelValue(doc, y, 'Advisor', req.advisor);
  y = labelValue(doc, y, 'Submitted By', req.submittedBy || req.advisor);
  if (req.tradeAmount) y = labelValue(doc, y, 'Trade Amount', req.tradeAmount);
  y = labelValue(doc, y, 'Total Value', formatCurrency(req.totalValue));
  y = labelValue(doc, y, 'Residence', req.residence);
  y = labelValue(doc, y, 'Accounts', req.selectedAccounts.join(', '));
  y = labelValue(doc, y, 'Date Submitted', new Date(req.date).toLocaleDateString());
  if (req.priority) y = labelValue(doc, y, 'Priority', req.priority);
  if (req.depositAccount) y = labelValue(doc, y, 'Deposit Account', req.depositAccount);
  if (req.liquidationApproval) y = labelValue(doc, y, 'Liquidation Approval', req.liquidationApproval);

  const esgList = Object.entries(req.esgFilters ?? {})
    .filter(([k, v]) => v && k !== 'none')
    .map(([k]) => k);
  if (esgList.length > 0) y = labelValue(doc, y, 'ESG Exclusions', esgList.join(', '));

  if (req.advisorExclusions) y = labelValue(doc, y, 'Advisor Exclusions', req.advisorExclusions);
  if (req.clientExclusions) y = labelValue(doc, y, 'Client Exclusions', req.clientExclusions);

  const standing = formatStandingForExport(standingByClient[req.clientId]);
  if (standing.advisor) y = labelValue(doc, y, 'Standing Advisor Exclusions (current)', standing.advisor);
  if (standing.client) y = labelValue(doc, y, 'Standing Client Exclusions (current)', standing.client);
  const accountStanding = formatAccountStandingForExport(accountExclusionsByRequestId[req.id]);
  if (accountStanding.advisor) {
    y = labelValue(doc, y, 'Standing Account Advisor Exclusions (current)', accountStanding.advisor);
  }
  if (accountStanding.client) {
    y = labelValue(doc, y, 'Standing Account Client Exclusions (current)', accountStanding.client);
  }

  if (req.advisorNotes) {
    y = labelValue(doc, y, 'Advisor Notes', '');
    y = wrappedBlock(doc, y, req.advisorNotes, 2);
  }

  // ── Allocation & Strategy Rationale ──
  if (req.riskProfile != null || (req.equityStrategies ?? []).length > 0) {
    y = sectionHeading(doc, y, 'Allocation & Strategy Rationale (Reg BI)');

    if (req.riskProfile != null) y = labelValue(doc, y, 'Risk Profile', String(req.riskProfile));
    if (req.baseAllocation) {
      y = labelValue(
        doc,
        y,
        'Base Allocation',
        `Equity ${req.baseAllocation.equity}%  |  Fixed Income ${req.baseAllocation.fixed}%  |  Cash ${req.baseAllocation.cash}%`,
      );
    }

    for (const strat of req.equityStrategies ?? []) {
      y = checkPage(doc, y, 26);
      y += ELEMENT_GAP;

      // Strategy name + allocation pill
      const pillH = 8;
      setFillColor(doc, [239, 246, 255]);
      doc.rect(MARGIN_L + 2, y, CONTENT_W - 4, pillH, 'F');
      doc.setFontSize(8.5);
      doc.setFont('helvetica', 'bold');
      setColor(doc, ACCENT);
      doc.text(`${strat.benchmark}  —  ${strat.allocation}% allocation`, MARGIN_L + 5, y + pillH / 2 + 1);
      y += pillH + ELEMENT_GAP;

      // Rationale paragraph
      doc.setFontSize(8);
      doc.setFont('helvetica', 'italic');
      setColor(doc, DARK_GRAY);
      doc.text('Rationale:', MARGIN_L + 5, y);
      y += 4.5;
      doc.setFont('helvetica', 'normal');
      y = wrappedBlock(doc, y, strat.rationale || 'No rationale provided.', 5);
      y += 2;
    }
  }

  // ── Audit Trail ──
  if (req.auditLog?.length > 0) {
    y = sectionHeading(doc, y, 'Audit Trail');
    const notesW = CONTENT_W - 30 - 38 - 38;
    const auditCols: TableColumn[] = [
      { label: 'Date', width: 30 },
      { label: 'User', width: 38 },
      { label: 'Action', width: 38 },
      { label: 'Notes', width: notesW },
    ];
    const auditRows = req.auditLog.map((e) => [new Date(e.date).toLocaleDateString(), e.user, e.action, e.notes]);
    y = drawTable(doc, y, auditCols, auditRows);
  }

  // Separator between requests
  y += SECTION_GAP;
  setDrawColor(doc, LIGHT_GRAY);
  doc.setLineWidth(0.4);
  y = checkPage(doc, y, 10);
  doc.line(MARGIN_L, y, PAGE_W - MARGIN_R, y);
  y += SECTION_GAP + 4;

  return y;
}

// ─── Single-request body ──────────────────────────────────────────────────────

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9_& -]/g, '').replace(/\s+/g, '_');
}

function renderSingleRequestBody(
  doc: jsPDF,
  req: TradeRequest,
  y: number,
  accountExclusions: ExportAccountExclusion[] = [],
): number {
  y = sectionHeading(doc, y, 'Request Details');
  y = labelValue(doc, y, 'Trade Type', req.tradeType);
  y = labelValue(doc, y, 'Advisor', req.advisor);
  y = labelValue(doc, y, 'Submitted By', req.submittedBy || req.advisor);
  if (req.tradeAmount) y = labelValue(doc, y, 'Trade Amount', req.tradeAmount);
  y = labelValue(doc, y, 'Total Value', formatCurrency(req.totalValue));
  y = labelValue(doc, y, 'Residence', req.residence);
  y = labelValue(doc, y, 'Accounts', req.selectedAccounts.join(', '));
  y = labelValue(doc, y, 'Date Submitted', new Date(req.date).toLocaleDateString());
  if (req.priority) y = labelValue(doc, y, 'Priority', req.priority);
  if (req.depositAccount) y = labelValue(doc, y, 'Deposit Account', req.depositAccount);
  if (req.liquidationApproval) y = labelValue(doc, y, 'Liquidation Approval', req.liquidationApproval);

  const esgList = Object.entries(req.esgFilters ?? {})
    .filter(([k, v]) => v && k !== 'none')
    .map(([k]) => k);
  if (esgList.length > 0) y = labelValue(doc, y, 'ESG Exclusions', esgList.join(', '));

  if (req.advisorExclusions) y = labelValue(doc, y, 'Advisor Exclusions', req.advisorExclusions);
  if (req.clientExclusions) y = labelValue(doc, y, 'Client Exclusions', req.clientExclusions);
  const accountStanding = formatAccountStandingForExport(accountExclusions);
  if (accountStanding.advisor) {
    y = labelValue(doc, y, 'Standing Account Advisor Exclusions (current)', accountStanding.advisor);
  }
  if (accountStanding.client) {
    y = labelValue(doc, y, 'Standing Account Client Exclusions (current)', accountStanding.client);
  }
  if (req.advisorNotes) {
    y = labelValue(doc, y, 'Advisor Notes', '');
    y = wrappedBlock(doc, y, req.advisorNotes, 2);
  }

  if (req.riskProfile != null || (req.equityStrategies ?? []).length > 0) {
    y = sectionHeading(doc, y, 'Allocation & Strategy Rationale (Reg BI)');

    if (req.riskProfile != null) y = labelValue(doc, y, 'Risk Profile', String(req.riskProfile));
    if (req.baseAllocation) {
      y = labelValue(
        doc,
        y,
        'Base Allocation',
        `Equity ${req.baseAllocation.equity}%  |  Fixed Income ${req.baseAllocation.fixed}%  |  Cash ${req.baseAllocation.cash}%`,
      );
    }

    for (const strat of req.equityStrategies ?? []) {
      y = checkPage(doc, y, 26);
      y += ELEMENT_GAP;

      const pillH = 8;
      setFillColor(doc, [239, 246, 255]);
      doc.rect(MARGIN_L + 2, y, CONTENT_W - 4, pillH, 'F');
      doc.setFontSize(8.5);
      doc.setFont('helvetica', 'bold');
      setColor(doc, ACCENT);
      doc.text(`${strat.benchmark}  —  ${strat.allocation}% allocation`, MARGIN_L + 5, y + pillH / 2 + 1);
      y += pillH + ELEMENT_GAP;

      doc.setFontSize(8);
      doc.setFont('helvetica', 'italic');
      setColor(doc, DARK_GRAY);
      doc.text('Rationale:', MARGIN_L + 5, y);
      y += 4.5;
      doc.setFont('helvetica', 'normal');
      y = wrappedBlock(doc, y, strat.rationale || 'No rationale provided.', 5);
      y += 2;
    }
  }

  if (req.auditLog?.length > 0) {
    y = sectionHeading(doc, y, 'Audit Trail');
    const notesW = CONTENT_W - 30 - 38 - 38;
    const auditCols: TableColumn[] = [
      { label: 'Date', width: 30 },
      { label: 'User', width: 38 },
      { label: 'Action', width: 38 },
      { label: 'Notes', width: notesW },
    ];
    const auditRows = req.auditLog.map((e) => [new Date(e.date).toLocaleDateString(), e.user, e.action, e.notes]);
    y = drawTable(doc, y, auditCols, auditRows);
  }

  return y;
}

// ─── Public builders ────────────────────────────────────────────────────────
// Each builds a jsPDF document and returns it plus a suggested filename keyed
// to the same timestamp stamped in the footer. Callers decide how to emit the
// bytes: `doc.save(filename)` in the browser, `doc.output('arraybuffer')` on
// the server. This module never touches the DOM or filesystem.

/** Build the single trade-request PDF (matches the in-app "Download PDF" button). */
export function buildRequestPdf(
  request: TradeRequest,
  exporter: ExportIdentity,
  accountExclusions: ExportAccountExclusion[] = [],
): BuiltPdf {
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const exportTimestamp = new Date().toISOString();

  const household = request.clientNames?.length > 1 ? request.clientNames.join(' & ') : request.clientName;

  // Header bar
  const BAR_H = 11;
  let y = MARGIN_TOP;
  setFillColor(doc, NAVY);
  doc.rect(MARGIN_L, y, CONTENT_W, BAR_H, 'F');

  const barTextY = y + BAR_H / 2 + 1.2;
  doc.setFontSize(9);
  doc.setFont('helvetica', 'bold');
  setColor(doc, WHITE);
  doc.text(`${request.id}  —  ${household}`, MARGIN_L + 4, barTextY);

  doc.setFontSize(7);
  doc.text(request.status.toUpperCase(), PAGE_W - MARGIN_R - 4, barTextY, { align: 'right' });

  y += BAR_H + 4;

  doc.setFontSize(7.5);
  doc.setFont('helvetica', 'normal');
  setColor(doc, MEDIUM_GRAY);
  doc.text(`Exported by ${exporter.name} (${exporter.email})`, MARGIN_L, y);
  y += SECTION_GAP;

  renderSingleRequestBody(doc, request, y, accountExclusions);

  drawFooter(doc, exportTimestamp);

  const dateStr = exportTimestamp.split('T')[0];
  const safeName = sanitizeFilename(household);
  return { doc, filename: `Trade_Request_${safeName}_${request.id}_${dateStr}.pdf` };
}

/** Build the multi-request "Compliance Export Report" PDF. */
export function buildCompliancePdf(
  requests: TradeRequest[],
  exporter: ExportIdentity,
  standingExclusionsByClient: Record<string, ClientExclusion[]> = {},
  accountExclusionsByRequestId: Record<string, ExportAccountExclusion[]> = {},
): BuiltPdf {
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const exportTimestamp = new Date().toISOString();
  const exportDate = new Date().toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  // ── Cover / header page ──
  let y = 30;

  // Decorative top bar
  setFillColor(doc, NAVY);
  doc.rect(0, 0, PAGE_W, 6, 'F');

  // Title
  doc.setFontSize(22);
  doc.setFont('helvetica', 'bold');
  setColor(doc, NAVY);
  doc.text('Compliance Export Report', MARGIN_L, y);
  y += 8;

  setDrawColor(doc, ACCENT);
  doc.setLineWidth(0.8);
  doc.line(MARGIN_L, y, MARGIN_L + 60, y);
  y += 12;

  doc.setFontSize(10);
  doc.setFont('helvetica', 'normal');
  setColor(doc, DARK_GRAY);
  doc.text(`Date: ${exportDate}`, MARGIN_L, y);
  y += 6;
  doc.text(`Exported By: ${exporter.name} (${exporter.email})`, MARGIN_L, y);
  y += 6;
  doc.text(`Total Records: ${requests.length}`, MARGIN_L, y);
  y += 6;
  doc.text(`Report ID: RPT-${exportTimestamp.replace(/[^0-9]/g, '').slice(0, 14)}`, MARGIN_L, y);
  y += 14;

  // Summary table
  const statusCounts = new Map<string, number>();
  for (const req of requests) {
    statusCounts.set(req.status, (statusCounts.get(req.status) ?? 0) + 1);
  }
  doc.setFontSize(10);
  doc.setFont('helvetica', 'bold');
  setColor(doc, NAVY);
  doc.text('Summary by Status', MARGIN_L, y);
  y += 7;

  const summaryCols: TableColumn[] = [
    { label: 'Status', width: 60 },
    { label: 'Count', width: 30, align: 'right' },
  ];
  const summaryRows = Array.from(statusCounts.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([status, count]) => [status, String(count)]);
  y = drawTable(doc, y, summaryCols, summaryRows);

  // Confidentiality notice
  y += 10;
  const noticeH = 16;
  setFillColor(doc, [254, 252, 232]);
  doc.rect(MARGIN_L, y, CONTENT_W, noticeH, 'F');
  doc.setFontSize(7);
  doc.setFont('helvetica', 'bold');
  setColor(doc, [146, 64, 14]);
  doc.text('CONFIDENTIAL', MARGIN_L + 4, y + 5);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(6.5);
  doc.text(
    'This document contains confidential compliance data. Distribution is restricted to authorized personnel only.',
    MARGIN_L + 4,
    y + 9.5,
  );
  doc.text('Unauthorized reproduction or distribution is prohibited.', MARGIN_L + 4, y + 13);

  // ── Render each request ──
  doc.addPage();
  y = MARGIN_TOP;

  for (let i = 0; i < requests.length; i++) {
    y = renderRequest(doc, requests[i], y, i, standingExclusionsByClient, accountExclusionsByRequestId);
  }

  // ── Footer on all pages ──
  drawFooter(doc, exportTimestamp);

  return { doc, filename: `Compliance_Report_${exportTimestamp.split('T')[0]}.pdf` };
}
