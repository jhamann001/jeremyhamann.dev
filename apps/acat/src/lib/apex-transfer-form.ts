import {
  PDFDocument,
  PDFFont,
  PDFForm,
  StandardFonts,
  rgb,
} from "pdf-lib";
import { createPartialRowControls } from "./apex-partial-row-actions";
import type {
  ApexTransferSelection,
  AssetInstruction,
} from "./manual-transfer-forms";

export interface ApexTransferFormAsset {
  symbol?: string | null;
  description?: string | null;
  cusip?: string | null;
  expectedQty?: number | null;
  /** Required for every included asset in a mixed partial packet. */
  assetInstruction?: AssetInstruction;
}

export interface ApexTransferFormValues {
  generatedOn: Date;
  clientName: string;
  apexAccountNumber: string;
  apexAccountTitle: string;
  receivingAccountNumber?: string | null;
  transferringAccountNumber?: string | null;
  transferringAccountTitle?: string | null;
  deliveringFirmName: string;
  brokerClearingNumber?: string | null;
  apexTransferSelection: ApexTransferSelection;
  assetInstruction: AssetInstruction | "MIXED";
  letterOfAuthorizationRequired: boolean;
  assets: ApexTransferFormAsset[];
}

const TRANSFER_SELECTION_FIELDS: Record<ApexTransferSelection, string> = {
  BROKERAGE_FIRM_TRANSFER: "BROKERAGE FIRM TRANSFER",
  NON_ACAT_TRANSFER: "NON-ACAT TRANSFER",
  LIQUIDATE_ALL_ASSETS_TRANSFER_AS_CASH:
    "LIQUIDATE ALL ASSETS & TRANSFER AS CASH",
  LIQUIDATE_ANNUITY_TRANSFER_AS_CASH:
    "LIQUIDATE ANNUITY & TRANSFER AS CASH",
  PARTIAL_TRANSFER: "PARTIAL TRANSFER",
  LIQUIDATE_CDS_IMMEDIATELY:
    "LIQUIDATE CERTIFICATES OF DEPOSIT IMMEDIATELY",
  MUTUAL_FUND_COMPANY_TRANSFER: "MUTUAL FUND COMPANY TRANSFER",
  TRANSFER_CD_PROCEEDS_AT_MATURITY:
    "TRANSFER PROCEEDS OF CERTIFICATES OF DEPOSIT AT MATURITY",
};

const MUTUAL_FUND_ROW_COUNT = 4;
const PARTIAL_TRANSFER_ROW_COUNT = 5;
const APEX_RECEIVING_FIRM_NAME = "Apex Clearing Corporation";
const RECEIVING_ACCOUNT_NOTE_FIELD = "CEDAR_RIDGE RECEIVING OMNIBUS ACCOUNT";
const RECEIVING_ACCOUNT_NOTE_PREFIX = "APEX OMNIBUS / HOUSE ACCT:";
const MUTUAL_FUND_ELECTION_FIELDS = [
  "FUTURE DIVIDEND-Reinvest 1",
  "FUTURE CAPITAL GAINS-Reinvest 1",
  "FUTURE DIVIDEND-Pay In Cash 1",
  "FUTURE CAPITAL GAINS-Pay In Cash 1",
  "FUTURE DIVIDEND-Reinvest 2",
  "FUTURE CAPITAL GAINS-Reinvest 2",
  "FUTURE DIVIDEND-Pay In Cash 2",
  "FUTURE CAPITAL GAINS-Pay In Cash 2",
  "FUTURE DIVIDEND-Reinvest 3",
  "FUTURE CAPITAL GAINS-Reinvest 3",
  "FUTURE DIVIDEND- Pay In Cash 3",
  "FUTURE CAPITAL GAINS- Pay In Cash 3",
  "FUTURE DIVIDEND-Reinvest 4",
  "FUTURE CAPITAL GAINS-Reinvest 4",
  "FUTURE DIVIDEND-Pay In Cash 4",
  "FUTURE CAPITAL GAINS-Pay In Cash 4",
] as const;
const MUTUAL_FUND_PAY_IN_CASH_FIELDS = [
  [
    "FUTURE DIVIDEND-Pay In Cash 1",
    "FUTURE CAPITAL GAINS-Pay In Cash 1",
  ],
  [
    "FUTURE DIVIDEND-Pay In Cash 2",
    "FUTURE CAPITAL GAINS-Pay In Cash 2",
  ],
  [
    "FUTURE DIVIDEND- Pay In Cash 3",
    "FUTURE CAPITAL GAINS- Pay In Cash 3",
  ],
  [
    "FUTURE DIVIDEND-Pay In Cash 4",
    "FUTURE CAPITAL GAINS-Pay In Cash 4",
  ],
] as const;

