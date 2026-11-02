import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Prisma } from "@prisma/client";
import { markCase } from "./acat-book-flywheel";

const spies = vi.hoisted(() => ({ auth: vi.fn(), scope: vi.fn(), workspaceFlag: vi.fn(), roster: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/auth", () => ({ auth: spies.auth }));
vi.mock("@/lib/rls", () => ({ withUserScope: spies.scope }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  redirect: vi.fn(),
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("@/lib/slack/closeout-webhook", () => ({ postCloseoutWebhook: vi.fn() }));
vi.mock("@/lib/crm/post-commit-signal", () => ({ scheduleCrmIdentityReconciliation: vi.fn() }));
vi.mock("@/lib/flags", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  assetTransferWorkspaceEnabled: spies.workspaceFlag,
}));
vi.mock("@/lib/data/transfer-connections", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readTaskOwnerRoster: spies.roster,
}));

import { setTaskFollowUp } from "@/app/(authenticated)/asset-transfer/actions";
import { MAILING_CONTENTS, MAILING_REASONS, saveMailing, validateMailing } from "@/lib/transfers/mailing";
import { mailingContentsText } from "@/lib/transfers/mailing-journeys";
import {
  followUpEligible, followUpState, matchesFollowUpFilter, validateTaskFollowUp, type TaskFollowUpFields,
} from "@/lib/transfers/task-follow-up";
import { queueRows, type WorkspaceTask, type WorkspaceTransfer } from "@/lib/transfers/workspace-queue";
import { parseTransferBoardQuery } from "@/lib/navigation/transfer-query";
import { WorkQueueView } from "@/components/asset-transfer/views/WorkQueueView";

const SUITE = "asset-transfer-mockup-gaps";
const TODAY = "2026-10-23";
const JOURNEY = "Cedar Ridge to the final destination";

const mailing = (overrides: Partial<Parameters<typeof validateMailing>[0]> = {}) => ({
  reason: "Statement", contents: ["Statement"], contentsNote: "", journey: JOURNEY, postage: "", ...overrides,
});

const followUp = (overrides: Partial<TaskFollowUpFields> = {}): TaskFollowUpFields => ({
  status: "Waiting", assignedTo: null, followUpOn: null, ...overrides,
});

function task(id: string, overrides: Partial<WorkspaceTask> = {}): WorkspaceTask {
  return { id, transferId: "T1", title: `Task ${id}`, sortOrder: 0, status: "Waiting", team: "Client Service", assignedTo: null, followUpOn: null, ...overrides };
}

function transfer(tasks: WorkspaceTask[]): WorkspaceTransfer {
  return {
    id: "T1", clientName: "Synthetic Client", clientFirstName: "Synthetic", clientLastName: "Client", clientSfId: null, householdSfId: null,
    householdName: null, stage: "DECISION", fundingType: "ACAT_FULL", transferringFirm: "Synthetic Brokerage", receivingAccount: "Individual",
    value: 1000, dealId: null, dealName: null, dealRef: null, source: { institution: "Synthetic Brokerage", type: "Individual", last4: "0001" },
    destination: { type: "Individual", last4: null, opening: false }, receivingAccounts: [], appAuthorized: false, statement: null,
    outcome: null, rejection: null, receipts: 0, tasks,
  };
}

describe("mailing reason and envelope contents", () => {
  it("accepts-the-mockup-options", () => {
    expect(MAILING_REASONS).toEqual(["Statement", "Wet Signature", "Physical Check / Deposit Slip", "Physical Mail", "Deceased Client", "Other"]);
    expect(MAILING_CONTENTS).toHaveLength(10);
    const result = validateMailing(mailing({ reason: "Wet Signature", contents: ["Statement", "Signed transfer paperwork", "Statement"] }));
    expect(result.ok && result.value.contentItems).toEqual(["Signed transfer paperwork", "Statement"]);
    markCase(SUITE, "accepts-the-mockup-options");
  });

  it("refuses-free-text-reason-and-contents", () => {
    const errors = (input: ReturnType<typeof mailing>) => {
      const result = validateMailing(input);
      return result.ok ? [] : result.errors.map(error => error.field);
    };
    expect(errors(mailing({ reason: "Signature needed" }))).toEqual(["reason"]);
    expect(errors(mailing({ contents: [] }))).toEqual(["contents"]);
    expect(errors(mailing({ contents: ["TOA form"] }))).toEqual(["contents"]);
    expect(errors(mailing({ contents: ["Other"] }))).toEqual(["contentsNote"]);
    expect(errors(mailing({ contents: ["Other"], contentsNote: "Synthetic letter" }))).toEqual([]);
    markCase(SUITE, "refuses-free-text-reason-and-contents");
  });

  it("saves-structured-values", async () => {
    const create = vi.fn(async () => ({ id: "mail-1" }));
    const audit = vi.fn(async () => ({}));
    const tx = { transferMailing: { create }, auditLog: { create: audit } } as unknown as Prisma.TransactionClient;
    const result = await saveMailing(tx, { role: "CLIENT_SERVICE", email: "cs@example.test" }, "transfer-1",
      mailing({ reason: "Other", contents: ["Other", "Return shipping label"], contentsNote: "Synthetic estate note" }), true);
    expect(result).toEqual({ ok: true, id: "mail-1" });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        reason: "Other",
        content_items: ["Return shipping label", "Other"],
        contents_note: "Synthetic estate note",
        contents: "Return shipping label, Other — Synthetic estate note",
      }),
    }));
    const detail = JSON.parse((audit.mock.calls[0] as unknown as [{ data: { detail: string } }])[0].data.detail);
    expect(detail).toMatchObject({ reason: "Other", contentItems: ["Return shipping label", "Other"] });
    expect(JSON.stringify(detail)).not.toContain("Synthetic estate note");
    expect(mailingContentsText([], "Only a note")).toBe("Only a note");
    markCase(SUITE, "saves-structured-values");
  });
});

