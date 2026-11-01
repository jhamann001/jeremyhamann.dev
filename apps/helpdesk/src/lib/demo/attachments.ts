/**
 * The demo's seeded attachments: a voided check, a beneficiary form and a statement page, generated from
 * code rather than committed as binaries, so the name check can read every byte that ships and nothing
 * here can carry a real document.
 *
 * The bytes are a pure function of the universe: no clock, no compression library. The image build
 * writes them to the filesystem store's paths (`writeDemoAttachments`) and the reset stamps the same
 * size and sha256 on the rows, so a download serves exactly what the ledger says was attached.
 */
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { attachmentObjectKey } from "@/lib/storage";
import { findPerson, personName, type Universe } from "./universe";

/** Seeded tickets carry readable ids, so an attachment's object key is known before the reset runs. */
export const demoTicketId = (ticketNumber: number): string => `hd-${ticketNumber}`;

export type DemoAttachment = {
  id: string;
  ticketNumber: number;
  filename: string;
  mime: "application/pdf" | "image/png";
  bytes: Uint8Array;
  sha256: string;
  objectKey: string;
};

export function buildDemoAttachments(universe: Universe): DemoAttachment[] {
  const files: Array<Omit<DemoAttachment, "sha256" | "objectKey">> = [
    { id: "att-lindqvist-voided-check", ticketNumber: 2470, filename: "voided-check.png", mime: "image/png", bytes: voidedCheck(universe) },
    {
      id: "att-okafor-beneficiary-form",
      ticketNumber: 2481,
      filename: "Roth IRA beneficiary designation.pdf",
      mime: "application/pdf",
      bytes: beneficiaryForm(universe),
    },
    {
      id: "att-nakamura-statement-page",
      ticketNumber: 2468,
      filename: "Q3 statement page 1.pdf",
      mime: "application/pdf",
      bytes: statementPage(universe),
    },
  ];
  return files.map((f) => ({
    ...f,
    sha256: createHash("sha256").update(f.bytes).digest("hex"),
    objectKey: attachmentObjectKey(demoTicketId(f.ticketNumber), f.id),
  }));
}

/** Writes every seeded attachment under `root` at its object key: the filesystem store's layout. */
export async function writeDemoAttachments(root: string, universe: Universe): Promise<number> {
  const files = buildDemoAttachments(universe);
  for (const f of files) {
    const path = join(root, f.objectKey);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, f.bytes);
  }
  return files.length;
}

// ---------------------------------------------------------------------------
// The three documents
// ---------------------------------------------------------------------------

function voidedCheck(universe: Universe): Uint8Array {
  const holder = personName(findPerson(universe, "lindqvist", "Erik")).toUpperCase();
  const img = new Gray(720, 300, 255);
  img.fill(0, 0, 720, 70, 242);
  img.frame(0, 0, 720, 300, 70);
  img.text(24, 18, "FIRST DEMO BANK", 3, 30);
  img.text(24, 48, holder, 2, 60);
  img.text(612, 18, "1001", 3, 30);
  img.text(470, 86, "DATE", 2, 60);
  img.fill(524, 98, 170, 2, 90);
  img.text(24, 130, "PAY TO THE", 2, 60);
  img.text(24, 148, "ORDER OF", 2, 60);
  img.fill(120, 162, 440, 2, 90);
  img.fill(24, 200, 536, 2, 90);
  img.text(568, 190, "DOLLARS", 2, 60);
  img.text(140, 100, "VOID", 13, 170);
  img.text(360, 224, "DEMO ONLY - NOT A REAL CHECK", 2, 60);
  img.text(24, 262, "000000000: 0000001001: 1001", 3, 30);
  return png(img);
}

