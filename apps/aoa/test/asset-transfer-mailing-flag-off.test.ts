import { describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";
import { markCase } from "./acat-book-flywheel";
import { MAILING_JOURNEYS, saveMailing } from "@/lib/transfers/mailing";

describe("asset transfer mailing flag off", () => {
  it("flag-off-no-insert", async () => {
    const create = vi.fn();
    const auditCreate = vi.fn();
    const tx = { transferMailing: { create }, auditLog: { create: auditCreate } } as unknown as Prisma.TransactionClient;
    const result = await saveMailing(
      tx,
      { role: "OPERATIONS", email: "ops@example.test" },
      "transfer-42",
      { reason: "Wet Signature", contents: ["Signed transfer paperwork"], contentsNote: "", journey: MAILING_JOURNEYS[0], postage: "" },
      false,
    );
    expect(result.ok).toBe(false);
    expect(create).not.toHaveBeenCalled();
    expect(auditCreate).not.toHaveBeenCalled();
    markCase("asset-transfer-mailing-flag-off", "flag-off-no-insert");
  });
});
