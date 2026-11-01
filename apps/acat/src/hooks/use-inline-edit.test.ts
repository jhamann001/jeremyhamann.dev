import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useInlineEdit } from "./use-inline-edit";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useInlineEdit", () => {
  it("starts with idle state and no editing field", () => {
    const onSave = vi.fn().mockResolvedValue(true);
    const { result } = renderHook(() => useInlineEdit({ onSave }));
    expect(result.current.editingField).toBeNull();
    expect(result.current.editValue).toBe("");
    expect(result.current.status).toBe("idle");
  });

  it("start() seeds editingField and editValue", () => {
    const onSave = vi.fn().mockResolvedValue(true);
    const { result } = renderHook(() => useInlineEdit({ onSave }));
    act(() => result.current.start("notes", "hi"));
    expect(result.current.editingField).toBe("notes");
    expect(result.current.editValue).toBe("hi");
  });

  it("change() updates the buffer without saving", () => {
    const onSave = vi.fn().mockResolvedValue(true);
    const { result } = renderHook(() => useInlineEdit({ onSave }));
    act(() => result.current.start("notes", "hi"));
    act(() => result.current.change("hello"));
    expect(result.current.editValue).toBe("hello");
    expect(onSave).not.toHaveBeenCalled();
  });

  it("commit() persists a changed value and flashes 'saved'", async () => {
    const onSave = vi.fn().mockResolvedValue(true);
    const { result } = renderHook(() =>
      useInlineEdit({ onSave, savedFlashMs: 500 })
    );
    act(() => result.current.start("notes", "hi"));
    act(() => result.current.change("hello"));
    await act(async () => {
      await result.current.commit();
    });
    expect(onSave).toHaveBeenCalledWith("notes", "hello");
    expect(result.current.editingField).toBeNull();
    expect(result.current.status).toBe("saved");
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(result.current.status).toBe("idle");
  });

  it("commit() with an unchanged value skips the network call", async () => {
    const onSave = vi.fn().mockResolvedValue(true);
    const { result } = renderHook(() => useInlineEdit({ onSave }));
    act(() => result.current.start("notes", "hi"));
    await act(async () => {
      await result.current.commit();
    });
    expect(onSave).not.toHaveBeenCalled();
    expect(result.current.editingField).toBeNull();
    expect(result.current.status).toBe("idle");
  });

  it("commit() sets status to 'error' on failure and keeps the editor open", async () => {
    const onSave = vi.fn().mockResolvedValue(false);
    const { result } = renderHook(() => useInlineEdit({ onSave }));
    act(() => result.current.start("notes", "hi"));
    act(() => result.current.change("hello"));
    await act(async () => {
      await result.current.commit();
    });
    expect(result.current.status).toBe("error");
    expect(result.current.editingField).toBe("notes");
    expect(result.current.editValue).toBe("hello");
  });

  it("cancel() drops the buffer and exits edit mode", () => {
    const onSave = vi.fn().mockResolvedValue(true);
    const { result } = renderHook(() => useInlineEdit({ onSave }));
    act(() => result.current.start("notes", "hi"));
    act(() => result.current.change("hello"));
    act(() => result.current.cancel());
    expect(result.current.editingField).toBeNull();
    expect(result.current.editValue).toBe("");
    expect(result.current.status).toBe("idle");
  });

  it("beginCancel() prevents the next blur-driven commit", async () => {
    const onSave = vi.fn().mockResolvedValue(true);
    const { result } = renderHook(() => useInlineEdit({ onSave }));
    act(() => result.current.start("notes", "hi"));
    act(() => result.current.change("hello"));
    act(() => result.current.beginCancel());
    await act(async () => {
      await result.current.commit();
    });
    expect(onSave).not.toHaveBeenCalled();
    // After the suppressed commit, a subsequent commit should work again.
    act(() => result.current.start("notes", "hi"));
    act(() => result.current.change("howdy"));
    await act(async () => {
      await result.current.commit();
    });
    expect(onSave).toHaveBeenCalledWith("notes", "howdy");
  });

  it("re-entrant commit() calls do not fire double saves", async () => {
    let resolveSave: (v: boolean) => void = () => {};
    const onSave = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          resolveSave = resolve;
        })
    );
    const { result } = renderHook(() => useInlineEdit({ onSave }));
    act(() => result.current.start("notes", "hi"));
    act(() => result.current.change("hello"));
    let firstCall: Promise<void> | undefined;
    act(() => {
      firstCall = result.current.commit();
    });
    // While the first save is in flight, additional commits should be ignored.
    let secondCall: Promise<void> | undefined;
    act(() => {
      secondCall = result.current.commit();
    });
    expect(onSave).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolveSave(true);
      await firstCall;
      await secondCall;
    });
  });

  it("bind() attaches Enter to commit and Escape to cancel for an input", async () => {
    const onSave = vi.fn().mockResolvedValue(true);
    const { result } = renderHook(() => useInlineEdit({ onSave }));
    act(() => result.current.start("notes", "hi"));
    act(() => result.current.change("hello"));

    const handlers = result.current.bind("notes");
    const input = document.createElement("input");
    const enterEvent = {
      key: "Enter",
      preventDefault: vi.fn(),
      target: input,
    } as unknown as React.KeyboardEvent<HTMLInputElement>;
    await act(async () => {
      handlers.onKeyDown(enterEvent);
    });
    expect(enterEvent.preventDefault).toHaveBeenCalled();
    expect(onSave).toHaveBeenCalledWith("notes", "hello");

    act(() => result.current.start("notes", "next"));
    act(() => result.current.change("changed"));
    const handlers2 = result.current.bind("notes");
    const escEvent = {
      key: "Escape",
      preventDefault: vi.fn(),
      target: document.createElement("input"),
    } as unknown as React.KeyboardEvent<HTMLInputElement>;
    act(() => {
      handlers2.onKeyDown(escEvent);
    });
    expect(escEvent.preventDefault).toHaveBeenCalled();
    expect(result.current.editingField).toBeNull();
  });

  it("bind() does NOT commit on Enter inside a textarea", () => {
    const onSave = vi.fn().mockResolvedValue(true);
    const { result } = renderHook(() => useInlineEdit({ onSave }));
    act(() => result.current.start("notes", "hi"));
    act(() => result.current.change("multi\nline"));
    const handlers = result.current.bind("notes");
    const textarea = document.createElement("textarea");
    const enterEvent = {
      key: "Enter",
      preventDefault: vi.fn(),
      target: textarea,
    } as unknown as React.KeyboardEvent<HTMLTextAreaElement>;
    act(() => {
      handlers.onKeyDown(enterEvent);
    });
    expect(enterEvent.preventDefault).not.toHaveBeenCalled();
    expect(onSave).not.toHaveBeenCalled();
  });

  it("bind() ignores blur for fields that are not currently being edited", async () => {
    const onSave = vi.fn().mockResolvedValue(true);
    const { result } = renderHook(() => useInlineEdit({ onSave }));
    act(() => result.current.start("notes", "hi"));
    const handlers = result.current.bind("controlNumber");
    await act(async () => {
      handlers.onBlur();
    });
    expect(onSave).not.toHaveBeenCalled();
    expect(result.current.editingField).toBe("notes");
  });
});
