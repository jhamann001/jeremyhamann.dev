import { inflateSync } from "node:zlib";
import { PDFArray, PDFDocument, PDFName, PDFRawStream, type PDFPage } from "pdf-lib";

// Text runs drawn with pdf-lib's standard fonts, read back per page in drawing
// order (hex-encoded WinAnsi strings inside the content streams).

const WIN_ANSI_EXTRA: Record<number, string> = { 0x97: "—", 0x96: "–", 0x95: "•" };

function pageStreams(page: PDFPage): PDFRawStream[] {
  const contents = page.node.get(PDFName.of("Contents"));
  const refs = contents instanceof PDFArray ? contents.asArray() : [contents];
  return refs.map((ref) => page.doc.context.lookup(ref) as PDFRawStream);
}

export async function pdfPageTexts(bytes: Uint8Array): Promise<string[][]> {
  const pdf = await PDFDocument.load(bytes);
  return pdf.getPages().map((page) => pageStreams(page).flatMap((stream) => {
    const raw = Buffer.from(stream.contents);
    const source = (stream.dict.get(PDFName.of("Filter")) ? inflateSync(raw) : raw).toString("latin1");
    return [...source.matchAll(/<([0-9A-Fa-f]*)> Tj/g)].map(([, hex]) =>
      Array.from(Buffer.from(hex, "hex"), (byte) => WIN_ANSI_EXTRA[byte] ?? String.fromCharCode(byte)).join(""));
  }));
}
