import type { ReactNode } from "react";
import { Card, FieldList, Pill, SectionLabel, StatTile, SummaryGrid, type Field } from "@/components/ui";
import { TradeRequestStatusPill } from "@/components/trade-requests/status-pill";
import {
  activeEsgFilters, formatCurrency, householdLabel, isHousehold, residenceLabel, strategyTotal,
} from "@/lib/trade-requests/detail-view";
import type { TradeRequest, TradeRequestAccount } from "@/lib/trade-requests/request-types";
import styles from "./RequestDetail.module.css";

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className={styles.section} aria-label={title}>
      <SectionLabel className={styles.sectionLabel}>{title}</SectionLabel>
      {children}
    </section>
  );
}

function Exclusion({ value }: { value: string }) {
  return value ? <span className={styles.excluded}>{value}</span> : <span className={styles.muted}>None</span>;
}

// Standalone section order and copy (RequestModal.tsx "plan" tab).
export function RequestDetails({ request, accounts }: { request: TradeRequest; accounts: TradeRequestAccount[] }) {
  const hasAllocation = request.riskProfile != null;
  const strategies = request.equityStrategies ?? [];
  const total = strategyTotal(request);
  const esg = activeEsgFilters(request.esgFilters);

  const amountFields: Field[] = [];
  if (request.tradeAmount) {
    amountFields.push({ label: request.tradeType === "Cash Deposit" ? "Deposit Amount" : "Trade Amount / Instructions", value: request.tradeAmount });
  }
  if (request.depositAccount) amountFields.push({ label: "Deposit Into Account", value: <span className={styles.mono}>{request.depositAccount}</span> });
  if (request.tradeType === "Cash Deposit") {
    amountFields.push({
      label: "Rebalance All Accounts",
      value: request.rebalanceAll ? "Yes — all selected accounts will be rebalanced to target" : "No — only the deposit account will be traded",
    });
  }

  return (
    <div className={styles.sections}>
      <SummaryGrid>
        <StatTile label="Status" value={<TradeRequestStatusPill status={request.status} />} />
        <StatTile label="Trade Type" value={request.tradeType} />
        <StatTile label="Priority" value={request.priority || "N/A"} />
        <StatTile label="Submitted" value={new Date(request.date).toLocaleDateString()} />
        <StatTile label="Advisor" value={request.advisor} />
        <StatTile label="Submitted by" value={request.submittedBy || request.advisor} />
      </SummaryGrid>

      <Section title="Client & Accounts">
        <FieldList items={[
          { label: isHousehold(request) ? "Clients (Household)" : "Client", value: householdLabel(request) },
          { label: "Trade Type", value: request.tradeType },
        ]} />
        {accounts.length > 0 && (
          <div className={styles.accounts}>
            <p className={styles.subLabel}>Selected Accounts</p>
            {accounts.map((account) => (
              <div key={account.accountNumber} className={styles.account}>
                <div>
                  <p className={styles.accountNumber}>{account.accountNumber}</p>
                  <p className={styles.accountMeta}>{account.accountType} · <span className={styles.mono}>ID: {account.id}</span></p>
                </div>
                <span className={styles.balance}>{formatCurrency(account.balance)}</span>
              </div>
            ))}
            <div className={styles.total}>
              <span className={styles.totalLabel}>Total Value</span>
              <span className={styles.totalValue}>{formatCurrency(request.totalValue)}</span>
            </div>
          </div>
        )}
        {amountFields.length > 0 && <FieldList items={amountFields} />}
      </Section>

      {hasAllocation && request.baseAllocation && (
        <Section title="Mandate & Base Allocation">
          <FieldList items={[{ label: "Client Risk Score", value: `Level ${request.riskProfile} / 25` }]} />
          <div>
            <p className={styles.subLabel}>Resulting Base Allocation</p>
            <div className={styles.tiles}>
              {(["equity", "fixed", "cash"] as const).map((key) => (
                <Card key={key} className={styles.tile}>
                  <p className={styles.tileLabel}>{key === "fixed" ? "Fixed Inc." : key === "equity" ? "Equity" : "Cash"}</p>
                  <p className={styles.tileValue}>{request.baseAllocation![key]}%</p>
                </Card>
              ))}
            </div>
          </div>
        </Section>
      )}

      {hasAllocation && strategies.length > 0 && (
        <Section title="Equity Strategy Construction">
          <div className={styles.strategies}>
            {strategies.map((strategy) => (
              <Card key={strategy.id} className={styles.strategy}>
                <div className={styles.strategyHead}>
                  <span>{strategy.benchmark}</span>
                  <span className={styles.allocation}>{strategy.allocation}%</span>
                </div>
                <p className={styles.rationale}>&quot;{strategy.rationale}&quot;</p>
              </Card>
            ))}
            <span className={`${styles.strategyTotal} ${total === 100 ? styles.totalOk : styles.totalOff}`}>{total}% / 100%</span>
          </div>
        </Section>
      )}

      {request.tradeType === "Raise Cash" && (
        <Section title="Cash Raise Details">
          <FieldList items={[
            { label: "Cash Amount to Raise", value: request.tradeAmount || "N/A" },
            { label: "Liquidity Deadline", value: request.liquidityDeadline ? new Date(request.liquidityDeadline).toLocaleDateString() : "Not specified" },
            ...(request.raiseCashReason ? [{ label: "Reason for Cash Raise", value: request.raiseCashReason }] : []),
          ]} />
        </Section>
      )}

      {request.tradeType === "Liquidate" && (
        <Section title="Liquidation Details">
          <FieldList items={[
            { label: "Liquidation Option", value: request.liquidateOption || "N/A" },
            ...(request.liquidateOption === "Specific Positions" && request.liquidatePositions
              ? [{ label: "Positions to Liquidate", value: request.liquidatePositions }] : []),
          ]} />
        </Section>
      )}

      {hasAllocation && (
        <Section title="Compliance, Exclusions & Execution">
          <FieldList items={[
            { label: "State Residence", value: residenceLabel(request.residence) },
            { label: "Liquidation Approval", value: request.liquidationApproval || "N/A" },
            {
              label: "ESG Filters",
              value: esg.length > 0
                ? <span className={styles.chips}>{esg.map((filter) => <Pill key={filter} tone="gray">{filter}</Pill>)}</span>
                : <span className={styles.muted}>None applied</span>,
            },
            { label: "Advisor Exclusions", value: <Exclusion value={request.advisorExclusions} /> },
            { label: "Client Exclusions", value: <Exclusion value={request.clientExclusions} /> },
          ]} />
        </Section>
      )}

      {request.advisorNotes && (
        <Section title="Workflow & Advisor Notes">
          <FieldList items={[{ label: "Advisor Compliance & Execution Notes", value: <span className={styles.preline}>{request.advisorNotes}</span> }]} />
        </Section>
      )}
    </div>
  );
}
