import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import StatusBadge from "./StatusBadge";

describe("StatusBadge", () => {
  it.each([
    ["AcatReceived", "ACAT Received", "sky"],
    ["Completed", "Completed", "green"],
    ["Rejected", "Rejected", "red"],
    ["Submitted", "Submitted", "violet"],
    ["WaitingForApex", "Waiting for Apex", "slate"],
    ["PendingReview", "Pending Review", "cyan"],
  ] as const)(
    "renders %s with label '%s' and exposes %s hue",
    (status, label, hue) => {
      const { container } = render(<StatusBadge status={status} />);
      expect(screen.getByText(label)).toBeInTheDocument();
      const badge = container.firstChild as HTMLElement;
      expect(badge).toHaveAttribute("data-status", status);
      expect(badge).toHaveAttribute("data-hue", hue);
    }
  );

  it("renders display labels from ACAT_STATUS_LABELS", () => {
    render(<StatusBadge status="PendingContraResponse" />);
    expect(screen.getByText("Pending Contra Response")).toBeInTheDocument();
  });

  it("renders Mapped with emerald hue (asset map status)", () => {
    const { container } = render(<StatusBadge status="Mapped" />);
    const badge = container.firstChild as HTMLElement;
    expect(badge).toHaveAttribute("data-status", "Mapped");
    expect(badge).toHaveAttribute("data-hue", "emerald");
  });

  it("falls back gracefully for unknown status", () => {
    const { container } = render(<StatusBadge status="SomethingNew" />);
    expect(screen.getByText("SomethingNew")).toBeInTheDocument();
    const badge = container.firstChild as HTMLElement;
    expect(badge).toHaveAttribute("data-status", "SomethingNew");
    expect(badge).toHaveAttribute("data-hue", "gray");
  });

  it("renders the status dot indicator", () => {
    const { container } = render(<StatusBadge status="Completed" />);
    const dot = container.querySelector("span > span");
    expect(dot).toBeInTheDocument();
    expect(dot?.className).toContain("rounded-full");
  });
});
