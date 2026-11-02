import { beforeEach, describe, expect, it, vi } from "vitest";
import { markCase } from "./acat-book-flywheel";

const spies = vi.hoisted(() => ({
  auth: vi.fn(), scope: vi.fn(), read: vi.fn(), sync: vi.fn(), webhook: vi.fn(), redirect: vi.fn(),
  paperwork: vi.fn(), workspaceFlag: vi.fn(), paperworkFlag: vi.fn(), match: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/auth", () => ({ auth: spies.auth }));
vi.mock("@/lib/rls", () => ({ withUserScope: spies.scope }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: spies.redirect }));
vi.mock("@/lib/data/drs-workflow-store", () => ({
  readDrsWorkflowTasks: spies.read, syncDrsWorkflowTasks: spies.sync,
}));
vi.mock("@/lib/slack/closeout-webhook", () => ({ postCloseoutWebhook: spies.webhook }));
vi.mock("@/lib/crm/post-commit-signal", () => ({ scheduleCrmIdentityReconciliation: vi.fn() }));
vi.mock("@/lib/data/transfer-paperwork-store", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readPaperworkRecords: spies.paperwork,
}));
vi.mock("@/lib/flags", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  assetTransferWorkspaceEnabled: spies.workspaceFlag,
  paperworkRecordsEnabled: spies.paperworkFlag,
}));
vi.mock("@/lib/transfers/intake-gates", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  accountMatchBlocks: spies.match,
}));

import {
  initializeDrsWorkflow,
  recordAppAuthorization,
  recordFormReview,
  recordMailedPaperwork,
  recordReturnedSignature,
  recordSentPacket,
  updateTransfer,
} from "@/app/(authenticated)/asset-transfer/actions";
import { DRS_TASKS } from "@/lib/data/drs-workflow";
import { transferToFormValues } from "@/components/transfers/transfer-form";
import { formTitleVersion, routeLabel, titlesSectionComplete } from "@/lib/transfers/route-label";
import type { PaperworkRecords } from "@/lib/data/transfer-paperwork-store";

const SUITE = "asset-transfer-paperwork-gates";

function fixture(overrides: Record<string, unknown> = {}) {
  return {
    id: "paperwork-synthetic", source: "APP", stage: "DECISION", archived_at: null,
    client_first_name: "TEST", client_last_name: "PAPERWORK", value: 100,
    owner_kind: "OPERATIONS", owner_name: null, funding_type: "DRS",
    funding_plan_complete: true, funding_plan_version: 1,
    funding_plan_approved_at: new Date("2026-10-01T12:00:00Z"),
    accounts_opened_at_apex: false, funding_initiated: false, cash_in_flight: false,
    acat_transfer_id: null, acat_record_id: null,
    tasks: [], accounts: [], decisions: [], decision_cases: [],
    ...overrides,
  };
}

const allDrsTasks = () => DRS_TASKS.map((task) => ({ id: task.key, taskKey: task.taskKey, status: "TODO" }));

function records(overrides: Partial<PaperworkRecords> = {}): PaperworkRecords {
  return {
    appAuthorizationRecorded: false,
    sentPacketRecorded: false,
    returnedSignatureRecorded: false,
    mailedPaperworkRecorded: false,
    drsServiceRequestRecorded: false,
    latestFormReview: null,
    ...overrides,
  };
}

const reviewed = {
  reviewed: true,
  receiving_form_title: "TEST RECEIVING",
  source_form_title: "TEST SOURCE",
  title_owners_confirmed: formTitleVersion("TEST RECEIVING", "TEST SOURCE"),
  apex_account_id: "synthetic-account",
  form_id: "apex-acat-generic",
};

const reviewInput = {
  reviewed: true,
  receivingFormTitle: "TEST RECEIVING",
  sourceFormTitle: "TEST SOURCE",
  titleOwnersConfirmed: null,
  apexAccountId: "synthetic-account",
  formId: "apex-acat-generic",
};

const creator = () => ({ create: vi.fn(async () => ({ id: "synthetic-record" })) });

let row: ReturnType<typeof fixture>;
let tx: Record<string, unknown> & {
  transferFormReview: ReturnType<typeof creator>;
  transferSentPacket: ReturnType<typeof creator>;
  transferReturnedSignature: ReturnType<typeof creator>;
  transferAppAuthorization: ReturnType<typeof creator>;
  transferDrsServiceRequest: ReturnType<typeof creator>;
  transferMailedPaperwork: ReturnType<typeof creator>;
  auditLog: { create: ReturnType<typeof vi.fn> };
};

const asRole = (role: string) =>
  spies.auth.mockResolvedValue({ user: { role, email: "paperwork@example.invalid" } });

beforeEach(() => {
  vi.clearAllMocks();
  row = fixture();
  tx = {
    $queryRaw: vi.fn(async () => [{ id: row.id }]),
    transfer: { findUnique: vi.fn(async () => row), update: vi.fn(async () => ({})) },
    transferTask: { createMany: vi.fn() },
    transferAccountMatch: { findFirst: vi.fn(async () => null) },
    transferFormReview: creator(),
    transferSentPacket: creator(),
    transferReturnedSignature: creator(),
    transferAppAuthorization: creator(),
    transferDrsServiceRequest: creator(),
    transferMailedPaperwork: creator(),
    auditLog: { create: vi.fn(async () => ({})) },
  };
  asRole("CLIENT_SERVICE");
  spies.scope.mockImplementation(async (_identity, fn) => fn(tx));
  spies.read.mockResolvedValue(allDrsTasks());
  spies.sync.mockResolvedValue(DRS_TASKS.length);
  spies.workspaceFlag.mockReturnValue(true);
  spies.paperworkFlag.mockReturnValue(true);
  spies.match.mockReturnValue(false);
  spies.paperwork.mockResolvedValue(records());
});

