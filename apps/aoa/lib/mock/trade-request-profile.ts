import {
  deriveTradeRequestProfile,
  type TradeProfileSourceRecord,
  type TradeRequestProfile,
} from "@/lib/data/trade-request-profile";

export type DevTradeRequestScenario =
  | "approved_initial_funding"
  | "no_approved_request"
  | "conflicting_instructions"
  | "household_scope"
  | "risk_change"
  | "pending_only";

// The deployed development database is populated from the CRM mirror, so its
// client ids are not the retired local C-1…C-6 seed ids. Keep the preview
// independent of client names and assign a stable, contentful synthetic scenario
// to every real dev client using only the opaque CRM id. Empty and pending-only
// scenarios remain available for explicit tests of those business rules.
const VISIBLE_SCENARIOS: readonly DevTradeRequestScenario[] = [
  "approved_initial_funding",
  "conflicting_instructions",
  "household_scope",
  "risk_change",
];

function stableHash(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function requestPrefix(clientSfId: string): string {
  return `REQ-DEV-${stableHash(clientSfId).toString(36).toUpperCase().padStart(7, "0")}`;
}

export function devTradeRequestScenarioForClient(
  clientSfId: string,
): DevTradeRequestScenario {
  return VISIBLE_SCENARIOS[stableHash(clientSfId) % VISIBLE_SCENARIOS.length];
}

function recordsForScenario(
  clientSfId: string,
  scenario: DevTradeRequestScenario,
): TradeProfileSourceRecord[] {
  const prefix = requestPrefix(clientSfId);

  switch (scenario) {
    case "approved_initial_funding":
      return [
        {
          requestId: `${prefix}-01`,
          clientIds: [clientSfId],
          status: "Completed",
          tradeType: "Initial Funding",
          decidedAt: "2026-07-18T15:30:00.000Z",
          riskScore: 11,
          instructions: [
            { key: "objective", label: "Objective", value: "Capital preservation" },
            {
              key: "restrictions",
              label: "Restrictions",
              value: "No individual equities",
            },
            {
              key: "cash_reserve",
              label: "Cash reserve",
              value: "12 months of expenses",
            },
            {
              key: "tax_preference",
              label: "Tax preference",
              value: "Tax-aware implementation",
            },
          ],
        },
      ];

    case "no_approved_request":
      return [];

    case "conflicting_instructions":
      return [
        {
          requestId: `${prefix}-01`,
          clientIds: [clientSfId],
          status: "Approved",
          tradeType: "Initial Funding",
          decidedAt: "2026-05-03T14:00:00.000Z",
          riskScore: 14,
          instructions: [
            {
              key: "objective",
              label: "Objective",
              value: "Balanced growth with income",
            },
            {
              key: "restrictions",
              label: "Restrictions",
              value: "Do not buy tobacco companies",
            },
          ],
        },
        {
          requestId: `${prefix}-02`,
          clientIds: [clientSfId],
          status: "Approved",
          tradeType: "Initial Funding",
          decidedAt: "2026-05-04T14:00:00.000Z",
          riskScore: 14,
          instructions: [
            {
              key: "objective",
              label: "Objective",
              value: "Balanced growth with income",
            },
            {
              key: "restrictions",
              label: "Restrictions",
              value: "No client-directed restrictions",
            },
          ],
        },
      ];

    case "household_scope":
      return [
        {
          requestId: `${prefix}-01`,
          clientIds: [clientSfId, `${prefix}-HOUSEHOLD-MEMBER`],
          status: "Completed",
          tradeType: "Initial Funding",
          decidedAt: "2026-06-11T16:45:00.000Z",
          riskScore: 18,
          instructions: [
            {
              key: "objective",
              label: "Objective",
              value: "Household long-term growth",
            },
            {
              key: "tax_preference",
              label: "Tax preference",
              value: "Coordinate asset location across spouses",
            },
          ],
        },
      ];

    case "risk_change": {
      const initialRequestId = `${prefix}-01`;
      return [
        {
          requestId: initialRequestId,
          clientIds: [clientSfId],
          status: "Completed",
          tradeType: "Initial Funding",
          decidedAt: "2026-02-10T18:00:00.000Z",
          riskScore: 16,
          instructions: [
            {
              key: "objective",
              label: "Objective",
              value: "Long-term growth and income",
            },
            {
              key: "restrictions",
              label: "Restrictions",
              value: "No fossil-fuel producers",
            },
          ],
        },
        {
          requestId: `${prefix}-02`,
          clientIds: [clientSfId],
          status: "Approved",
          tradeType: "Rebalance",
          decidedAt: "2026-07-22T18:00:00.000Z",
          riskScore: 18,
          instructions: [
            {
              key: "objective",
              label: "Objective",
              value: "Long-term growth and income",
            },
            {
              key: "restrictions",
              label: "Restrictions",
              value: "No fossil-fuel producers",
            },
          ],
          supersedesRequestId: initialRequestId,
        },
      ];
    }

    case "pending_only":
      return [
        {
          requestId: `${prefix}-01`,
          clientIds: [clientSfId],
          status: "Pending Review",
          tradeType: "Initial Funding",
          decidedAt: "2026-08-01T13:00:00.000Z",
          riskScore: 20,
          instructions: [
            { key: "objective", label: "Objective", value: "Aggressive growth" },
          ],
        },
      ];
  }
}

export function devTradeRequestProfileForScenario(
  clientSfId: string,
  scenario: DevTradeRequestScenario,
): TradeRequestProfile {
  return deriveTradeRequestProfile(
    clientSfId,
    recordsForScenario(clientSfId, scenario),
  );
}

export function devTradeRequestProfileForClient(
  clientSfId: string,
): TradeRequestProfile {
  return devTradeRequestProfileForScenario(
    clientSfId,
    devTradeRequestScenarioForClient(clientSfId),
  );
}