function beneficiaryForm(universe: Universe): Uint8Array {
  const owner = findPerson(universe, "okafor", "Ada");
  const spouse = findPerson(universe, "okafor", "Kofi");
  const roth = universe.stories.statements
    .find((s) => s.household === "okafor")
    ?.accounts?.find((a) => a.label === "Roth IRA");
  const custodian = universe.custodians.find((c) => c.id === "edward-jones")?.name ?? "the delivering firm";
  const page: PdfOp[] = [
    ...heading(universe.firm.name, "Beneficiary designation - Roth IRA"),
    ...section(640, "1. Account owner", [
      ["Name", personName(owner)],
      ["Account", `Roth IRA ending ${roth?.suffix ?? "0000"} (transferring from ${custodian})`],
      ["Email", owner.email],
      ["Phone", owner.phone],
    ]),
    ...section(520, "2. Primary beneficiary", [
      ["Name", personName(spouse)],
      ["Relationship", "Spouse"],
      ["Share", "100%"],
    ]),
    ...section(420, "3. Contingent beneficiary", [
      ["Name", `The ${owner.last} Family Trust`],
      ["Relationship", "Trust"],
      ["Share", "100%"],
    ]),
    ...section(320, "4. Signature", [
      ["Signed", `${personName(owner)} (electronically)`],
      ["Date", universe.meta.asOf],
    ]),
    ...footer(),
  ];
  return pdf([page]);
}

function statementPage(universe: Universe): Uint8Array {
  const ken = findPerson(universe, "nakamura", "Ken");
  const emi = findPerson(universe, "nakamura", "Emi");
  const account = universe.accounts.find((a) => a.household === "nakamura");
  const rows = (universe as Universe & { holdings?: Array<{ account: string; symbol: string; quantity: number; value: number }> }).holdings
    ?.filter((h) => h.account === account?.id)
    .slice(0, 8) ?? [];
  const money = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const page: PdfOp[] = [
    ...heading(universe.firm.name, "Quarterly statement - period ending 2026-09-30"),
    { t: "text", x: 56, y: 650, size: 11, bold: true, text: `${ken.first} and ${emi.first} ${ken.last}` },
    { t: "text", x: 56, y: 635, size: 11, text: "88 Old Mill Road, Apt 4" },
    { t: "text", x: 56, y: 620, size: 11, text: "Anytown, OR 97000" },
    { t: "rect", x: 52, y: 612, w: 230, h: 56 },
    { t: "text", x: 300, y: 650, size: 10, text: `Account ${account?.number ?? "DEMO-000000"}` },
    { t: "text", x: 300, y: 635, size: 10, text: "Traditional IRA" },
    { t: "text", x: 300, y: 620, size: 10, text: "Page 1 of 4" },
    { t: "text", x: 56, y: 570, size: 12, bold: true, text: "Holdings" },
    { t: "line", x1: 56, y1: 562, x2: 556, y2: 562 },
    { t: "text", x: 56, y: 548, size: 10, bold: true, text: "Symbol" },
    { t: "text", x: 200, y: 548, size: 10, bold: true, text: "Quantity" },
    { t: "text", x: 420, y: 548, size: 10, bold: true, text: "Market value" },
    ...rows.flatMap((h, i): PdfOp[] => [
      { t: "text", x: 56, y: 530 - i * 16, size: 10, text: h.symbol },
      { t: "text", x: 200, y: 530 - i * 16, size: 10, text: String(h.quantity) },
      { t: "text", x: 420, y: 530 - i * 16, size: 10, text: money(h.value) },
    ]),
    ...footer(),
  ];
  return pdf([page]);
}

function heading(firm: string, title: string): PdfOp[] {
  return [
    { t: "fill", x: 0, y: 712, w: 612, h: 80, gray: 0.93 },
    { t: "text", x: 56, y: 752, size: 18, bold: true, text: firm },
    { t: "text", x: 56, y: 728, size: 13, text: title },
    { t: "text", x: 56, y: 690, size: 9, gray: 0.4, text: "DEMO DOCUMENT - synthetic data for a portfolio demo, not a real form or account." },
  ];
}

function section(y: number, title: string, fields: Array<[string, string]>): PdfOp[] {
  return [
    { t: "text", x: 56, y, size: 12, bold: true, text: title },
    { t: "line", x1: 56, y1: y - 8, x2: 556, y2: y - 8 },
    ...fields.flatMap(([label, value], i): PdfOp[] => [
      { t: "text", x: 56, y: y - 26 - i * 18, size: 10, gray: 0.35, text: label },
      { t: "text", x: 170, y: y - 26 - i * 18, size: 10, text: value },
    ]),
  ];
}

