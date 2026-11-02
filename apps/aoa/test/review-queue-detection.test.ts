import { describe, expect, it } from "vitest";
import { detectTradeProfileReviews } from "@/lib/data/review-queue-detection";
import type { TradeRequestProfile } from "@/lib/data/trade-request-profile";

function profile(overrides: Partial<TradeRequestProfile> = {}): TradeRequestProfile {
  return {
    state: "account_review",
    instructions: [], instructionConflicts: [], risk: null, sources: [], excludedRequestCount: 0,
    accountReview: { state: "review", riskVaries: false, accounts: [], warnings: [] },
    ...overrides,
  };
}

function account(selection: "confirmed" | "stale" | "unavailable" | null, candidates = 2) {
  return {
    accountId: "raw-account-ulid",
    accountNumber: "****4J9A",
    accountType: "Brokerage",
    status: "OPEN",
    state: "ready" as const,
    instructions: [], instructionConflicts: [], risk: null, sources: [],
    candidates: Array.from({ length: candidates }, (_, index) => ({
      requestId: `REQ-${index}`, status: "Approved" as const,
      tradeType: "Initial Funding" as const, decidedAt: "2026-08-01T00:00:00Z",
      riskScore: null, instructions: [], scope: "client" as const,
    })),
    selection: selection ? { requestId: "REQ-0", state: selection } : null,
  };
}

describe("central review queue Trade Request detection", () => {
  it("surfaces multiple unconfirmed, stale and unavailable source decisions", () => {
    const multiple = detectTradeProfileReviews(profile({
      accountReview: { state: "review", riskVaries: false, accounts: [account(null)], warnings: [] },
    }));
    expect(multiple.map((issue) => issue.type)).toContain("TRADE_PROFILE_MULTIPLE_UNCONFIRMED");

    for (const [selection, expected] of [
      ["stale", "TRADE_PROFILE_SELECTION_STALE"],
      ["unavailable", "TRADE_PROFILE_SELECTION_UNAVAILABLE"],
    ] as const) {
      const result = detectTradeProfileReviews(profile({
        accountReview: { state: "review", riskVaries: false, accounts: [account(selection)], warnings: [] },
      }));
      expect(result.map((issue) => issue.type)).toContain(expected);
    }
  });

  it("surfaces an unconfirmed household request on an account until it is confirmed", () => {
    const pending = { ...account(null, 1), state: "scope_review" as const };
    const result = detectTradeProfileReviews(profile({
      accountReview: { state: "review", riskVaries: false, accounts: [pending], warnings: [] },
    }));
    expect(result).toEqual([{
      type: "TRADE_PROFILE_HOUSEHOLD_SCOPE",
      discriminator: "raw-account-ulid",
      summary: "An approved household request needs confirmation for this account",
      snapshot: { accountLast4: "4J9A", candidateCount: 1 },
    }]);

    const confirmed = detectTradeProfileReviews(profile({
      accountReview: {
        state: "consistent", riskVaries: false,
        accounts: [{ ...account("confirmed", 1), state: "ready" as const }], warnings: [],
      },
    }));
    expect(confirmed).toEqual([]);
  });

  it("raises only the household-scope item for an account awaiting a household request among several", () => {
    const pending = { ...account(null, 3), state: "scope_review" as const };
    const result = detectTradeProfileReviews(profile({
      accountReview: { state: "review", riskVaries: false, accounts: [pending], warnings: [] },
    }));
    expect(result).toEqual([{
      type: "TRADE_PROFILE_HOUSEHOLD_SCOPE",
      discriminator: "raw-account-ulid",
      summary: "An approved household request needs confirmation for this account",
      snapshot: { accountLast4: "4J9A", candidateCount: 3 },
    }]);
  });

  it("maps unmatched, inactive and missing-scope warnings", () => {
    const result = detectTradeProfileReviews(profile({
      accountReview: {
        state: "review", riskVaries: false, accounts: [],
        warnings: [
          { kind: "unmatched_request_account", requestId: "REQ-1", accountNumber: "****1111" },
          { kind: "inactive_request_account", requestId: "REQ-2", accountNumber: "****2222" },
          { kind: "missing_request_scope", requestId: "REQ-3", accountNumber: null },
        ],
      },
    }));
    expect(result.map((issue) => issue.type)).toEqual([
      "TRADE_PROFILE_UNMATCHED_ACCOUNT",
      "TRADE_PROFILE_INACTIVE_ACCOUNT",
      "TRADE_PROFILE_MISSING_ACCOUNT_SCOPE",
    ]);
  });

  it("surfaces valid per-account instruction and risk variation without copying facts", () => {
    const first = {
      ...account("confirmed", 1),
      accountId: "raw-account-one",
      accountNumber: "****1111",
      instructions: [{
        key: "equity", label: "Equity", value: "60%",
        sourceRequestId: "REQ-ONE", decidedAt: "2026-08-01T00:00:00Z",
      }],
      risk: {
        profile: { score: 15, tolerance: "Moderate", capacity: "Moderate", change: "No change" },
        sourceRequestId: "REQ-ONE", decidedAt: "2026-08-01T00:00:00Z", previousScore: null,
      },
    };
    const second = {
      ...account("confirmed", 1),
      accountId: "raw-account-two",
      accountNumber: "****2222",
      instructions: [{
        key: "equity", label: "Equity", value: "80%",
        sourceRequestId: "REQ-TWO", decidedAt: "2026-08-02T00:00:00Z",
      }],
      risk: {
        profile: { score: 20, tolerance: "Growth", capacity: "High", change: "+5" },
        sourceRequestId: "REQ-TWO", decidedAt: "2026-08-02T00:00:00Z", previousScore: 15,
      },
    };
    const result = detectTradeProfileReviews(profile({
      state: "account_variation",
      accountReview: {
        state: "varies", riskVaries: true, accounts: [first, second], warnings: [],
      },
    }));

    expect(result).toContainEqual({
      type: "TRADE_PROFILE_ACCOUNT_VARIATION",
      discriminator: "account-variation",
      summary: "Approved risk profiles or instructions differ across this client's accounts",
      snapshot: { accountCount: 2 },
    });
    expect(JSON.stringify(result)).not.toMatch(/60%|80%|REQ-ONE|REQ-TWO|raw-account/);
  });

  it("retains only masked last-four/count metadata in persisted snapshots", () => {
    const [issue] = detectTradeProfileReviews(profile({
      accountReview: { state: "review", riskVaries: false, accounts: [account(null)], warnings: [] },
    }));
    expect(issue.snapshot).toEqual({ accountLast4: "4J9A", candidateCount: 2 });
    expect(JSON.stringify(issue.snapshot)).not.toContain("raw-account-ulid");
    expect(JSON.stringify(issue.snapshot)).not.toContain("REQ-");
  });
});