describe("asset transfer paperwork gates", () => {
  it("unapproved-plan", async () => {
    row = fixture({ funding_type: "ACAT_FULL", funding_plan_approved_at: null });
    expect(await recordFormReview(row.id, reviewInput)).toMatchObject({ ok: false });
    expect(tx.transferFormReview.create).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
    markCase(SUITE, "unapproved-plan");
  });

  it("draft-copies-no-service-request", async () => {
    spies.paperwork.mockResolvedValue(records({ returnedSignatureRecorded: true, latestFormReview: reviewed }));
    expect(await recordFormReview(row.id, reviewInput)).toEqual({ ok: true });
    expect(await recordSentPacket(row.id)).toEqual({ ok: true });
    expect(await recordReturnedSignature(row.id)).toEqual({ ok: true });
    expect(await recordAppAuthorization(row.id)).toEqual({ ok: true });
    expect(await recordMailedPaperwork(row.id)).toEqual({ ok: true });
    expect(tx.transferDrsServiceRequest.create).not.toHaveBeenCalled();
    markCase(SUITE, "draft-copies-no-service-request");
  });

  it("flag-off", async () => {
    spies.paperworkFlag.mockReturnValue(false);
    expect(await recordSentPacket(row.id)).toMatchObject({ ok: false });
    expect(tx.transferSentPacket.create).not.toHaveBeenCalled();
    asRole("OPERATIONS");
    spies.paperwork.mockResolvedValue(records({ returnedSignatureRecorded: true }));
    expect(await initializeDrsWorkflow(row.id)).toEqual({ ok: true });
    expect(tx.transferDrsServiceRequest.create).not.toHaveBeenCalled();
    expect(spies.paperwork).not.toHaveBeenCalled();
    markCase(SUITE, "flag-off");
  });

  it("sent-packet-unreviewed", async () => {
    spies.paperwork.mockResolvedValue(records({ latestFormReview: { ...reviewed, reviewed: false } }));
    expect(await recordSentPacket(row.id)).toMatchObject({ ok: false });
    spies.paperwork.mockResolvedValue(records({ latestFormReview: null }));
    expect(await recordSentPacket(row.id)).toMatchObject({ ok: false });
    expect(tx.transferSentPacket.create).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
    markCase(SUITE, "sent-packet-unreviewed");
  });

  it("drs-signature-missing", async () => {
    asRole("OPERATIONS");
    spies.paperwork.mockResolvedValue(records({ returnedSignatureRecorded: false }));
    expect(await initializeDrsWorkflow(row.id)).toEqual({ ok: true });
    expect(tx.transferDrsServiceRequest.create).not.toHaveBeenCalled();
    markCase(SUITE, "drs-signature-missing");
  });

  it("drs-signature-recorded-later", async () => {
    asRole("OPERATIONS");
    spies.paperwork.mockResolvedValueOnce(records({ returnedSignatureRecorded: false }));
    expect(await initializeDrsWorkflow(row.id)).toEqual({ ok: true });
    expect(tx.transferDrsServiceRequest.create).not.toHaveBeenCalled();
    spies.paperwork.mockResolvedValueOnce(records({ returnedSignatureRecorded: true, drsServiceRequestRecorded: false }));
    expect(await initializeDrsWorkflow(row.id)).toEqual({ ok: true });
    expect(tx.transferDrsServiceRequest.create).toHaveBeenCalledTimes(1);
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
    const auditData = (tx.auditLog.create.mock.calls[0] as unknown as [{ data: { detail: string } }])[0].data;
    expect(JSON.parse(auditData.detail)).toEqual({
      paperworkRecord: "transfer_drs_service_request",
      recordId: expect.any(String),
    });
    markCase(SUITE, "drs-signature-recorded-later");
  });

  it("update-transfer-flags-on", async () => {
    asRole("OPERATIONS");
    row = fixture({ funding_type: "ACAT_FULL" });
    spies.paperwork.mockResolvedValue(records({ appAuthorizationRecorded: true, latestFormReview: reviewed }));
    const values = transferToFormValues(row as never);
    await updateTransfer(row.id, { ...values, next_step: "TEST NEXT STEP" });
    expect(spies.paperwork).toHaveBeenCalledTimes(1);
    expect(spies.paperwork).toHaveBeenCalledWith(tx, row.id);
    expect(spies.match).toHaveBeenCalled();
    const [, route, , , titlesComplete] = spies.match.mock.calls[0];
    expect(route).toBe(routeLabel("ACAT_FULL", true));
    expect(titlesComplete).toBe(titlesSectionComplete({
      receivingFormTitle: "TEST RECEIVING",
      sourceFormTitle: "TEST SOURCE",
      titleOwnersConfirmed: formTitleVersion("TEST RECEIVING", "TEST SOURCE"),
      receivingAccountTitle: null,
      sourceAccountTitle: null,
    }));
    expect(titlesComplete).toBe(true);
    markCase(SUITE, "update-transfer-flags-on");
  });

  it("update-transfer-flag-off", async () => {
    asRole("OPERATIONS");
    row = fixture({ funding_type: "ACAT_FULL" });
    spies.paperworkFlag.mockReturnValue(false);
    const values = transferToFormValues(row as never);
    await updateTransfer(row.id, { ...values, next_step: "TEST NEXT STEP" });
    expect(spies.paperwork).not.toHaveBeenCalled();
    expect(spies.match).toHaveBeenCalled();
    const [, route, , , titlesComplete] = spies.match.mock.calls[0];
    expect(route).toBe("");
    expect(titlesComplete).toBe(false);
    markCase(SUITE, "update-transfer-flag-off");
  });
});
