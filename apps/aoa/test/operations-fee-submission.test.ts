import { describe, expect, it } from "vitest";
import { feeSubmissionDigest, parseFeeSubmissionKey } from "@/lib/operations/fee-submission";
import type { ParsedOperationsFeeRequest } from "@/lib/operations/fee-request";

const key = "0f987ccf-55dd-4346-b8ef-1b30b128d210";
const request: ParsedOperationsFeeRequest = { kind: "FEE_CREDIT", clientSfId: "DEV-SYNTHETIC", accountIds: ["b", "a"], feeTypes: ["Wire", "Transaction"], feeAmount: "25.00", waiverStart: null, waiverDurationMonths: null, indefiniteDuration: false, reason: "Synthetic only", relevantTicketRefs: ["b", "a"] };
describe("actor-bound submission payload", () => {
  it("requires a UUIDv4 form key", () => expect(parseFeeSubmissionKey(key)).toBe(key));
  it.each([null, undefined, "", "anything", key + "\n", key.toUpperCase(), key.replace("4346", "1346")])("rejects invalid key", (value) => expect(() => parseFeeSubmissionKey(value)).toThrow());
  it("ignores selection order, not selected values", () => {
    expect(feeSubmissionDigest(request)).toBe(feeSubmissionDigest({ ...request, accountIds: ["a", "b"], feeTypes: ["Transaction", "Wire"], relevantTicketRefs: ["a", "b"] }));
    expect(feeSubmissionDigest(request)).not.toBe(feeSubmissionDigest({ ...request, accountIds: ["a"] }));
  });
  it("changes when a semantic field changes", () => {
    for (const changed of [{ feeAmount: "26.00" }, { reason: "Different" }, { clientSfId: "DEV-OTHER" }, { waiverDurationMonths: 2 }, { indefiniteDuration: true }]) {
      expect(feeSubmissionDigest({ ...request, ...changed })).not.toBe(feeSubmissionDigest(request));
    }
  });
  it("stores a hash, not the text", () => expect(feeSubmissionDigest(request)).toMatch(/^[a-f0-9]{64}$/));
});
