import { beforeEach, describe, expect, it, vi } from "vitest";
import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { TransferRow } from "@/lib/data/transfer-types";

vi.mock("server-only", () => ({}));
const flags = vi.hoisted(() => ({ assetMap: vi.fn() }));
vi.mock("@/lib/flags", () => ({ assetMapTransferLinkEnabled: flags.assetMap }));
vi.mock("@/components/client-portrait", () => ({
  TradeRequestsSection: () => null,
  TradeRequestsSkeleton: () => null,
}));
vi.mock("@/components/transfers/AcatStatusSection", () => ({
  AcatStatusSection: () => createElement("p", null, "Synthetic tracker status"),
}));
vi.mock("@/components/transfers/AcatAssetSummaryRow", () => ({
  AcatAssetSummaryRow: () => createElement("p", null, "Synthetic mapped positions"),
}));
vi.mock("@/components/transfers/AssetMapLinkControl", () => ({
  AssetMapLinkControl: ({ canWrite }: { canWrite: boolean }) => createElement("span", null, canWrite ? "Synthetic map edit control" : "Synthetic map read-only"),
}));
vi.mock("@/components/transfers/TransferAcatPicker", () => ({
  TransferAcatPicker: () => createElement("button", null, "Find and link ACAT"),
}));
// Fail visibly if the integration hub ever reintroduces its duplicate editor.
// The actual editor belongs only to DecisionChecklistCard in the funding plan.
vi.mock("@/components/transfers/FundingTypeControl", () => ({
  FundingTypeControl: () => { throw new Error("Duplicate funding editor in information hub"); },
}));

import { FundingPictureCard } from "@/components/transfers/FundingPictureCard";
import { FundingTypeControl } from "@/components/transfers/FundingTypeControl";
import { AcatStatusSection } from "@/components/transfers/AcatStatusSection";
import { AssetMapLinkControl } from "@/components/transfers/AssetMapLinkControl";
import { TransferAcatPicker } from "@/components/transfers/TransferAcatPicker";

function findElement(node: ReactNode, type: unknown): ReactElement<Record<string, unknown>> | null {
  for (const child of Children.toArray(node)) {
    if (!isValidElement<{ children?: ReactNode }>(child)) continue;
    if (child.type === type) return child as ReactElement<Record<string, unknown>>;
    const found = findElement(child.props.children, type);
    if (found) return found;
  }
  return null;
}

function fixture(overrides: Partial<TransferRow> = {}): TransferRow {
  return {
    id: "synthetic-transfer", source: "APP", client_first_name: "Example", client_last_name: "Client",
    client_sf_id: null, household_name: null, household_sf_id: null,
    value: 1000, stage: "DECISION", stage_entered_at: new Date("2026-09-22T12:00:00Z"),
    owner_kind: "OPERATIONS", owner_name: null, next_step: null, next_step_owner: null, pending_nudge: null,
    acat_transfer_id: null, acat_record_id: null, funding_type: "ACAT_FULL",
    accounts_opened_at_apex: false, funding_plan_complete: false, funding_plan_version: 0,
    funding_plan_approved_at: null, funding_plan_approved_by: null, funding_initiated: false, cash_in_flight: false,
    deal_id: null, deal_sf_id: null, transferring_firm: "Synthetic Custodian",
    archived_at: null, archived_by: null, archived_reason: null, sync_flag: null,
    asset_map_folder_id: null, asset_map_custodian: null, asset_map_account_number: null, asset_map_account_type: null,
    created_by: null, updated_by: null, created_at: new Date("2026-09-22T12:00:00Z"), updated_at: new Date("2026-09-22T12:00:00Z"),
    ...overrides,
  };
}

function card(transfer: TransferRow, canWrite = true, canLinkAcat = false, canLinkAssetMap = false) {
  return FundingPictureCard({ transfer, canWrite, canLinkAcat, canLinkAssetMap, deal: null, deals: null, assignedMapDetail: null, tradeRequestUserId: null });
}

