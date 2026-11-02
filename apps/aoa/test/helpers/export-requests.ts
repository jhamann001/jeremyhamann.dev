import type { TradeRequest } from "@/lib/trade-requests/request-types";

// Synthetic Trade Request rows for the export tests. No real client data.
export function syntheticRequest(overrides: Partial<TradeRequest> = {}): TradeRequest {
  return {
    id: "REQ-SYN0001", clientId: "HH-901", clientName: "Synthetic Family", clientIds: ["HH-901"],
    clientNames: ["Synthetic Family"], advisor: "Rachel Moss", submittedBy: "Avery Stone",
    tradeType: "Initial Funding", tradeAmount: "250000", depositAccount: "", rebalanceAll: false,
    status: "Pending Review", date: "2026-10-15T14:00:00.000Z", updatedAt: "2026-10-15T15:00:00.000Z",
    selectedAccounts: ["SYN-1001"], totalValue: 1125000, priority: "Standard", advisorNotes: "",
    residence: "NY", liquidationApproval: "Yes", advisorExclusions: "", clientExclusions: "",
    esgFilters: { fossilFuels: false, none: true }, riskProfile: 14, baseAllocation: { equity: 67, fixed: 29.5, cash: 3.5 },
    equityStrategies: [], raiseCashReason: "", liquidityDeadline: null, liquidateOption: "", liquidatePositions: "",
    auditLog: [{ id: "a1", date: "2026-10-15T14:00:00.000Z", user: "Avery Stone", action: "Request Created", notes: "Initial submission" }],
    ...overrides,
  };
}

export const SYNTHETIC_EXPORTER = { name: "Riley Ops", email: "ops@example.invalid" };
