// The parts of the Trade Request service's shared types
// (trade-request shared/src/types.ts) that the workspace reads. Stored
// values are kept as strings so a value the service adds later still renders.

export type TradeRequestAuditEntry = {
  id?: string;
  date: string;
  user: string;
  action: string;
  notes: string;
  channel?: "standalone" | "aoa";
};

export type TradeRequestEquityStrategy = { id: number; benchmark: string; allocation: number; rationale: string };

export type TradeRequestAccountMetadata = {
  accountId?: string | null;
  accountNumber: string;
  accountType: string;
  balance: number;
};

export type TradeRequest = {
  id: string;
  clientId: string;
  clientName: string;
  clientIds: string[];
  clientNames: string[];
  advisor: string;
  submittedBy: string;
  tradeType: string;
  tradeAmount: string;
  depositAccount: string;
  rebalanceAll: boolean;
  status: string;
  date: string;
  updatedAt: string;
  selectedAccounts: string[];
  totalValue: number;
  priority: string;
  advisorNotes: string;
  residence: string;
  liquidationApproval: string;
  advisorExclusions: string;
  clientExclusions: string;
  esgFilters: Record<string, boolean | string | undefined> & { otherDescription?: string };
  riskProfile: number | null;
  baseAllocation: { equity: number; fixed: number; cash: number } | null;
  equityStrategies: TradeRequestEquityStrategy[];
  raiseCashReason: string;
  liquidityDeadline: string | null;
  liquidateOption: string;
  liquidatePositions: string;
  assetLocationMode?: string;
  accountMetadata?: TradeRequestAccountMetadata[];
  auditLog: TradeRequestAuditEntry[];
};

export type TradeRequestAccount = {
  id: string;
  clientId: string;
  accountNumber: string;
  accountType: string;
  balance: number;
};

export type TradeRequestClient = { id: string; name: string; accounts: TradeRequestAccount[] };

export type TradeRequestAccountExclusion = {
  id: string;
  accountId: string;
  ticker: string;
  kind: "advisor" | "client";
  reason: string;
  noBuy: boolean;
  noSell: boolean;
};

export type TradeRequestExporter = { name: string; email: string };
