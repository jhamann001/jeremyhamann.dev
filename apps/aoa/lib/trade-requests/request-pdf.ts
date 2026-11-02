import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { formatCurrency, householdLabel, type PdfAccountExclusion } from "./detail-view";
import type { TradeRequest, TradeRequestExporter } from "./request-types";

// Port of the standalone single-request PDF (trade-request
// shared/src/pdf.ts buildRequestPdf, jsPDF, A4 portrait, millimetres) to
// pdf-lib. Text, order, colours, header, footer and file name follow the
// source; the status prints as stored, upper-cased (owner ruling D-01). The
// drawing helpers are shared with the queue's Compliance Export Report.

export type RGB = readonly [number, number, number];
export const NAVY: RGB = [15, 30, 61];
export const DARK_GRAY: RGB = [55, 65, 81];
export const MEDIUM_GRAY: RGB = [107, 114, 128];
export const LIGHT_GRAY: RGB = [229, 231, 235];
const TABLE_STRIPE: RGB = [249, 250, 251];
export const WHITE: RGB = [255, 255, 255];
export const ACCENT: RGB = [37, 99, 235];
const PILL: RGB = [239, 246, 255];

const PT_PER_MM = 72 / 25.4;
const pdfColor = ([r, g, b]: RGB) => rgb(r / 255, g / 255, b / 255);
export const PAGE_W = 210;
const PAGE_H = 297;
export const MARGIN_L = 18;
export const MARGIN_R = 18;
export const MARGIN_TOP = 18;
const MARGIN_BOTTOM = 22;
export const CONTENT_W = PAGE_W - MARGIN_L - MARGIN_R;
const FOOTER_Y = PAGE_H - 14;
export const SECTION_GAP = 8;
const ELEMENT_GAP = 5;
const LINE_HEIGHT_FACTOR = 1.15;

type FontStyle = "normal" | "bold" | "italic";

// The small slice of jsPDF's drawing model the source uses: a current page,
// font, size and colours, coordinates in millimetres from the top-left.
export class Doc {
  readonly pages: PDFPage[] = [];
  private page!: PDFPage;
  private font: PDFFont;
  private size = 16;
  private textColor: RGB = [0, 0, 0];
  private fillColor: RGB = [0, 0, 0];
  private drawColor: RGB = [0, 0, 0];
  private lineWidthMm = 0.2;
  private readonly charset: Set<number>;

  constructor(private readonly pdf: PDFDocument, private readonly fonts: Record<FontStyle, PDFFont>) {
    this.font = fonts.normal;
    this.charset = new Set(fonts.normal.getCharacterSet());
    this.addPage();
  }

  addPage() {
    this.page = this.pdf.addPage([PAGE_W * PT_PER_MM, PAGE_H * PT_PER_MM]);
    this.pages.push(this.page);
  }

  setPage(index: number) { this.page = this.pages[index]; }
  setFont(style: FontStyle) { this.font = this.fonts[style]; }
  setFontSize(size: number) { this.size = size; }
  setTextColor(color: RGB) { this.textColor = color; }
  setFillColor(color: RGB) { this.fillColor = color; }
  setDrawColor(color: RGB) { this.drawColor = color; }
  setLineWidth(mm: number) { this.lineWidthMm = mm; }

  /** Standard fonts encode WinAnsi only; anything else prints as "?". */
  private encodable(text: string): string {
    return Array.from(text.replace(/\t/g, " "), (char) => (this.charset.has(char.codePointAt(0)!) ? char : "?")).join("");
  }

  getTextWidth(text: string): number {
    return this.font.widthOfTextAtSize(this.encodable(text), this.size) / PT_PER_MM;
  }

  splitTextToSize(text: string, maxWidth: number): string[] {
    const lines: string[] = [];
    for (const paragraph of text.split(/\r\n|\r|\n/)) {
      let line = "";
      for (const word of paragraph.split(" ")) {
        const candidate = line === "" ? word : `${line} ${word}`;
        if (this.getTextWidth(candidate) <= maxWidth) {
          line = candidate;
          continue;
        }
        if (line !== "") lines.push(line);
        line = "";
        let rest = word;
        while (rest !== "" && this.getTextWidth(rest) > maxWidth) {
          let cut = rest.length - 1;
          while (cut > 1 && this.getTextWidth(rest.slice(0, cut)) > maxWidth) cut -= 1;
          lines.push(rest.slice(0, cut));
          rest = rest.slice(cut);
        }
        line = rest;
      }
      lines.push(line);
    }
    return lines;
  }

