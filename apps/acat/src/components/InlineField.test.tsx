import { describe, it, expect, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { renderHook } from "@testing-library/react";
import InlineField from "./InlineField";
import { useInlineEdit } from "@/hooks/use-inline-edit";

function HookHarness({
  field,
  value,
  type,
  onSave,
  options,
}: {
  field: string;
  value: string;
  type?: "text" | "date" | "textarea" | "select" | "multiselect" | "contra";
  onSave: (f: string, v: string) => Promise<boolean>;
  options?: string[];
}) {
  const [latest, setLatest] = useState(value);
  const edit = useInlineEdit({
    onSave: async (f, v) => {
      const ok = await onSave(f, v);
      if (ok) setLatest(v);
      return ok;
    },
  });
  return (
    <InlineField
      field={field}
      value={latest}
      edit={edit}
      type={type ?? "text"}
      options={options}
    />
  );
}

describe("InlineField", () => {
  it("renders the placeholder when value is empty", () => {
    render(
      <HookHarness field="ctrl" value="" onSave={vi.fn().mockResolvedValue(true)} />
    );
    expect(screen.getByText("—")).toBeInTheDocument();
  });

  it("clicking the value enters edit mode and shows an input", () => {
    render(
      <HookHarness field="ctrl" value="ABC123" onSave={vi.fn().mockResolvedValue(true)} />
    );
    fireEvent.click(screen.getByRole("button", { name: /edit ctrl/i }));
    const input = screen.getByDisplayValue("ABC123") as HTMLInputElement;
    expect(input).toBeInTheDocument();
  });

  it("commits on blur with the new value", async () => {
    const onSave = vi.fn().mockResolvedValue(true);
    render(<HookHarness field="ctrl" value="ABC123" onSave={onSave} />);
    fireEvent.click(screen.getByRole("button", { name: /edit ctrl/i }));
    const input = screen.getByDisplayValue("ABC123") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "XYZ999" } });
    fireEvent.blur(input);
    await waitFor(() => {
      expect(onSave).toHaveBeenCalledWith("ctrl", "XYZ999");
    });
  });

  it("does not commit when the value is unchanged", async () => {
    const onSave = vi.fn().mockResolvedValue(true);
    render(<HookHarness field="ctrl" value="ABC" onSave={onSave} />);
    fireEvent.click(screen.getByRole("button", { name: /edit ctrl/i }));
    const input = screen.getByDisplayValue("ABC") as HTMLInputElement;
    fireEvent.blur(input);
    await waitFor(() => {
      expect(screen.queryByDisplayValue("ABC")).not.toBeInTheDocument();
    });
    expect(onSave).not.toHaveBeenCalled();
  });

  it("Escape cancels the edit without saving", async () => {
    const onSave = vi.fn().mockResolvedValue(true);
    render(<HookHarness field="ctrl" value="ABC" onSave={onSave} />);
    fireEvent.click(screen.getByRole("button", { name: /edit ctrl/i }));
    const input = screen.getByDisplayValue("ABC") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "ZZZ" } });
    fireEvent.keyDown(input, { key: "Escape" });
    await waitFor(() => {
      expect(screen.queryByDisplayValue("ZZZ")).not.toBeInTheDocument();
    });
    expect(onSave).not.toHaveBeenCalled();
  });

  it("Enter commits in a single-line input", async () => {
    const onSave = vi.fn().mockResolvedValue(true);
    render(<HookHarness field="ctrl" value="ABC" onSave={onSave} />);
    fireEvent.click(screen.getByRole("button", { name: /edit ctrl/i }));
    const input = screen.getByDisplayValue("ABC") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "DEF" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => {
      expect(onSave).toHaveBeenCalledWith("ctrl", "DEF");
    });
  });

  it("clicking the cancel button drops changes even though blur fires first", async () => {
    const onSave = vi.fn().mockResolvedValue(true);
    render(<HookHarness field="ctrl" value="ABC" onSave={onSave} />);
    fireEvent.click(screen.getByRole("button", { name: /edit ctrl/i }));
    const input = screen.getByDisplayValue("ABC") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "ZZZ" } });
    const cancel = screen.getByRole("button", { name: /cancel edit/i });
    // Real browsers fire the cancel button's mousedown BEFORE the input's blur.
    fireEvent.mouseDown(cancel);
    fireEvent.blur(input);
    fireEvent.click(cancel);
    await waitFor(() => {
      expect(screen.queryByDisplayValue("ZZZ")).not.toBeInTheDocument();
    });
    expect(onSave).not.toHaveBeenCalled();
  });

  it("select type auto-commits on change", async () => {
    const onSave = vi.fn().mockResolvedValue(true);
    render(
      <HookHarness
        field="direction"
        value="In"
        type="select"
        options={["In", "Out"]}
        onSave={onSave}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: /edit direction/i }));
    const select = screen.getByRole("combobox") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "Out" } });
    await waitFor(() => {
      expect(onSave).toHaveBeenCalledWith("direction", "Out");
    });
  });

  it("textarea Enter does NOT commit (allows newlines)", async () => {
    const onSave = vi.fn().mockResolvedValue(true);
    render(
      <HookHarness field="notes" value="hello" type="textarea" onSave={onSave} />
    );
    fireEvent.click(screen.getByRole("button", { name: /edit notes/i }));
    const textarea = screen.getByDisplayValue("hello") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "hello\nworld" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(onSave).not.toHaveBeenCalled();
    fireEvent.blur(textarea);
    await waitFor(() => {
      expect(onSave).toHaveBeenCalledWith("notes", "hello\nworld");
    });
  });

  it("multiselect commits on outside click", async () => {
    const onSave = vi.fn().mockResolvedValue(true);
    render(
      <div>
        <button>outside</button>
        <HookHarness
          field="methodRequested"
          value="API"
          type="multiselect"
          options={["API", "Full Docusign", "N/A"]}
          onSave={onSave}
        />
      </div>
    );
    fireEvent.click(screen.getByRole("button", { name: /edit methodrequested/i }));
    const trigger = screen.getByText(/api/i, { selector: "span" });
    fireEvent.click(trigger);
    // Pick a second option from the popover.
    const fullDocusign = await screen.findByText("Full Docusign");
    fireEvent.click(fullDocusign);
    // Click outside the wrapper.
    fireEvent.mouseDown(screen.getByRole("button", { name: "outside" }));
    await waitFor(() => {
      expect(onSave).toHaveBeenCalled();
    });
    expect(onSave.mock.calls[0][1]).toContain("Full Docusign");
  });

  it("ignores clicks when editable is false", () => {
    function Harness() {
      const edit = useInlineEdit({ onSave: vi.fn().mockResolvedValue(true) });
      return (
        <InlineField
          field="ctrl"
          value="ABC"
          edit={edit}
          editable={false}
        />
      );
    }
    render(<Harness />);
    expect(
      screen.queryByRole("button", { name: /edit ctrl/i })
    ).not.toBeInTheDocument();
    expect(screen.getByText("ABC")).toBeInTheDocument();
  });

  it("shows a saving indicator while a save is in flight", async () => {
    let resolve: (v: boolean) => void = () => {};
    const onSave = vi.fn(
      () =>
        new Promise<boolean>((r) => {
          resolve = r;
        })
    );
    render(<HookHarness field="ctrl" value="ABC" onSave={onSave} />);
    fireEvent.click(screen.getByRole("button", { name: /edit ctrl/i }));
    const input = screen.getByDisplayValue("ABC") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "DEF" } });
    fireEvent.blur(input);
    await waitFor(() => {
      expect(screen.getByLabelText("Saving")).toBeInTheDocument();
    });
    await act(async () => {
      resolve(true);
    });
  });
});

describe("hook integration sanity", () => {
  it("renders without throwing when edit hook is supplied externally", () => {
    const { result } = renderHook(() =>
      useInlineEdit({ onSave: async () => true })
    );
    render(
      <InlineField field="ctrl" value="ABC" edit={result.current} />
    );
    expect(screen.getByText("ABC")).toBeInTheDocument();
  });
});
