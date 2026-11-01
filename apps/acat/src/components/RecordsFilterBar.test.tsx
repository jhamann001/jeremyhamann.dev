import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { useState } from "react";
import RecordsFilterBar, {
  loadFilterRules,
  saveFilterRules,
} from "./RecordsFilterBar";
import { FilterRule } from "@/lib/record-filters";

function setup(initial: FilterRule[] = []) {
  const onChange = vi.fn();
  const Wrapper = () => {
    const [rules, setRules] = useState<FilterRule[]>(initial);
    return (
      <RecordsFilterBar
        rules={rules}
        onChange={(r) => {
          onChange(r);
          setRules(r);
        }}
      />
    );
  };
  const utils = render(<Wrapper />);
  return { onChange, ...utils };
}

describe("RecordsFilterBar", () => {
  it("shows an Add filter button initially", () => {
    setup();
    expect(screen.getByRole("button", { name: /Add filter/i })).toBeTruthy();
  });

  it("opens the field picker and adds a rule with default operator", () => {
    const { onChange } = setup();
    fireEvent.click(screen.getByRole("button", { name: /Add filter/i }));
    fireEvent.click(screen.getByText("Client"));
    expect(onChange).toHaveBeenCalled();
    const next = onChange.mock.calls.at(-1)![0] as FilterRule[];
    expect(next.length).toBe(1);
    expect(next[0].field).toBe("clientName");
    expect(next[0].operator).toBe("contains");
  });

  it("filters fields by search query", () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: /Add filter/i }));
    const search = screen.getByPlaceholderText(/Search fields/i) as HTMLInputElement;
    fireEvent.change(search, { target: { value: "advisor" } });
    expect(screen.getByText(/Advisor/i)).toBeTruthy();
    expect(screen.queryByText("Client")).toBeNull();
  });

  it("offers all transfer operations fields in the field picker", () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: /Add filter/i }));

    expect(screen.getByText("Transfer Workflow")).toBeTruthy();
    expect(screen.getByText("Monitor for Residual")).toBeTruthy();
    expect(screen.getByText("Residual Follow-Up Date")).toBeTruthy();
  });

  it("clears all rules when Clear all is clicked", () => {
    const { onChange } = setup([
      { id: "r1", field: "clientName", operator: "contains", value: "x" },
    ]);
    fireEvent.click(screen.getByText(/Clear all/i));
    expect(onChange).toHaveBeenCalledWith([]);
  });

  it("removes individual rules via the chip X", () => {
    const { onChange } = setup([
      { id: "r1", field: "clientName", operator: "contains", value: "x" },
      { id: "r2", field: "status", operator: "is_one_of", values: ["Completed"] },
    ]);
    const removes = screen.getAllByLabelText("Remove filter");
    fireEvent.click(removes[0]);
    const next = onChange.mock.calls.at(-1)![0] as FilterRule[];
    expect(next.length).toBe(1);
    expect(next[0].id).toBe("r2");
  });
});

describe("filter rule persistence", () => {
  it("loads and saves filter rules from localStorage", () => {
    const store: Record<string, string> = {};
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => {
        store[k] = v;
      },
      removeItem: (k: string) => {
        delete store[k];
      },
    });
    const rules: FilterRule[] = [
      { id: "r1", field: "clientName", operator: "contains", value: "smith" },
    ];
    saveFilterRules(rules);
    expect(loadFilterRules()).toEqual(rules);
    vi.unstubAllGlobals();
  });

  it("returns [] when nothing is stored", () => {
    const store: Record<string, string> = {};
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => {
        store[k] = v;
      },
      removeItem: (k: string) => {
        delete store[k];
      },
    });
    expect(loadFilterRules()).toEqual([]);
    vi.unstubAllGlobals();
  });

  it("returns [] on malformed JSON", () => {
    const store: Record<string, string> = { "records-view-filters": "not json" };
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => {
        store[k] = v;
      },
      removeItem: (k: string) => {
        delete store[k];
      },
    });
    expect(loadFilterRules()).toEqual([]);
    vi.unstubAllGlobals();
  });
});