  text(value: string | string[], x: number, y: number, options?: { align?: "right" }) {
    const lines = Array.isArray(value) ? value : [value];
    const step = (this.size * LINE_HEIGHT_FACTOR) / PT_PER_MM;
    lines.forEach((line, index) => {
      const text = this.encodable(line);
      const left = options?.align === "right" ? x - this.getTextWidth(text) : x;
      this.page.drawText(text, {
        x: left * PT_PER_MM, y: (PAGE_H - (y + index * step)) * PT_PER_MM,
        size: this.size, font: this.font, color: pdfColor(this.textColor),
      });
    });
  }

  rect(x: number, y: number, width: number, height: number) {
    this.page.drawRectangle({
      x: x * PT_PER_MM, y: (PAGE_H - y - height) * PT_PER_MM, width: width * PT_PER_MM, height: height * PT_PER_MM,
      color: pdfColor(this.fillColor),
    });
  }

  line(x1: number, y1: number, x2: number, y2: number) {
    this.page.drawLine({
      start: { x: x1 * PT_PER_MM, y: (PAGE_H - y1) * PT_PER_MM }, end: { x: x2 * PT_PER_MM, y: (PAGE_H - y2) * PT_PER_MM },
      thickness: this.lineWidthMm * PT_PER_MM, color: pdfColor(this.drawColor),
    });
  }
}

export function checkPage(doc: Doc, y: number, needed: number): number {
  if (y + needed > PAGE_H - MARGIN_BOTTOM) {
    doc.addPage();
    return MARGIN_TOP;
  }
  return y;
}

export function drawFooter(doc: Doc, exportTimestamp: string) {
  const pageCount = doc.pages.length;
  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i - 1);
    doc.setTextColor(MEDIUM_GRAY);
    doc.setFontSize(7.5);
    doc.setFont("normal");
    doc.text(`Exported: ${exportTimestamp}`, MARGIN_L, FOOTER_Y);
    doc.text(`Page ${i} of ${pageCount}`, PAGE_W - MARGIN_R, FOOTER_Y, { align: "right" });
    doc.setDrawColor(LIGHT_GRAY);
    doc.setLineWidth(0.3);
    doc.line(MARGIN_L, FOOTER_Y - 4, PAGE_W - MARGIN_R, FOOTER_Y - 4);
  }
}

