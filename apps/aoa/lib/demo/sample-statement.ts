import "server-only";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { buildStatementDocument, type BuiltStatementDocument } from "@/lib/data/transfer-statement-documents";
import { DEMO_SAMPLE_STATEMENT_FILENAME } from "@/lib/transfers/statement-document";

// The public demo takes no uploads (visitors' files would be stored for every other visitor to download), so the
// statement dialog offers this one-page sample instead. It is built without a creation date, so its bytes and digest
// are the same every time and a transfer reuses its stored copy rather than storing it again.

const LINES: ReadonlyArray<[string, string]> = [
  ["Cash and sweep", "$12,480.15"],
  ["Total market index fund", "$148,902.40"],
  ["International index fund", "$61,318.77"],
  ["Short-term bond fund", "$40,112.03"],
];

let built: Promise<BuiltStatementDocument> | null = null;

async function samplePdf(): Promise<Uint8Array> {
  const ink = rgb(0.12, 0.14, 0.17);
  const muted = rgb(0.4, 0.42, 0.46);
  const document = await PDFDocument.create({ updateMetadata: false });
  document.setTitle("Sample account statement (demo)");
  const regular = await document.embedFont(StandardFonts.Helvetica);
  const bold = await document.embedFont(StandardFonts.HelveticaBold);
  const page = document.addPage([612, 792]);
  page.drawText("Sample account statement", { x: 54, y: 730, size: 18, font: bold, color: ink });
  page.drawText("Prior custodian · account ending 0000", { x: 54, y: 708, size: 11, font: regular, color: ink });
  page.drawText("A stand-in for the client's statement in the public demo. Every figure is invented.",
    { x: 54, y: 690, size: 9, font: regular, color: muted });
  page.drawLine({ start: { x: 54, y: 676 }, end: { x: 558, y: 676 }, thickness: 1, color: ink });
  page.drawText("Holding", { x: 54, y: 656, size: 9, font: bold, color: ink });
  page.drawText("Market value", { x: 470, y: 656, size: 9, font: bold, color: ink });
  let y = 636;
  for (const [holding, value] of LINES) {
    page.drawText(holding, { x: 54, y, size: 10, font: regular, color: ink });
    page.drawText(value, { x: 470, y, size: 10, font: regular, color: ink });
    y -= 18;
  }
  return document.save();
}

/** The sample statement, checked like an upload. Built once per process. */
export function demoSampleStatement(): Promise<BuiltStatementDocument> {
  if (!built) {
    built = samplePdf().then((content) =>
      buildStatementDocument({ filename: DEMO_SAMPLE_STATEMENT_FILENAME, contentType: "application/pdf", content }));
    // A failed build is not kept, so the next request tries again.
    built.catch(() => { built = null; });
  }
  return built;
}
