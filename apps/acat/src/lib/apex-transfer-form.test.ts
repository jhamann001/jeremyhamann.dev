// @vitest-environment node

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createContext, runInContext } from "node:vm";
import { PDFArray, PDFCheckBox, PDFDict, PDFDocument, PDFHexString, PDFName, PDFPage, PDFSignature, PDFTextField } from "pdf-lib";
import { describe, expect, it, vi } from "vitest";
import { PARTIAL_ROW_COUNT_FIELD } from "./apex-partial-row-actions";
import {
  fillApexTransferForm,
  type ApexTransferFormValues,
} from "./apex-transfer-form";

const templatePath = join(
  process.cwd(),
  "public/form-templates/apex-customer-account-transfer-request.pdf"
);

function activatePdfActions(document: PDFDocument) {
  const form = document.getForm();
  const getField = (name: string) => {
    const field = form.getFieldMaybe(name);
    if (!field) return null;
    const widgets = field.acroField.getWidgets();
    return {
      get valueAsString() { return field instanceof PDFTextField ? field.getText() ?? "" : ""; },
      set value(value: string) { if (field instanceof PDFTextField) field.setText(value); },
      textSize: 8,
      get display() {
        const flags = widgets[0].getFlags();
        return flags & 2 ? 1 : flags & 4 ? 0 : 2;
      },
      set display(value: number) {
        for (const widget of widgets) {
          widget.setFlagTo(2, value === 1);
          widget.setFlagTo(4, value === 0);
        }
      },
    };
  };
  const names = document.catalog.lookup(PDFName.of("Names"), PDFDict);
  const scripts = names.lookup(PDFName.of("JavaScript"), PDFDict).lookup(PDFName.of("Names"), PDFArray);
  const script = scripts.lookup(1, PDFDict).lookup(PDFName.of("JS"), PDFHexString).decodeText();
  const context = createContext({ getField, app: { alert: () => 4 } });
  runInContext(script, context);
  return (name: string) => {
    const widget = form.getButton(name).acroField.getWidgets()[0];
    const action = widget.dict.lookup(PDFName.of("A"), PDFDict);
    expect(action.lookup(PDFName.of("S"), PDFName).toString()).toBe("/JavaScript");
    runInContext(action.lookup(PDFName.of("JS"), PDFHexString).decodeText(), context);
  };
}

const baseValues: ApexTransferFormValues = {
  generatedOn: new Date("2026-09-03T12:00:00Z"),
  clientName: "Example Client",
  apexAccountNumber: "ABC1234",
  apexAccountTitle: "Example Client - Traditional IRA",
  transferringAccountNumber: "ALD9876",
  deliveringFirmName: "T. Rowe Price",
  brokerClearingNumber: "0443",
  apexTransferSelection: "MUTUAL_FUND_COMPANY_TRANSFER",
  assetInstruction: "IN_KIND",
  letterOfAuthorizationRequired: true,
  assets: [
    {
      symbol: "PRWCX",
      description: "T. Rowe Price Capital Appreciation Fund",
      cusip: "74144Q104",
      expectedQty: 125.5,
    },
  ],
};

async function loadGenerated(
  overrides: Partial<typeof baseValues> = {}
): Promise<PDFDocument> {
  const template = await readFile(templatePath);
  const output = await fillApexTransferForm(template, {
    ...baseValues,
    ...overrides,
  });
  return PDFDocument.load(output);
}

