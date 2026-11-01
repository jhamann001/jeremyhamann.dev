import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import ColumnChooser, {
  loadColumnOrder,
  loadVisibleColumns,
  saveColumnOrder,
  saveVisibleColumns,
} from "./ColumnChooser";
import {
  defaultColumnOrder,
  defaultVisibleColumns,
  RecordFieldKey,
} from "@/lib/record-fields";
import { useState } from "react";

function Harness({ initial }: { initial: Set<RecordFieldKey> }) {
  const [visible, setVisible] = useState<Set<RecordFieldKey>>(initial);
  return <ColumnChooser visible={visible} onChange={setVisible} />;
}

describe("ColumnChooser", () => {
  it("shows the Columns toggle with current count", () => {
    render(<Harness initial={new Set(["clientName", "status"])} />);
    expect(screen.getByRole("button", { name: /Columns/i })).toBeTruthy();
    expect(screen.getByText("2")).toBeTruthy();
  });

  it("opens the popover and toggles a column on click", () => {
    render(<Harness initial={new Set(["clientName"])} />);
    fireEvent.click(screen.getByRole("button", { name: /Columns/i }));
    const cb = document.getElementById(
      "column-toggle-status"
    ) as HTMLInputElement;
    expect(cb.checked).toBe(false);
    fireEvent.click(cb);
    expect(
      (document.getElementById("column-toggle-status") as HTMLInputElement).checked
    ).toBe(true);
  });

  it("filters columns by search", () => {
    render(<Harness initial={defaultVisibleColumns()} />);
    fireEvent.click(screen.getByRole("button", { name: /Columns/i }));
    const search = screen.getByPlaceholderText(/Search columns/i);
    fireEvent.change(search, { target: { value: "advisor" } });
    expect(document.getElementById("column-toggle-wealthAdvisor")).toBeTruthy();
    expect(document.getElementById("column-toggle-clientName")).toBeNull();
  });

  it("resets to defaults", () => {
    render(<Harness initial={new Set(["clientName"])} />);
    fireEvent.click(screen.getByRole("button", { name: /Columns/i }));
    fireEvent.click(screen.getByText(/Reset/i));
    const defaults = defaultVisibleColumns();
    for (const key of defaults) {
      const cb = document.getElementById(
        `column-toggle-${key}`
      ) as HTMLInputElement | null;
      expect(cb?.checked).toBe(true);
    }
  });
});

describe("visible-columns persistence", () => {
  let mockStore: Record<string, string> = {};
  beforeEach(() => {
    mockStore = {};
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => mockStore[k] ?? null,
      setItem: (k: string, v: string) => {
        mockStore[k] = v;
      },
      removeItem: (k: string) => {
        delete mockStore[k];
      },
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns defaults when nothing is stored", () => {
    expect(loadVisibleColumns()).toEqual(defaultVisibleColumns());
  });

  it("round-trips a saved set of columns", () => {
    const set = new Set<RecordFieldKey>(["clientName", "status", "wealthAdvisor"]);
    saveVisibleColumns(set);
    expect(loadVisibleColumns()).toEqual(set);
  });

  it("returns defaults on malformed JSON", () => {
    mockStore["records-view-columns"] = "not json";
    expect(loadVisibleColumns()).toEqual(defaultVisibleColumns());
  });
});

describe("column-order persistence", () => {
  let mockStore: Record<string, string> = {};
  beforeEach(() => {
    mockStore = {};
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => mockStore[k] ?? null,
      setItem: (k: string, v: string) => {
        mockStore[k] = v;
      },
      removeItem: (k: string) => {
        delete mockStore[k];
      },
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the default order when nothing is stored", () => {
    expect(loadColumnOrder()).toEqual(defaultColumnOrder());
  });

  it("round-trips a saved order", () => {
    const reordered: RecordFieldKey[] = ["status", "clientName"];
    saveColumnOrder(reordered);
    const loaded = loadColumnOrder();
    expect(loaded.slice(0, 2)).toEqual(reordered);
    // Schema-default tail is appended so newly-added fields stay reachable.
    expect(new Set(loaded)).toEqual(new Set(defaultColumnOrder()));
  });

  it("drops stale keys persisted before a schema cleanup", () => {
    // completedDate was removed in ticket; a user who saved it before the
    // upgrade shouldn't see it on the next page load.
    mockStore["records-view-column-order"] = JSON.stringify([
      "clientName",
      "completedDate",
      "status",
    ]);
    const loaded = loadColumnOrder();
    expect(loaded).not.toContain("completedDate" as RecordFieldKey);
    expect(loaded.indexOf("clientName")).toBe(0);
    expect(loaded.indexOf("status")).toBe(1);
  });

  it("falls back to the default order on malformed JSON", () => {
    mockStore["records-view-column-order"] = "not json";
    expect(loadColumnOrder()).toEqual(defaultColumnOrder());
  });
});
