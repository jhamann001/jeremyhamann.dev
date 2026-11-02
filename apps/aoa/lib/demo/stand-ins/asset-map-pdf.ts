import "server-only";
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import type { BulkHousehold } from "./pipeline";

// The asset map report the pipeline exports (one household, or every current household): each account with its
// positions and their transfer status. A plain letter-size table, in the demo's place of the pipeline's own layout.

const PAGE = { width: 612, height: 792, margin: 48 };
const INK = rgb(0.13, 0.15, 0.17);
const MUTED = rgb(0.42, 0.45, 0.48);
const RULE = rgb(0.85, 0.86, 0.88);

const money = (n: unknown) => {
  const v = Number(n);
  return Number.isFinite(v) ? v.toLocaleString("en-US", { style: "currency", currency: "USD" }) : "—";
};
const masked = (n: unknown) => (typeof n === "string" && n.length > 4 ? `••••${n.slice(-4)}` : String(n ?? "—"));
const fit = (font: PDFFont, s: string, size: number, width: number) => {
  let out = s;
  while (out.length > 1 && font.widthOfTextAtSize(out, size) > width) out = out.slice(0, -2) + "…";
  return out;
};

class Writer {
  private page!: PDFPage;
  private y = 0;
  constructor(private doc: PDFDocument, private font: PDFFont, private bold: PDFFont, private footer: string) {
    this.newPage();
  }
  private newPage() {
    this.page = this.doc.addPage([PAGE.width, PAGE.height]);
    this.y = PAGE.height - PAGE.margin;
    this.page.drawText(this.footer, { x: PAGE.margin, y: 28, size: 8, font: this.font, color: MUTED });
  }
  private room(h: number) {
    if (this.y - h < PAGE.margin) this.newPage();
  }
  text(s: string, opts: { size?: number; bold?: boolean; color?: typeof INK; gap?: number } = {}) {
    const size = opts.size ?? 10;
    this.room(size + 4);
    this.page.drawText(fit(opts.bold ? this.bold : this.font, s, size, PAGE.width - 2 * PAGE.margin), {
      x: PAGE.margin, y: this.y - size, size, font: opts.bold ? this.bold : this.font, color: opts.color ?? INK,
    });
    this.y -= size + (opts.gap ?? 6);
  }
  row(cells: string[], widths: number[], opts: { bold?: boolean } = {}) {
    const size = 8.5;
    this.room(size + 6);
    let x = PAGE.margin;
    cells.forEach((cell, i) => {
      const font = opts.bold ? this.bold : this.font;
      const w = widths[i];
      const s = fit(font, cell, size, w - 6);
      const right = i >= cells.length - 2;
      this.page.drawText(s, { x: right ? x + w - 6 - font.widthOfTextAtSize(s, size) : x, y: this.y - size, size, font, color: INK });
      x += w;
    });
    this.y -= size + 5;
  }
  rule() {
    this.room(6);
    this.page.drawLine({ start: { x: PAGE.margin, y: this.y }, end: { x: PAGE.width - PAGE.margin, y: this.y }, thickness: 0.5, color: RULE });
    this.y -= 6;
  }
  space(h: number) {
    this.y -= h;
  }
}

const WIDTHS = [62, 186, 92, 86, 90];

function writeHousehold(w: Writer, h: BulkHousehold) {
  w.text(h.client_name, { size: 16, bold: true, gap: 4 });
  w.text(`Run ${h.run_number} · ${h.total_accounts} accounts · ${h.total_positions} positions · ${money(h.total_value)}`, { color: MUTED, gap: 4 });
  w.text(`ACAT ${h.acat_count} · Liquidate ${h.liquidate_count} · Unsupported ${h.unsupported_count} · Review ${h.review_count} · ACH/Wire ${h.transfer_count}`, { color: MUTED, gap: 14 });
  for (const a of h.accounts) {
    w.text(`${a.custodian ?? "Unknown custodian"} · ${a.account_type ?? "Account"} ${masked(a.account_number)}`, { bold: true, size: 11, gap: 4 });
    w.text(`${a.account_holder ?? ""}${a.statement_date ? ` · statement ${String(a.statement_date).slice(0, 10)}` : ""} · ${money(a.total_value)}`, { color: MUTED, size: 9, gap: 6 });
    w.row(["Symbol", "Description", "Status", "Quantity", "Value"], WIDTHS, { bold: true });
    w.rule();
    for (const p of a.assets) {
      w.row([p.symbol ?? "—", p.description ?? "", String(p.effective_status ?? "—"),
        p.quantity == null ? "—" : Number(p.quantity).toLocaleString("en-US", { maximumFractionDigits: 4 }), money(p.market_value)], WIDTHS);
    }
    w.space(10);
  }
}

async function render(households: BulkHousehold[], title: string): Promise<Uint8Array<ArrayBuffer>> {
  const doc = await PDFDocument.create();
  doc.setTitle(title);
  doc.setProducer("Always-On-Advice demo");
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const w = new Writer(doc, font, bold, `${title} · generated ${new Date().toISOString().slice(0, 10)} · Cedar Ridge Wealth (portfolio demo, invented data)`);
  households.forEach((h, i) => {
    if (i > 0) w.space(18);
    writeHousehold(w, h);
  });
  return new Uint8Array(await doc.save());
}

export const householdPdf = (h: BulkHousehold) => render([h], `Asset map: ${h.client_name}`);
export const allHouseholdsPdf = (all: BulkHousehold[]) => render(all, "Asset maps: all current households");
