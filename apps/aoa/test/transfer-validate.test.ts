import { describe, expect, it } from "vitest";
import type { TransferInput } from "@/lib/data/transfer-types";
import { validateTransferInput } from "@/lib/data/transfer-validate";

// All data invented — no real client information.

function base(overrides: Partial<TransferInput> = {}): TransferInput {
  return {
    source: "APP",
    client_first_name: "Rae",
    client_last_name: "Winter",
    value: 250000,
    stage: "DECISION",
    owner_kind: "OPERATIONS",
    ...overrides,
  };
}

function fields(input: TransferInput): string[] {
  return validateTransferInput(input).errors.map((e) => e.field);
}

describe("validateTransferInput — valid inputs", () => {
  it("accepts a minimal APP row (optional fields omitted)", () => {
    const result = validateTransferInput(base());
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("accepts a fully-populated row", () => {
    const result = validateTransferInput(
      base({
        client_sf_id: "C-9",
        household_name: "Winter Household",
        household_sf_id: "HH-9001",
        stage: "IN_TRANSFER",
        owner_kind: "CLIENT_SERVICE",
        owner_name: "Kayden Altenwerth",
        next_step: "Open the receiving account.",
        next_step_owner: "Client Service",
        pending_nudge: "Open receiving accounts",
      }),
    );
    expect(result.ok).toBe(true);
  });

  it("accepts every stage and owner kind", () => {
    for (const stage of ["DECISION", "IN_TRANSFER", "FUNDED"] as const) {
      expect(validateTransferInput(base({ stage })).ok).toBe(true);
    }
    for (const owner_kind of [
      "OPERATIONS",
      "CLIENT_SERVICE",
      "ADVISOR",
    ] as const) {
      expect(validateTransferInput(base({ owner_kind })).ok).toBe(true);
    }
  });

  it("accepts a small positive value (0.01)", () => {
    expect(validateTransferInput(base({ value: 0.01 })).ok).toBe(true);
  });
});

describe("validateTransferInput — required identity", () => {
  it("rejects a missing first name", () => {
    expect(fields(base({ client_first_name: "" }))).toContain(
      "client_first_name",
    );
  });

  it("rejects a whitespace-only last name", () => {
    expect(fields(base({ client_last_name: "   " }))).toContain(
      "client_last_name",
    );
  });
});

describe("validateTransferInput — value", () => {
  it("rejects NaN", () => {
    expect(fields(base({ value: Number.NaN }))).toContain("value");
  });

  it("rejects Infinity", () => {
    expect(fields(base({ value: Number.POSITIVE_INFINITY }))).toContain(
      "value",
    );
  });

  it("rejects a non-number (raw form string)", () => {
    expect(
      fields(base({ value: "250000" as unknown as number })),
    ).toContain("value");
  });

  it("rejects zero (strictly positive contract)", () => {
    expect(fields(base({ value: 0 }))).toContain("value");
  });

  it("rejects a negative value", () => {
    expect(fields(base({ value: -5000 }))).toContain("value");
  });
});

describe("validateTransferInput — enum membership", () => {
  it("rejects an unknown stage", () => {
    expect(
      fields(base({ stage: "SETTLED" as TransferInput["stage"] })),
    ).toContain("stage");
  });

  it("rejects an unknown source", () => {
    expect(
      fields(base({ source: "SYNC" as TransferInput["source"] })),
    ).toContain("source");
  });

  it("rejects an unknown owner kind", () => {
    expect(
      fields(base({ owner_kind: "ADMIN" as TransferInput["owner_kind"] })),
    ).toContain("owner_kind");
  });
});

describe("validateTransferInput — funding_type (ticket Slice 2)", () => {
  it("accepts a null/omitted funding_type (nullable column)", () => {
    expect(validateTransferInput(base()).ok).toBe(true);
    expect(validateTransferInput(base({ funding_type: null })).ok).toBe(true);
  });

  it("accepts every legal funding type", () => {
    for (const funding_type of [
      "ACAT_FULL",
      "ACAT_PARTIAL",
      "DRS",
      "CHECK",
      "WIRE",
      "ACH",
      "MANUAL",
    ] as const) {
      expect(validateTransferInput(base({ funding_type })).ok).toBe(true);
    }
  });

  it("rejects an unknown funding type", () => {
    expect(
      fields(
        base({
          funding_type: "CRYPTO" as TransferInput["funding_type"],
        }),
      ),
    ).toContain("funding_type");
  });
});

describe("validateTransferInput — error accumulation", () => {
  it("reports every faulty field at once", () => {
    const result = validateTransferInput(
      base({
        client_first_name: "",
        client_last_name: " ",
        value: -1,
        stage: "NOPE" as TransferInput["stage"],
        source: "NOPE" as TransferInput["source"],
        owner_kind: "NOPE" as TransferInput["owner_kind"],
      }),
    );
    expect(result.ok).toBe(false);
    const errorFields = result.errors.map((e) => e.field).sort();
    expect(errorFields).toEqual(
      [
        "client_first_name",
        "client_last_name",
        "owner_kind",
        "source",
        "stage",
        "value",
      ].sort(),
    );
  });

  it("gives every error a non-blank message", () => {
    const result = validateTransferInput(base({ value: Number.NaN }));
    for (const error of result.errors) {
      expect(error.message.trim()).not.toBe("");
    }
  });
});