function formatDate(value: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "2-digit",
    day: "2-digit",
    year: "numeric",
    timeZone: "America/New_York",
  }).format(value);
}

function formatAssetDescription(asset: ApexTransferFormAsset): string {
  const symbol = asset.symbol?.trim();
  const description = asset.description?.trim();
  const cusip = asset.cusip?.trim();
  // Match the Apex field label order: description first, then symbol. Slashes
  // keep the parts visually aligned with "ASSETS DESCRIPTION/SYMBOL".
  return [description, symbol, cusip ? `CUSIP ${cusip}` : ""]
    .filter(Boolean)
    .join(" / ");
}

function formatQuantity(value?: number | null): string {
  if (value == null || !Number.isFinite(value)) return "";
  return "All";
}

function rowInstruction(asset: ApexTransferFormAsset | undefined, packet: ApexTransferFormValues["assetInstruction"]): AssetInstruction | undefined {
  return packet === "MIXED" ? asset?.assetInstruction : packet;
}

function validateInstructions(values: ApexTransferFormValues): void {
  if (values.assetInstruction === "MIXED") {
    if (values.apexTransferSelection !== "PARTIAL_TRANSFER" || values.assets.length < 2 ||
      values.assets.some((asset) =>
        !["IN_KIND", "LIQUIDATE"].includes(asset.assetInstruction ?? "") ||
        !Boolean(asset.symbol?.trim() || asset.description?.trim() || asset.cusip?.trim())) ||
      new Set(values.assets.map((asset) => asset.assetInstruction)).size !== 2) {
      throw new Error("Mixed partial transfers require an explicit instruction for every asset and both directions.");
    }
  } else if (values.assets.some((asset) => asset.assetInstruction !== undefined && asset.assetInstruction !== values.assetInstruction)) {
    throw new Error("Asset instructions must match the packet instruction.");
  }
}

function setText(
  form: PDFForm,
  fieldName: string,
  value: string | null | undefined,
  fontSize = 8
): void {
  const field = form.getTextField(fieldName);
  field.setText(value?.trim() ?? "");
  field.setFontSize(fontSize);
}

function setChecked(
  form: PDFForm,
  fieldName: string,
  checked: boolean
): void {
  const field = form.getCheckBox(fieldName);
  if (checked) field.check();
  else field.uncheck();
}

function clearTransferSelections(form: PDFForm): void {
  for (const fieldName of Object.values(TRANSFER_SELECTION_FIELDS)) {
    setChecked(form, fieldName, false);
  }
}

function clearMutualFundElections(form: PDFForm): void {
  for (const fieldName of MUTUAL_FUND_ELECTION_FIELDS) {
    setChecked(form, fieldName, false);
  }
}

function fillLetterOfAuthorization(
  form: PDFForm,
  values: ApexTransferFormValues
): void {
  const required = values.letterOfAuthorizationRequired;
  setText(
    form,
    "DELIVERING FIRM NAME",
    required ? values.deliveringFirmName : ""
  );
  setText(
    form,
    "ACCOUNT NO_2",
    required ? values.transferringAccountNumber : ""
  );
  setText(
    form,
    "ACCOUNT TITLE_3",
    required ? values.transferringAccountTitle || values.clientName : ""
  );
  setText(
    form,
    "APEX CLEARING ACCOUNT NO_2",
    required ? values.apexAccountNumber : ""
  );
  setText(form, "ACCOUNT TITLE_4", required ? values.apexAccountTitle : "");
  setText(
    form,
    "RECEIVING FIRM NAME",
    required ? APEX_RECEIVING_FIRM_NAME : ""
  );

  // These dates accompany wet signatures and must be completed by the
  // signers, not inferred from the generation date.
  setText(form, "DATE_4", "");
  setText(form, "DATE_5", "");
}

