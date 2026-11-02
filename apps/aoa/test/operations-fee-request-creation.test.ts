import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

import { createOperationsFeeRequest } from "@/lib/data/operations-fee-requests";
import type { ParsedOperationsFeeRequest } from "@/lib/operations/fee-request";

const CLIENT_ID = "003V100000ABCDEF";
const ACCOUNT_ID = "opaque-account";

describe("Operations fee-request creation defaults", () => {
  afterEach(() => vi.unstubAllEnvs());

  let tx: {
    $executeRaw: ReturnType<typeof vi.fn>;
    $queryRaw: ReturnType<typeof vi.fn>;
    operationsFeeRequest: { create: ReturnType<typeof vi.fn>; findUnique: ReturnType<typeof vi.fn> };
    operationsFeeRequestEvent: { create: ReturnType<typeof vi.fn> };
  };

  beforeEach(() => {
    scopeSpy.mockReset();
    auditSpy.mockReset();
    tx = {
      $executeRaw: vi.fn().mockResolvedValue(1),
      $queryRaw: vi.fn()
        .mockResolvedValueOnce([{ sf_id: CLIENT_ID }])
        .mockResolvedValueOnce([{ custodian_account_id: ACCOUNT_ID }]),
      operationsFeeRequest: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({ id: "cmfee_request_123456" }),
      },
      operationsFeeRequestEvent: { create: vi.fn().mockResolvedValue({}) },
    };
    scopeSpy.mockImplementation(async (_identity: unknown, fn: (value: typeof tx) => unknown) => fn(tx));
  });

  it.each(["dev", "prod"])(
    "requires a current mirror client and owned account in %s", async (appEnv) => {
      vi.stubEnv("APP_ENV", appEnv);
      const input: ParsedOperationsFeeRequest = {
        kind: "FEE_CREDIT", clientSfId: CLIENT_ID, accountIds: [ACCOUNT_ID],
        feeTypes: ["Wire"], feeAmount: "25.00", waiverStart: null,
        waiverDurationMonths: null, indefiniteDuration: false, reason: "",
        relevantTicketRefs: [],
      };
      tx.$queryRaw.mockReset().mockResolvedValueOnce([]);
      await expect(createOperationsFeeRequest(
        { role: "OPERATIONS", email: "operator@example.test" }, input,
      )).rejects.toThrow("client_unavailable");
      expect(tx.operationsFeeRequest.create).not.toHaveBeenCalled();
      expect(tx.operationsFeeRequestEvent.create).not.toHaveBeenCalled();

      tx.$queryRaw.mockReset()
        .mockResolvedValueOnce([{ sf_id: CLIENT_ID }])
        .mockResolvedValueOnce([]);
      await expect(createOperationsFeeRequest(
        { role: "OPERATIONS", email: "operator@example.test" }, input,
      )).rejects.toThrow("account_unavailable");
      expect(tx.operationsFeeRequest.create).not.toHaveBeenCalled();
      expect(tx.operationsFeeRequestEvent.create).not.toHaveBeenCalled();
      expect(auditSpy).not.toHaveBeenCalled();
    },
  );

  it.each(["BILLING_EXCEPTION", "SERVICE_GUARANTEE"] as const)(
    "creates a new %s as pending without reviewer metadata",
    async (kind) => {
      const input: ParsedOperationsFeeRequest = {
        kind,
        clientSfId: CLIENT_ID,
        accountIds: [ACCOUNT_ID],
        feeTypes: [],
        feeAmount: null,
        waiverStart: "2026-10-01",
        waiverDurationMonths: 6,
        indefiniteDuration: false,
        reason: "Requires review.",
        relevantTicketRefs: [],
      };

      await expect(createOperationsFeeRequest(
        { role: "OPERATIONS", email: "Submitter@Example.com" },
        input,
      )).resolves.toBe("cmfee_request_123456");

      const createCall = tx.operationsFeeRequest.create.mock.calls[0]?.[0] as {
        data: Record<string, unknown>;
      };
      expect(createCall.data).toMatchObject({
        kind,
        status: "PENDING",
        submitted_by_email: "submitter@example.com",
        submitted_by_role: "OPERATIONS",
      });
      expect(createCall.data).not.toHaveProperty("reviewed_by_email");
      expect(createCall.data).not.toHaveProperty("reviewed_by_name");
      expect(createCall.data).not.toHaveProperty("reviewed_at");
      expect(tx.operationsFeeRequestEvent.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          request_id: "cmfee_request_123456",
          action: "SUBMITTED",
          actor_email: "submitter@example.com",
          actor_role: "OPERATIONS",
          from_status: null,
          to_status: "PENDING",
        }),
      });
    },
  );
});
