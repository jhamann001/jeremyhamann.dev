import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import FilterChip from "./FilterChip";
import { FilterRule } from "@/lib/record-filters";

function renderChip(rule: FilterRule, defaultOpen = false) {
  const onChange = vi.fn();
  const onRemove = vi.fn();
  const utils = render(
    <FilterChip
      rule={rule}
      onChange={onChange}
      onRemove={onRemove}
      defaultOpen={defaultOpen}
    />
  );
  return { onChange, onRemove, ...utils };
}

describe("FilterChip", () => {
  it("renders the field label and operator label", () => {
    const rule: FilterRule = {
      id: "r1",
      field: "clientName",
      operator: "contains",
      value: "smith",
    };
    renderChip(rule);
    expect(screen.getByText("Client")).toBeTruthy();
    expect(screen.getByText("contains")).toBeTruthy();
    expect(screen.getByText("smith")).toBeTruthy();
  });

  it("calls onRemove when X is clicked", () => {
    const rule: FilterRule = {
      id: "r1",
      field: "clientName",
      operator: "contains",
      value: "smith",
    };
    const { onRemove } = renderChip(rule);
    fireEvent.click(screen.getByLabelText("Remove filter"));
    expect(onRemove).toHaveBeenCalledTimes(1);
  });

  it("opens the editor popover and lets the user change the value", () => {
    const rule: FilterRule = {
      id: "r1",
      field: "clientName",
      operator: "contains",
      value: "smith",
    };
    const { onChange } = renderChip(rule, true);
    const input = screen.getByDisplayValue("smith") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "jones" } });
    expect(onChange).toHaveBeenCalled();
    const last = onChange.mock.calls.at(-1)![0];
    expect(last.value).toBe("jones");
  });

  it("changes the operator and clears operands", () => {
    const rule: FilterRule = {
      id: "r1",
      field: "clientName",
      operator: "contains",
      value: "smith",
    };
    const { onChange } = renderChip(rule, true);
    const operator = screen.getAllByRole("combobox")[0] as HTMLSelectElement;
    fireEvent.change(operator, { target: { value: "is_empty" } });
    const last = onChange.mock.calls.at(-1)![0];
    expect(last.operator).toBe("is_empty");
    expect(last.value).toBeUndefined();
  });

  it("renders checkboxes for many-arity operators", () => {
    const rule: FilterRule = {
      id: "r1",
      field: "status",
      operator: "is_one_of",
      values: ["Completed"],
    };
    renderChip(rule, true);
    const checkboxes = screen.getAllByRole("checkbox") as HTMLInputElement[];
    expect(checkboxes.length).toBeGreaterThan(0);
    const completed = checkboxes.find(
      (cb) => (cb.nextSibling as HTMLElement)?.textContent === "Completed"
    );
    expect(completed?.checked).toBe(true);
  });

  it("renders two inputs for between operator", () => {
    const rule: FilterRule = {
      id: "r1",
      field: "acatDate",
      operator: "between",
      value: "2026-01-01",
      value2: "2026-02-01",
    };
    renderChip(rule, true);
    expect(screen.getByDisplayValue("2026-01-01")).toBeTruthy();
    expect(screen.getByDisplayValue("2026-02-01")).toBeTruthy();
    expect(screen.getByText(/and/i)).toBeTruthy();
  });
});
