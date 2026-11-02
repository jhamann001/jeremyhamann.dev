import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { scopeSpy, auditSpy } = vi.hoisted(() => ({
  scopeSpy: vi.fn(),
  auditSpy: vi.fn(async () => {}),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/rls", () => ({ withUserScope: scopeSpy }));
vi.mock("@/lib/audit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/audit")>()),
  writeAudit: auditSpy,
}));

import { transitionOperationsFeeRequest } from "@/lib/data/operations-fee-requests";

const root = process.cwd();
const migration = fs.readFileSync(
  path.join(root, "prisma/migrations/20260903221500_operations_fee_request_workflow/migration.sql"),
  "utf8",
);

describe("Operations fee-request workflow", () => {
  let tx: {
    operationsFeeRequest: {
      findUnique: ReturnType<typeof vi.fn>;
      updateMany: ReturnType<typeof vi.fn>;
    };
    operationsFeeRequestEvent: { create: ReturnType<typeof vi.fn> };
  };

  beforeEach(() => {
    scopeSpy.mockReset();
    auditSpy.mockReset();
    tx = {
      operationsFeeRequest: {
        findUnique: vi.fn().mockResolvedValue({ id: "cmfee_request_123456", kind: "FEE_CREDIT", status: "PENDING" }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      operationsFeeRequestEvent: { create: vi.fn().mockResolvedValue({}) },
    };
    scopeSpy.mockImplementation(async (_identity: unknown, fn: (value: typeof tx) => unknown) => fn(tx));
  });

  it("records an optimistic pending-to-approved decision with a same-transaction event and metadata-only audit", async () => {
    const result = await transitionOperationsFeeRequest(
      { role: "OPERATIONS", email: "Reviewer@Example.com" },
      { requestId: "cmfee_request_123456", action: "APPROVE", note: "Internal review context", creditedDate: null, apexRequestId: null },
    );

    expect(result).toBe("updated");
    expect(tx.operationsFeeRequest.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "cmfee_request_123456", status: "PENDING" },
      data: expect.objectContaining({ status: "APPROVED", reviewed_by_email: "reviewer@example.com" }),
    }));
    expect(tx.operationsFeeRequestEvent.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      action: "APPROVED", from_status: "PENDING", to_status: "APPROVED",
      detail: { note: "Internal review context" },
    }) });
    const auditDetail = (auditSpy.mock.calls[0] as unknown as [unknown, unknown, { detail: Record<string, unknown> }])?.[2]?.detail;
    expect(auditDetail).toMatchObject({ action: "APPROVED", notePresent: true });
    expect(JSON.stringify(auditDetail)).not.toContain("Internal review context");
  });

  it("records fee-credit completion evidence only after approval", async () => {
    tx.operationsFeeRequest.findUnique.mockResolvedValueOnce({ id: "cmfee_request_123456", kind: "FEE_CREDIT", status: "APPROVED" });
    const result = await transitionOperationsFeeRequest(
      { role: "ADMIN", email: "ops@example.com" },
      { requestId: "cmfee_request_123456", action: "CREDIT", note: "", creditedDate: "2026-09-03", apexRequestId: "APEX-123" },
    );
    expect(result).toBe("updated");
    expect(tx.operationsFeeRequest.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: "CREDITED",
        credited_at: new Date("2026-09-03T00:00:00.000Z"),
        apex_request_id: "APEX-123",
        completed_by_email: "ops@example.com",
      }),
    }));
  });

  it("refuses invalid transitions and preserves an optimistic conflict without an event", async () => {
    tx.operationsFeeRequest.findUnique.mockResolvedValueOnce({ id: "cmfee_request_123456", kind: "BILLING_EXCEPTION", status: "APPROVED" });
    expect(await transitionOperationsFeeRequest(
      { role: "OPERATIONS", email: "ops@example.com" },
      { requestId: "cmfee_request_123456", action: "CREDIT", note: "", creditedDate: "2026-09-03", apexRequestId: "APEX-123" },
    )).toBe("invalid");
    expect(tx.operationsFeeRequest.updateMany).not.toHaveBeenCalled();

    tx.operationsFeeRequest.findUnique.mockResolvedValueOnce({ id: "cmfee_request_123456", kind: "FEE_CREDIT", status: "PENDING" });
    tx.operationsFeeRequest.updateMany.mockResolvedValueOnce({ count: 0 });
    expect(await transitionOperationsFeeRequest(
      { role: "OPERATIONS", email: "ops@example.com" },
      { requestId: "cmfee_request_123456", action: "APPROVE", note: "", creditedDate: null, apexRequestId: null },
    )).toBe("conflict");
    expect(tx.operationsFeeRequestEvent.create).not.toHaveBeenCalled();
    expect(auditSpy).not.toHaveBeenCalled();
  });

  it("keeps request payloads immutable and constrains database transitions to Operations/Admin", () => {
    expect(migration).toContain("operations_fee_request_payload_immutable");
    expect(migration).toContain("operations_fee_request_transition_invalid");
    expect(migration).toContain("current_setting('app.user_role', true) IN ('ADMIN', 'OPERATIONS')");
    expect(migration).toContain('GRANT UPDATE (');
    expect(migration).not.toMatch(/GRANT\s+UPDATE\s+ON\s+"app"\."operations_fee_request"/i);
    expect(migration).not.toMatch(/GRANT[^;]*DELETE[^;]*operations_fee_request/i);
  });
});
