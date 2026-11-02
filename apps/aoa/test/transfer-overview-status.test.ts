import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AcatStatus } from "@/lib/data/acat-status";
import { AcatStatusCard } from "@/components/transfers/AcatStatusCard";
import { TransferOverviewSummary } from "@/components/transfers/TransferOverviewSummary";

const read = vi.hoisted(() => vi.fn());
vi.mock("@/lib/data/acat-status", () => ({ readAcatStatusForTransferCached: read }));
import { AcatStatusSection } from "@/components/transfers/AcatStatusSection";

const status: AcatStatus = {
  acatTransferId: "synthetic-transfer", controlNumber: "SYNTHETIC", direction: "INCOMING",
  type: "PARTIAL", accountType: "IRA", status: "IN_TRANSFER", transferringContra: "Synthetic Custodian",
  statementAmount: null, methodRequested: "ACATS", feeCharged: null, feeAmount: null,
  acatDate: null, apexAccountId: "••••5678", statementAccountNumber: "••••1234", dtccNumber: null,
  assets: [{ symbol: "SYNTH", description: "Synthetic holding", cusip: null, expectedQty: 2,
    actualQty: 1, mapStatus: null, issue: null, amount: null, assetClass: null }],
};

describe("transfer overview live status", () => {
  beforeEach(() => read.mockReset());

  it("uses the existing cached reader and keeps discrepancy attention visible in compact mode", async () => {
    read.mockResolvedValue(status);
    const html = renderToStaticMarkup(await AcatStatusSection({
      acatRecordId: "synthetic-record", acatTransferId: "synthetic-transfer", summaryOnly: true,
    }));
    expect(read).toHaveBeenCalledWith("synthetic-record", "synthetic-transfer");
    expect(html).toContain("Live ACAT status");
    expect(html).toContain("1 of 1 positions need attention");
    expect(html).not.toContain("<table");
  });

  it("preserves full account and position details in the default card", () => {
    const html = renderToStaticMarkup(createElement(AcatStatusCard, { status }));
    expect(html).toContain("<table");
    expect(html).toContain("Statement account");
    expect(html).toContain("••••1234");
    expect(html).toContain("SYNTH");
  });

  it("distinguishes missing linked records from unavailable status", async () => {
    read.mockResolvedValueOnce(null);
    const missing = renderToStaticMarkup(await AcatStatusSection({ acatRecordId: "synthetic", acatTransferId: null, summaryOnly: true }));
    expect(missing).toContain("No tracker record matches");
    read.mockRejectedValueOnce(new Error("synthetic failure"));
    const unavailable = renderToStaticMarkup(await AcatStatusSection({ acatRecordId: "synthetic", acatTransferId: null, summaryOnly: true }));
    expect(unavailable).toContain("ACAT status unavailable");
    expect(unavailable).not.toContain("No tracker record matches");
  });
});

describe("transfer overview saved facts", () => {
  const props = {
    transfer: {
      funding_type: "ACAT_PARTIAL" as const, funding_plan_complete: true, funding_plan_version: 1,
      transferring_firm: "Synthetic firm", asset_map_custodian: "Synthetic map custodian",
      asset_map_account_type: "Traditional IRA", asset_map_account_number: "SYNTHETIC-12345678",
      owner_kind: "OPERATIONS" as const, owner_name: "Synthetic Operator",
      next_step: "Review signed paperwork", next_step_owner: "Operations", pending_nudge: null,
    },
    receiving: null, nextTask: "Collect statements", openExceptions: 1, blockingExceptions: 1,
  };

  it("masks source accounts, labels saved facts and distinguishes overall and step owners", () => {
    const html = renderToStaticMarkup(createElement(TransferOverviewSummary, props));
    expect(html).toContain("Saved funding method");
    expect(html).toContain("Approved · version 1");
    expect(html).toContain("••••5678");
    expect(html).not.toContain("SYNTHETIC-12345678");
    expect(html).toContain("Review signed paperwork");
    expect(html).toContain("Step owner: Operations");
    expect(html).not.toContain("Collect statements");
    expect(html).toContain("1 open · 1 blocking");
    expect(html).toContain("Not yet matched");
  });

  it("does not treat a missing synced match as proof an account needs opening", () => {
    const html = renderToStaticMarkup(createElement(TransferOverviewSummary, {
      ...props, receiving: { registrationType: "IRA", status: "TO_OPEN", apexAccountMasked: null },
    }));
    expect(html).toContain("No open match in synced data — verify");
    expect(html).not.toContain("Needs to be opened");
  });

  it("does not claim legacy completion is a versioned approval", () => {
    const html = renderToStaticMarkup(createElement(TransferOverviewSummary, {
      ...props, transfer: { ...props.transfer, funding_plan_version: 0 },
    }));
    expect(html).toContain("Legacy completion — approval needed");
    expect(html).not.toContain("Approved");
  });

  it.each([
    ["ACAT_FULL", "5 business days"],
    ["ACAT_PARTIAL", "5 business days"],
    ["MANUAL", "3–5 months"],
    ["WIRE", "1–2 business days"],
    ["CHECK", "30 business days"],
    ["ACH", "3–5 business days"],
  ] as const)("retains the existing %s estimate without an editable control", (funding_type, estimate) => {
    const html = renderToStaticMarkup(createElement(TransferOverviewSummary, {
      ...props, transfer: { ...props.transfer, funding_type },
    }));
    expect(html).toContain(`Est. ${estimate}`);
    expect(html).not.toContain("<select");
  });

  it.each(["DRS", null] as const)("does not invent an estimate for %s", (funding_type) => {
    const html = renderToStaticMarkup(createElement(TransferOverviewSummary, {
      ...props, transfer: { ...props.transfer, funding_type },
    }));
    expect(html).not.toContain("Est.");
  });

  it("keeps map data behind the existing feature flag", () => {
    const html = renderToStaticMarkup(createElement(TransferOverviewSummary, { ...props, assetMapEnabled: false }));
    expect(html).toContain("Synthetic firm");
    expect(html).not.toContain("Synthetic map custodian");
    expect(html).not.toContain("Traditional IRA");
    expect(html).not.toContain("5678");
  });

  it("does not invent a next step when recorded instructions and checklist items are absent", () => {
    const html = renderToStaticMarkup(createElement(TransferOverviewSummary, {
      ...props, transfer: { ...props.transfer, next_step: null }, nextTask: null,
    }));
    expect(html).toContain("No next step recorded");
    expect(html).not.toContain("Step owner:");
  });
});
