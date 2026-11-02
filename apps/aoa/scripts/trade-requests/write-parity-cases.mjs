// Synthetic write-parity cases (ticket), shared by the standalone capture and the AOA parity test.
// Order matters: each case runs against the state the previous cases left. No real names or data.

export const SEED_VERSION = "2026-10-01T12:00:00.000Z";
const KEY_1 = "00000000-0000-4000-8000-0000000000a1";
const KEY_2 = "00000000-0000-4000-8000-0000000000a2";
const KEY_3 = "00000000-0000-4000-8000-0000000000a3";
const KEY_4 = "00000000-0000-4000-8000-0000000000a4";
const KEY_5 = "00000000-0000-4000-8000-0000000000a5";
const KEY_6 = "00000000-0000-4000-8000-0000000000a6";

/** AOA account (role, name) and the Trade Request identity the standalone service resolves for it. */
export const ACTORS = {
  advisor: { email: "parity.advisor@example.test", aoaRole: "ADVISOR", aoaName: "Avery AOA" },
  advisor2: { email: "parity.advisor2@example.test", aoaRole: "ADVISOR", aoaName: "Blake AOA" },
  ops: { email: "parity.ops@example.test", aoaRole: "OPERATIONS", aoaName: "Orin AOA" },
  admin: { email: "parity.admin@example.test", aoaRole: "ADMIN", aoaName: "Ada Admin" },
};

/** Seeded ids kept verbatim by the normalizer; any other UUID becomes "<uuid>". */
export const KNOWN_UUIDS = new Set([
  KEY_1, KEY_2, KEY_3, KEY_4, KEY_5, KEY_6,
  "00000000-0000-4000-8000-000000000b01",
  "00000000-0000-4000-8000-000000000c01", "00000000-0000-4000-8000-000000000c02",
  "00000000-0000-4000-8000-000000000d01",
  "00000000-0000-4000-8000-000000000e01", "00000000-0000-4000-8000-000000000e02", "00000000-0000-4000-8000-000000000e03",
  "00000000-0000-4000-8000-000000000f01",
]);

const ACCT = { accountNumber: "PAR-ACCT-1", accountType: "Taxable", balance: 250000.5 };
const ESG = { fossilFuels: false, tobacco: false, weapons: false, alcohol: false, gambling: false, other: false, otherDescription: "", none: true };
const base = (over) => ({
  clientId: "PARITY-C1", clientName: "Parity Client One", tradeType: "Raise Cash", tradeAmount: "2500", depositAccount: "",
  rebalanceAll: false, selectedAccounts: ["PAR-ACCT-1"], accountsData: [ACCT], priority: "Standard", advisorNotes: "",
  residence: "Other", liquidationApproval: "", advisorExclusions: "", clientExclusions: "", esgFilters: ESG, riskProfile: null,
  equityStrategies: [], raiseCashReason: "Tuition", liquidityDeadline: null, liquidateOption: "", liquidatePositions: "",
  existingId: null, isClone: false, assetLocationMode: "priority", householdId: null, householdName: null, ...over,
});
const cashDeposit = (riskProfile, rationale, tradeAmount) => base({
  clientId: "PARITY-C2", clientName: "Parity Client Two", tradeType: "Cash Deposit", tradeAmount,
  depositAccount: "PAR-ACCT-2", selectedAccounts: ["PAR-ACCT-2"],
  accountsData: [{ accountNumber: "PAR-ACCT-2", accountType: "Roth IRA", balance: 50000 }], residence: "NY",
  liquidationApproval: "No", riskProfile, raiseCashReason: "",
  equityStrategies: [{ id: 1, benchmark: "SPY", allocation: 100, rationale }],
});
const liquidate = (over) => base({ tradeType: "Liquidate", tradeAmount: "", raiseCashReason: "", liquidateOption: "Entire Account", ...over });
const ex = (n) => `00000000-0000-4000-8000-000000000${n}`;

