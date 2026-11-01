// The demo's transfer form: a fictional stand-in for the clearing firm's customer
// account transfer request, drawn here with pdf-lib. Its layout and wording are new;
// only the AcroForm field names match what apex-transfer-form.ts fills, so
// the form-filling code runs unchanged. The committed copy in
// public/form-templates is this function's output, byte for byte (a test
// rebuilds it and compares), so regenerate it with
// `npx tsx scripts/build-transfer-form-template.ts` after any change here.

import {
  PDFDocument,
  PDFFont,
  PDFForm,
  PDFPage,
  PDFString,
  StandardFonts,
  rgb,
} from "pdf-lib";

export const TRANSFER_FORM_TEMPLATE_PATH =
  "public/form-templates/apex-customer-account-transfer-request.pdf";

const INK = rgb(0.12, 0.14, 0.17);
const MUTED = rgb(0.4, 0.42, 0.46);
const BAND = rgb(0.23, 0.44, 0.63);
const FIELD_BORDER = rgb(0.6, 0.62, 0.66);
const FIELD_FILL = rgb(0.96, 0.97, 0.98);

const LEFT = 42;
const RIGHT = 570;

interface Fonts {
  regular: PDFFont;
  bold: PDFFont;
}

function label(page: PDFPage, fonts: Fonts, text: string, x: number, y: number, size = 6.5) {
  page.drawText(text, { x, y, size, font: fonts.regular, color: MUTED });
}

function sectionHeading(page: PDFPage, fonts: Fonts, letter: string, title: string, y: number) {
  page.drawRectangle({ x: LEFT, y: y - 3, width: RIGHT - LEFT, height: 14, color: BAND });
  page.drawText(`${letter}  ${title}`, { x: LEFT + 6, y: y + 1, size: 8.5, font: fonts.bold, color: rgb(1, 1, 1) });
}

function textField(
  form: PDFForm,
  page: PDFPage,
  fonts: Fonts,
  name: string,
  caption: string,
  x: number,
  y: number,
  width: number,
  height = 15
) {
  label(page, fonts, caption, x, y + height + 2);
  const field = form.createTextField(name);
  field.addToPage(page, {
    x,
    y,
    width,
    height,
    font: fonts.regular,
    textColor: INK,
    backgroundColor: FIELD_FILL,
    borderColor: FIELD_BORDER,
    borderWidth: 0.6,
  });
  field.setFontSize(8);
}

function checkBox(form: PDFForm, page: PDFPage, fonts: Fonts, name: string, x: number, y: number, caption?: string) {
  const box = form.createCheckBox(name);
  box.addToPage(page, {
    x,
    y,
    width: 9,
    height: 9,
    textColor: INK,
    backgroundColor: rgb(1, 1, 1),
    borderColor: FIELD_BORDER,
    borderWidth: 0.6,
  });
  if (caption) page.drawText(caption, { x: x + 13, y: y + 1.5, size: 7, font: fonts.regular, color: INK });
}

// pdf-lib reads signature fields but cannot create one, so build the merged
// field/widget dictionary directly. Signers complete these by hand.
function signatureField(form: PDFForm, page: PDFPage, fonts: Fonts, name: string, caption: string, x: number, y: number, width: number) {
  const height = 22;
  page.drawLine({ start: { x, y }, end: { x: x + width, y }, thickness: 0.6, color: INK });
  label(page, fonts, caption, x, y - 9);
  const context = page.doc.context;
  const widget = context.register(
    context.obj({
      FT: "Sig",
      T: PDFString.of(name),
      Type: "Annot",
      Subtype: "Widget",
      Rect: [x, y, x + width, y + height],
      F: 4,
      P: page.ref,
    })
  );
  page.node.addAnnot(widget);
  form.acroForm.addField(widget);
}

function paragraph(page: PDFPage, fonts: Fonts, lines: string[], y: number): number {
  for (const line of lines) {
    page.drawText(line, { x: LEFT, y, size: 7, font: fonts.regular, color: INK });
    y -= 10;
  }
  return y;
}

