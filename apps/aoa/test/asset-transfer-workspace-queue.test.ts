import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { markCase } from "./acat-book-flywheel";

vi.mock("server-only", () => ({}));
vi.mock("@/auth", () => ({ auth: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), usePathname: () => "/asset-transfer" }));

import { workspaceStageLabel } from "@/lib/data/transfer-types";
import { parseTransferBoardQuery } from "@/lib/navigation/transfer-query";
import {
  DEFAULT_TASK_STATUS,
  groupByHousehold,
  queueEmptyCopy,
  queueRows,
  selectedTaskStatus,
  taskMatchesTeam,
  type TaskTeam,
  type WorkspaceTransfer,
} from "@/lib/transfers/workspace-queue";
import { TransferTable, TransfersView } from "@/components/asset-transfer/views/TransfersView";
import { WorkQueueView } from "@/components/asset-transfer/views/WorkQueueView";
import { ActivityView } from "@/components/asset-transfer/views/ActivityView";
import { MailingReport } from "@/components/asset-transfer/views/MailingReport";

const SUITE = "asset-transfer-workspace-queue";

function transfer(id: string, overrides: Partial<WorkspaceTransfer> = {}): WorkspaceTransfer {
  return {
    id, clientName: `Client ${id}`, clientFirstName: "Client", clientLastName: id, clientSfId: null, householdSfId: null, householdName: null,
    stage: "DECISION", fundingType: "ACAT_FULL", transferringFirm: "Synthetic Brokerage", receivingAccount: "Individual", value: 1000,
    dealId: null, dealName: null, dealRef: null, source: { institution: "Synthetic Brokerage", type: "Individual", last4: "0001" },
    destination: { type: "Individual", last4: null, opening: false }, receivingAccounts: [], appAuthorized: false, statement: null,
    outcome: null, rejection: null, receipts: 0,
    tasks: [{ id: `${id}-task`, transferId: id, title: "Collect statements", sortOrder: 1, status: "Ready", team: "Client Service", assignedTo: null, followUpOn: null }],
    ...overrides,
  };
}

function withTeams(teams: (TaskTeam | null)[]): WorkspaceTransfer {
  return transfer("T1", { tasks: teams.map((team, index) => ({ id: `task-${index}`, transferId: "T1", title: `Task ${team ?? "none"}`, sortOrder: index, status: "Ready", team, assignedTo: null, followUpOn: null })) });
}

const common = { scope: "", listHref: "/asset-transfer" };