describe("information hub has one purpose and no duplicate funding editor", () => {
  beforeEach(() => { flags.assetMap.mockReturnValue(true); });

  it("uses the separate source-edit permission instead of general transfer write access", () => {
    expect(findElement(card(fixture(), true), AssetMapLinkControl)!.props.canWrite).toBe(false);
    expect(findElement(card(fixture(), true, false, true), AssetMapLinkControl)!.props.canWrite).toBe(true);
  });

  it.each([true, false])("never mounts a funding dropdown with canWrite=%s", (canWrite) => {
    const element = card(fixture(), canWrite);
    expect(findElement(element, FundingTypeControl)).toBeNull();
    const html = renderToStaticMarkup(element);
    expect(html).not.toContain("<select");
    expect(html).not.toContain("Funding type");
    expect(findElement(element, AssetMapLinkControl)!.props.canWrite).toBe(false);
  });

  it("uses the shared picker only with the separate firm-wide permission", () => {
    const element = card(fixture(), true, true);
    expect(findElement(element, TransferAcatPicker)!.props).toEqual({ transferId: "synthetic-transfer", variant: "inline" });
    const writable = renderToStaticMarkup(element);
    expect(writable).toContain("Find and link ACAT");
    expect(writable).not.toContain('href="/acat-tracking"');
    expect(renderToStaticMarkup(card(fixture()))).not.toContain("Find and link ACAT");
    const readOnly = renderToStaticMarkup(card(fixture(), false));
    expect(readOnly).toContain("No linked ACAT yet");
    expect(readOnly).not.toContain("Find and link ACAT");
    expect(readOnly).toContain("Synthetic map read-only");
  });

  it("does not offer ACAT linking for a DRS funding plan", () => {
    const element = card(fixture({ funding_type: "DRS" }), true, true);
    expect(findElement(element, TransferAcatPicker)).toBeNull();
    const html = renderToStaticMarkup(element);
    expect(html).not.toContain("Find and link ACAT");
    expect(html).not.toContain('href="/acat-tracking"');
  });

  it.each([
    { stage: "FUNDED" as const },
    { archived_at: new Date("2026-09-24T00:00:00Z") },
    { acat_record_id: "synthetic-linked" },
    { acat_transfer_id: "synthetic-linked-uuid" },
  ])("keeps the picker absent for non-linkable transfers: %j", (overrides) => {
    expect(findElement(card(fixture(overrides), true, true), TransferAcatPicker)).toBeNull();
  });

  it.each([
    { acat_record_id: "synthetic-record", acat_transfer_id: null, label: "ACAT record synthetic-record" },
    { acat_record_id: null, acat_transfer_id: "synthetic-uuid", label: "ACAT synthetic-uuid" },
  ])("preserves existing tracker link and status routing for $label", ({ label, ...ids }) => {
    const element = card(fixture(ids));
    expect(findElement(element, AcatStatusSection)!.props).toEqual({ acatRecordId: ids.acat_record_id, acatTransferId: ids.acat_transfer_id });
    const html = renderToStaticMarkup(element);
    expect(html).toContain(label);
    expect(html).toContain("View in ACAT Tracking");
    expect(html).toContain("Synthetic tracker status");
    expect(html).not.toContain("Link a live ACAT");
  });

  it("preserves linked status even on a non-ACAT rail and does not invent a link for an unlinked manual transfer", () => {
    const element = card(fixture({ funding_type: "MANUAL", acat_record_id: "synthetic-manual" }));
    expect(findElement(element, AcatStatusSection)!.props.acatRecordId).toBe("synthetic-manual");
    expect(renderToStaticMarkup(element)).toContain("Synthetic tracker status");
    const unlinked = renderToStaticMarkup(card(fixture({ funding_type: "MANUAL" })));
    expect(unlinked).not.toContain("Link a live ACAT");
    expect(unlinked).not.toContain("Synthetic tracker status");
  });

  it("preserves the asset-map feature gate while keeping the existing integration empty states", () => {
    flags.assetMap.mockReturnValue(false);
    const element = card(fixture());
    expect(findElement(element, AssetMapLinkControl)).toBeNull();
    const html = renderToStaticMarkup(element);
    expect(html).toContain("No household on file yet");
    expect(html).toContain("No asset map linked");
    expect(html).not.toContain("<select");
  });
});