function pageHeader(page: PDFPage, fonts: Fonts, subtitle: string, pageNumber: number) {
  page.drawText("TRANSFER TRACKER DEMO", { x: LEFT, y: 752, size: 13, font: fonts.bold, color: INK });
  page.drawText(subtitle, { x: LEFT, y: 736, size: 10, font: fonts.regular, color: INK });
  page.drawText("Demo form · Not an Apex form", { x: 448, y: 754, size: 7, font: fonts.regular, color: MUTED });
  page.drawText("Fictional form for a portfolio demo.", { x: 448, y: 745, size: 7, font: fonts.regular, color: rgb(0.7, 0.13, 0.13) });
  page.drawText("Not for use with any real account.", { x: 448, y: 736, size: 7, font: fonts.regular, color: rgb(0.7, 0.13, 0.13) });
  page.drawLine({ start: { x: LEFT, y: 728 }, end: { x: RIGHT, y: 728 }, thickness: 1, color: INK });
  page.drawText(`Page ${pageNumber} of 2`, { x: 520, y: 26, size: 7, font: fonts.regular, color: MUTED });
  page.drawText("A stand-in for the clearing firm's transfer form. Every name and number on this form is fictional.", {
    x: LEFT,
    y: 26,
    size: 6.5,
    font: fonts.regular,
    color: MUTED,
  });
}

const TRANSFER_SELECTIONS: Array<[string, string]> = [
  ["BROKERAGE FIRM TRANSFER", "Full transfer from a brokerage firm (ACAT)"],
  ["PARTIAL TRANSFER", "Partial transfer of the assets listed in section D"],
  ["NON-ACAT TRANSFER", "Transfer from a firm outside the ACAT system"],
  ["MUTUAL FUND COMPANY TRANSFER", "Transfer from a mutual fund company (section E)"],
  ["LIQUIDATE ALL ASSETS & TRANSFER AS CASH", "Sell all assets and transfer the proceeds as cash"],
  ["LIQUIDATE ANNUITY & TRANSFER AS CASH", "Surrender the annuity and transfer the proceeds"],
  ["LIQUIDATE CERTIFICATES OF DEPOSIT IMMEDIATELY", "Redeem certificates of deposit now"],
  ["TRANSFER PROCEEDS OF CERTIFICATES OF DEPOSIT AT MATURITY", "Transfer CD proceeds when each CD matures"],
];

// Row 3's elections carry a space after the hyphen; the filler uses these
// exact names, so keep them as they are.
const ELECTIONS = [
  ["FUTURE DIVIDEND-Reinvest 1", "FUTURE DIVIDEND-Pay In Cash 1", "FUTURE CAPITAL GAINS-Reinvest 1", "FUTURE CAPITAL GAINS-Pay In Cash 1"],
  ["FUTURE DIVIDEND-Reinvest 2", "FUTURE DIVIDEND-Pay In Cash 2", "FUTURE CAPITAL GAINS-Reinvest 2", "FUTURE CAPITAL GAINS-Pay In Cash 2"],
  ["FUTURE DIVIDEND-Reinvest 3", "FUTURE DIVIDEND- Pay In Cash 3", "FUTURE CAPITAL GAINS-Reinvest 3", "FUTURE CAPITAL GAINS- Pay In Cash 3"],
  ["FUTURE DIVIDEND-Reinvest 4", "FUTURE DIVIDEND-Pay In Cash 4", "FUTURE CAPITAL GAINS-Reinvest 4", "FUTURE CAPITAL GAINS-Pay In Cash 4"],
] as const;

