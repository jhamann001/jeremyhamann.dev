// One-page summaries of a delivering firm's published transfer fees. The seed stores one as the fee-schedule
// document of each story firm, so the Custodian Library has a file to open. The summary names the firm's own
// published source; it is the demo's sheet, not a document from the firm.

import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

export interface FeeScheduleLine {
  label: string;
  amount: string;
}

export interface FeeScheduleInput {
  firmName: string;
  source: string; // the firm's published fee document, e.g. "Schwab Pricing Guide"
  lines: FeeScheduleLine[];
  notes: string[];
}

const INK = rgb(0.12, 0.14, 0.17);
const MUTED = rgb(0.4, 0.42, 0.46);
const RULE = rgb(0.78, 0.8, 0.83);

/** A one-page fee summary. Deterministic: the same input always gives the same bytes. */
export async function buildFeeSchedulePdf(input: FeeScheduleInput): Promise<Uint8Array> {
  const document = await PDFDocument.create({ updateMetadata: false });
  document.setTitle(`${input.firmName} transfer fee summary (demo)`);
  const regular = await document.embedFont(StandardFonts.Helvetica);
  const bold = await document.embedFont(StandardFonts.HelveticaBold);
  const page = document.addPage([612, 792]);

  page.drawText(input.firmName, { x: 54, y: 730, size: 18, font: bold, color: INK });
  page.drawText("Transfer fee summary", { x: 54, y: 708, size: 12, font: regular, color: INK });
  page.drawText(`Source: ${input.source}`, { x: 54, y: 690, size: 9, font: regular, color: MUTED });
  page.drawLine({ start: { x: 54, y: 676 }, end: { x: 558, y: 676 }, thickness: 1, color: INK });

  page.drawText("Service", { x: 54, y: 656, size: 9, font: bold, color: INK });
  page.drawText("Fee", { x: 470, y: 656, size: 9, font: bold, color: INK });
  let y = 636;
  for (const line of input.lines) {
    page.drawText(line.label, { x: 54, y, size: 10, font: regular, color: INK });
    page.drawText(line.amount, { x: 470, y, size: 10, font: regular, color: INK });
    page.drawLine({ start: { x: 54, y: y - 7 }, end: { x: 558, y: y - 7 }, thickness: 0.5, color: RULE });
    y -= 24;
  }

  y -= 12;
  for (const note of input.notes) {
    page.drawText(note, { x: 54, y, size: 8.5, font: regular, color: MUTED });
    y -= 14;
  }

  page.drawText("Summary sheet made for a portfolio demo from the firm's published fees. Not a document from the firm.", {
    x: 54,
    y: 40,
    size: 7.5,
    font: regular,
    color: rgb(0.7, 0.13, 0.13),
  });
  return document.save({ useObjectStreams: false });
}
