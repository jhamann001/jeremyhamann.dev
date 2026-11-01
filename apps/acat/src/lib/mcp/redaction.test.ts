import { describe, expect, it } from "vitest";
import { markCase } from "@/lib/test-flywheel";
import { BOOK_RECORD_COLUMN_KEYS, maskIdentifier, redactAcatListItem, redactAcatForMachine, redactAcatDetail, redactAcatForMachineBook } from "./redaction";

describe("MCP redaction", () => {
  it("masks account identifiers to the last four characters", () => {
    expect(maskIdentifier("123456789")).toBe("*****6789");
    expect(maskIdentifier("1234")).toBe("****");
    expect(maskIdentifier(null)).toBeNull();
  });

  it("redacts list items instead of returning raw account values", () => {
    const redacted = redactAcatListItem({
      ...{ cedarRidgeUserId: "user-private", identityVersion: 9 },
      id: "rec_1",
      clientName: "Jane Client",
      status: "Submitted",
      controlNumber: "CTL-1",
      apexAccountId: "BLST123456",
      statementAccountNumber: "ACC987654",
      custodianName: "Fidelity",
      acatDate: "2026-05-01",
      statementAmount: 10000,
      createdAt: new Date("2026-05-01T12:00:00Z"),
    });
    expect(redacted.apexAccountId).toBe("******3456");
    expect(redacted.statementAccountNumber).toBe("*****7654");
    expect(redacted).not.toHaveProperty("notes");
    expect(redacted).not.toHaveProperty("cedarRidgeUserId");
    expect(redacted).not.toHaveProperty("identityVersion");
  });
});


it("keeps identity internals out of MCP detail and machine projections", () => {
  const record = { id: "synthetic", clientName: "Synthetic", cedarRidgeUserId: "user-private", identityVersion: 9,
    status: "Submitted", apexAccountId: "SYNTH123456", acatDate: "2026-01-01", lastUpdated: "2026-01-01", assets: [] };
  for (const payload of [redactAcatDetail(record), redactAcatForMachine(record)]) {
    expect(payload).not.toHaveProperty("cedarRidgeUserId");
    expect(payload).not.toHaveProperty("identityVersion");
  }
});

describe("redactAcatForMachineBook removedAt", () => {
  const base = {
    id: "R1", clientName: "Sarah Jenkins", status: "Submitted", apexAccountId: "BLSTACCTQZ7K",
    acatDate: "2026-06-30", lastUpdated: "2026-07-01T00:00:00Z", assets: [],
  };
  it("book projection returns call the client, sell winners, and Fidelity", () => {
    markCase("mcp-redaction", "book projection returns call the client, sell winners, and Fidelity");
    const projected = redactAcatForMachineBook({
      ...base,
      notes: "call the client",
      tradeInstructions: "sell winners",
      custodianName: "Fidelity",
    });
    expect(projected.notes).toBe("call the client");
    expect(projected.tradeInstructions).toBe("sell winners");
    expect(projected.custodianName).toBe("Fidelity");
  });

  it("book projection keeps existing book fields and masking", () => {
    const identifiers = { ...base, statementAccountNumber: "STMT00000061", dtccNumber: "0061", notes: "kept" };
    const before = redactAcatForMachineBook(identifiers);
    const after = redactAcatForMachineBook({
      ...identifiers,
      clientLinks: [{ cedarRidgeUserId: "u-a", client: { canonicalName: "Client A" } }],
      custodian: { avgProcessingDays: 5 },
    });
    expect(after.apexAccountId).toBe(maskIdentifier("BLSTACCTQZ7K"));
    expect(after.statementAccountNumber).toBe(maskIdentifier("STMT00000061"));
    expect(after.dtccNumber).toBe(maskIdentifier("0061"));
    const existing = Object.keys(before).filter((key) => !(BOOK_RECORD_COLUMN_KEYS as readonly string[]).includes(key));
    expect(existing.length).toBeGreaterThan(20);
    for (const key of existing) {
      expect(after[key as keyof typeof after], key).toEqual(before[key as keyof typeof before]);
    }
    markCase("mcp-redaction", "book projection keeps existing book fields and masking");
  });

  it("book projection single link sets cedarRidgeUserId", () => {
    const projected = redactAcatForMachineBook({
      ...base,
      clientLinks: [{ cedarRidgeUserId: "u-a", client: { canonicalName: "Client A" } }],
    });
    expect(projected.cedarRidgeUserId).toBe("u-a");
    expect(projected.needsClientLink).toBe(false);
    markCase("mcp-redaction", "book projection single link sets cedarRidgeUserId");
  });

  it("emits removedAt as the ISO removal time, null when the row is live", () => {
    expect(redactAcatForMachineBook({ ...base, deletedAt: new Date("2026-09-02T00:00:00Z") }).removedAt).toBe("2026-09-02T00:00:00.000Z");
    expect(redactAcatForMachineBook(base).removedAt).toBeNull();
    expect(redactAcatForMachineBook({ ...base, deletedAt: null }).removedAt).toBeNull();
  });
});

describe("redactAcatForMachine drawer reveal (ticket)", () => {
  const record = {
    id: "R1", clientName: "Sarah Jenkins", status: "Submitted", apexAccountId: "BLSTACCTQZ7K",
    statementAccountNumber: "STMT00000061", dtccNumber: "731", identityVersion: 7,
    acatDate: "2026-06-30",
    assets: [{ symbol: "AAPL", description: "Apple", cusip: "037833100", expectedQty: 1, actualQty: 1, mapStatus: "Mapped" }],
  };

  it("redaction: revealing DTCC leaves Apex, statement, and CUSIP masked", () => {
    markCase("mcp-redaction", "revealing DTCC leaves Apex, statement, and CUSIP masked");
    const revealed = redactAcatForMachine(record, { revealDtcc: true, includeIdentityVersion: true });
    expect(revealed.dtccNumber).toBe("0731");
    expect(revealed.identityVersion).toBe(7);
    expect(revealed.apexAccountId).toBe("********QZ7K");
    expect(revealed.statementAccountNumber).toBe("********0061");
    expect(revealed.assets[0].cusip).toBe("*****3100");
    expect(redactAcatForMachine({ ...record, dtccNumber: "" }, { revealDtcc: true }).dtccNumber).toBeNull();
  });

  it("redaction: a non-normalizable DTCC is returned as stored", () => {
    markCase("mcp-redaction", "a non-normalizable DTCC is returned as stored");
    expect(redactAcatForMachine({ ...record, dtccNumber: "AB" }, { revealDtcc: true }).dtccNumber).toBe("AB");
  });

  it("redaction: default keeps DTCC masked and the identity version absent", () => {
    markCase("mcp-redaction", "default keeps DTCC masked and the identity version absent");
    const masked = redactAcatForMachine(record);
    expect(masked.dtccNumber).toBe("****");
    expect(masked).not.toHaveProperty("identityVersion");
    expect(redactAcatForMachine(record, {}).dtccNumber).toBe("****");
  });

  it("machine read includes the fee Apex ticket and credit request id", () => {
    markCase("mcp-redaction", "machine read includes the fee Apex ticket and credit request id");
    const revealed = redactAcatForMachine({ ...record, feeApexTicket: "FEE-326", feeCreditRequestId: "CR-326" });
    expect(revealed.feeApexTicket).toBe("FEE-326");
    expect(revealed.feeCreditRequestId).toBe("CR-326");
    const absent = redactAcatForMachine(record);
    expect(absent.feeApexTicket).toBeNull();
    expect(absent.feeCreditRequestId).toBeNull();
  });
});