/** op is the AOA TradeRequestOperation; method and path are what the AOA caller sends below /api/aoa. */
export const CASES = [
  { name: "create_raise_cash", op: "createRequest", actor: "advisor", method: "POST", path: "/requests", body: base({ idempotencyKey: KEY_1 }) },
  { name: "create_replay_same_key", op: "createRequest", actor: "advisor", method: "POST", path: "/requests", body: base({ idempotencyKey: KEY_1 }) },
  { name: "create_duplicate_content_new_key", op: "createRequest", actor: "advisor", method: "POST", path: "/requests", body: base({ idempotencyKey: KEY_2 }) },
  { name: "create_invalid_initial_funding", op: "createRequest", actor: "advisor", method: "POST", path: "/requests", body: base({ tradeType: "Initial Funding", tradeAmount: "", raiseCashReason: "", liquidationApproval: "", idempotencyKey: KEY_3 }) },
  { name: "create_cash_deposit_unchanged_blank_rationale", op: "createRequest", actor: "advisor", method: "POST", path: "/requests", body: { ...cashDeposit(12, "", "10000"), idempotencyKey: KEY_4 } },
  { name: "create_cash_deposit_changed_blank_rationale", op: "createRequest", actor: "advisor", method: "POST", path: "/requests", body: { ...cashDeposit(13, "", "10001"), idempotencyKey: KEY_5 } },
  { name: "create_liquidate_local_accounts", op: "createRequest", actor: "ops", method: "POST", path: "/requests", body: liquidate({ accountsData: undefined }) },
  { name: "create_local_accounts_mismatch", op: "createRequest", actor: "ops", method: "POST", path: "/requests", body: base({ clientId: "PARITY-C2", clientName: "Parity Client Two", accountsData: undefined, tradeAmount: "777" }) },
  { name: "create_first_time_admin", op: "createRequest", actor: "admin", method: "POST", path: "/requests", body: base({ tradeAmount: "3100", idempotencyKey: KEY_6 }) },
  { name: "create_accounts_data_missing", op: "createRequest", actor: "advisor", method: "POST", path: "/requests", body: base({ tradeAmount: "4100", selectedAccounts: ["PAR-ACCT-1", "PAR-ACCT-9"] }) },
  { name: "resubmit_other_advisor", op: "resubmitRequest", actor: "advisor2", method: "PUT", path: "/requests/REQ-PARNI002", body: { ...liquidate({ advisorNotes: "edited" }), existingId: "REQ-PARNI002", expectedUpdatedAt: SEED_VERSION } },
  { name: "resubmit_stale", op: "resubmitRequest", actor: "advisor", method: "PUT", path: "/requests/REQ-PARNI002", body: { ...liquidate({ advisorNotes: "edited" }), existingId: "REQ-PARNI002", expectedUpdatedAt: "2026-09-30T00:00:00.000Z" } },
  { name: "resubmit_missing_version", op: "resubmitRequest", actor: "advisor", method: "PUT", path: "/requests/REQ-PARNI002", body: { ...liquidate({ advisorNotes: "edited" }), existingId: "REQ-PARNI002" } },
  { name: "resubmit_owner", op: "resubmitRequest", actor: "advisor", method: "PUT", path: "/requests/REQ-PARNI001", body: { ...liquidate({ advisorNotes: "now with detail", priority: "Urgent" }), existingId: "REQ-PARNI001", expectedUpdatedAt: SEED_VERSION } },
  { name: "resubmit_not_needs_info", op: "resubmitRequest", actor: "advisor", method: "PUT", path: "/requests/REQ-PARPR001", body: { ...liquidate({}), existingId: "REQ-PARPR001", expectedUpdatedAt: SEED_VERSION } },
  { name: "resubmit_trader_for_other", op: "resubmitRequest", actor: "ops", method: "PUT", path: "/requests/REQ-PARNI003", body: { ...liquidate({}), existingId: "REQ-PARNI003", expectedUpdatedAt: SEED_VERSION } },
  { name: "status_advisor_refused", op: "statusChange", actor: "advisor", method: "PUT", path: "/requests/REQ-PARPR001/status", body: { status: "Approved", note: "", expectedUpdatedAt: SEED_VERSION } },
  { name: "status_stale", op: "statusChange", actor: "ops", method: "PUT", path: "/requests/REQ-PARPR001/status", body: { status: "Approved", note: "", expectedUpdatedAt: "2026-09-30T00:00:00.000Z" } },
  { name: "status_needs_info", op: "statusChange", actor: "ops", method: "PUT", path: "/requests/REQ-PARPR001/status", body: { status: "Needs Info", note: "", expectedUpdatedAt: SEED_VERSION } },
  { name: "status_decided", op: "statusChange", actor: "ops", method: "PUT", path: "/requests/REQ-PARAP001/status", body: { status: "Completed", note: "done", expectedUpdatedAt: SEED_VERSION } },
  { name: "status_not_found", op: "statusChange", actor: "ops", method: "PUT", path: "/requests/REQ-PARMISS1/status", body: { status: "Approved", note: "", expectedUpdatedAt: SEED_VERSION } },
  { name: "status_invalid", op: "statusChange", actor: "ops", method: "PUT", path: "/requests/REQ-PARPR001/status", body: { status: "Done", note: "" } },
  { name: "checklist_advisor_refused", op: "checklistSave", actor: "advisor", method: "PUT", path: "/requests/REQ-PARNI002/checklist", body: { key: "templates", checked: true, value: "" } },
  { name: "checklist_save", op: "checklistSave", actor: "ops", method: "PUT", path: "/requests/REQ-PARNI002/checklist", body: { key: "templates", checked: true, value: "Model A" } },
  { name: "checklist_locked", op: "checklistSave", actor: "ops", method: "PUT", path: "/requests/REQ-PARAP001/checklist", body: { key: "templates", checked: true, value: "" } },
  { name: "checklist_invalid_key", op: "checklistSave", actor: "ops", method: "PUT", path: "/requests/REQ-PARNI002/checklist", body: { key: "nope", checked: true } },
  { name: "checklist_not_found", op: "checklistSave", actor: "ops", method: "PUT", path: "/requests/REQ-PARMISS1/checklist", body: { key: "templates", checked: false } },
  { name: "exclusions_client_batch", op: "exclusionSave", actor: "advisor", method: "POST", path: "/clients/PARITY-C1/exclusions/batch", body: { add: [{ ticker: "nvda", kind: "client", reason: "Concentration", noBuy: true, noSell: false }], remove: [ex("c02")], edit: [{ id: ex("c01"), noBuy: true, noSell: true }] } },
  { name: "exclusions_client_duplicate_add", op: "exclusionSave", actor: "advisor", method: "POST", path: "/clients/PARITY-C1/exclusions/batch", body: { add: [{ ticker: "TSLA", kind: "client", reason: "", noBuy: true, noSell: true }], remove: [], edit: [] } },
  { name: "exclusions_client_missing_remove", op: "exclusionSave", actor: "advisor", method: "POST", path: "/clients/PARITY-C1/exclusions/batch", body: { add: [], remove: [ex("c99")], edit: [] } },
  { name: "exclusions_client_noop_edit", op: "exclusionSave", actor: "advisor", method: "POST", path: "/clients/PARITY-C1/exclusions/batch", body: { add: [], remove: [], edit: [{ id: ex("c01"), noBuy: true, noSell: true }] } },
  { name: "exclusions_account_batch", op: "exclusionSave", actor: "ops", method: "POST", path: "/clients/account-exclusions/PAR-ULID-1/batch", body: { add: [{ ticker: "MSFT", kind: "advisor", reason: "", noBuy: false, noSell: true }], remove: [ex("d01")], edit: [] } },
  { name: "exclusions_invalid_empty", op: "exclusionSave", actor: "advisor", method: "POST", path: "/clients/PARITY-C1/exclusions/batch", body: { add: [], remove: [], edit: [] } },
  { name: "notification_read_own", op: "markNotificationRead", actor: "advisor", method: "PATCH", path: `/notifications/${ex("e01")}/read` },
  { name: "notification_read_again", op: "markNotificationRead", actor: "advisor", method: "PATCH", path: `/notifications/${ex("e01")}/read` },
  { name: "notification_read_other_user", op: "markNotificationRead", actor: "advisor", method: "PATCH", path: `/notifications/${ex("e03")}/read` },
  { name: "notification_read_all", op: "markAllNotificationsRead", actor: "advisor", method: "POST", path: "/notifications/read-all" },
];

