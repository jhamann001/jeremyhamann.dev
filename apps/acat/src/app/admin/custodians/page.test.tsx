import { describe, it, expect, vi } from "vitest";
import type { ReactNode } from "react";
import { render, screen } from "@testing-library/react";

// Render next/link as a plain anchor so CustodianCard mounts without a router.
vi.mock("next/link", () => ({
  default: ({ children, href }: { children: ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

const { default: CustodianCard, SEGMENTS, needsPlaybook, timingSpeed } =
  await import("@/components/CustodianCard");

const base = {
  id: "c1",
  name: "Charles Schwab",
  avgProcessingDays: 7,
  observedAvgProcessingBusinessDays: null,
  observedCompletedTransfers: 0,
  contactEmail: null,
  reviewStatus: "VERIFIED" as const,
  transferType: null,
  documentationStatus: null,
  dtcNumber: null,
  hasInboundRecords: false,
  fees: [],
};

describe("CustodianCard — ticket list badges", () => {
  it("renders the transfer-type pill, documentation badge, and DTC #", () => {
    render(
      <CustodianCard
        custodian={{
          ...base,
          transferType: "ACAT_API",
          documentationStatus: "DOCUMENTED",
          dtcNumber: "0164",
        }}
      />
    );
    expect(screen.getByText("ACAT")).toBeInTheDocument();
    expect(screen.getByText("Documented")).toBeInTheDocument();
    expect(screen.getByText("DTC 0164")).toBeInTheDocument();
  });

  it("renders a Manual transfer-type pill and Needs call badge for a manual contra", () => {
    render(
      <CustodianCard
        custodian={{
          ...base,
          name: "Victory Funds",
          transferType: "MANUAL",
          documentationStatus: "NEEDS_CALL",
          dtcNumber: "5686",
        }}
      />
    );
    expect(screen.getByText("Manual")).toBeInTheDocument();
    expect(screen.getByText("Needs call")).toBeInTheDocument();
    expect(screen.getByText("DTC 5686")).toBeInTheDocument();
  });

  it("shows no playbook badges when the fields are unset", () => {
    render(<CustodianCard custodian={base} />);
    expect(screen.queryByText("ACAT")).toBeNull();
    expect(screen.queryByText("Documented")).toBeNull();
    expect(screen.queryByText(/^DTC /)).toBeNull();
  });
});

describe("CustodianCard — observed processing time", () => {
  it("shows a measured business-day average with its sample size and speed", () => {
    render(
      <CustodianCard
        custodian={{
          ...base,
          observedAvgProcessingBusinessDays: 18,
          observedCompletedTransfers: 4,
        }}
      />
    );

    const timing = screen.getByText("~18 business days avg · 4 completed");
    expect(timing).toBeInTheDocument();
    expect(timing).toHaveAttribute("title", "Slow (more than 10 business days)");
    expect(screen.queryByText("~7d avg")).toBeNull();
  });

  it("does not present the configured fallback as an average", () => {
    render(<CustodianCard custodian={base} />);

    expect(screen.getByText("No completed timing data")).toBeInTheDocument();
    expect(screen.queryByText("~7d avg")).toBeNull();
  });

  it("uses clear fast, typical, and slow timing bands", () => {
    expect(timingSpeed(5)).toBe("fast");
    expect(timingSpeed(6)).toBe("typical");
    expect(timingSpeed(10)).toBe("typical");
    expect(timingSpeed(11)).toBe("slow");
  });
});

describe("ticket — slimmed segments", () => {
  it("exposes exactly All / ACAT / Manual / Mixed / Needs playbook", () => {
    expect(SEGMENTS.map((s) => s.key)).toEqual([
      "all",
      "acat",
      "manual",
      "mixed",
      "needsPlaybook",
    ]);
  });
});

describe("ticket — inbound-aware needsPlaybook (documentation-based)", () => {
  it("does NOT flag a contra with no inbound records (outbound-only / orphan)", () => {
    expect(
      needsPlaybook({ ...base, hasInboundRecords: false, documentationStatus: null })
    ).toBe(false);
  });

  it("does NOT flag an inbound + DOCUMENTED contra even if reviewStatus is NEEDS_SETUP", () => {
    expect(
      needsPlaybook({
        ...base,
        hasInboundRecords: true,
        documentationStatus: "DOCUMENTED",
        reviewStatus: "NEEDS_SETUP",
      })
    ).toBe(false);
  });

  it("flags an inbound + undocumented (unset) contra", () => {
    expect(
      needsPlaybook({ ...base, hasInboundRecords: true, documentationStatus: null })
    ).toBe(true);
  });

  it("flags an inbound + PARTIAL contra even with a transfer type and VERIFIED", () => {
    expect(
      needsPlaybook({
        ...base,
        hasInboundRecords: true,
        transferType: "ACAT_API",
        documentationStatus: "PARTIAL",
        reviewStatus: "VERIFIED",
      })
    ).toBe(true);
  });

  it("flags an inbound + NEEDS_CALL contra", () => {
    expect(
      needsPlaybook({ ...base, hasInboundRecords: true, documentationStatus: "NEEDS_CALL" })
    ).toBe(true);
  });

  it("renders a 'Needs playbook' chip on the card when flagged", () => {
    render(
      <CustodianCard
        custodian={{ ...base, hasInboundRecords: true, documentationStatus: null }}
      />
    );
    expect(screen.getByText("Needs playbook")).toBeInTheDocument();
  });
});