function addReceivingAccountRoutingNote(
  document: PDFDocument,
  form: PDFForm,
  font: PDFFont,
  receivingAccountNumber?: string | null
): void {
  const accountNumber = receivingAccountNumber?.trim();
  if (!accountNumber) return;

  // The template has no dedicated omnibus/house-account field. Keep the
  // client's Apex account in both labeled Apex account fields, and add a
  // separate red routing note in the Mutual Fund Company Transfer header row.
  const companyField = form.getTextField("NAME OF FUND COMPANY");
  const companyWidget = companyField.acroField.getWidgets()[0];
  if (!companyWidget) return;

  const companyRect = companyWidget.getRectangle();
  const companyFieldWidth = 160;
  companyWidget.setRectangle({
    ...companyRect,
    width: companyFieldWidth,
  });

  const routingNote = form.createTextField(RECEIVING_ACCOUNT_NOTE_FIELD);
  routingNote.setText(`${RECEIVING_ACCOUNT_NOTE_PREFIX} ${accountNumber}`);
  routingNote.enableReadOnly();
  routingNote.addToPage(document.getPage(0), {
    x: companyRect.x + companyFieldWidth + 4,
    y: companyRect.y,
    width: companyRect.width - companyFieldWidth - 4,
    height: companyRect.height,
    textColor: rgb(1, 0, 0),
    borderWidth: 0,
    font,
  });
  routingNote.setFontSize(6.5);
}

function fillPartialTransferRows(
  form: PDFForm,
  assets: ApexTransferFormAsset[],
  instruction: ApexTransferFormValues["assetInstruction"]
): ApexTransferFormAsset[] {
  const usesAttachment = assets.length > PARTIAL_TRANSFER_ROW_COUNT;
  for (let index = 0; index < PARTIAL_TRANSFER_ROW_COUNT; index += 1) {
    const row = index + 1;
    const asset = usesAttachment ? undefined : assets[index];
    const attachmentReference = usesAttachment && index === 0;
    const assetInstruction = rowInstruction(asset, instruction);
    setText(
      form,
      `QUANTITYRow${row}`,
      formatQuantity(asset?.expectedQty)
    );
    setText(
      form,
      `ASSETS DESCRIPTIONSYMBOLRow${row}`,
      attachmentReference
        ? instruction === "MIXED" ? "See attached list - instructions per asset" : "See attached list"
        : asset
          ? formatAssetDescription(asset).slice(0, 100)
          : ""
    );
    setChecked(
      form,
      `TRANSFER-Transfer In Kind ${row}`,
      (Boolean(asset) || attachmentReference) && assetInstruction === "IN_KIND"
    );
    setChecked(
      form,
      `TRANSFER-Liquidate ${row}`,
      (Boolean(asset) || attachmentReference) && assetInstruction === "LIQUIDATE"
    );
  }
  return usesAttachment ? assets : [];
}

