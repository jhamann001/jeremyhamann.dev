// The pre-approval checklist as the Trade Request service defines it
// (trade-request shared/src/types.ts PREAPPROVAL_CHECKLIST_ITEMS) and the
// standalone tab presents it (client/src/components/RequestModal.tsx), verbatim.

export type ChecklistItemKey =
  | "exclusions"
  | "templates"
  | "asset_location"
  | "transition"
  | "legacy_liquidation"
  | "residual_cash"
  | "advisor_tickers";

export type ChecklistItemDef = {
  key: ChecklistItemKey;
  label: string;
  help: string;
  field?: { label: string; placeholder: string };
};

export const CHECKLIST_ITEMS: readonly ChecklistItemDef[] = [
  {
    key: "exclusions",
    label: "Exclusions & restrictions applied (DNB / DNS)",
    help: "Client- and advisor-level no-buy / no-sell restrictions reflected in the orders.",
  },
  {
    key: "templates",
    label: "Meridian templates created for all accounts",
    help: "Every account in the request has a target model.",
    field: { label: "Template name(s)", placeholder: "e.g., National Tax Efficient – Risk 20" },
  },
  {
    key: "asset_location",
    label: "Asset location completed",
    help: "Tax-ideal sleeve placement set at the household level.",
  },
  {
    key: "transition",
    label: "Transition used",
    help: "",
    field: { label: "Transition model", placeholder: "e.g., National Tax Efficient – Risk 20" },
  },
  {
    key: "legacy_liquidation",
    label: "Legacy / ACAT positions liquidated",
    help: "Transferred-in holdings that aren't on the model sold to fund the target templates.",
  },
  {
    key: "residual_cash",
    label: "Residual cash trades placed",
    help: "Leftover settlement cash swept into the model.",
  },
  {
    key: "advisor_tickers",
    label: "Advisor-instructed tickers traded",
    help: "",
    field: { label: "Tickers / instructions", placeholder: "e.g., sold legacy AAPL per advisor note…" },
  },
];

export const CHECKLIST_KEYS: readonly ChecklistItemKey[] = CHECKLIST_ITEMS.map((item) => item.key);

/** The service's `value` limit (requests.ts checklistBodySchema). */
export const CHECKLIST_VALUE_MAX = 2000;

export const CHECKLIST_COPY = {
  introLead: "Pre-approval checklist",
  introRest: " — confirm before you approve & execute.",
  progressLabel: "Pre-approval checklist completion",
  readOnly: "Read-only — only traders can update the checklist.",
  locked: "This request is closed; the checklist is locked.",
  tab: "Pre-approval Checklist",
} as const;

export type ChecklistItemState = { checked: boolean; value?: string; by?: string | null; at?: string | null };
export type ChecklistState = Partial<Record<ChecklistItemKey, ChecklistItemState>>;
export type ChecklistChange = { key: ChecklistItemKey; checked: boolean; value: string };

/** "edit" for a reviewer on an undecided request; advisors read; a decided request is locked. */
export type ChecklistAccess = "edit" | "read_only" | "locked";

const TERMINAL_STATUSES = new Set(["Approved", "Rejected", "Completed"]);
const REVIEWER_ROLES = new Set(["ADMIN", "OPERATIONS"]);

export function isTerminalStatus(status: string): boolean {
  return TERMINAL_STATUSES.has(status);
}

export function isChecklistKey(value: unknown): value is ChecklistItemKey {
  return typeof value === "string" && (CHECKLIST_KEYS as readonly string[]).includes(value);
}

export function checklistAccess(role: string, status: string): ChecklistAccess {
  if (!REVIEWER_ROLES.has(role)) return "read_only";
  return isTerminalStatus(status) ? "locked" : "edit";
}

export function checkedCount(checklist: ChecklistState): number {
  return CHECKLIST_KEYS.filter((key) => checklist[key]?.checked === true).length;
}

export function uncheckedCount(checklist: ChecklistState): number {
  return CHECKLIST_KEYS.length - checkedCount(checklist);
}

/** The tab label with the unchecked count while any item is unchecked (P2-116). */
export function checklistTabLabel(unchecked: number): string {
  return unchecked > 0 ? `${CHECKLIST_COPY.tab} (${unchecked})` : CHECKLIST_COPY.tab;
}

/** "Checked by {name} · {date}" for an item that carries a stamp, else null. */
export function checklistStamp(state: ChecklistItemState | undefined, formatDate: (iso: string) => string): string | null {
  if (!state?.by || !state.at) return null;
  return `Checked by ${state.by} · ${formatDate(state.at)}`;
}

/** Keeps only known items with the shapes the tab reads; anything else reads as untouched. */
export function sanitizeChecklist(value: unknown): ChecklistState {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return {};
  const result: ChecklistState = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!isChecklistKey(key) || raw == null || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    result[key] = {
      checked: item.checked === true,
      value: typeof item.value === "string" ? item.value : "",
      by: typeof item.by === "string" ? item.by : null,
      at: typeof item.at === "string" ? item.at : null,
    };
  }
  return result;
}