function drawPageOne(form: PDFForm, page: PDFPage, fonts: Fonts) {
  pageHeader(page, fonts, "Customer Account Transfer Request", 1);
  textField(form, page, fonts, "DATE", "Date", 470, 703, 100);

  sectionHeading(page, fonts, "A", "Receiving account at Apex Clearing", 686);
  textField(form, page, fonts, "ACCOUNT TITLE", "Account title (as registered at Apex)", LEFT, 654, 300);
  textField(form, page, fonts, "APEX CLEARING ACCOUNT NO", "Apex account number", 352, 654, 110);
  textField(form, page, fonts, "SSNTAX ID NO", "SSN / tax ID (client completes)", 472, 654, 98);

  sectionHeading(page, fonts, "B", "Delivering account", 632);
  textField(form, page, fonts, "ACCOUNT TITLE_2", "Account title (as registered at the delivering firm)", LEFT, 600, 300);
  textField(form, page, fonts, "ACCOUNT NO", "Delivering account number", 352, 600, 110);
  textField(form, page, fonts, "BROKER CLEARING NO", "DTC / clearing number", 472, 600, 98);
  textField(form, page, fonts, "NAME OF FIRM", "Delivering firm", LEFT, 570, 300);
  textField(form, page, fonts, "FIRM ADDRESS", "Firm address", 352, 570, 218);
  textField(form, page, fonts, "CITY", "City", LEFT, 540, 200);
  textField(form, page, fonts, "STATE", "State", 252, 540, 60);
  textField(form, page, fonts, "ZIP", "ZIP", 322, 540, 80);

  sectionHeading(page, fonts, "C", "Transfer instructions (check one)", 516);
  TRANSFER_SELECTIONS.forEach(([name, caption], index) => {
    const x = index < 4 ? LEFT + 4 : 310;
    const y = 498 - (index % 4) * 14;
    checkBox(form, page, fonts, name, x, y, caption);
  });

  sectionHeading(page, fonts, "D", "Partial transfer: assets to move", 432);
  label(page, fonts, "Quantity", LEFT, 416, 7);
  label(page, fonts, "Asset description / symbol", 118, 416, 7);
  label(page, fonts, "In kind", 474, 416, 7);
  label(page, fonts, "Liquidate", 524, 416, 7);
  for (let row = 1; row <= 5; row += 1) {
    const y = 398 - (row - 1) * 17;
    const quantity = form.createTextField(`QUANTITYRow${row}`);
    quantity.addToPage(page, { x: LEFT, y, width: 70, height: 13, font: fonts.regular, textColor: INK, backgroundColor: FIELD_FILL, borderColor: FIELD_BORDER, borderWidth: 0.6 });
    quantity.setFontSize(8);
    const description = form.createTextField(`ASSETS DESCRIPTIONSYMBOLRow${row}`);
    description.addToPage(page, { x: 118, y, width: 344, height: 13, font: fonts.regular, textColor: INK, backgroundColor: FIELD_FILL, borderColor: FIELD_BORDER, borderWidth: 0.6 });
    description.setFontSize(8);
    checkBox(form, page, fonts, `TRANSFER-Transfer In Kind ${row}`, 480, y + 2);
    checkBox(form, page, fonts, `TRANSFER-Liquidate ${row}`, 534, y + 2);
  }

  sectionHeading(page, fonts, "E", "Mutual fund company transfer", 300);
  textField(form, page, fonts, "NAME OF FUND COMPANY", "Fund company", LEFT, 268, RIGHT - LEFT);
  label(page, fonts, "Fund name / symbol / CUSIP", LEFT, 246, 7);
  label(page, fonts, "Fund account number", 298, 246, 7);
  label(page, fonts, "Shares", 404, 246, 7);
  label(page, fonts, "In kind", 474, 246, 7);
  label(page, fonts, "Liquidate", 524, 246, 7);
  for (let row = 1; row <= 4; row += 1) {
    const y = 226 - (row - 1) * 40;
    const suffix = row === 1 ? "" : `_${row}`;
    const fund = form.createTextField(`FUND NAMESYMBOLCUSIPRow${row}`);
    fund.addToPage(page, { x: LEFT, y, width: 250, height: 13, font: fonts.regular, textColor: INK, backgroundColor: FIELD_FILL, borderColor: FIELD_BORDER, borderWidth: 0.6 });
    fund.setFontSize(7);
    const account = form.createTextField(`FUND ACCOUNT NOTransfer In Kind Liquidate${suffix}`);
    account.addToPage(page, { x: 298, y, width: 100, height: 13, font: fonts.regular, textColor: INK, backgroundColor: FIELD_FILL, borderColor: FIELD_BORDER, borderWidth: 0.6 });
    account.setFontSize(8);
    const shares = form.createTextField(` OF SHARESTransfer In Kind Liquidate${suffix}`);
    shares.addToPage(page, { x: 404, y, width: 60, height: 13, font: fonts.regular, textColor: INK, backgroundColor: FIELD_FILL, borderColor: FIELD_BORDER, borderWidth: 0.6 });
    shares.setFontSize(8);
    checkBox(form, page, fonts, `TRANSFER-Transfer In Kind ${row + 5}`, 480, y + 2);
    checkBox(form, page, fonts, `TRANSFER-Liquidate ${row + 5}`, 534, y + 2);

    const [dividendReinvest, dividendCash, gainsReinvest, gainsCash] = ELECTIONS[row - 1];
    const electionY = y - 16;
    label(page, fonts, "Future dividends:", LEFT + 4, electionY + 2, 6.5);
    checkBox(form, page, fonts, dividendReinvest, LEFT + 62, electionY, "Reinvest");
    checkBox(form, page, fonts, dividendCash, LEFT + 112, electionY, "Pay in cash");
    label(page, fonts, "Future capital gains:", 228, electionY + 2, 6.5);
    checkBox(form, page, fonts, gainsReinvest, 298, electionY, "Reinvest");
    checkBox(form, page, fonts, gainsCash, 348, electionY, "Pay in cash");
  }
}