function fillMutualFundRows(
  form: PDFForm,
  assets: ApexTransferFormAsset[],
  values: ApexTransferFormValues
): ApexTransferFormAsset[] {
  setText(form, "NAME OF FUND COMPANY", values.deliveringFirmName);
  for (let index = 0; index < MUTUAL_FUND_ROW_COUNT; index += 1) {
    const row = index + 1;
    const checkboxRow = row + 5;
    const suffix = row === 1 ? "" : `_${row}`;
    const asset = assets[index];
    // When holdings have not synced yet, preselect the chosen instruction on
    // the first row so the generated form still reflects the workflow. Keep
    // the other unused rows clear until they contain an asset.
    const instructionApplies =
      Boolean(asset) || (index === 0 && assets.length === 0);
    setText(
      form,
      `FUND NAMESYMBOLCUSIPRow${row}`,
      asset ? formatAssetDescription(asset).slice(0, 100) : "",
      7
    );
    setText(
      form,
      `FUND ACCOUNT NOTransfer In Kind Liquidate${suffix}`,
      asset ? values.transferringAccountNumber : ""
    );
    setText(
      form,
      ` OF SHARESTransfer In Kind Liquidate${suffix}`,
      formatQuantity(asset?.expectedQty)
    );
    setChecked(
      form,
      `TRANSFER-Transfer In Kind ${checkboxRow}`,
      instructionApplies && values.assetInstruction === "IN_KIND"
    );
    setChecked(
      form,
      `TRANSFER-Liquidate ${checkboxRow}`,
      instructionApplies && values.assetInstruction === "LIQUIDATE"
    );
    for (const fieldName of MUTUAL_FUND_PAY_IN_CASH_FIELDS[index]) {
      setChecked(
        form,
        fieldName,
        instructionApplies && values.assetInstruction === "LIQUIDATE"
      );
    }
  }
  return assets.slice(MUTUAL_FUND_ROW_COUNT);
}

function drawOverflowPages(
  document: PDFDocument,
  font: PDFFont,
  assets: ApexTransferFormAsset[],
  values: ApexTransferFormValues
): void {
  const rowsPerPage = 32;
  const numberRows = values.apexTransferSelection === "PARTIAL_TRANSFER";
  const form = document.getForm();
  const controls = numberRows ? createPartialRowControls(document, font, assets.length) : null;
  const tableOffset = controls ? 16 : 0;
  for (let offset = 0; offset < assets.length; offset += rowsPerPage) {
    const page = document.addPage([612, 792]);
    const rows = assets.slice(offset, offset + rowsPerPage);
    page.drawText("CUSTOMER ACCOUNT TRANSFER REQUEST - ADDITIONAL ASSETS", {
      x: 42,
      y: 744,
      size: 13,
      font,
      color: rgb(0, 0, 0),
    });
    page.drawText(`Client: ${values.clientName}`, {
      x: 42,
      y: 720,
      size: 9,
      font,
    });
    page.drawText(`Delivering firm: ${values.deliveringFirmName}`, {
      x: 306,
      y: 720,
      size: 9,
      font,
    });
    if (numberRows) {
      page.drawText("#", { x: 26, y: 696 - tableOffset, size: 8, font });
    }
    controls?.addPageControls(page, Math.floor(offset / rowsPerPage) + 1);
    page.drawText("Quantity", { x: 42, y: 696 - tableOffset, size: 8, font });
    page.drawText("Asset description / symbol / CUSIP", {
      x: 112,
      y: 696 - tableOffset,
      size: 8,
      font,
    });
    page.drawText("Instruction", { x: 486, y: 696 - tableOffset, size: 8, font });
    page.drawLine({
      start: { x: numberRows ? 20 : 42, y: 690 - tableOffset },
      end: { x: 570, y: 690 - tableOffset },
      thickness: 0.75,
    });

    rows.forEach((asset, index) => {
      const y = 668 - tableOffset - index * 19;
      const row = offset + index + 1;
      controls?.addRemoveButton(page, row, y);
      const cells = [
        // Keep reference numbers editable too, so a cleared security does not
        // leave an unchangeable number behind. Existing field widths stay intact.
        ...(numberRows
          ? [{ name: "NUMBER", value: String(row), x: 20, width: 16 }]
          : []),
        {
          name: "QUANTITY",
          value: formatQuantity(asset.expectedQty),
          x: 42,
          width: 62,
        },
        {
          name: "DESCRIPTION",
          value: formatAssetDescription(asset),
          x: 112,
          width: 366,
        },
        {
          name: "INSTRUCTION",
          value: rowInstruction(asset, values.assetInstruction) === "LIQUIDATE" ? "Liquidate" : "In kind",
          x: 486,
          width: 84,
        },
      ];
      for (const cell of cells) {
        // Distinct fields across every attachment page keep edits on one
        // security from changing another. Do not draw fixed text underneath.
        const field = form.createTextField(
          `CEDAR_RIDGE ADDITIONAL ASSET ${row} ${cell.name}`
        );
        field.setText(cell.value);
        field.addToPage(page, {
          x: cell.x,
          y,
          width: cell.width,
          height: 14,
          font,
          textColor: rgb(0, 0, 0),
          backgroundColor: rgb(1, 1, 1),
          borderColor: rgb(0.8, 0.8, 0.8),
          borderWidth: 0.5,
        });
        // Fit the complete initial value instead of truncating identifiers.
        field.setFontSize(
          Math.min(
            8,
            (cell.width - 4) / Math.max(1, font.widthOfTextAtSize(cell.value, 1))
          )
        );
      }
    });

    page.drawText(
      `Attachment page ${Math.floor(offset / rowsPerPage) + 1}`,
      { x: 486, y: 30, size: 8, font }
    );
  }
}

