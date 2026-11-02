import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TradeRequestProfileCards } from "@/components/client-portrait/TradeRequestProfileCards";
import {
  deriveAccountScopedTradeRequestProfileFromSummaries,
  deriveTradeRequestProfile,
  deriveTradeRequestProfileFromSummaries,
  tradeProfileRecordsFromSummaries,
  type TradeProfileSourceRecord,
} from "@/lib/data/trade-request-profile";
import type { TradeRequestSummary } from "@/lib/data/trade-requests";
import {
  devTradeRequestProfileForClient,
  devTradeRequestProfileForScenario,
  devTradeRequestScenarioForClient,
} from "@/lib/mock/trade-request-profile";

const DEV_CLIENT_ID = "003DEVCLIENT000001AA";

const ACCOUNT_A = {
  accountId: "apex-account-a",
  accountNumber: "JWSOMOOSA-6931",
  accountType: "Taxable",
  status: "OPEN",
};
const ACCOUNT_B = {
  accountId: "apex-account-b",
  accountNumber: "UQB-9535",
  accountType: "Traditional IRA",
  status: "OPEN",
};

function scopedRequest({
  id,
  accountId,
  accountNumber,
  riskScore = 18,
  instructions = [
    { key: "target_allocation", label: "Target allocation", value: "80% equity · 20% fixed income · 0% cash" },
  ],
  clientIds = ["CLIENT"],
}: {
  id: string;
  accountId: string | null;
  accountNumber: string;
  riskScore?: number;
  instructions?: Array<{ key: string; label: string; value: string }>;
  clientIds?: string[];
}): TradeRequestSummary {
  return {
    id,
    clientId: clientIds[0] ?? "CLIENT",
    clientIds,
    status: "Approved",
    tradeType: "Initial Funding",
    priority: "Standard",
    createdAt: "2026-07-10T00:00:00.000Z",
    updatedAt: "2026-07-10T00:00:00.000Z",
    totalValue: 100000,
    advisor: "Advisor",
    householdId: null,
    householdName: null,
    selectedAccounts: [accountNumber],
    accounts: [{ accountId, accountNumber, accountType: "Taxable", balance: 100000 }],
    liquidateOption: null,
    liquidationApproval: "Yes",
    profile: {
      decidedAt: "2026-07-10T00:00:00.000Z",
      riskScore,
      instructions,
    },
  };
}

