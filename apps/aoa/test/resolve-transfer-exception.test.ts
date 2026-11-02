// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DecisionCaseRow } from "@/lib/data/decision-cases";

const refresh = vi.hoisted(() => vi.fn());
const actions = vi.hoisted(() => ({ resolve: vi.fn(), create: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
vi.mock("@/auth", () => ({ auth: vi.fn() }));
vi.mock("@/app/(authenticated)/asset-transfer/actions", () => ({
  archiveTransfer: vi.fn(),
  dismissSyncFlag: vi.fn(),
  resumeDeferredTransfer: vi.fn(),
  saveClientRequest: vi.fn(),
  setAccountStatus: vi.fn(),
}));
vi.mock("@/app/(authenticated)/(workflow)/decision-center/actions", () => ({
  resolveDecisionCase: actions.resolve,
  createTransferExceptionDecision: actions.create,
}));

import { TransferExceptions, type ExceptionCase } from "@/components/asset-transfer/detail/DetailActions";
import { LinkedDecisionCases } from "@/components/transfers/LinkedDecisionCases";

const SUMMARY = "Synthetic registration reviewed; proceed with the saved plan.";

function exception(over: Partial<ExceptionCase> = {}): ExceptionCase {
  return {
    id: "decision-1",
    question: "Synthetic receiving registration needs review.",
    open: true,
    blocking: true,
    owner: "Operations",
    resolution: null,
    version: 0,
    ...over,
  };
}

function decision(over: Partial<DecisionCaseRow> = {}): DecisionCaseRow {
  return {
    id: "decision-1",
    source: "ASSET_TRANSFER",
    sourceLabel: null,
    sourceVersion: 1,
    sourceSnapshot: {
      fundingPlanVersion: 1,
      included: [],
      excluded: [],
      includedCount: 0,
      excludedCount: 0,
      positions: [],
    },
    transferId: "transfer-1",
    clientName: null,
    householdName: "Synthetic Household",
    category: "Exception",
    question: "Synthetic receiving registration needs review.",
    context: "",
    ownerTeam: "OPERATIONS",
    status: "OPEN",
    blocksTransfer: true,
    version: 0,
    resolutionCode: null,
    resolutionSummary: null,
    resolvedBy: null,
    resolvedAt: null,
    createdAt: "2026-10-24T00:00:00.000Z",
    tasks: [],
    events: [],
    ...over,
  };
}

async function approve(summary = SUMMARY) {
  fireEvent.click(screen.getByRole("button", { name: "Resolve" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Approved exception resolution" }), {
    target: { value: summary },
  });
  fireEvent.click(screen.getByRole("button", { name: "Approve resolution" }));
  await waitFor(() => expect(actions.resolve).toHaveBeenCalledTimes(1));
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Resolve on the transfer", () => {
  it("resolves an open blocking exception from the workspace transfer page", async () => {
    actions.resolve.mockResolvedValue({ ok: true, id: "decision-1" });
    render(createElement(TransferExceptions, {
      transferId: "transfer-1",
      canWrite: true,
      cases: [
        exception(),
        exception({ id: "decision-2", question: "Optional follow-up", blocking: false }),
        exception({ id: "decision-3", question: "Already resolved", open: false, resolution: "Kept." }),
      ],
    }));

    expect(screen.getAllByRole("button", { name: "Resolve" })).toHaveLength(1);
    await approve();
    expect(actions.resolve).toHaveBeenCalledWith({
      decisionId: "decision-1",
      baseVersion: 0,
      resolutionCode: "TRANSFER_EXCEPTION_APPROVED",
      resolutionSummary: SUMMARY,
    });
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it("resolves the same blocking exception when the workspace flag is off", async () => {
    actions.resolve.mockResolvedValue({ ok: true, id: "decision-1" });
    render(createElement(LinkedDecisionCases, {
      transferId: "transfer-1",
      canWrite: true,
      cases: [
        decision(),
        decision({ id: "decision-2", question: "Optional follow-up", blocksTransfer: false }),
        decision({ id: "decision-3", question: "Already resolved", status: "RESOLVED", resolutionSummary: "Kept." }),
      ],
    }));

    expect(screen.getAllByRole("button", { name: "Resolve" })).toHaveLength(1);
    await approve();
    expect(actions.resolve).toHaveBeenCalledWith({
      decisionId: "decision-1",
      baseVersion: 0,
      resolutionCode: "TRANSFER_EXCEPTION_APPROVED",
      resolutionSummary: SUMMARY,
    });
  });

  it("hides Resolve from a viewer on both transfer pages", () => {
    render(createElement(TransferExceptions, {
      transferId: "transfer-1",
      canWrite: false,
      cases: [exception()],
    }));
    expect(screen.queryByRole("button", { name: "Resolve" })).toBeNull();
    cleanup();

    render(createElement(LinkedDecisionCases, {
      transferId: "transfer-1",
      canWrite: false,
      cases: [decision()],
    }));
    expect(screen.queryByRole("button", { name: "Resolve" })).toBeNull();
    expect(screen.queryByRole("button", { name: "+ Escalate exception" })).toBeNull();
  });
});