function drawPageTwo(form: PDFForm, page: PDFPage, fonts: Fonts) {
  pageHeader(page, fonts, "Customer Account Transfer Request (continued)", 2);

  sectionHeading(page, fonts, "F", "Authorization", 700);
  let y = paragraph(page, fonts, [
    "I ask the delivering firm to transfer the assets described on page 1 to my account at Apex Clearing Corporation,",
    "and to cancel any open orders on those assets. I understand that assets the receiving firm cannot hold may be sold or",
    "returned, and that the delivering firm may charge a fee for the transfer. Every account owner must sign.",
  ], 680);
  y -= 26;
  signatureField(form, page, fonts, "PRIMARY SIGNATURE", "Account owner signature", LEFT, y, 300);
  textField(form, page, fonts, "DATE_2", "Date", 360, y, 100);
  y -= 46;
  signatureField(form, page, fonts, "JOINT SIGNATURE", "Joint owner signature (if any)", LEFT, y, 300);
  textField(form, page, fonts, "DATE_3", "Date", 360, y, 100);

  y -= 40;
  page.drawRectangle({ x: LEFT, y: y - 60, width: 220, height: 60, borderColor: FIELD_BORDER, borderWidth: 0.6 });
  label(page, fonts, "Medallion signature guarantee (only if the delivering firm requires one)", LEFT, y + 4);

  sectionHeading(page, fonts, "G", "Letter of authorization (only if the delivering firm requires one)", y - 84);
  y = paragraph(page, fonts, [
    "Please accept this letter as my instruction to deliver the account below to the receiving firm named here. This",
    "letter accompanies the transfer request and does not change its instructions.",
  ], y - 104);
  y -= 30;
  textField(form, page, fonts, "DELIVERING FIRM NAME", "Delivering firm", LEFT, y, 300);
  textField(form, page, fonts, "ACCOUNT NO_2", "Delivering account number", 360, y, 210);
  y -= 32;
  textField(form, page, fonts, "ACCOUNT TITLE_3", "Delivering account title", LEFT, y, RIGHT - LEFT);
  y -= 32;
  textField(form, page, fonts, "RECEIVING FIRM NAME", "Receiving firm", LEFT, y, 300);
  textField(form, page, fonts, "APEX CLEARING ACCOUNT NO_2", "Receiving account number", 360, y, 210);
  y -= 32;
  textField(form, page, fonts, "ACCOUNT TITLE_4", "Receiving account title", LEFT, y, RIGHT - LEFT);
  y -= 46;
  signatureField(form, page, fonts, "LOA CLIENT SIGNATURE", "Account owner signature", LEFT, y, 300);
  textField(form, page, fonts, "DATE_4", "Date", 360, y, 100);
  y -= 46;
  signatureField(form, page, fonts, "LOA RECEIVING FIRM SIGNATURE", "Authorized signer, receiving firm", LEFT, y, 300);
  textField(form, page, fonts, "DATE_5", "Date", 360, y, 100);
}

/** Build the template. The output is deterministic: no dates, ids or random names. */
export async function buildTransferFormTemplate(): Promise<Uint8Array> {
  const document = await PDFDocument.create({ updateMetadata: false });
  document.setTitle("Customer account transfer request to Apex Clearing (demo stand-in)");
  const fonts: Fonts = {
    regular: await document.embedFont(StandardFonts.Helvetica),
    bold: await document.embedFont(StandardFonts.HelveticaBold),
  };
  const form = document.getForm();
  drawPageOne(form, document.addPage([612, 792]), fonts);
  drawPageTwo(form, document.addPage([612, 792]), fonts);
  form.updateFieldAppearances(fonts.regular);
  return document.save({ useObjectStreams: false });
}