describe("fillApexTransferForm", () => {
  it("fills record-backed fields and the selected mutual-fund instruction", async () => {
    const document = await loadGenerated();
    const form = document.getForm();

    expect(form.getTextField("DATE").getText()).toBe("09/03/2026");
    expect(form.getTextField("ACCOUNT TITLE").getText()).toBe(
      "Example Client - Traditional IRA"
    );
    expect(form.getTextField("APEX CLEARING ACCOUNT NO").getText()).toBe(
      "ABC1234"
    );
    expect(form.getTextField("BROKER CLEARING NO").getText()).toBe("0443");
    expect(form.getTextField("NAME OF FIRM").getText()).toBe("T. Rowe Price");
    expect(
      form.getCheckBox("MUTUAL FUND COMPANY TRANSFER").isChecked()
    ).toBe(true);
    expect(form.getCheckBox("TRANSFER-Transfer In Kind 6").isChecked()).toBe(
      true
    );
    expect(form.getCheckBox("TRANSFER-Liquidate 6").isChecked()).toBe(false);
    expect(form.getTextField("FUND NAMESYMBOLCUSIPRow1").getText()).toBe(
      "T. Rowe Price Capital Appreciation Fund / PRWCX / CUSIP 74144Q104"
    );
    expect(form.getTextField(" OF SHARESTransfer In Kind Liquidate").getText()).toBe(
      "All"
    );
    expect(form.getTextField("DELIVERING FIRM NAME").getText()).toBe(
      "T. Rowe Price"
    );
    expect(form.getTextField("ACCOUNT NO_2").getText()).toBe("ALD9876");
    expect(form.getTextField("ACCOUNT TITLE_3").getText()).toBe(
      "Example Client"
    );
    expect(form.getTextField("APEX CLEARING ACCOUNT NO_2").getText()).toBe(
      "ABC1234"
    );
    expect(form.getTextField("ACCOUNT TITLE_4").getText()).toBe(
      "Example Client - Traditional IRA"
    );
    expect(form.getTextField("RECEIVING FIRM NAME").getText()).toBe(
      "Apex Clearing Corporation"
    );
    expect(
      form.getFieldMaybe("CEDAR_RIDGE RECEIVING OMNIBUS ACCOUNT")
    ).toBeUndefined();
    expect(form.getTextField("DATE_4").getText() ?? "").toBe("");
    expect(form.getTextField("DATE_5").getText() ?? "").toBe("");
  });

  it("always leaves SSN, addresses, signatures, and elections blank", async () => {
    const document = await loadGenerated();
    const form = document.getForm();

    expect(form.getTextField("SSNTAX ID NO").getText() ?? "").toBe("");
    expect(form.getTextField("FIRM ADDRESS").getText() ?? "").toBe("");
    expect(form.getTextField("CITY").getText() ?? "").toBe("");
    expect(form.getTextField("STATE").getText() ?? "").toBe("");
    expect(form.getTextField("ZIP").getText() ?? "").toBe("");
    expect(form.getField("PRIMARY SIGNATURE")).toBeInstanceOf(PDFSignature);
    expect(
      form.getCheckBox("FUTURE DIVIDEND-Reinvest 1").isChecked()
    ).toBe(false);
    expect(
      form.getCheckBox("FUTURE CAPITAL GAINS-Pay In Cash 1").isChecked()
    ).toBe(false);
  });

  it("keeps the client Apex account and adds a separate Victory omnibus routing note", async () => {
    const document = await loadGenerated({
      deliveringFirmName: "Victory Funds",
      receivingAccountNumber: "DEMOOMNI01",
      assetInstruction: "LIQUIDATE",
      assets: [
        { symbol: "A", expectedQty: 1 },
        { symbol: "B", expectedQty: 2 },
      ],
    });
    const form = document.getForm();

    expect(form.getCheckBox("TRANSFER-Liquidate 6").isChecked()).toBe(true);
    expect(form.getCheckBox("TRANSFER-Liquidate 7").isChecked()).toBe(true);
    expect(form.getCheckBox("TRANSFER-Transfer In Kind 6").isChecked()).toBe(
      false
    );
    expect(
      form.getCheckBox("FUTURE DIVIDEND-Pay In Cash 1").isChecked()
    ).toBe(true);
    expect(
      form.getCheckBox("FUTURE CAPITAL GAINS-Pay In Cash 1").isChecked()
    ).toBe(true);
    expect(
      form.getCheckBox("FUTURE DIVIDEND-Pay In Cash 2").isChecked()
    ).toBe(true);
    expect(
      form.getCheckBox("FUTURE CAPITAL GAINS-Pay In Cash 2").isChecked()
    ).toBe(true);
    expect(
      form.getCheckBox("FUTURE DIVIDEND-Reinvest 1").isChecked()
    ).toBe(false);
    expect(form.getTextField("APEX CLEARING ACCOUNT NO").getText()).toBe(
      "ABC1234"
    );
    expect(form.getTextField("APEX CLEARING ACCOUNT NO_2").getText()).toBe(
      "ABC1234"
    );
    const routingNote = form.getTextField(
      "CEDAR_RIDGE RECEIVING OMNIBUS ACCOUNT"
    );
    expect(routingNote.getText()).toBe(
      "APEX OMNIBUS / HOUSE ACCT: DEMOOMNI01"
    );
    expect(routingNote.isReadOnly()).toBe(true);
    expect(routingNote.acroField.getDefaultAppearance()).toContain("1 0 0 rg");
  });

  it("keeps Victory liquidation and cash elections visible before holdings sync", async () => {
    const document = await loadGenerated({
      deliveringFirmName: "Victory Funds",
      receivingAccountNumber: "DEMOOMNI01",
      assetInstruction: "LIQUIDATE",
      assets: [],
    });
    const form = document.getForm();

    expect(form.getCheckBox("TRANSFER-Liquidate 6").isChecked()).toBe(true);
    expect(
      form.getCheckBox("FUTURE DIVIDEND-Pay In Cash 1").isChecked()
    ).toBe(true);
    expect(
      form.getCheckBox("FUTURE CAPITAL GAINS-Pay In Cash 1").isChecked()
    ).toBe(true);
    expect(form.getCheckBox("TRANSFER-Liquidate 7").isChecked()).toBe(false);
    expect(
      form.getCheckBox("FUTURE DIVIDEND-Pay In Cash 2").isChecked()
    ).toBe(false);
  });

  it("leaves the Letter of Authorization identity fields blank when it is not required", async () => {
    const document = await loadGenerated({
      letterOfAuthorizationRequired: false,
    });
    const form = document.getForm();

    for (const fieldName of [
      "DELIVERING FIRM NAME",
      "ACCOUNT NO_2",
      "ACCOUNT TITLE_3",
      "APEX CLEARING ACCOUNT NO_2",
      "ACCOUNT TITLE_4",
      "RECEIVING FIRM NAME",
    ]) {
      expect(form.getTextField(fieldName).getText() ?? "").toBe("");
    }
  });

  it("adds an overflow asset page instead of dropping holdings", async () => {
    const assets = Array.from({ length: 6 }, (_, index) => ({
      symbol: `FUND${index + 1}`,
      expectedQty: index + 1,
    }));
    const document = await loadGenerated({ assets });

    expect(document.getPageCount()).toBe(3);
    const form = document.getForm();
    expect(form.getTextField("FUND NAMESYMBOLCUSIPRow4").getText()).toContain(
      "FUND4"
    );
  });

  it("keeps five or fewer partial holdings together on the form", async () => {
    const assets = Array.from({ length: 5 }, (_, index) => ({
      symbol: `ASSET${index + 1}`,
      description: `Asset ${index + 1}`,
      expectedQty: index + 1,
    }));
    const document = await loadGenerated({
      apexTransferSelection: "PARTIAL_TRANSFER",
      assets,
    });
    const form = document.getForm();

    expect(document.getPageCount()).toBe(2);
    expect(form.getTextField("ASSETS DESCRIPTIONSYMBOLRow1").getText()).toBe(
      "Asset 1 / ASSET1"
    );
    expect(form.getTextField("QUANTITYRow1").getText()).toBe("All");
    expect(form.getTextField("ASSETS DESCRIPTIONSYMBOLRow5").getText()).toBe(
      "Asset 5 / ASSET5"
    );
  });

  it("moves every partial holding to an attachment when there are more than five", async () => {
    const assets = Array.from({ length: 6 }, (_, index) => ({
      symbol: `ASSET${index + 1}`,
      description: `Asset ${index + 1}`,
      expectedQty: index + 1,
    }));
    const document = await loadGenerated({
      apexTransferSelection: "PARTIAL_TRANSFER",
      assets,
    });
    const form = document.getForm();

    expect(document.getPageCount()).toBe(3);
    expect(form.getTextField("ASSETS DESCRIPTIONSYMBOLRow1").getText()).toBe(
      "See attached list"
    );
    expect(form.getTextField("QUANTITYRow1").getText() ?? "").toBe("");
    expect(form.getCheckBox("TRANSFER-Transfer In Kind 1").isChecked()).toBe(true);
    expect(form.getCheckBox("TRANSFER-Liquidate 1").isChecked()).toBe(false);
    for (let row = 2; row <= 5; row += 1) {
      expect(form.getTextField(`QUANTITYRow${row}`).getText() ?? "").toBe("");
      expect(
        form.getTextField(`ASSETS DESCRIPTIONSYMBOLRow${row}`).getText() ?? ""
      ).toBe("");
      expect(
        form.getCheckBox(`TRANSFER-Transfer In Kind ${row}`).isChecked()
      ).toBe(false);
      expect(form.getCheckBox(`TRANSFER-Liquidate ${row}`).isChecked()).toBe(false);
    }
  });

  it("fills separate in-kind and liquidation choices on actual partial template rows", async () => {
    const document = await loadGenerated({ apexTransferSelection: "PARTIAL_TRANSFER", assetInstruction: "MIXED",
      assets: [
        { symbol: "KEEP", expectedQty: 12.5, assetInstruction: "IN_KIND" },
        { symbol: "SELL", expectedQty: 8, assetInstruction: "LIQUIDATE" },
      ] });
    const form = document.getForm();
    expect(document.getPageCount()).toBe(2);
    expect(form.getCheckBox("PARTIAL TRANSFER").isChecked()).toBe(true);
    expect(form.getCheckBox("LIQUIDATE ALL ASSETS & TRANSFER AS CASH").isChecked()).toBe(false);
    expect(form.getTextField("ASSETS DESCRIPTIONSYMBOLRow1").getText()).toBe("KEEP");
    expect(form.getTextField("ASSETS DESCRIPTIONSYMBOLRow2").getText()).toBe("SELL");
    for (let row = 1; row <= 5; row += 1) {
      expect(form.getCheckBox(`TRANSFER-Transfer In Kind ${row}`).isChecked()).toBe(row === 1);
      expect(form.getCheckBox(`TRANSFER-Liquidate ${row}`).isChecked()).toBe(row === 2);
      expect(form.getTextField(`QUANTITYRow${row}`).getText() ?? "").toBe(row <= 2 ? "All" : "");
    }
  });

  it("keeps mixed attachment instructions with each holding across pages, removal and undo", async () => {
    const assets = Array.from({ length: 34 }, (_, index) => ({ symbol: `ASSET${index + 1}`, expectedQty: index + 1,
      assetInstruction: index % 2 === 0 ? "IN_KIND" as const : "LIQUIDATE" as const }));
    const document = await loadGenerated({ apexTransferSelection: "PARTIAL_TRANSFER", assetInstruction: "MIXED", assets });
    const form = document.getForm();
    expect(document.getPageCount()).toBe(4);
    expect(form.getTextField("ASSETS DESCRIPTIONSYMBOLRow1").getText()).toBe("See attached list - instructions per asset");
    for (let row = 1; row <= 5; row += 1) {
      expect(form.getCheckBox(`TRANSFER-Transfer In Kind ${row}`).isChecked()).toBe(false);
      expect(form.getCheckBox(`TRANSFER-Liquidate ${row}`).isChecked()).toBe(false);
    }
    for (let row = 1; row <= 34; row += 1) {
      expect(form.getTextField(`CEDAR_RIDGE ADDITIONAL ASSET ${row} DESCRIPTION`).getText()).toBe(`ASSET${row}`);
      expect(form.getTextField(`CEDAR_RIDGE ADDITIONAL ASSET ${row} QUANTITY`).getText()).toBe("All");
      expect(form.getTextField(`CEDAR_RIDGE ADDITIONAL ASSET ${row} INSTRUCTION`).getText()).toBe(row % 2 === 1 ? "In kind" : "Liquidate");
    }
    const act = activatePdfActions(document);
    act("CEDAR_RIDGE PARTIAL REMOVE 32");
    expect(form.getTextField("CEDAR_RIDGE ADDITIONAL ASSET 32 DESCRIPTION").getText()).toBe("ASSET33");
    expect(form.getTextField("CEDAR_RIDGE ADDITIONAL ASSET 32 INSTRUCTION").getText()).toBe("In kind");
    const reopened = await PDFDocument.load(await document.save());
    const saved = reopened.getForm();
    expect(saved.getTextField("CEDAR_RIDGE ADDITIONAL ASSET 33 DESCRIPTION").getText()).toBe("ASSET34");
    expect(saved.getTextField("CEDAR_RIDGE ADDITIONAL ASSET 33 INSTRUCTION").getText()).toBe("Liquidate");
    const reopenedAct = activatePdfActions(reopened);
    // Undo state is session-local; a subsequent remove/undo keeps directions paired.
    reopenedAct("CEDAR_RIDGE PARTIAL REMOVE 32");
    reopenedAct("CEDAR_RIDGE PARTIAL UNDO 1");
    expect(saved.getTextField("CEDAR_RIDGE ADDITIONAL ASSET 32 DESCRIPTION").getText()).toBe("ASSET33");
    expect(saved.getTextField("CEDAR_RIDGE ADDITIONAL ASSET 32 INSTRUCTION").getText()).toBe("In kind");
  });

  it.each<Partial<ApexTransferFormValues>>([
    { apexTransferSelection: "BROKERAGE_FIRM_TRANSFER" },
    { apexTransferSelection: "MUTUAL_FUND_COMPANY_TRANSFER" },
    { assets: [{ symbol: "MISSING", expectedQty: 1 }, { symbol: "SELL", assetInstruction: "LIQUIDATE" }] },
    { assets: [{ symbol: "ONE", assetInstruction: "IN_KIND" }, { symbol: "TWO", assetInstruction: "IN_KIND" }] },
    { assets: [{ symbol: "ONE", assetInstruction: "IN_KIND" }, { assetInstruction: "LIQUIDATE" }] },
  ])("rejects mixed renderer input that cannot express every asset unambiguously", async (overrides) => {
    await expect(loadGenerated({ apexTransferSelection: "PARTIAL_TRANSFER", assetInstruction: "MIXED",
      assets: [{ symbol: "KEEP", assetInstruction: "IN_KIND" }, { symbol: "SELL", assetInstruction: "LIQUIDATE" }],
      ...overrides })).rejects.toThrow("Mixed partial transfers require");
  });

  it("rejects a per-asset override contradicting a single packet instruction", async () => {
    await expect(loadGenerated({ apexTransferSelection: "PARTIAL_TRANSFER", assetInstruction: "IN_KIND",
      assets: [{ symbol: "SELL", assetInstruction: "LIQUIDATE" }] })).rejects.toThrow("Asset instructions must match");
  });

  it("keeps partial attachment numbers sequential, editable, and separate from security details", async () => {
    const drawText = vi.spyOn(PDFPage.prototype, "drawText");
    try {
      const assets = Array.from({ length: 78 }, (_, index) => ({
        symbol: `ASSET${index + 1}`,
        description: `Asset ${index + 1}`,
        expectedQty: index + 1,
      }));
      const document = await loadGenerated({
        apexTransferSelection: "PARTIAL_TRANSFER",
        assets,
      });
      const form = document.getForm();
      expect(drawText.mock.calls.filter(([text]) => text === "#")).toHaveLength(3);
      // No fixed number underneath the field that could reappear after clearing it.
      expect(drawText.mock.calls.filter(([text]) => /^\d+$/.test(text))).toHaveLength(0);
      for (let index = 0; index < assets.length; index += 1) {
        const row = index + 1;
        const number = form.getTextField(`CEDAR_RIDGE ADDITIONAL ASSET ${row} NUMBER`);
        const widget = number.acroField.getWidgets()[0];
        const numberBounds = widget.getRectangle();
        const quantity = form.getTextField(`CEDAR_RIDGE ADDITIONAL ASSET ${row} QUANTITY`);
        const bounds = quantity.acroField.getWidgets()[0].getRectangle();
        expect(number.getText()).toBe(String(row));
        expect(number.isReadOnly()).toBe(false);
        expect(widget.P()).toEqual(document.getPage(2 + Math.floor(index / 32)).ref);
        expect(numberBounds.x + numberBounds.width).toBeLessThan(bounds.x);
        expect(numberBounds.y).toBe(bounds.y);
        expect(numberBounds.height).toBe(bounds.height);
        expect(quantity.isReadOnly()).toBe(false);
        expect(form.getTextField(`CEDAR_RIDGE ADDITIONAL ASSET ${row} DESCRIPTION`).getText()).toBe(
          `Asset ${row} / ASSET${row}`
        );
      }
    } finally {
      drawText.mockRestore();
    }
  });

  it("preserves a manually cleared row and renumbered securities after saving and reopening", async () => {
    const document = await loadGenerated({
      apexTransferSelection: "PARTIAL_TRANSFER",
      assets: Array.from({ length: 78 }, (_, index) => ({
        symbol: `ASSET${index + 1}`,
        expectedQty: index + 1,
      })),
    });
    const form = document.getForm();
    const fieldName = (row: number, column: string) =>
      `CEDAR_RIDGE ADDITIONAL ASSET ${row} ${column}`;

    for (const column of ["NUMBER", "QUANTITY", "DESCRIPTION", "INSTRUCTION"]) {
      form.getTextField(fieldName(32, column)).setText("");
    }
    for (let row = 33; row <= 78; row += 1) {
      form.getTextField(fieldName(row, "NUMBER")).setText(String(row - 1));
    }

    const reopened = (await PDFDocument.load(await document.save())).getForm();
    for (const column of ["NUMBER", "QUANTITY", "DESCRIPTION", "INSTRUCTION"]) {
      expect(reopened.getTextField(fieldName(32, column)).getText() ?? "").toBe("");
    }
    expect(reopened.getTextField(fieldName(31, "NUMBER")).getText()).toBe("31");
    for (let row = 33; row <= 78; row += 1) {
      expect(reopened.getTextField(fieldName(row, "NUMBER")).getText()).toBe(String(row - 1));
      expect(reopened.getTextField(fieldName(row, "DESCRIPTION")).getText()).toBe(`ASSET${row}`);
    }
  });

  it("saves automatic removals and continues correctly after reopening the PDF", async () => {
    const document = await loadGenerated({
      apexTransferSelection: "PARTIAL_TRANSFER",
      assets: Array.from({ length: 78 }, (_, index) => ({ symbol: `ASSET${index + 1}`, expectedQty: 1 })),
    });
    const form = document.getForm();
    const act = activatePdfActions(document);
    form.getTextField("CEDAR_RIDGE ADDITIONAL ASSET 33 QUANTITY").setText("12.50");
    form.getTextField("CEDAR_RIDGE ADDITIONAL ASSET 33 INSTRUCTION").setText("Liquidate");
    act("CEDAR_RIDGE PARTIAL REMOVE 32");

    const reopened = await PDFDocument.load(await document.save());
    const saved = reopened.getForm();
    expect(saved.getTextField(PARTIAL_ROW_COUNT_FIELD).getText()).toBe("77");
    expect(saved.getTextField("CEDAR_RIDGE ADDITIONAL ASSET 32 DESCRIPTION").getText()).toBe("ASSET33");
    expect(saved.getTextField("CEDAR_RIDGE ADDITIONAL ASSET 32 NUMBER").getText()).toBe("32");
    expect(saved.getTextField("CEDAR_RIDGE ADDITIONAL ASSET 32 QUANTITY").getText()).toBe("12.50");
    expect(saved.getTextField("CEDAR_RIDGE ADDITIONAL ASSET 32 INSTRUCTION").getText()).toBe("Liquidate");
    const last = saved.getTextField("CEDAR_RIDGE ADDITIONAL ASSET 78 DESCRIPTION");
    expect(last.getText() ?? "").toBe("");
    expect(last.acroField.getWidgets()[0].getFlags() & 2).toBe(2);
    expect(saved.getTextField("ACCOUNT TITLE").getText()).toBe(baseValues.apexAccountTitle);
    expect(saved.getTextField("ASSETS DESCRIPTIONSYMBOLRow1").getText()).toBe("See attached list");
    expect(saved.getTextField("QUANTITYRow1").getText() ?? "").toBe("");

    const reopenedAct = activatePdfActions(reopened);
    reopenedAct("CEDAR_RIDGE PARTIAL REMOVE 32");
    expect(saved.getTextField(PARTIAL_ROW_COUNT_FIELD).getText()).toBe("76");
    expect(saved.getTextField("CEDAR_RIDGE ADDITIONAL ASSET 32 DESCRIPTION").getText()).toBe("ASSET34");
    reopenedAct("CEDAR_RIDGE PARTIAL UNDO 2");
    expect(saved.getTextField("CEDAR_RIDGE ADDITIONAL ASSET 32 DESCRIPTION").getText()).toBe("ASSET33");
    expect(saved.getTextField(PARTIAL_ROW_COUNT_FIELD).getText()).toBe("77");
  });

  it("keeps removal controls out of printouts and off other form workflows", async () => {
    const document = await loadGenerated({
      apexTransferSelection: "PARTIAL_TRANSFER",
      assets: Array.from({ length: 78 }, (_, index) => ({ symbol: `ASSET${index + 1}`, expectedQty: 1 })),
    });
    const controls = document.getForm().getFields().filter((field) =>
      /^CEDAR_RIDGE PARTIAL (REMOVE|UNDO|EDIT HELP) /.test(field.getName())
    );
    expect(controls).toHaveLength(78 + 3 + 3);
    for (const field of controls) {
      expect(field.acroField.getWidgets()[0].getFlags() & 4).toBe(0);
    }
    const mutual = await loadGenerated({ assets: Array.from({ length: 6 }, (_, index) => ({ symbol: `FUND${index}`, expectedQty: 1 })) });
    expect(mutual.getForm().getFieldMaybe(PARTIAL_ROW_COUNT_FIELD)).toBeUndefined();
    expect(mutual.getForm().getFields().some((field) => field.getName().startsWith("CEDAR_RIDGE PARTIAL REMOVE"))).toBe(false);
  });

  it.each([
    { selection: "PARTIAL_TRANSFER" as const, count: 78, firstAttached: 1, pages: 5 },
    { selection: "MUTUAL_FUND_COMPANY_TRANSFER" as const, count: 6, firstAttached: 5, pages: 3 },
  ])("keeps $selection attachment fields editable after saving and reopening", async ({ selection, count, firstAttached, pages }) => {
    const description = "A security with a long description that must remain complete when edited, including its full fund name and share class";
    const assets = Array.from({ length: count }, (_, index) => ({
      symbol: `ASSET${index + 1}`,
      description,
      cusip: "123456789",
      expectedQty: index + 1,
    }));
    const document = await loadGenerated({ apexTransferSelection: selection, assets });
    const form = document.getForm();
    const attachedCount = count - firstAttached + 1;
    const fieldName = (row: number, column: string) =>
      `CEDAR_RIDGE ADDITIONAL ASSET ${row} ${column}`;

    expect(document.getPageCount()).toBe(pages);
    const columns = selection === "PARTIAL_TRANSFER"
      ? ["NUMBER", "QUANTITY", "DESCRIPTION", "INSTRUCTION"]
      : ["QUANTITY", "DESCRIPTION", "INSTRUCTION"];
    expect(form.getFields().filter((field) => field.getName().startsWith("CEDAR_RIDGE ADDITIONAL ASSET "))).toHaveLength(attachedCount * columns.length);
    for (let row = 1; row <= attachedCount; row += 1) {
      for (const column of columns) {
        const field = form.getTextField(fieldName(row, column));
        expect(field).toBeInstanceOf(PDFTextField);
        expect(field.isReadOnly()).toBe(false);
        expect(field.acroField.getWidgets()[0].P()).toEqual(
          document.getPage(2 + Math.floor((row - 1) / 32)).ref
        );
      }
      expect(form.getTextField(fieldName(row, "QUANTITY")).getText()).toBe("All");
      expect(form.getTextField(fieldName(row, "DESCRIPTION")).getText()).toBe(
        `${description} / ASSET${firstAttached + row - 1} / CUSIP 123456789`
      );
      expect(form.getTextField(fieldName(row, "INSTRUCTION")).getText()).toBe("In kind");
    }

    form.getTextField(fieldName(1, "QUANTITY")).setText("12.5");
    form.getTextField(fieldName(1, "DESCRIPTION")).setText("Corrected security / NEW");
    form.getTextField(fieldName(1, "INSTRUCTION")).setText("Liquidate");
    form.getTextField(fieldName(attachedCount, "QUANTITY")).setText("25");

    const reopened = (await PDFDocument.load(await document.save())).getForm();
    expect(reopened.getTextField(fieldName(1, "QUANTITY")).getText()).toBe("12.5");
    expect(reopened.getTextField(fieldName(1, "DESCRIPTION")).getText()).toBe("Corrected security / NEW");
    expect(reopened.getTextField(fieldName(1, "INSTRUCTION")).getText()).toBe("Liquidate");
    expect(reopened.getTextField(fieldName(attachedCount, "QUANTITY")).getText()).toBe("25");
    if (attachedCount > 2) {
      expect(reopened.getTextField(fieldName(2, "QUANTITY")).getText()).toBe("All");
      expect(reopened.getTextField(fieldName(33, "QUANTITY")).getText()).toBe("All");
    }
  });

  it("preserves fillable checkboxes after generation", async () => {
    const document = await loadGenerated();
    expect(
      document.getForm().getField("TRANSFER-Liquidate 6")
    ).toBeInstanceOf(PDFCheckBox);
  });
});