describe("task follow-up", () => {
  it("states-and-filters", () => {
    expect(followUpEligible(followUp({ status: "Ready" }))).toBe(false);
    expect(followUpEligible(followUp({ status: "Ready", assignedTo: "Synthetic Person" }))).toBe(true);
    expect(followUpState(followUp(), TODAY)).toBe("unassigned");
    expect(followUpState(followUp({ assignedTo: "A", followUpOn: "2026-10-22" }), TODAY)).toBe("overdue");
    expect(followUpState(followUp({ assignedTo: "A", followUpOn: TODAY }), TODAY)).toBe("today");
    expect(followUpState(followUp({ assignedTo: "A", followUpOn: "2026-10-24" }), TODAY)).toBe("scheduled");
    expect(followUpState(followUp({ status: "Completed", assignedTo: "A", followUpOn: "2026-10-01" }), TODAY)).toBe("completed");
    expect(matchesFollowUpFilter(followUp({ assignedTo: "A", followUpOn: TODAY }), "due", TODAY)).toBe(true);
    expect(matchesFollowUpFilter(followUp({ followUpOn: "2026-10-01" }), "due", TODAY)).toBe(true);
    expect(matchesFollowUpFilter(followUp({ assignedTo: "A", followUpOn: "2026-10-24" }), "due", TODAY)).toBe(false);
    expect(matchesFollowUpFilter(followUp({ status: "Completed", assignedTo: "A", followUpOn: "2026-10-01" }), "due", TODAY)).toBe(false);
    expect(matchesFollowUpFilter(followUp(), "missing", TODAY)).toBe(true);
    expect(matchesFollowUpFilter(followUp({ assignedTo: "A", followUpOn: "2026-10-24" }), "missing", TODAY)).toBe(false);
    expect(matchesFollowUpFilter(followUp({ status: "Ready" }), "missing", TODAY)).toBe(false);
    markCase(SUITE, "states-and-filters");
  });

  it("requires-person-and-date", () => {
    const fields = (assignedTo: string, followUpOn: string) => {
      const result = validateTaskFollowUp({ assignedTo, followUpOn });
      return result.ok ? [] : result.errors.map(error => error.field);
    };
    expect(fields("", "")).toEqual(["assignedTo", "followUpOn"]);
    expect(fields("Synthetic Person", "2026-02-30")).toEqual(["followUpOn"]);
    expect(fields("x".repeat(101), TODAY)).toEqual(["assignedTo"]);
    expect(validateTaskFollowUp({ assignedTo: "  Synthetic   Person ", followUpOn: TODAY })).toMatchObject({ ok: true, assignedTo: "Synthetic Person" });
    markCase(SUITE, "requires-person-and-date");
  });

  it("queue-follow-up-filter", () => {
    const tasks = [
      task("due", { assignedTo: "Synthetic Person", followUpOn: TODAY }),
      task("later", { assignedTo: "Synthetic Person", followUpOn: "2026-10-30" }),
      task("blank"),
      task("ready", { status: "Ready" }),
    ];
    const ids = (filter: "due" | "missing") =>
      queueRows([transfer(tasks)], { query: "", team: null, stage: null, followUp: { filter, today: TODAY } }).map(row => row.task.id);
    expect(ids("due")).toEqual(["due"]);
    expect(ids("missing")).toEqual(["blank"]);
    expect(parseTransferBoardQuery(new URLSearchParams("view=queue&followUp=due")).workspace.followUp).toBe("due");
    expect(() => parseTransferBoardQuery(new URLSearchParams("followUp=soon"))).toThrow("invalid_transfer_query");
    const html = renderToStaticMarkup(createElement(WorkQueueView, {
      transfers: [transfer(tasks)], query: "", taskStatus: "Waiting", team: null, stage: null, followUp: "due", today: TODAY,
      layout: "flat", household: "", householdName: null, scope: "", listHref: "/asset-transfer",
    }));
    expect(html).toContain('form="queue-filters" name="followUp"');
    for (const label of ["All follow-ups", "Due today &amp; overdue", "Needs owner or date"]) expect(html).toContain(label);
    expect(html).toMatch(/<option value="due" selected="">Due today &amp; overdue/);
    expect(html).toContain("Synthetic Person");
    expect(html).toContain("Due today");
    expect(html).not.toContain("Task later");
    markCase(SUITE, "queue-follow-up-filter");
  });
});