function footer(): PdfOp[] {
  return [{ t: "text", x: 56, y: 40, size: 8, gray: 0.5, text: "Generated for the WM Help Desk demo. Every name and number on this page is invented." }];
}

// ---------------------------------------------------------------------------
// A minimal PDF writer: uncompressed, ASCII only, the two standard Helvetica faces
// ---------------------------------------------------------------------------

type PdfOp =
  | { t: "text"; x: number; y: number; size: number; text: string; bold?: boolean; gray?: number }
  | { t: "line"; x1: number; y1: number; x2: number; y2: number }
  | { t: "rect"; x: number; y: number; w: number; h: number }
  | { t: "fill"; x: number; y: number; w: number; h: number; gray: number };

const pdfString = (s: string): string => `(${s.replace(/[^\x20-\x7e]/g, "-").replace(/([\\()])/g, "\\$1")})`;

function pdfOp(op: PdfOp): string {
  switch (op.t) {
    case "text":
      return `${op.gray ?? 0} g BT /${op.bold ? "F2" : "F1"} ${op.size} Tf ${op.x} ${op.y} Td ${pdfString(op.text)} Tj ET`;
    case "line":
      return `0.6 G 0.75 w ${op.x1} ${op.y1} m ${op.x2} ${op.y2} l S`;
    case "rect":
      return `0.6 G 0.75 w ${op.x} ${op.y} ${op.w} ${op.h} re S`;
    case "fill":
      return `${op.gray} g ${op.x} ${op.y} ${op.w} ${op.h} re f`;
  }
}

