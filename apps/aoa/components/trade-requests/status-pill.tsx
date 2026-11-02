import { Pill } from "@/components/ui";
import { resolveTradeRequestStatus } from "@/lib/data/trade-request-status-catalog";

// Hover text keyed by the stored status, not the display label.
const DESCRIPTIONS: Record<string, string> = {
  "Pending Review": "Awaiting trader review",
  "Needs Info": "Returned to advisor for additional details",
  "Pending Current Asset Liquidation": "Waiting for existing positions to be sold",
  Approved: "Approved and ready for execution",
  Completed: "Fully executed",
  Rejected: "Permanently rejected — advisor must submit a new request",
};

export function TradeRequestStatusPill({ status }: { status: string | null | undefined }) {
  const meta = resolveTradeRequestStatus(status);
  const key = (status ?? "").trim();
  return (
    <span title={Object.hasOwn(DESCRIPTIONS, key) ? DESCRIPTIONS[key] : undefined} data-status-tone={meta.tone}>
      <Pill tone={meta.tone}>{meta.label}</Pill>
    </span>
  );
}