describe("setTaskFollowUp", () => {
  let row: { transfer_id: string; done: boolean; override_done: boolean | null; status: string; transfer: { archived_at: Date | null } };
  const update = vi.fn(async () => ({}));
  const audit = vi.fn(async () => ({}));

  beforeEach(() => {
    vi.clearAllMocks();
    row = { transfer_id: "T1", done: false, override_done: null, status: "Waiting", transfer: { archived_at: null } };
    spies.workspaceFlag.mockReturnValue(true);
    spies.roster.mockResolvedValue([
      { name: "A", email: "a@example.invalid" },
      { name: "Synthetic Person", email: "synthetic@example.invalid" },
    ]);
    spies.auth.mockResolvedValue({ user: { role: "CLIENT_SERVICE", email: "cs@example.invalid" } });
    spies.scope.mockImplementation(async (_identity, fn) => fn({
      transferTask: { findUnique: vi.fn(async () => row), update },
      auditLog: { create: audit },
    }));
  });

  it("saves-and-clears-with-id-only-audit", async () => {
    expect(await setTaskFollowUp("T1", "task-1", { assignedTo: "Synthetic Person", followUpOn: TODAY })).toEqual({ ok: true });
    expect(update).toHaveBeenCalledWith({
      where: { id: "task-1" },
      data: { assigned_to: "Synthetic Person", follow_up_on: new Date(`${TODAY}T00:00:00.000Z`) },
    });
    const detail = (audit.mock.calls[0] as unknown as [{ data: { detail: string } }])[0].data.detail;
    expect(JSON.parse(detail)).toEqual({ taskFollowUp: "task-1", cleared: false });
    expect(await setTaskFollowUp("T1", "task-1", null)).toEqual({ ok: true });
    expect(update).toHaveBeenLastCalledWith({ where: { id: "task-1" }, data: { assigned_to: null, follow_up_on: null } });
    markCase(SUITE, "saves-and-clears-with-id-only-audit");
  });

  it("refuses-blank-completed-other-transfer-role-and-flag", async () => {
    expect(await setTaskFollowUp("T1", "task-1", { assignedTo: "", followUpOn: "" })).toMatchObject({ ok: false });
    expect(await setTaskFollowUp("T1", "task-1", { assignedTo: "Someone Typed", followUpOn: TODAY })).toEqual({
      ok: false, errors: [expect.objectContaining({ field: "assignedTo", message: expect.stringContaining("roster") })],
    });
    row.status = "Completed";
    expect(await setTaskFollowUp("T1", "task-1", { assignedTo: "A", followUpOn: TODAY })).toMatchObject({ ok: false });
    row.status = "Waiting";
    expect(await setTaskFollowUp("T2", "task-1", { assignedTo: "A", followUpOn: TODAY })).toMatchObject({ ok: false });
    spies.auth.mockResolvedValue({ user: { role: "VIEWER", email: "viewer@example.invalid" } });
    expect(await setTaskFollowUp("T1", "task-1", { assignedTo: "A", followUpOn: TODAY })).toMatchObject({ ok: false });
    spies.auth.mockResolvedValue({ user: { role: "CLIENT_SERVICE", email: "cs@example.invalid" } });
    spies.workspaceFlag.mockReturnValue(false);
    expect(await setTaskFollowUp("T1", "task-1", { assignedTo: "A", followUpOn: TODAY })).toMatchObject({ ok: false });
    expect(update).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
    markCase(SUITE, "refuses-blank-completed-other-transfer-role-and-flag");
  });
});