function pdf(pages: PdfOp[][]): Uint8Array {
  const objects: string[] = [];
  const pageIds = pages.map((_, i) => 5 + i * 2);
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`;
  objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";
  objects[4] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>";
  pages.forEach((ops, i) => {
    const content = ops.map(pdfOp).join("\n");
    objects[pageIds[i] as number] =
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] " +
      `/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${(pageIds[i] as number) + 1} 0 R >>`;
    objects[(pageIds[i] as number) + 1] = `<< /Length ${content.length} >>\nstream\n${content}\nendstream`;
  });
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let id = 1; id < objects.length; id++) {
    offsets[id] = out.length;
    out += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xref = out.length;
  out += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id++) out += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

// ---------------------------------------------------------------------------
// A minimal PNG writer: 8-bit grayscale, stored (uncompressed) deflate blocks, a 5x7 bitmap font
// ---------------------------------------------------------------------------

/** 5x7 glyphs, one byte per row, the low five bits left to right. */
const FONT: Record<string, readonly number[]> = {
  A: [14, 17, 17, 31, 17, 17, 17], B: [30, 17, 17, 30, 17, 17, 30], C: [14, 17, 16, 16, 16, 17, 14],
  D: [28, 18, 17, 17, 17, 18, 28], E: [31, 16, 16, 30, 16, 16, 31], F: [31, 16, 16, 30, 16, 16, 16],
  G: [14, 17, 16, 23, 17, 17, 15], H: [17, 17, 17, 31, 17, 17, 17], I: [14, 4, 4, 4, 4, 4, 14],
  J: [7, 2, 2, 2, 2, 18, 12], K: [17, 18, 20, 24, 20, 18, 17], L: [16, 16, 16, 16, 16, 16, 31],
  M: [17, 27, 21, 21, 17, 17, 17], N: [17, 17, 25, 21, 19, 17, 17], O: [14, 17, 17, 17, 17, 17, 14],
  P: [30, 17, 17, 30, 16, 16, 16], Q: [14, 17, 17, 17, 21, 18, 13], R: [30, 17, 17, 30, 20, 18, 17],
  S: [15, 16, 16, 14, 1, 1, 30], T: [31, 4, 4, 4, 4, 4, 4], U: [17, 17, 17, 17, 17, 17, 14],
  V: [17, 17, 17, 17, 17, 10, 4], W: [17, 17, 17, 21, 21, 21, 10], X: [17, 17, 10, 4, 10, 17, 17],
  Y: [17, 17, 10, 4, 4, 4, 4], Z: [31, 1, 2, 4, 8, 16, 31],
  "0": [14, 17, 19, 21, 25, 17, 14], "1": [4, 12, 4, 4, 4, 4, 14], "2": [14, 17, 1, 2, 4, 8, 31],
  "3": [31, 2, 4, 2, 1, 17, 14], "4": [2, 6, 10, 18, 31, 2, 2], "5": [31, 16, 30, 1, 1, 17, 14],
  "6": [6, 8, 16, 30, 17, 17, 14], "7": [31, 1, 2, 4, 8, 8, 8], "8": [14, 17, 17, 14, 17, 17, 14],
  "9": [14, 17, 17, 15, 1, 2, 12],
  " ": [0, 0, 0, 0, 0, 0, 0], "-": [0, 0, 0, 31, 0, 0, 0], ".": [0, 0, 0, 0, 0, 12, 12],
  ":": [0, 12, 12, 0, 12, 12, 0], "'": [4, 4, 8, 0, 0, 0, 0],
};

class Gray {
  readonly pixels: Uint8Array;
  constructor(
    readonly width: number,
    readonly height: number,
    background: number,
  ) {
    this.pixels = new Uint8Array(width * height).fill(background);
  }
  fill(x: number, y: number, w: number, h: number, value: number): void {
    for (let row = Math.max(0, y); row < Math.min(this.height, y + h); row++) {
      this.pixels.fill(value, row * this.width + Math.max(0, x), row * this.width + Math.min(this.width, x + w));
    }
  }
  frame(x: number, y: number, w: number, h: number, value: number): void {
    this.fill(x, y, w, 2, value);
    this.fill(x, y + h - 2, w, 2, value);
    this.fill(x, y, 2, h, value);
    this.fill(x + w - 2, y, 2, h, value);
  }
  text(x: number, y: number, text: string, scale: number, value: number): void {
    let cursor = x;
    for (const ch of text.toUpperCase()) {
      const glyph = FONT[ch] ?? FONT[" "]!;
      glyph.forEach((bits, row) => {
        for (let col = 0; col < 5; col++) {
          if (bits & (1 << (4 - col))) this.fill(cursor + col * scale, y + row * scale, scale, scale, value);
        }
      });
      cursor += 6 * scale;
    }
  }
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = (CRC_TABLE[(c ^ b) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function u32(n: number): Uint8Array {
  return new Uint8Array([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const typed = concat([new TextEncoder().encode(type), data]);
  return concat([u32(data.length), typed, u32(crc32(typed))]);
}

/** A zlib stream of stored blocks: no compression, so the output depends on nothing but the input. */
function zlibStored(raw: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [new Uint8Array([0x78, 0x01])];
  for (let at = 0; at < raw.length || at === 0; at += 65535) {
    const block = raw.subarray(at, Math.min(raw.length, at + 65535));
    const last = at + 65535 >= raw.length ? 1 : 0;
    parts.push(new Uint8Array([last, block.length & 0xff, block.length >>> 8, ~block.length & 0xff, (~block.length >>> 8) & 0xff]), block);
    if (raw.length === 0) break;
  }
  let a = 1;
  let b = 0;
  for (const byte of raw) {
    a = (a + byte) % 65521;
    b = (b + a) % 65521;
  }
  parts.push(u32(((b << 16) | a) >>> 0));
  return concat(parts);
}

function png(img: Gray): Uint8Array {
  const raw = new Uint8Array((img.width + 1) * img.height);
  for (let row = 0; row < img.height; row++) {
    raw[row * (img.width + 1)] = 0; // filter: none
    raw.set(img.pixels.subarray(row * img.width, (row + 1) * img.width), row * (img.width + 1) + 1);
  }
  const header = concat([u32(img.width), u32(img.height), new Uint8Array([8, 0, 0, 0, 0])]);
  return concat([
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", zlibStored(raw)),
    chunk("IEND", new Uint8Array(0)),
  ]);
}