describe("deriveTradeRequestProfile", () => {


  it("fails closed when an approved row arrives before its profile projection", () => {
    const clientId = "CLIENT";
    const request = {
      id: "REQ-OLD-CONTRACT",
      clientId,
      clientIds: [clientId],
      status: "Approved",
      tradeType: "Initial Funding",
      createdAt: "2026-07-10T00:00:00.000Z",
      updatedAt: "2026-07-10T00:00:00.000Z",
    } as TradeRequestSummary;

    expect(tradeProfileRecordsFromSummaries([request])).toEqual([]);
  });

  it("uses a completed Initial Funding request as an approved client profile", () => {
    const profile = devTradeRequestProfileForScenario(
      DEV_CLIENT_ID,
      "approved_initial_funding",
    );

    expect(profile.state).toBe("ready");
    expect(profile.risk?.profile.score).toBe(11);
    expect(profile.instructions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "restrictions",
          value: "No individual equities",
          sourceRequestId: expect.stringMatching(/^REQ-DEV-[A-Z0-9]+-01$/),
        }),
      ]),
    );
  });

  it("shows no profile when no approved allocation request exists", () => {
    expect(
      devTradeRequestProfileForScenario(DEV_CLIENT_ID, "no_approved_request"),
    ).toMatchObject({
      state: "none",
      instructions: [],
      risk: null,
      excludedRequestCount: 0,
    });

    expect(
      devTradeRequestProfileForScenario(DEV_CLIENT_ID, "pending_only"),
    ).toMatchObject({
      state: "none",
      instructions: [],
      risk: null,
      excludedRequestCount: 1,
    });
  });

  it("does not silently resolve contradictory approved instructions", () => {
    const profile = devTradeRequestProfileForScenario(
      DEV_CLIENT_ID,
      "conflicting_instructions",
    );

    expect(profile.state).toBe("conflict");
    expect(profile.instructionConflicts).toEqual([
      expect.objectContaining({
        key: "restrictions",
        options: expect.arrayContaining([
          expect.objectContaining({ value: "Do not buy tobacco companies" }),
          expect.objectContaining({ value: "No client-directed restrictions" }),
        ]),
      }),
    ]);
    expect(profile.instructions).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ key: "restrictions" })]),
    );
  });

  it("requires review instead of assigning a household profile to one client", () => {
    const profile = devTradeRequestProfileForScenario(
      DEV_CLIENT_ID,
      "household_scope",
    );

    expect(profile.state).toBe("household_review");
    expect(profile.risk).toBeNull();
    expect(profile.instructions).toEqual([]);
    expect(profile.sources).toEqual([
      expect.objectContaining({ scope: "household" }),
    ]);
  });

  it("does not ignore household ambiguity when a client-only request also exists", () => {
    const records: TradeProfileSourceRecord[] = [
      {
        requestId: "REQ-CLIENT",
        clientIds: ["CLIENT"],
        status: "Approved",
        tradeType: "Initial Funding",
        decidedAt: "2026-06-02T00:00:00.000Z",
        riskScore: 12,
        instructions: [
          { key: "objective", label: "Objective", value: "Balanced growth" },
        ],
      },
      {
        requestId: "REQ-HOUSEHOLD",
        clientIds: ["CLIENT", "SPOUSE"],
        status: "Completed",
        tradeType: "Initial Funding",
        decidedAt: "2026-06-01T00:00:00.000Z",
        riskScore: 18,
        instructions: [
          { key: "objective", label: "Objective", value: "Household growth" },
        ],
      },
    ];

    expect(deriveTradeRequestProfile("CLIENT", records)).toMatchObject({
      state: "household_review",
      instructions: [],
      risk: null,
      sources: expect.arrayContaining([
        expect.objectContaining({ requestId: "REQ-CLIENT", scope: "client" }),
        expect.objectContaining({ requestId: "REQ-HOUSEHOLD", scope: "household" }),
      ]),
    });
  });

  it("uses the latest approved score and retains the prior score as change context", () => {
    const profile = devTradeRequestProfileForScenario(
      DEV_CLIENT_ID,
      "risk_change",
    );

    expect(profile.state).toBe("ready");
    expect(profile.risk).toMatchObject({
      sourceRequestId: expect.stringMatching(/^REQ-DEV-[A-Z0-9]+-02$/),
      previousScore: 16,
      profile: {
        score: 18,
        tolerance: "Growth",
        capacity: "Not provided by Trade Request",
        change: "+2 vs prior approved score",
      },
    });
  });

  it("accepts changed instructions only with explicit supersession lineage", () => {
    const records: TradeProfileSourceRecord[] = [
      {
        requestId: "REQ-OLD",
        clientIds: ["CLIENT"],
        status: "Completed",
        tradeType: "Initial Funding",
        decidedAt: "2026-01-01T00:00:00.000Z",
        riskScore: 10,
        instructions: [
          { key: "objective", label: "Objective", value: "Preservation" },
        ],
      },
      {
        requestId: "REQ-NEW",
        clientIds: ["CLIENT"],
        status: "Approved",
        tradeType: "Rebalance",
        decidedAt: "2026-06-01T00:00:00.000Z",
        riskScore: 12,
        instructions: [
          { key: "objective", label: "Objective", value: "Balanced growth" },
        ],
        supersedesRequestId: "REQ-OLD",
      },
    ];

    const profile = deriveTradeRequestProfile("CLIENT", records);
    expect(profile.state).toBe("ready");
    expect(profile.instructions).toEqual([
      expect.objectContaining({
        value: "Balanced growth",
        sourceRequestId: "REQ-NEW",
      }),
    ]);
    expect(profile.instructionConflicts).toEqual([]);
  });

  it("excludes pending, rejected, and non-allocation requests", () => {
    const records: TradeProfileSourceRecord[] = [
      {
        requestId: "REQ-PENDING",
        clientIds: ["CLIENT"],
        status: "Pending Review",
        tradeType: "Initial Funding",
        decidedAt: "2026-06-01T00:00:00.000Z",
        riskScore: 20,
        instructions: [{ key: "objective", label: "Objective", value: "Growth" }],
      },
      {
        requestId: "REQ-REJECTED",
        clientIds: ["CLIENT"],
        status: "Rejected",
        tradeType: "Rebalance",
        decidedAt: "2026-06-02T00:00:00.000Z",
        riskScore: 5,
        instructions: [{ key: "objective", label: "Objective", value: "Preservation" }],
      },
      {
        requestId: "REQ-CASH",
        clientIds: ["CLIENT"],
        status: "Completed",
        tradeType: "Cash Deposit",
        decidedAt: "2026-06-03T00:00:00.000Z",
        riskScore: 25,
        instructions: [{ key: "objective", label: "Objective", value: "Speculation" }],
      },
    ];

    expect(deriveTradeRequestProfile("CLIENT", records)).toMatchObject({
      state: "none",
      risk: null,
      instructions: [],
      excludedRequestCount: 3,
    });
  });

  it("assigns every current dev client a stable, non-empty review scenario", () => {
    const currentDevClientIds = [
      "003DEVCLIENT000001AA",
      "003DEVCLIENT000002AA",
      "003DEVCLIENT000003AA",
      "003DEVCLIENT000004AA",
    ];

    for (const clientId of currentDevClientIds) {
      expect(devTradeRequestScenarioForClient(clientId)).toBe(
        devTradeRequestScenarioForClient(clientId),
      );
      const profile = devTradeRequestProfileForClient(clientId);
      expect(profile.state).not.toBe("none");
      expect(profile.sources.length).toBeGreaterThan(0);
    }
  });
});