/**
 * Populate only fields backed by the transfer record or explicitly confirmed
 * during generation. SSN/Tax ID, all signatures, and medallion remain blank
 * for the client or authorized signer. Liquidating mutual-fund rows direct
 * future distributions to cash; other elections remain blank.
 */
export async function fillApexTransferForm(
  templateBytes: Uint8Array,
  values: ApexTransferFormValues
): Promise<Uint8Array> {
  validateInstructions(values);
  const document = await PDFDocument.load(templateBytes);
  const form = document.getForm();
  const font = await document.embedFont(StandardFonts.Helvetica);

  setText(form, "DATE", formatDate(values.generatedOn));
  setText(form, "ACCOUNT TITLE", values.apexAccountTitle);
  setText(form, "APEX CLEARING ACCOUNT NO", values.apexAccountNumber);
  // Explicitly clear this field even if a future template accidentally ships
  // with a saved value. The client always completes it themselves.
  setText(form, "SSNTAX ID NO", "");
  setText(
    form,
    "ACCOUNT TITLE_2",
    values.transferringAccountTitle || values.clientName
  );
  setText(form, "BROKER CLEARING NO", values.brokerClearingNumber);
  setText(form, "ACCOUNT NO", values.transferringAccountNumber);
  setText(form, "NAME OF FIRM", values.deliveringFirmName);
  // The tracker has no client-specific delivering address. Historical
  // addresses are suggestions only, so these fields deliberately stay blank.
  setText(form, "FIRM ADDRESS", "");
  setText(form, "CITY", "");
  setText(form, "STATE", "");
  setText(form, "ZIP", "");

  // The Custodian Library decides whether this section is required. Populate
  // only record-backed identity fields; all client and Apex signatures remain
  // blank for wet signing where required.
  fillLetterOfAuthorization(form, values);

  clearTransferSelections(form);
  clearMutualFundElections(form);
  setChecked(
    form,
    TRANSFER_SELECTION_FIELDS[values.apexTransferSelection],
    true
  );

  addReceivingAccountRoutingNote(
    document,
    form,
    font,
    values.receivingAccountNumber
  );

  const assets = values.assets.filter(
    (asset) =>
      Boolean(asset.symbol?.trim() || asset.description?.trim() || asset.cusip?.trim())
  );
  let overflow: ApexTransferFormAsset[] = [];
  if (values.apexTransferSelection === "PARTIAL_TRANSFER") {
    overflow = fillPartialTransferRows(form, assets, values.assetInstruction);
  } else if (
    values.apexTransferSelection === "MUTUAL_FUND_COMPANY_TRANSFER"
  ) {
    overflow = fillMutualFundRows(form, assets, values);
  }

  if (overflow.length > 0) {
    drawOverflowPages(document, font, overflow, values);
  }

  form.updateFieldAppearances(font);
  return document.save();
}