/** AOA side-effect events each case must trigger (TRB-05 via emitTradeRequestEvent); cases not listed trigger none. */
export const EXPECTED_EVENTS = {
  create_raise_cash: "submitted",
  create_cash_deposit_unchanged_blank_rationale: "submitted",
  create_liquidate_local_accounts: "submitted",
  create_first_time_admin: "submitted",
  resubmit_owner: "resubmitted",
  resubmit_trader_for_other: "resubmitted",
  status_needs_info: "status_changed",
  exclusions_client_batch: "exclusion_batch_changed",
};

/** Saved-field snapshot queries; each returns rows with one text column `j`. `s` is the schema. */
export function snapshotQueries(s) {
  return {
    users: `SELECT jsonb_build_object('id', id, 'email', email, 'name', name, 'role', role, 'isActive', is_active,
              'slackUserId', slack_user_id, 'provisioned', aoa_provisioned_at IS NOT NULL)::text AS j FROM ${s}.users`,
    requests: `SELECT ((to_jsonb(t) - 'created_at' - 'updated_at')
              || jsonb_build_object('seedVersion', t.updated_at = '${SEED_VERSION}'::timestamptz))::text AS j FROM ${s}.trade_requests t`,
    audit: `SELECT (to_jsonb(a) - 'id' - 'created_at')::text AS j FROM ${s}.audit_logs a`,
    clientExclusions: `SELECT (to_jsonb(e) - 'created_at')::text AS j FROM ${s}.client_exclusions e`,
    accountExclusions: `SELECT (to_jsonb(e) - 'created_at')::text AS j FROM ${s}.account_exclusions e`,
    seededNotifications: `SELECT jsonb_build_object('id', id, 'read', read_at IS NOT NULL)::text AS j FROM ${s}.notifications
              WHERE id IN ('${ex("e01")}', '${ex("e02")}', '${ex("e03")}')`,
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const CREATED_ID = /^REQ-[0-9A-F]{8}$/;

/** Replaces values that differ between runs: user ids by email, other new UUIDs, created request ids, timestamps. */
export function normalize(value, usersById) {
  if (Array.isArray(value)) return value.map((v) => normalize(v, usersById));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalize(v, usersById)]));
  }
  if (typeof value !== "string") return value;
  if (usersById.has(value)) return `user:${usersById.get(value)}`;
  if (UUID.test(value)) return KNOWN_UUIDS.has(value.toLowerCase()) ? value : "<uuid>";
  if (CREATED_ID.test(value)) return "<request>";
  if (TIMESTAMP.test(value)) return "<timestamp>";
  return value;
}

/** Turns raw snapshot rows ({ table: string[] of JSON text }) into a normalized, order-independent object. */
export function normalizeSnapshot(raw) {
  const users = raw.users.map((j) => JSON.parse(j));
  const usersById = new Map(users.map((u) => [u.id, u.email]));
  const out = {};
  for (const [table, rows] of Object.entries(raw)) {
    out[table] = rows.map((j) => JSON.stringify(normalize(JSON.parse(j), usersById))).sort();
  }
  return out;
}

/** Tables whose normalized rows differ from the previous snapshot (the fixture stores only these). */
export function changedTables(previous, next) {
  const out = {};
  for (const [table, rows] of Object.entries(next)) {
    if (JSON.stringify(rows) !== JSON.stringify(previous[table])) out[table] = rows;
  }
  return out;
}

/** Same user-id map, for normalizing a response body against the snapshot taken after it. */
export function usersByIdFromRaw(raw) {
  return new Map(raw.users.map((j) => JSON.parse(j)).map((u) => [u.id, u.email]));
}