function normalizeText(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function sectionHeading(doc: Doc, y: number, label: string): number {
  y = checkPage(doc, y, 16);
  y += SECTION_GAP;
  doc.setTextColor(NAVY);
  doc.setFontSize(10);
  doc.setFont("bold");
  doc.text(label, MARGIN_L, y);
  y += 2.5;
  doc.setDrawColor(ACCENT);
  doc.setLineWidth(0.6);
  doc.line(MARGIN_L, y, MARGIN_L + CONTENT_W, y);
  return y + ELEMENT_GAP;
}

function labelValue(doc: Doc, y: number, label: string, value: string): number {
  y = checkPage(doc, y, 10);
  doc.setFontSize(8);
  doc.setFont("bold");
  doc.setTextColor(DARK_GRAY);
  const labelStr = `${label}:  `;
  doc.text(labelStr, MARGIN_L, y);
  const labelWidth = doc.getTextWidth(labelStr);
  doc.setFont("normal");
  const lines = doc.splitTextToSize(value || "N/A", CONTENT_W - labelWidth);
  doc.text(lines, MARGIN_L + labelWidth, y);
  return y + lines.length * 4 + 2.5;
}

function wrappedBlock(doc: Doc, y: number, text: string, indent = 0): number {
  doc.setFontSize(8);
  doc.setFont("normal");
  doc.setTextColor(DARK_GRAY);
  const lines = doc.splitTextToSize(normalizeText(text), CONTENT_W - indent);
  const lineHeight = 3.8;
  y = checkPage(doc, y, Math.min(lines.length * lineHeight + 2, 40));
  for (const line of lines) {
    y = checkPage(doc, y, lineHeight + 1);
    doc.text(line, MARGIN_L + indent, y);
    y += lineHeight;
  }
  return y + 2;
}

export type TableColumn = { label: string; width: number; align?: "right" };

export function drawTable(doc: Doc, y: number, columns: TableColumn[], rows: string[][]): number {
  const MIN_ROW_H = 7;
  const HEADER_H = 8;
  const PAD_X = 2.5;
  const PAD_Y = 2.5;
  const LINE_H = 3.2;

  doc.setFont("normal");
  doc.setFontSize(7);
  const wrappedRows = rows.map((row) => row.map((cell, c) => doc.splitTextToSize(cell ?? "", columns[c].width - PAD_X * 2)));
  const rowHeights = wrappedRows.map((cells) => Math.max(MIN_ROW_H, Math.max(1, ...cells.map((lines) => lines.length)) * LINE_H + PAD_Y * 2));

  y = checkPage(doc, y, HEADER_H + (rowHeights[0] ?? MIN_ROW_H) + 4);
  const headerTop = y;
  doc.setFillColor(NAVY);
  doc.rect(MARGIN_L, headerTop, CONTENT_W, HEADER_H);
  doc.setFontSize(7);
  doc.setFont("bold");
  doc.setTextColor(WHITE);
  let xPos = MARGIN_L + PAD_X;
  for (const column of columns) {
    if (column.align === "right") doc.text(column.label, xPos + column.width - PAD_X * 2, headerTop + HEADER_H / 2 + 1.2, { align: "right" });
    else doc.text(column.label, xPos, headerTop + HEADER_H / 2 + 1.2);
    xPos += column.width;
  }
  y = headerTop + HEADER_H;

  doc.setFont("normal");
  doc.setFontSize(7);
  for (let r = 0; r < wrappedRows.length; r++) {
    const rowHeight = rowHeights[r];
    y = checkPage(doc, y, rowHeight + 1);
    const rowTop = y;
    if (r % 2 === 0) {
      doc.setFillColor(TABLE_STRIPE);
      doc.rect(MARGIN_L, rowTop, CONTENT_W, rowHeight);
    }
    doc.setTextColor(DARK_GRAY);
    xPos = MARGIN_L + PAD_X;
    for (let c = 0; c < columns.length; c++) {
      const right = columns[c].align === "right";
      let lineY = rowTop + PAD_Y + LINE_H * 0.7;
      for (const line of wrappedRows[r][c]) {
        if (right) doc.text(line, xPos + columns[c].width - PAD_X * 2, lineY, { align: "right" });
        else doc.text(line, xPos, lineY);
        lineY += LINE_H;
      }
      xPos += columns[c].width;
    }
    y += rowHeight;
  }
  return y + ELEMENT_GAP;
}

export function standingSide(exclusion: Pick<PdfAccountExclusion, "noBuy" | "noSell">): string {
  if (exclusion.noBuy && exclusion.noSell) return "DNB+DNS";
  if (exclusion.noBuy) return "DNB";
  return "DNS";
}

/** "{account}: {ticker} ({side} - {reason}); …" per account, accounts joined with " || ". */
export function formatAccountStanding(entries: PdfAccountExclusion[]): { advisor: string; client: string } {
  const format = (kind: "advisor" | "client") => {
    const byAccount = new Map<string, string[]>();
    for (const entry of entries) {
      if (entry.kind !== kind) continue;
      const side = standingSide(entry);
      const list = byAccount.get(entry.accountNumber) ?? [];
      list.push(entry.reason ? `${entry.ticker} (${side} - ${entry.reason})` : `${entry.ticker} (${side})`);
      byAccount.set(entry.accountNumber, list);
    }
    return Array.from(byAccount.entries()).map(([account, values]) => `${account}: ${values.join("; ")}`).join(" || ");
  };
  return { advisor: format("advisor"), client: format("client") };
}

/**
 * The request's details, allocation and audit trail. `clientStanding` (the
 * Compliance Export Report's current client-level lines) prints after the
 * stored exclusions; the request PDF passes none.
 */
export function renderBody(
  doc: Doc, req: TradeRequest, y: number, accountExclusions: PdfAccountExclusion[],
  clientStanding?: { advisor: string; client: string },
): number {
  y = sectionHeading(doc, y, "Request Details");
  y = labelValue(doc, y, "Trade Type", req.tradeType);
  y = labelValue(doc, y, "Advisor", req.advisor);
  y = labelValue(doc, y, "Submitted By", req.submittedBy || req.advisor);
  if (req.tradeAmount) y = labelValue(doc, y, "Trade Amount", req.tradeAmount);
  y = labelValue(doc, y, "Total Value", formatCurrency(req.totalValue));
  y = labelValue(doc, y, "Residence", req.residence);
  y = labelValue(doc, y, "Accounts", req.selectedAccounts.join(", "));
  y = labelValue(doc, y, "Date Submitted", new Date(req.date).toLocaleDateString());
  if (req.priority) y = labelValue(doc, y, "Priority", req.priority);
  if (req.depositAccount) y = labelValue(doc, y, "Deposit Account", req.depositAccount);
  if (req.liquidationApproval) y = labelValue(doc, y, "Liquidation Approval", req.liquidationApproval);

  const esgList = Object.entries(req.esgFilters ?? {}).filter(([key, value]) => value && key !== "none").map(([key]) => key);
  if (esgList.length > 0) y = labelValue(doc, y, "ESG Exclusions", esgList.join(", "));

  if (req.advisorExclusions) y = labelValue(doc, y, "Advisor Exclusions", req.advisorExclusions);
  if (req.clientExclusions) y = labelValue(doc, y, "Client Exclusions", req.clientExclusions);
  if (clientStanding?.advisor) y = labelValue(doc, y, "Standing Advisor Exclusions (current)", clientStanding.advisor);
  if (clientStanding?.client) y = labelValue(doc, y, "Standing Client Exclusions (current)", clientStanding.client);
  const standing = formatAccountStanding(accountExclusions);
  if (standing.advisor) y = labelValue(doc, y, "Standing Account Advisor Exclusions (current)", standing.advisor);
  if (standing.client) y = labelValue(doc, y, "Standing Account Client Exclusions (current)", standing.client);
  if (req.advisorNotes) {
    y = labelValue(doc, y, "Advisor Notes", "");
    y = wrappedBlock(doc, y, req.advisorNotes, 2);
  }

  if (req.riskProfile != null || (req.equityStrategies ?? []).length > 0) {
    y = sectionHeading(doc, y, "Allocation & Strategy Rationale (Reg BI)");
    if (req.riskProfile != null) y = labelValue(doc, y, "Risk Profile", String(req.riskProfile));
    if (req.baseAllocation) {
      y = labelValue(doc, y, "Base Allocation",
        `Equity ${req.baseAllocation.equity}%  |  Fixed Income ${req.baseAllocation.fixed}%  |  Cash ${req.baseAllocation.cash}%`);
    }
    for (const strategy of req.equityStrategies ?? []) {
      y = checkPage(doc, y, 26);
      y += ELEMENT_GAP;
      const pillH = 8;
      doc.setFillColor(PILL);
      doc.rect(MARGIN_L + 2, y, CONTENT_W - 4, pillH);
      doc.setFontSize(8.5);
      doc.setFont("bold");
      doc.setTextColor(ACCENT);
      doc.text(`${strategy.benchmark}  —  ${strategy.allocation}% allocation`, MARGIN_L + 5, y + pillH / 2 + 1);
      y += pillH + ELEMENT_GAP;
      doc.setFontSize(8);
      doc.setFont("italic");
      doc.setTextColor(DARK_GRAY);
      doc.text("Rationale:", MARGIN_L + 5, y);
      y += 4.5;
      doc.setFont("normal");
      y = wrappedBlock(doc, y, strategy.rationale || "No rationale provided.", 5);
      y += 2;
    }
  }

  if (req.auditLog?.length > 0) {
    y = sectionHeading(doc, y, "Audit Trail");
    const columns: TableColumn[] = [
      { label: "Date", width: 30 },
      { label: "User", width: 38 },
      { label: "Action", width: 38 },
      { label: "Notes", width: CONTENT_W - 30 - 38 - 38 },
    ];
    y = drawTable(doc, y, columns, req.auditLog.map((entry) => [new Date(entry.date).toLocaleDateString(), entry.user, entry.action, entry.notes]));
  }
  return y;
}

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9_& -]/g, "").replace(/\s+/g, "_");
}

