// @vitest-environment node

import { createContext, runInContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { buildPartialRowScript, PARTIAL_ROW_COUNT_FIELD } from "./apex-partial-row-actions";

const columns = ["NUMBER", "QUANTITY", "DESCRIPTION", "INSTRUCTION"];
const key = (row: number, column: string) => `CEDAR_RIDGE ADDITIONAL ASSET ${row} ${column}`;

function makeField(value: string, display = 0) {
  return { value, display, textSize: 8, get valueAsString() { return this.value; } };
}

function setup(count = 78) {
  const fields = new Map<string, ReturnType<typeof makeField>>();
  fields.set(PARTIAL_ROW_COUNT_FIELD, makeField(String(count), 1));
  for (let row = 1; row <= count; row++) {
    const values = [String(row), row === 2 ? "12.50" : "All", `Security ${row} / SEC${row}`, row === 2 ? "Liquidate" : "In kind"];
    for (const [index, column] of columns.entries()) fields.set(key(row, column), makeField(values[index]));
    fields.set(`CEDAR_RIDGE PARTIAL REMOVE ${row}`, makeField("", 2));
  }
  const alert = vi.fn(() => 4);
  const doc = { getField: (name: string) => fields.get(name) ?? null };
  const reopen = () => {
    const context = createContext({ doc, app: { alert } });
    runInContext(buildPartialRowScript(count), context);
    return {
      remove: (row: number) => runInContext(`cedarRidgeRemoveSecurity(doc, ${row});`, context),
      undo: () => runInContext("cedarRidgeUndoSecurity(doc);", context),
    };
  };
  return { fields, alert, reopen, ...reopen(), field: (row: number, column: string) => fields.get(key(row, column))! };
}

describe("partial PDF row actions", () => {
  it.each([1, 32, 33, 64, 65, 78])("removes row %i, closes gaps across pages, and renumbers every remaining security", (removed) => {
    const { remove, field, fields } = setup();
    remove(removed);
    expect(fields.get(PARTIAL_ROW_COUNT_FIELD)?.value).toBe("77");
    for (let row = 1; row <= 77; row++) {
      const original = row >= removed ? row + 1 : row;
      expect(field(row, "NUMBER").value).toBe(String(row));
      expect(field(row, "DESCRIPTION").value).toBe(`Security ${original} / SEC${original}`);
      expect(field(row, "QUANTITY").value).toBe(original === 2 ? "12.50" : "All");
      expect(field(row, "INSTRUCTION").value).toBe(original === 2 ? "Liquidate" : "In kind");
    }
    for (const column of columns) {
      expect(field(78, column).value).toBe("");
      expect(field(78, column).display).toBe(1);
    }
    expect(fields.get("CEDAR_RIDGE PARTIAL REMOVE 78")?.display).toBe(1);
    expect(fields.get("CEDAR_RIDGE PARTIAL REMOVE 77")?.display).toBe(2);
  });

  it("preserves current edits and restores removed rows without overwriting subsequent edits", () => {
    const { remove, undo, field } = setup();
    field(33, "DESCRIPTION").value = "Edited security / NEW";
    field(33, "DESCRIPTION").textSize = 6;
    remove(32);
    expect(field(32, "DESCRIPTION").value).toBe("Edited security / NEW");
    expect(field(32, "DESCRIPTION").textSize).toBe(6);
    field(32, "QUANTITY").value = "0012.50";
    field(32, "INSTRUCTION").value = "Liquidate";
    undo();
    expect(field(32, "DESCRIPTION").value).toBe("Security 32 / SEC32");
    expect(field(33, "DESCRIPTION").value).toBe("Edited security / NEW");
    expect(field(33, "QUANTITY").value).toBe("0012.50");
    expect(field(33, "INSTRUCTION").value).toBe("Liquidate");
    expect(field(78, "NUMBER").value).toBe("78");
    expect(field(78, "NUMBER").display).toBe(0);
  });

  it("supports consecutive removals and undo in reverse order", () => {
    const { remove, undo, field, fields } = setup();
    remove(2);
    remove(2);
    expect(field(2, "DESCRIPTION").value).toBe("Security 4 / SEC4");
    undo();
    expect(field(2, "DESCRIPTION").value).toBe("Security 3 / SEC3");
    undo();
    expect(field(2, "DESCRIPTION").value).toBe("Security 2 / SEC2");
    expect(fields.get(PARTIAL_ROW_COUNT_FIELD)?.value).toBe("78");
  });

  it("uses saved row state after reopening without restoring removed securities", () => {
    const { remove, reopen, field, fields, alert } = setup();
    remove(32);
    const reopened = reopen();
    reopened.undo();
    expect(alert).toHaveBeenLastCalledWith(expect.stringContaining("Nothing to undo"));
    expect(field(32, "DESCRIPTION").value).toBe("Security 33 / SEC33");
    reopened.remove(32);
    expect(field(32, "DESCRIPTION").value).toBe("Security 34 / SEC34");
    expect(fields.get(PARTIAL_ROW_COUNT_FIELD)?.value).toBe("76");
  });

  it("does not remove anything when confirmation is declined", () => {
    const { remove, field, fields, alert } = setup();
    alert.mockReturnValue(3);
    remove(1);
    expect(field(1, "DESCRIPTION").value).toBe("Security 1 / SEC1");
    expect(fields.get(PARTIAL_ROW_COUNT_FIELD)?.value).toBe("78");
  });

  it("prevents removing the final security", () => {
    const { remove, field, alert } = setup(1);
    remove(1);
    expect(field(1, "DESCRIPTION").value).toBe("Security 1 / SEC1");
    expect(alert).toHaveBeenCalledWith(expect.stringContaining("at least one security"));
  });

  it("does not treat an empty description as a request to remove another row", () => {
    const { remove, field } = setup();
    field(2, "DESCRIPTION").value = "";
    field(3, "QUANTITY").value = "";
    remove(1);
    expect(field(1, "DESCRIPTION").value).toBe("");
    expect(field(1, "QUANTITY").value).toBe("12.50");
    expect(field(2, "QUANTITY").value).toBe("");
  });

  it.each(["", "NaN", "79", "0", "1.5"])("fails closed for invalid saved count %s", (count) => {
    const { remove, field, fields, alert } = setup();
    fields.get(PARTIAL_ROW_COUNT_FIELD)!.value = count;
    remove(1);
    expect(field(1, "DESCRIPTION").value).toBe("Security 1 / SEC1");
    expect(alert).toHaveBeenCalledWith(expect.stringContaining("could not be read"));
  });

  it("validates the entire list before writing when a field is missing", () => {
    const { remove, field, fields, alert } = setup();
    fields.delete(key(78, "QUANTITY"));
    remove(1);
    expect(field(1, "DESCRIPTION").value).toBe("Security 1 / SEC1");
    expect(alert).toHaveBeenCalledWith(expect.stringContaining("field is missing"));
  });

  it("restores the original list if a viewer rejects a write", () => {
    const { remove, field, fields, alert } = setup();
    const failing = field(33, "DESCRIPTION");
    let value = failing.value;
    let rejected = false;
    Object.defineProperty(failing, "value", {
      get: () => value,
      set: (next: string) => {
        if (!rejected) { rejected = true; throw new Error("Viewer refused write"); }
        value = next;
      },
    });
    remove(1);
    expect(field(1, "DESCRIPTION").value).toBe("Security 1 / SEC1");
    expect(field(33, "DESCRIPTION").value).toBe("Security 33 / SEC33");
    expect(fields.get(PARTIAL_ROW_COUNT_FIELD)?.value).toBe("78");
    expect(alert).toHaveBeenLastCalledWith(expect.stringContaining("Viewer refused write"));
  });
});
