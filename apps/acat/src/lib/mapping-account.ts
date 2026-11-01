/** Safe source context for the account picker and saved link (masked identifiers). */
export interface MappingAccount {
  id: string;
  clientName: string;
  holder: string;
  custodian: string;
  registration: string;
  accountNumberLast4: string | null;
  investorNumberLast4: string | null;
  statementDate: string | null;
  processedAt: string | null;
  isHistorical: boolean;
  positionCount: number;
}

export function mappingAccountSummary(raw: Record<string, unknown>): MappingAccount {
  const text = (key: string) => typeof raw[key] === "string" ? raw[key] as string : "";
  return {
    id: text("id"),
    clientName: text("client_name"),
    holder: text("account_holder"),
    custodian: text("custodian"),
    registration: text("account_registration") || text("account_type_raw") || text("account_type"),
    accountNumberLast4: text("account_number").slice(-4) || null,
    investorNumberLast4: text("investor_number").slice(-4) || null,
    statementDate: text("statement_date") || null,
    processedAt: text("processed_at") || null,
    isHistorical: raw.is_historical === true,
    positionCount: Array.isArray(raw.positions) ? raw.positions.length : Number(raw.position_count) || 0,
  };
}