export type BuiltRequestPdf = { bytes: Uint8Array; filename: string };

/** A blank A4 document with the standalone's three Helvetica faces. */
export async function createPdfDoc(): Promise<{ pdf: PDFDocument; doc: Doc }> {
  const pdf = await PDFDocument.create();
  const fonts = {
    normal: await pdf.embedFont(StandardFonts.Helvetica),
    bold: await pdf.embedFont(StandardFonts.HelveticaBold),
    italic: await pdf.embedFont(StandardFonts.HelveticaOblique),
  };
  return { pdf, doc: new Doc(pdf, fonts) };
}

export async function buildRequestPdf(
  request: TradeRequest,
  exporter: TradeRequestExporter,
  accountExclusions: PdfAccountExclusion[] = [],
  now: Date = new Date(),
): Promise<BuiltRequestPdf> {
  const { pdf, doc } = await createPdfDoc();
  const exportTimestamp = now.toISOString();
  const household = householdLabel(request);

  const BAR_H = 11;
  let y = MARGIN_TOP;
  doc.setFillColor(NAVY);
  doc.rect(MARGIN_L, y, CONTENT_W, BAR_H);
  const barTextY = y + BAR_H / 2 + 1.2;
  doc.setFontSize(9);
  doc.setFont("bold");
  doc.setTextColor(WHITE);
  doc.text(`${request.id}  —  ${household}`, MARGIN_L + 4, barTextY);
  doc.setFontSize(7);
  doc.text(request.status.toUpperCase(), PAGE_W - MARGIN_R - 4, barTextY, { align: "right" });
  y += BAR_H + 4;

  doc.setFontSize(7.5);
  doc.setFont("normal");
  doc.setTextColor(MEDIUM_GRAY);
  doc.text(`Exported by ${exporter.name} (${exporter.email})`, MARGIN_L, y);
  y += SECTION_GAP;

  renderBody(doc, request, y, accountExclusions);
  drawFooter(doc, exportTimestamp);

  return {
    bytes: await pdf.save(),
    filename: `Trade_Request_${sanitizeFilename(household)}_${request.id}_${exportTimestamp.split("T")[0]}.pdf`,
  };
}