describe("multi-account Trade Request profile", () => {
  it("collapses multiple accounts only when their approved profiles agree", () => {
    const requests = [
      scopedRequest({ id: "REQ-A", accountId: ACCOUNT_A.accountId, accountNumber: "****6931" }),
      scopedRequest({ id: "REQ-B", accountId: ACCOUNT_B.accountId, accountNumber: "****9535" }),
    ];

    const profile = deriveAccountScopedTradeRequestProfileFromSummaries(
      "CLIENT",
      requests,
      [ACCOUNT_A, ACCOUNT_B],
    );

    expect(profile.state).toBe("ready");
    expect(profile.accountReview).toMatchObject({
      state: "consistent",
      riskVaries: false,
      accounts: [{ state: "ready" }, { state: "ready" }],
      warnings: [],
    });
    expect(profile.sources.map((source) => source.requestId)).toEqual(["REQ-A", "REQ-B"]);
  });

  it("keeps valid differences separate and calls out different account risk scores", () => {
    const profile = deriveAccountScopedTradeRequestProfileFromSummaries(
      "CLIENT",
      [
        scopedRequest({
          id: "REQ-A",
          accountId: ACCOUNT_A.accountId,
          accountNumber: "****6931",
          riskScore: 25,
          instructions: [
            { key: "equity_strategy", label: "Equity strategy", value: "URTH 100%" },
          ],
        }),
        scopedRequest({
          id: "REQ-B",
          accountId: ACCOUNT_B.accountId,
          accountNumber: "****9535",
          riskScore: 18,
        }),
      ],
      [ACCOUNT_A, ACCOUNT_B],
    );

    expect(profile).toMatchObject({
      state: "account_variation",
      instructions: [],
      risk: null,
      accountReview: {
        state: "varies",
        riskVaries: true,
        accounts: [
          { accountNumber: "****6931", state: "ready", risk: { profile: { score: 25 } } },
          { accountNumber: "****9535", state: "ready", risk: { profile: { score: 18 } } },
        ],
      },
    });
  });

  it("flags contradictory approved instructions for the same account", () => {
    const restriction = (value: string) => [
      { key: "restrictions", label: "Restrictions", value },
    ];
    const profile = deriveAccountScopedTradeRequestProfileFromSummaries(
      "CLIENT",
      [
        scopedRequest({
          id: "REQ-OLD",
          accountId: ACCOUNT_A.accountId,
          accountNumber: "****6931",
          instructions: restriction("No fossil-fuel producers"),
        }),
        scopedRequest({
          id: "REQ-NEW",
          accountId: ACCOUNT_A.accountId,
          accountNumber: "****6931",
          instructions: restriction("None"),
        }),
      ],
      [ACCOUNT_A],
    );

    expect(profile.state).toBe("account_review");
    expect(profile.accountReview?.accounts[0]).toMatchObject({
      state: "conflict",
      instructionConflicts: [{ key: "restrictions" }],
    });
    expect(profile.accountReview?.accounts[0]?.candidates).toHaveLength(2);
  });

  it("uses a human-confirmed request as the complete account profile source", () => {
    const older = scopedRequest({
      id: "REQ-OLD",
      accountId: ACCOUNT_A.accountId,
      accountNumber: "****6931",
      riskScore: 20,
      instructions: [
        { key: "equity_strategy", label: "Equity strategy", value: "Other 100%" },
      ],
    });
    const newer = {
      ...scopedRequest({
        id: "REQ-CURRENT",
        accountId: ACCOUNT_A.accountId,
        accountNumber: "****6931",
        riskScore: 25,
        instructions: [
          { key: "equity_strategy", label: "Equity strategies", value: "IWV 65% · EFA 35%" },
        ],
      }),
      profile: {
        decidedAt: "2026-07-20T00:00:00.000Z",
        riskScore: 25,
        instructions: [
          { key: "equity_strategy", label: "Equity strategies", value: "IWV 65% · EFA 35%" },
        ],
      },
    };

    const profile = deriveAccountScopedTradeRequestProfileFromSummaries(
      "CLIENT",
      [newer, older],
      [ACCOUNT_A],
      {
        [ACCOUNT_A.accountId]: {
          requestId: "REQ-CURRENT",
          reviewedRequestIds: ["REQ-OLD", "REQ-CURRENT"],
        },
      },
    );

    expect(profile).toMatchObject({
      state: "ready",
      risk: { profile: { score: 25 } },
      instructions: [{ key: "equity_strategy", value: "IWV 65% · EFA 35%" }],
      accountReview: {
        state: "consistent",
        accounts: [
          {
            state: "ready",
            selection: { requestId: "REQ-CURRENT", state: "confirmed" },
          },
        ],
      },
    });
    expect(profile.sources.map((source) => source.requestId)).toEqual(["REQ-CURRENT"]);
  });

  it("reopens review when a qualifying request is newer than the confirmation", () => {
    const selected = scopedRequest({
      id: "REQ-SELECTED",
      accountId: ACCOUNT_A.accountId,
      accountNumber: "****6931",
      instructions: [
        { key: "restrictions", label: "Restrictions", value: "None" },
      ],
    });
    const later = {
      ...scopedRequest({
        id: "REQ-LATER",
        accountId: ACCOUNT_A.accountId,
        accountNumber: "****6931",
        instructions: [
          { key: "restrictions", label: "Restrictions", value: "No tobacco" },
        ],
      }),
      profile: {
        decidedAt: "2026-07-21T00:00:00.000Z",
        riskScore: 18,
        instructions: [
          { key: "restrictions", label: "Restrictions", value: "No tobacco" },
        ],
      },
    };

    const profile = deriveAccountScopedTradeRequestProfileFromSummaries(
      "CLIENT",
      [later, selected],
      [ACCOUNT_A],
      {
        [ACCOUNT_A.accountId]: {
          requestId: "REQ-SELECTED",
          reviewedRequestIds: ["REQ-SELECTED"],
        },
      },
    );

    expect(profile.state).toBe("account_review");
    expect(profile.accountReview?.accounts[0]).toMatchObject({
      state: "conflict",
      selection: { requestId: "REQ-SELECTED", state: "stale" },
    });
  });

  it("keeps an intentionally selected older request confirmed when every candidate was reviewed", () => {
    const older = scopedRequest({
      id: "REQ-OLDER-CORRECT",
      accountId: ACCOUNT_A.accountId,
      accountNumber: "****6931",
      riskScore: 20,
    });
    const later = {
      ...scopedRequest({
        id: "REQ-LATER-REJECTED-BY-REVIEWER",
        accountId: ACCOUNT_A.accountId,
        accountNumber: "****6931",
        riskScore: 25,
      }),
      profile: {
        decidedAt: "2026-07-21T00:00:00.000Z",
        riskScore: 25,
        instructions: [
          { key: "target_allocation", label: "Target allocation", value: "100% equity" },
        ],
      },
    };

    const profile = deriveAccountScopedTradeRequestProfileFromSummaries(
      "CLIENT",
      [later, older],
      [ACCOUNT_A],
      {
        [ACCOUNT_A.accountId]: {
          requestId: "REQ-OLDER-CORRECT",
          reviewedRequestIds: [
            "REQ-OLDER-CORRECT",
            "REQ-LATER-REJECTED-BY-REVIEWER",
          ],
        },
      },
    );

    expect(profile).toMatchObject({
      state: "ready",
      risk: { profile: { score: 20 } },
      accountReview: {
        state: "consistent",
        accounts: [
          {
            selection: { requestId: "REQ-OLDER-CORRECT", state: "confirmed" },
          },
        ],
      },
    });
  });

  it("flags an unmatched request account instead of joining on masked digits", () => {
    const profile = deriveAccountScopedTradeRequestProfileFromSummaries(
      "CLIENT",
      [scopedRequest({ id: "REQ-X", accountId: "unknown-account", accountNumber: "****6931" })],
      [ACCOUNT_A],
    );

    expect(profile.state).toBe("account_review");
    expect(profile.accountReview).toMatchObject({
      state: "review",
      accounts: [{ accountId: ACCOUNT_A.accountId, state: "missing" }],
      warnings: [
        {
          kind: "unmatched_request_account",
          requestId: "REQ-X",
          accountNumber: "****6931",
        },
      ],
    });
  });

  it("flags an active account with no approved source", () => {
    const profile = deriveAccountScopedTradeRequestProfileFromSummaries(
      "CLIENT",
      [scopedRequest({ id: "REQ-A", accountId: ACCOUNT_A.accountId, accountNumber: "****6931" })],
      [ACCOUNT_A, ACCOUNT_B],
    );

    expect(profile.state).toBe("account_review");
    expect(profile.accountReview?.accounts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ accountId: ACCOUNT_A.accountId, state: "ready" }),
        expect.objectContaining({ accountId: ACCOUNT_B.accountId, state: "missing" }),
      ]),
    );
  });

  it("calls out requests tied to an inactive account without requiring that account for coverage", () => {
    const closedAccount = { ...ACCOUNT_B, status: "CLOSED" };
    const profile = deriveAccountScopedTradeRequestProfileFromSummaries(
      "CLIENT",
      [
        scopedRequest({ id: "REQ-A", accountId: ACCOUNT_A.accountId, accountNumber: "****6931" }),
        scopedRequest({ id: "REQ-CLOSED", accountId: ACCOUNT_B.accountId, accountNumber: "****9535" }),
      ],
      [ACCOUNT_A, closedAccount],
    );

    expect(profile.state).toBe("account_review");
    expect(profile.accountReview?.accounts).toHaveLength(1);
    expect(profile.accountReview?.warnings).toContainEqual({
      kind: "inactive_request_account",
      requestId: "REQ-CLOSED",
      accountNumber: "****9535",
    });
  });

  it("holds a household request on the account it names until a person confirms it", () => {
    const household = scopedRequest({
      id: "REQ-HOUSEHOLD",
      accountId: ACCOUNT_A.accountId,
      accountNumber: "****6931",
      riskScore: 22,
      clientIds: ["CLIENT", "SPOUSE"],
    });

    const pending = deriveAccountScopedTradeRequestProfileFromSummaries(
      "CLIENT",
      [household],
      [ACCOUNT_A],
    );
    expect(pending).toMatchObject({
      state: "account_review",
      risk: null,
      accountReview: {
        state: "review",
        warnings: [],
        accounts: [
          {
            state: "scope_review",
            risk: null,
            instructions: [],
            candidates: [{ requestId: "REQ-HOUSEHOLD", scope: "household" }],
            selection: null,
          },
        ],
      },
    });
    expect(pending.sources).toEqual([
      expect.objectContaining({ requestId: "REQ-HOUSEHOLD", scope: "household" }),
    ]);

    const confirmed = deriveAccountScopedTradeRequestProfileFromSummaries(
      "CLIENT",
      [household],
      [ACCOUNT_A],
      {
        [ACCOUNT_A.accountId]: {
          requestId: "REQ-HOUSEHOLD",
          reviewedRequestIds: ["REQ-HOUSEHOLD"],
        },
      },
    );
    expect(confirmed).toMatchObject({
      state: "ready",
      risk: { profile: { score: 22 }, sourceRequestId: "REQ-HOUSEHOLD" },
      accountReview: {
        state: "consistent",
        accounts: [{ state: "ready", selection: { state: "confirmed" } }],
      },
    });
    expect(confirmed.sources).toEqual([
      expect.objectContaining({ requestId: "REQ-HOUSEHOLD", scope: "household" }),
    ]);
  });

  it("does not let an unconfirmed household request fall back to older client-only values", () => {
    const own = scopedRequest({
      id: "REQ-OWN",
      accountId: ACCOUNT_A.accountId,
      accountNumber: "****6931",
      riskScore: 12,
    });
    const household = scopedRequest({
      id: "REQ-HOUSEHOLD",
      accountId: ACCOUNT_A.accountId,
      accountNumber: "****6931",
      riskScore: 22,
      clientIds: ["CLIENT", "SPOUSE"],
    });

    const profile = deriveAccountScopedTradeRequestProfileFromSummaries(
      "CLIENT",
      [own, household],
      [ACCOUNT_A],
    );
    expect(profile.accountReview?.accounts[0]).toMatchObject({
      state: "scope_review",
      risk: null,
      candidates: expect.arrayContaining([
        expect.objectContaining({ requestId: "REQ-OWN", scope: "client" }),
        expect.objectContaining({ requestId: "REQ-HOUSEHOLD", scope: "household" }),
      ]),
    });

    const reopened = deriveAccountScopedTradeRequestProfileFromSummaries(
      "CLIENT",
      [own, household],
      [ACCOUNT_A],
      { [ACCOUNT_A.accountId]: { requestId: "REQ-OWN", reviewedRequestIds: ["REQ-OWN"] } },
    );
    expect(reopened.accountReview?.accounts[0]).toMatchObject({
      state: "scope_review",
      risk: null,
      selection: { requestId: "REQ-OWN", state: "stale" },
    });
  });

  it("leaves a client's own accounts alone when a household request names only another member's account", () => {
    const profile = deriveAccountScopedTradeRequestProfileFromSummaries(
      "CLIENT",
      [
        scopedRequest({ id: "REQ-OWN", accountId: ACCOUNT_B.accountId, accountNumber: "****9535", riskScore: 19 }),
        scopedRequest({
          id: "REQ-SPOUSE-JOINT",
          accountId: "spouse-joint-account",
          accountNumber: "****4410",
          clientIds: ["SPOUSE", "CLIENT"],
        }),
      ],
      [ACCOUNT_B],
    );

    expect(profile).toMatchObject({
      state: "ready",
      risk: { profile: { score: 19 }, sourceRequestId: "REQ-OWN" },
      excludedRequestCount: 0,
      accountReview: { state: "consistent", warnings: [] },
    });
    expect(profile.sources.map((source) => source.requestId)).toEqual(["REQ-OWN"]);
  });

  it("still flags a household request with no account scope", () => {
    const profile = deriveAccountScopedTradeRequestProfileFromSummaries(
      "CLIENT",
      [
        {
          ...scopedRequest({
            id: "REQ-HOUSEHOLD",
            accountId: null,
            accountNumber: "",
            clientIds: ["CLIENT", "SPOUSE"],
          }),
          accounts: [],
        },
      ],
      [ACCOUNT_A],
    );

    expect(profile.state).toBe("account_review");
    expect(profile.accountReview?.warnings).toEqual([
      { kind: "missing_request_scope", requestId: "REQ-HOUSEHOLD", accountNumber: null },
    ]);
  });
});

