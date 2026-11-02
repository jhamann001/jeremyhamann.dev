// Synthetic queues for the Trade Request digest wording fixture (ticket). No real names or data.
// Rows use the shapes the standalone query returns (numeric and minute columns as text).
const row = (id, status, extra = {}) => ({
  id,
  status,
  trade_type: "Rebalance",
  trade_amount: null,
  total_value: null,
  priority: "Standard",
  created_at: "2026-10-19T09:00:00.000Z",
  liquidity_deadline: null,
  client_names: null,
  client_name: "Sample",
  advisor_name: "Pat Advisor",
  waiting_minutes: "90",
  ...extra,
});

const MIXED = [
  row("REQ-00000101", "Pending Review", { total_value: "2500000", liquidity_deadline: "2026-10-10", client_names: ["Sample <Family> & Co", "Beta Trust"], advisor_name: "Pat <Advisor>", waiting_minutes: "3060" }),
  row("REQ-00000102", "Needs Info", { trade_type: "Initial Funding", trade_amount: " 100k-200k ", priority: "Urgent", liquidity_deadline: "2026-10-22", client_name: "Gamma", advisor_name: null, waiting_minutes: "1560" }),
  row("REQ-00000103", "Pending Current Asset Liquidation", { trade_type: "Withdrawal", total_value: "12345", priority: "Low", liquidity_deadline: "2026-11-30", client_names: ["Alpha", "Beta", "Gamma"], client_name: null, advisor_name: "Tia Trader", waiting_minutes: "180" }),
  row("REQ-00000104", "Completed", { trade_type: "Tax Loss Harvest", trade_amount: "", total_value: "999.6", priority: null, client_names: [], client_name: null, waiting_minutes: "45" }),
  row("REQ-00000105", "Pending Review", { total_value: "0", priority: "Urgent", liquidity_deadline: "2026-10-19", client_names: ["Delta"], client_name: "Delta", waiting_minutes: "60" }),
  row("REQ-00000106", "Approved", { waiting_minutes: "5000" }),
  row("REQ-00000107", "Pending Review", { total_value: "1500", liquidity_deadline: "2026-10-26", client_names: ["  ", "Echo"], waiting_minutes: "125" }),
  row("REQ-00000108", "Needs Info", { total_value: "1000000", liquidity_deadline: "2026-10-27", priority: "Bogus", waiting_minutes: "2881" }),
  row("REQ-00000109", "Pending Review", { liquidity_deadline: "not-a-date", advisor_name: "", waiting_minutes: "abc" }),
];

const OVERFLOW = [
  ...Array.from({ length: 11 }, (_, i) => row(`REQ-000002${String(i).padStart(2, "0")}`, "Pending Review", { total_value: String((i + 1) * 1000), waiting_minutes: String(100 + i * 10) })),
  row("REQ-00000301", "Completed", { waiting_minutes: "30" }),
  row("REQ-00000302", "Completed", { waiting_minutes: "20" }),
];

/** Each case: the clock, the rows the queue query returns, and whether the run date is already claimed. */
export const CASES = {
  empty: { now: "2026-10-21T12:00:00.000Z", rows: [], claimed: false },
  mixed: { now: "2026-10-19T12:00:00.000Z", rows: MIXED, claimed: false },
  overflow: { now: "2026-10-19T12:00:00.000Z", rows: OVERFLOW, claimed: false },
  singleWinter: { now: "2026-12-14T13:00:00.000Z", rows: [row("REQ-00000401", "Needs Info", { waiting_minutes: "30" })], claimed: false },
  lateEvening: { now: "2026-10-20T03:30:00.000Z", rows: [], claimed: false },
  alreadyPosted: { now: "2026-10-19T12:00:00.000Z", rows: MIXED, claimed: true },
};