describe("asset transfer workspace queue", () => {
  it("team-client-service", () => {
    const titles = queueRows([withTeams(["Client Service", "Operations / Client Service", "Operations", null])], { query: "", team: "Client Service", stage: null })
      .map(row => row.task.team);
    expect(titles).toEqual(["Client Service", "Operations / Client Service"]);
    expect(taskMatchesTeam("Client Service", "Operations")).toBe(false);
    markCase(SUITE, "team-client-service");
  });

  it("team-operations", () => {
    const titles = queueRows([withTeams(["Client Service", "Operations / Client Service", "Operations", null])], { query: "", team: "Operations", stage: null })
      .map(row => row.task.team);
    expect(titles).toEqual(["Operations / Client Service", "Operations"]);
    expect(taskMatchesTeam("Operations", "Client Service")).toBe(false);
    markCase(SUITE, "team-operations");
  });

  it("unknown-key", () => {
    expect(() => parseTransferBoardQuery(new URLSearchParams("unknown=1"))).toThrow("invalid_transfer_query");
    expect(() => parseTransferBoardQuery(new URLSearchParams("team=Advisors"))).toThrow("invalid_transfer_query");
    expect(() => parseTransferBoardQuery(new URLSearchParams("team=Operations&team=Client+Service"))).toThrow("invalid_transfer_query");
    expect(() => parseTransferBoardQuery(new URLSearchParams("view=board"))).toThrow("invalid_transfer_query");
    const parsed = parseTransferBoardQuery(new URLSearchParams("view=queue&taskStatus=Waiting&layout=flat&team=Operations&stage=DECISION"));
    expect(parsed.workspace).toEqual({ view: "queue", taskStatus: "Waiting", layout: "flat", team: "Operations", stage: "DECISION", followUp: null });
    markCase(SUITE, "unknown-key");
  });

  it("owner-unchanged", () => {
    expect(() => parseTransferBoardQuery(new URLSearchParams("owner=ADVISOR"))).toThrow("invalid_transfer_owner");
    expect(parseTransferBoardQuery(new URLSearchParams("owner=OPERATIONS")).owner).toBe("OPERATIONS");
    markCase(SUITE, "owner-unchanged");
  });

  it("stage-label-on-views", () => {
    const rows = [transfer("T1")];
    const markup = [
      renderToStaticMarkup(createElement(TransfersView, { transfers: rows, query: "", stage: null, outcome: null, ...common })),
      renderToStaticMarkup(createElement(WorkQueueView, { transfers: rows, query: "", taskStatus: null, team: null, stage: null, followUp: null, today: "2026-10-23", layout: null, household: "", householdName: null, ...common })),
      renderToStaticMarkup(createElement(ActivityView, { transfers: rows, activity: [{ id: "1", at: "2026-10-01T12:00:00.000Z", actor: "OPERATIONS", action: "transfer.update", transferId: "T1" }], query: "", ...common })),
      renderToStaticMarkup(createElement(MailingReport, { rows: [], transfers: rows, filters: { query: "", from: "", through: "" } })),
    ];
    for (const html of markup.slice(0, 2)) expect(html).toContain("Decision");
    for (const html of markup) expect(html).not.toContain("Preparation");
    markCase(SUITE, "stage-label-on-views");
  });

  it("stage-label-flag-off", () => {
    expect(workspaceStageLabel("DECISION", false)).toBe("Preparation");
    expect(workspaceStageLabel("DECISION", true)).toBe("Decision");
    expect(workspaceStageLabel("IN_TRANSFER", true)).toBe("In transfer");
    markCase(SUITE, "stage-label-flag-off");
  });

  it("household-group", () => {
    const rows = [
      transfer("T1", { householdSfId: "HH-SYN-1", householdName: "Synthetic Household One" }),
      transfer("T2", { householdSfId: "HH-SYN-1", householdName: "Synthetic Household One" }),
      transfer("T3", { householdSfId: "HH-SYN-2", householdName: "Synthetic Household Two" }),
    ];
    const groups = groupByHousehold(rows);
    expect(groups.map(group => [group.key, group.transfers.map(row => row.id)])).toEqual([
      ["household:HH-SYN-1", ["T1", "T2"]], ["household:HH-SYN-2", ["T3"]],
    ]);
    const one = renderToStaticMarkup(createElement(TransferTable, { transfers: groups[0].transfers, from: "household", ...common }));
    expect(one).toContain('data-transfer-id="T1"');
    expect(one).toContain('data-transfer-id="T2"');
    expect(one).not.toContain('data-transfer-id="T3"');
    expect(one).toContain("from=household");
    markCase(SUITE, "household-group");
  });

  it("empty-copy-and-default-ready", () => {
    expect(queueEmptyCopy("deal", "All")).toBe("No deals match these filters.");
    expect(queueEmptyCopy("deal", "Waiting")).toBe("No deals with waiting tasks match these filters.");
    expect(queueEmptyCopy("flat", "All")).toBe("No tasks match these filters.");
    expect(queueEmptyCopy("flat", "Completed")).toBe("No completed tasks match these filters.");
    expect(DEFAULT_TASK_STATUS).toBe("Ready");
    expect(selectedTaskStatus(null)).toBe("Ready");
    const html = renderToStaticMarkup(createElement(WorkQueueView, { transfers: [transfer("T1", { tasks: [] })], query: "", taskStatus: null, team: null, stage: null, followUp: null, today: "2026-10-23", layout: null, household: "", householdName: null, ...common }));
    expect(html).toContain("No deals with ready tasks match these filters.");
    markCase(SUITE, "empty-copy-and-default-ready");
  });
});