describe("TradeRequestProfileCards", () => {
  it("renders synthetic provenance and unresolved conflicts clearly", () => {
    const html = renderToStaticMarkup(
      React.createElement(TradeRequestProfileCards, {
        profile: devTradeRequestProfileForScenario(
          DEV_CLIENT_ID,
          "conflicting_instructions",
        ),
      }),
    );

    expect(html).toContain("Synthetic data only");
    expect(html).toContain("Contradictory approved instructions found");
    expect(html).toContain("Do not buy tobacco companies");
    expect(html).toContain("No client-directed restrictions");
    expect(html).toContain("Each development client receives a stable review scenario");
    expect(html).toContain("REQ-DEV-");
  });

  it("renders household ambiguity without displaying its score as client risk", () => {
    const html = renderToStaticMarkup(
      React.createElement(TradeRequestProfileCards, {
        profile: devTradeRequestProfileForScenario(DEV_CLIENT_ID, "household_scope"),
      }),
    );

    expect(html).toContain("Client-level scope is not established");
    expect(html).toContain("household scope");
    expect(html).not.toContain("Risk score 18 of 25");
  });

  it("explains that a pending request was excluded", () => {
    const html = renderToStaticMarkup(
      React.createElement(TradeRequestProfileCards, {
        profile: devTradeRequestProfileForScenario(DEV_CLIENT_ID, "pending_only"),
      }),
    );

    expect(html).toContain("No approved investment instructions on file");
    expect(html).toContain("No approved risk score on file");
    expect(html).toContain("1 pending, rejected, or non-allocation request was excluded");
    expect(html).not.toContain("Aggressive growth");
  });

  it("renders approved differences by account without the synthetic banner", () => {
    const profile = deriveAccountScopedTradeRequestProfileFromSummaries(
      "CLIENT",
      [
        scopedRequest({
          id: "REQ-A",
          accountId: ACCOUNT_A.accountId,
          accountNumber: "****6931",
          riskScore: 25,
          instructions: [
            { key: "equity_strategy", label: "Equity strategy", value: "URTH 100%" },
          ],
        }),
        scopedRequest({
          id: "REQ-B",
          accountId: ACCOUNT_B.accountId,
          accountNumber: "****9535",
          riskScore: 18,
        }),
      ],
      [ACCOUNT_A, ACCOUNT_B],
    );
    const html = renderToStaticMarkup(
      React.createElement(TradeRequestProfileCards, { profile, source: "live" }),
    );

    expect(html).toContain("Varies by account");
    expect(html).toContain("Investment profile varies by account");
    expect(html).toContain("Taxable");
    expect(html).toContain("Traditional IRA");
    expect(html).toContain("****6931");
    expect(html).toContain("****9535");
    expect(html).toContain("Risk score 25 of 25");
    expect(html).toContain("Risk score 18 of 25");
    expect(html).not.toContain("Synthetic data only");
  });

  it("renders unmatched and missing account review details", () => {
    const profile = deriveAccountScopedTradeRequestProfileFromSummaries(
      "CLIENT",
      [
        scopedRequest({
          id: "REQ-X",
          accountId: "unknown-account",
          accountNumber: "****9999",
        }),
      ],
      [ACCOUNT_A],
    );
    const html = renderToStaticMarkup(
      React.createElement(TradeRequestProfileCards, { profile, source: "live" }),
    );

    expect(html).toContain("Account-level review is required");
    expect(html).toContain("REQ-X references account ****9999");
    expect(html).toContain("No approved Initial Funding or Rebalance request");
  });

  it("renders an unconfirmed household request as account scope review without its score", () => {
    const profile = deriveAccountScopedTradeRequestProfileFromSummaries(
      "CLIENT",
      [
        scopedRequest({
          id: "REQ-HOUSEHOLD",
          accountId: ACCOUNT_A.accountId,
          accountNumber: "****6931",
          riskScore: 22,
          clientIds: ["CLIENT", "SPOUSE"],
        }),
      ],
      [ACCOUNT_A],
    );
    const html = renderToStaticMarkup(
      React.createElement(TradeRequestProfileCards, { profile, source: "live" }),
    );

    expect(html).toContain("Scope review");
    expect(html).toContain("also includes another household member");
    expect(html).toContain("household request awaiting confirmation");
    expect(html).toContain("household scope");
    expect(html).not.toContain("Risk score 22 of 25");
  });
});
