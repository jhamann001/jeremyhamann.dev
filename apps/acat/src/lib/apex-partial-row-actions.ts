import { PDFDocument, PDFFont, PDFHexString, PDFName, PDFPage, rgb } from "pdf-lib";

export const PARTIAL_ROW_COUNT_FIELD = "CEDAR_RIDGE PARTIAL ACTIVE ROW COUNT";
const PRINT_FLAG = 4;

/**
 * Runs inside the PDF viewer, not the tracker. Never embeds client data in code.
 * Compacts editable fields within the existing pages; it does not delete pages.
 * Removed-row undo history lives only in viewer memory, not in the saved PDF.
 */
export function buildPartialRowScript(capacity: number): string {
  if (!Number.isSafeInteger(capacity) || capacity < 1) {
    throw new Error("Invalid partial-transfer row capacity");
  }
  // Use the common Acrobat/PDFium API and ES5 syntax for PDF viewer compatibility.
  return `
var cedarRidgeRemovedSecurities = [];
function cedarRidgeReadRows(doc) {
  var counter = doc.getField("${PARTIAL_ROW_COUNT_FIELD}");
  var count = counter && Number(counter.valueAsString);
  if (!counter || count < 1 || count > ${capacity} || count !== Math.floor(count)) {
    throw new Error("The securities list could not be read. No row was removed.");
  }
  var columns = ["NUMBER", "QUANTITY", "DESCRIPTION", "INSTRUCTION"];
  var slots = [], rows = [];
  for (var i = 1; i <= ${capacity}; i++) {
    var fields = [], cells = [];
    for (var j = 0; j < columns.length; j++) {
      var field = doc.getField("CEDAR_RIDGE ADDITIONAL ASSET " + i + " " + columns[j]);
      if (!field) throw new Error("A security field is missing. No row was removed.");
      fields.push(field);
      cells.push({ value: field.valueAsString, size: field.textSize, display: field.display });
    }
    var button = doc.getField("CEDAR_RIDGE PARTIAL REMOVE " + i);
    if (!button) throw new Error("A row control is missing. No row was removed.");
    slots.push({ fields: fields, cells: cells, button: button, display: button.display });
    if (i <= count) rows.push(cells);
  }
  return { counter: counter, count: count, slots: slots, rows: rows };
}
function cedarRidgeWriteRows(state, rows) {
  try {
    for (var i = 0; i < state.slots.length; i++) {
      var slot = state.slots[i], cells = rows[i];
      for (var j = 0; j < slot.fields.length; j++) {
        var field = slot.fields[j];
        field.value = cells ? (j === 0 ? String(i + 1) : cells[j].value) : "";
        if (cells) field.textSize = cells[j].size;
        field.display = cells ? 0 : 1;
        if (field.valueAsString !== (cells ? (j === 0 ? String(i + 1) : cells[j].value) : "") || field.display !== (cells ? 0 : 1)) {
          throw new Error("The PDF viewer did not save a security field. Try an editable copy in Chrome.");
        }
      }
      slot.button.display = cells ? 2 : 1;
    }
    state.counter.value = String(rows.length);
    if (Number(state.counter.valueAsString) !== rows.length) {
      throw new Error("The PDF viewer did not save the row count.");
    }
  } catch (error) {
    // Restore the original fields if a viewer refuses any part of the update.
    for (var r = 0; r < state.slots.length; r++) {
      var original = state.slots[r];
      for (var c = 0; c < original.fields.length; c++) {
        original.fields[c].value = original.cells[c].value;
        original.fields[c].textSize = original.cells[c].size;
        original.fields[c].display = original.cells[c].display;
      }
      original.button.display = original.display;
    }
    state.counter.value = String(state.count);
    throw error;
  }
}
function cedarRidgeRemoveSecurity(doc, row) {
  try {
    var state = cedarRidgeReadRows(doc);
    if (row < 1 || row > state.count || row !== Math.floor(row)) return;
    if (state.count === 1) {
      app.alert("Keep at least one security on a partial-transfer request.");
      return;
    }
    if (app.alert({
      cMsg: "Remove security " + row + ": " + state.rows[row - 1][2].value + "? Remaining securities will move up and renumber. This changes this PDF only, not the tracker.",
      cTitle: "Remove security", nIcon: 2, nType: 2
    }) !== 4) return;
    var removed = state.rows.splice(row - 1, 1)[0];
    cedarRidgeWriteRows(state, state.rows);
    cedarRidgeRemovedSecurities.push({ index: row - 1, cells: removed });
  } catch (error) { app.alert("Could not remove the security: " + error.message); }
}
function cedarRidgeUndoSecurity(doc) {
  try {
    if (!cedarRidgeRemovedSecurities.length) {
      app.alert("Nothing to undo. Undo is available until this PDF is closed.");
      return;
    }
    var state = cedarRidgeReadRows(doc);
    if (state.count >= ${capacity}) return;
    var removed = cedarRidgeRemovedSecurities[cedarRidgeRemovedSecurities.length - 1];
    // Insert into the current list so edits made after removal are preserved.
    state.rows.splice(removed.index, 0, removed.cells);
    cedarRidgeWriteRows(state, state.rows);
    cedarRidgeRemovedSecurities.pop();
  } catch (error) { app.alert("Could not undo the removal: " + error.message); }
}
`;
}

export function createPartialRowControls(document: PDFDocument, font: PDFFont, capacity: number) {
  const form = document.getForm();
  const counter = form.createTextField(PARTIAL_ROW_COUNT_FIELD);
  counter.setText(String(capacity));
  counter.enableReadOnly();
  document.addJavaScript("cedar-ridge-partial-row-actions", buildPartialRowScript(capacity));

  function addButton(page: PDFPage, name: string, label: string, action: string, x: number, y: number, width: number) {
    const button = form.createButton(name);
    button.addToPage(label, page, {
      x, y, width, height: 14, font,
      backgroundColor: rgb(0.96, 0.96, 0.96),
      borderColor: rgb(0.7, 0.7, 0.7), borderWidth: 0.5,
    });
    button.setFontSize(7);
    const widget = button.acroField.getWidgets()[0];
    widget.clearFlag(PRINT_FLAG);
    widget.dict.set(PDFName.of("A"), document.context.obj({
      S: "JavaScript", JS: PDFHexString.fromText(action),
    }));
  }

  return {
    addPageControls(page: PDFPage, pageNumber: number) {
      if (pageNumber === 1) {
        counter.addToPage(page, { x: 0, y: 0, width: 1, height: 1, hidden: true, font });
      }
      const help = form.createTextField(`CEDAR_RIDGE PARTIAL EDIT HELP ${pageNumber}`);
      help.setText("Use Chrome for Remove/Undo. Save your edits. Undo lasts until closed. Changes affect this PDF only.");
      help.enableReadOnly();
      help.addToPage(page, { x: 42, y: 700, width: 434, height: 14, borderWidth: 0, font });
      help.setFontSize(7);
      help.acroField.getWidgets()[0].clearFlag(PRINT_FLAG);
      addButton(page, `CEDAR_RIDGE PARTIAL UNDO ${pageNumber}`, "Undo removal", "cedarRidgeUndoSecurity(this);", 486, 700, 84);
    },
    addRemoveButton(page: PDFPage, row: number, y: number) {
      addButton(page, `CEDAR_RIDGE PARTIAL REMOVE ${row}`, "Remove", `cedarRidgeRemoveSecurity(this, ${row});`, 576, y, 30);
    },
  };
}
