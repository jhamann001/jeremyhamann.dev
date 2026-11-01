// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { FeeScheduleIdentity } from "../src/lib/custodian-fee-documents";
import {
  backupIdAccepted,
  clearRetiredFeeScheduleBytes,
  readRetirementGates,
  retentionApproved,
} from "./retire-custodian-fee-schedule-bytes";

const APPROVAL_LINE = "retention-approved: ticket custodian fee-schedule bytes";

function client(rows: FeeScheduleIdentity[][]) {
  let call = 0;
  const updateMany = vi.fn();
  const fake = {
    custodianFeeScheduleDocument: {
      findMany: vi.fn(async () => rows[Math.min(call++, rows.length - 1)]),
      updateMany,
    },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(fake),
  };
  return fake;
}

describe("retire custodian fee-schedule bytes", () => {
  it("missing gates refuse before any file or database", () => {
    expect(readRetirementGates([])).toEqual({ ok: false, line: "retirement-refused: missing-gate" });
  });

  it("retention approval is one exact line", () => {
    expect(retentionApproved("approved")).toBe(false);
    expect(retentionApproved(APPROVAL_LINE)).toBe(true);
  });

  it("accepts a backup id of the required shape", () => {
    expect(backupIdAccepted("short")).toBe(false);
    expect(backupIdAccepted("backup-2026-10-20")).toBe(true);
  });

  it("refuses a checksum mismatch without clearing", async () => {
    const fake = client([[{ id: "doc-1", byteSize: 4, sha256: "aaa" }]]);
    await expect(clearRetiredFeeScheduleBytes(fake as never, [{ id: "doc-1", byteSize: 4, sha256: "bbb" }])).resolves.toEqual({
      refused: "checksum",
    });
    expect(fake.custodianFeeScheduleDocument.updateMany).not.toHaveBeenCalled();
  });

  it("clears matching content to null", async () => {
    const row = { id: "doc-1", byteSize: 4, sha256: "aaa" };
    const fake = client([[row], [row]]);
    await expect(clearRetiredFeeScheduleBytes(fake as never, [row])).resolves.toEqual({ cleared: 1 });
    expect(fake.custodianFeeScheduleDocument.updateMany).toHaveBeenCalledOnce();
    expect(fake.custodianFeeScheduleDocument.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["doc-1"] } },
      data: { content: null },
    });
  });

  it("refuses when the second comparison changes", async () => {
    const fake = client([
      [{ id: "doc-1", byteSize: 4, sha256: "aaa" }],
      [{ id: "doc-1", byteSize: 4, sha256: "bbb" }],
    ]);
    await expect(clearRetiredFeeScheduleBytes(fake as never, [{ id: "doc-1", byteSize: 4, sha256: "aaa" }])).rejects.toThrow(
      "retirement-refused: comparison-changed",
    );
    expect(fake.custodianFeeScheduleDocument.updateMany).not.toHaveBeenCalled();
  });
});
