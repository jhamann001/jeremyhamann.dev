import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, fireEvent } from "@testing-library/react";
import { ToastProvider, useToast } from "./Toast";

function TestTrigger() {
  const { toast } = useToast();
  return (
    <div>
      <button onClick={() => toast("success", "Done", "It worked")}>
        Show Success
      </button>
      <button onClick={() => toast("error", "Oops", "Something broke")}>
        Show Error
      </button>
    </div>
  );
}

describe("Toast", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders toast on trigger", async () => {
    render(
      <ToastProvider>
        <TestTrigger />
      </ToastProvider>
    );

    await act(async () => {
      fireEvent.click(screen.getByText("Show Success"));
    });

    expect(screen.getByText("Done")).toBeInTheDocument();
    expect(screen.getByText("It worked")).toBeInTheDocument();
  });

  it("renders error toast", async () => {
    render(
      <ToastProvider>
        <TestTrigger />
      </ToastProvider>
    );

    await act(async () => {
      fireEvent.click(screen.getByText("Show Error"));
    });

    expect(screen.getByText("Oops")).toBeInTheDocument();
    expect(screen.getByText("Something broke")).toBeInTheDocument();
  });

  it("auto-dismisses after timeout", async () => {
    render(
      <ToastProvider>
        <TestTrigger />
      </ToastProvider>
    );

    await act(async () => {
      fireEvent.click(screen.getByText("Show Success"));
    });

    expect(screen.getByText("Done")).toBeInTheDocument();

    await act(async () => {
      vi.advanceTimersByTime(5000);
    });

    expect(screen.queryByText("Done")).not.toBeInTheDocument();
  });

  it("dismisses on close button click", async () => {
    render(
      <ToastProvider>
        <TestTrigger />
      </ToastProvider>
    );

    await act(async () => {
      fireEvent.click(screen.getByText("Show Success"));
    });

    expect(screen.getByText("Done")).toBeInTheDocument();

    const closeBtn = screen.getByText("Done").closest("div")?.parentElement?.querySelector("button");
    expect(closeBtn).toBeTruthy();

    await act(async () => {
      fireEvent.click(closeBtn!);
    });

    await act(async () => {
      vi.advanceTimersByTime(300);
    });

    expect(screen.queryByText("Done")).not.toBeInTheDocument();
  });

  it("can show multiple toasts", async () => {
    render(
      <ToastProvider>
        <TestTrigger />
      </ToastProvider>
    );

    await act(async () => {
      fireEvent.click(screen.getByText("Show Success"));
      fireEvent.click(screen.getByText("Show Error"));
    });

    expect(screen.getByText("Done")).toBeInTheDocument();
    expect(screen.getByText("Oops")).toBeInTheDocument();
  });
});
