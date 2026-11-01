import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import ContraCombobox, { ContraOption } from "./ContraCombobox";

const OPTIONS: ContraOption[] = [
  { id: "CUST-001", name: "Fidelity" },
  { id: "CUST-002", name: "Charles Schwab" },
  { id: "CUST-003", name: "Vanguard" },
];

function renderWithValue(
  overrides: Partial<React.ComponentProps<typeof ContraCombobox>> = {}
) {
  const onChange = vi.fn();
  const onCreate = vi.fn(async () => {});
  const utils = render(
    <ContraCombobox
      value=""
      onChange={onChange}
      options={OPTIONS}
      onCreate={onCreate}
      {...overrides}
    />
  );
  return { ...utils, onChange, onCreate };
}

describe("ContraCombobox", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the placeholder text", () => {
    renderWithValue({ placeholder: "Pick a contra" });
    expect(screen.getByPlaceholderText("Pick a contra")).toBeInTheDocument();
  });

  it("opens the dropdown on focus and shows all options", () => {
    renderWithValue();
    fireEvent.focus(screen.getByRole("combobox"));
    expect(screen.getByText("Fidelity")).toBeInTheDocument();
    expect(screen.getByText("Charles Schwab")).toBeInTheDocument();
    expect(screen.getByText("Vanguard")).toBeInTheDocument();
  });

  it("filters options case-insensitively as the user types", () => {
    renderWithValue();
    const input = screen.getByRole("combobox");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "schw" } });

    expect(screen.queryByText("Fidelity")).not.toBeInTheDocument();
    expect(screen.getByText("Charles Schwab")).toBeInTheDocument();
    expect(screen.queryByText("Vanguard")).not.toBeInTheDocument();
  });

  it("calls onChange when an option is clicked", () => {
    const { onChange } = renderWithValue();
    const input = screen.getByRole("combobox");
    fireEvent.focus(input);
    fireEvent.mouseDown(screen.getByText("Fidelity"));
    expect(onChange).toHaveBeenCalledWith("Fidelity");
  });

  it("does NOT render the Add row when canCreate is false", () => {
    renderWithValue({ canCreate: false });
    const input = screen.getByRole("combobox");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "Raymond James" } });

    expect(
      screen.queryByText(/Add "Raymond James" as a new contra/i)
    ).not.toBeInTheDocument();
  });

  it("renders the Add row when canCreate and no exact match", () => {
    renderWithValue({ canCreate: true });
    const input = screen.getByRole("combobox");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "Raymond James" } });

    expect(
      screen.getByText(/Add "Raymond James" as a new contra/i)
    ).toBeInTheDocument();
  });

  it("hides the Add row when the query exactly matches an existing option (case-insensitive)", () => {
    renderWithValue({ canCreate: true });
    const input = screen.getByRole("combobox");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "fidelity" } });

    expect(
      screen.queryByText(/Add "fidelity" as a new contra/i)
    ).not.toBeInTheDocument();
  });

  it("calls onCreate with the trimmed query when the Add row is clicked", async () => {
    const { onCreate } = renderWithValue({ canCreate: true });
    const input = screen.getByRole("combobox");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "  Raymond James  " } });

    fireEvent.mouseDown(
      screen.getByText(/Add "Raymond James" as a new contra/i)
    );

    await waitFor(() => {
      expect(onCreate).toHaveBeenCalledWith("Raymond James");
    });
  });

  it("closes the dropdown on Escape and restores the original value", () => {
    const { onChange } = renderWithValue({ value: "Fidelity" });
    const input = screen.getByRole("combobox") as HTMLInputElement;
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "schw" } });
    fireEvent.keyDown(input, { key: "Escape" });

    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(input.value).toBe("Fidelity");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("closes the dropdown on outside mousedown", () => {
    renderWithValue();
    fireEvent.focus(screen.getByRole("combobox"));
    expect(screen.getByRole("listbox")).toBeInTheDocument();

    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("selects the highlighted option when Enter is pressed", () => {
    const { onChange } = renderWithValue();
    const input = screen.getByRole("combobox");
    fireEvent.focus(input);
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith("Charles Schwab");
  });

  // ticket: free text must never be committed silently. An unmatched
  // query does not call onChange (on Enter or blur); a normalized/alias
  // query snaps to the canonical existing option instead.
  it("does NOT commit free text on blur when there is no match", () => {
    const { onChange } = renderWithValue({ canCreate: false });
    const input = screen.getByRole("combobox") as HTMLInputElement;
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "Unknown Firm" } });
    fireEvent.blur(input);
    expect(onChange).not.toHaveBeenCalled();
    // Stray text is discarded back to the committed value.
    expect(input.value).toBe("");
  });

  it("does NOT commit free text on Enter when there is no match", () => {
    const { onChange } = renderWithValue({ canCreate: false });
    const input = screen.getByRole("combobox");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "Unknown Firm" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("shows a 'use Add to create' hint for an unmatched query", () => {
    renderWithValue({ canCreate: false });
    const input = screen.getByRole("combobox");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "Unknown Firm" } });
    expect(screen.getByText(/use Add to create/i)).toBeInTheDocument();
  });

  it("snaps an alias query to the canonical option on Enter", () => {
    const { onChange } = renderWithValue({
      canCreate: false,
      options: [...OPTIONS, { id: "CUST-SPG", name: "Sparrow Growth Funds" }],
    });
    const input = screen.getByRole("combobox");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "Sparrow Advisors" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith("Sparrow Growth Funds");
    expect(onChange).not.toHaveBeenCalledWith("Sparrow Advisors");
  });

  it("snaps an alias query to the canonical option on blur", () => {
    const { onChange } = renderWithValue({
      canCreate: false,
      options: [...OPTIONS, { id: "CUST-SPG", name: "Sparrow Growth Funds" }],
    });
    const input = screen.getByRole("combobox");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "Sparrow Advisors" } });
    fireEvent.blur(input);
    expect(onChange).toHaveBeenCalledWith("Sparrow Growth Funds");
  });
});
