import type { TradeRequestCall } from "@/lib/trade-requests/client";

// Recorded read-parity cases (ticket). Each case is one workspace read made as one synthetic AOA account
// against test/fixtures/trade-request-read-parity-seed.sql. Shared by the capture (standalone service) and the
// replay (native handlers); the captured results live in test/fixtures/trade-request-read-parity.json.

export const PARITY_ACTORS = {
  admin: { id: "parity-admin", email: "ada.admin@example.test" },
  ops: { id: "parity-ops", email: "orin.ops@example.test" },
  avery: { id: "parity-avery", email: "avery.advisor@example.test" },
  blake: { id: "parity-blake", email: "blake.advisor@example.test" },
  nora: { id: "parity-nora", email: "nora.new@example.test" },
  viewer: { id: "parity-viewer", email: "vic.viewer@example.test" },
  service: { id: "parity-service", email: "cara.service@example.test" },
} as const;

export type ParityActor = keyof typeof PARITY_ACTORS;
export type ParityCase = { id: string; actor: ParityActor; call: TradeRequestCall };

const LONG_ID = "x".repeat(51);
const C1 = "user-10000000-0000-4000-8000-000000000001";
const C2 = "user-10000000-0000-4000-8000-000000000002";
const C3 = "user-10000000-0000-4000-8000-000000000003";
const C9 = "user-10000000-0000-4000-8000-000000000009";
const ACCOUNT_1 = "01PARITY000000000000000001";
const ACCOUNT_3 = "01PARITY000000000000000003";
const PAGE_TWO_CURSOR = "2026-01-01T05:00:00.000Z|REQ-PF000005";

function matrix(): ParityCase[] {
  const out: ParityCase[] = [];
  for (const actor of ["admin", "ops", "avery"] as const) {
    out.push(
      { id: `counts.${actor}`, actor, call: { operation: "requestCounts", method: "GET", path: "/requests/counts", defaultMessage: "counts_failed" } },
      { id: `list.page1.${actor}`, actor, call: { operation: "listRequests", method: "GET", path: "/requests", query: { limit: 50 }, defaultMessage: "list_failed" } },
      { id: `detail.R1.${actor}`, actor, call: { operation: "requestDetail", method: "GET", path: "/requests/REQ-P0000001", defaultMessage: "detail_failed" } },
      { id: `checklist.R4.${actor}`, actor, call: { operation: "checklistRead", method: "GET", path: "/requests/REQ-P0000004/checklist", defaultMessage: "checklist_failed" } },
      { id: `clients.${actor}`, actor, call: { operation: "clientList", method: "GET", path: "/clients", defaultMessage: "clients_failed" } },
      { id: `lastAllocation.C-1.${actor}`, actor, call: { operation: "lastAllocation", method: "GET", path: `/requests/last-allocation/${C1}`, defaultMessage: "allocation_failed" } },
      { id: `clientExclusions.C-1.${actor}`, actor, call: { operation: "clientExclusions", method: "GET", path: `/clients/${C1}/exclusions`, defaultMessage: "exclusions_failed" } },
      { id: `households.C-1.C-2.${actor}`, actor, call: { operation: "householdResolve", method: "GET", path: "/households/resolve", query: { clientIds: `${C1},${C2}` }, defaultMessage: "household_lookup_failed" } },
      { id: `notifications.${actor}`, actor, call: { operation: "notificationsList", method: "GET", path: "/notifications", query: { limit: 100 }, defaultMessage: "bell_unavailable", channel: "bell" } },
      { id: `exportExclusions.bulk.${actor}`, actor, call: { operation: "exportExclusions", method: "POST", path: "/clients/exclusions/bulk", body: { clientIds: [C1, C2, C3] }, defaultMessage: "export_failed" } },
      { id: `clientsLookup.${actor}`, actor, call: { operation: "clientsExclusionsLookup", method: "POST", path: "/clients/exclusions/bulk", body: { clientIds: [C1, C2, C9, C1] }, defaultMessage: "lookup_failed" } },
      { id: `accountLookup.${actor}`, actor, call: { operation: "accountExclusionsLookup", method: "POST", path: "/clients/account-exclusions/bulk", body: { accountIds: [ACCOUNT_1, ACCOUNT_3, "01PARITY000000000000000009"] }, defaultMessage: "account_lookup_failed" } },
    );
  }
  return out;
}

const EDGES: ParityCase[] = [
  { id: "list.page2.ops", actor: "ops", call: { operation: "listRequests", method: "GET", path: "/requests", query: { limit: 50, before: PAGE_TWO_CURSOR }, defaultMessage: "list_failed" } },
  { id: "list.search.submitter.ops", actor: "ops", call: { operation: "listRequests", method: "GET", path: "/requests", query: { limit: 50, q: "avery a." }, defaultMessage: "list_failed" } },
  { id: "list.search.escaped.ops", actor: "ops", call: { operation: "listRequests", method: "GET", path: "/requests", query: { limit: 50, q: "50%" }, defaultMessage: "list_failed" } },
  { id: "list.searchWithAll.ops", actor: "ops", call: { operation: "listRequests", method: "GET", path: "/requests", query: { all: true, q: "x" }, defaultMessage: "list_failed" } },
  { id: "list.limitZero.ops", actor: "ops", call: { operation: "listRequests", method: "GET", path: "/requests", query: { limit: 0 }, defaultMessage: "list_failed" } },
  { id: "list.badCursor.ops", actor: "ops", call: { operation: "listRequests", method: "GET", path: "/requests", query: { limit: 50, before: "not-a-date" }, defaultMessage: "list_failed" } },
  { id: "list.export.ops", actor: "ops", call: { operation: "listRequests", method: "GET", path: "/requests", query: { all: true }, defaultMessage: "export_failed" } },
  { id: "list.limitFive.avery", actor: "avery", call: { operation: "listRequests", method: "GET", path: "/requests", query: { limit: 5 }, defaultMessage: "list_failed" } },
  { id: "detail.R6.legacySubmitter.ops", actor: "ops", call: { operation: "requestDetail", method: "GET", path: "/requests/REQ-P0000006", defaultMessage: "detail_failed" } },
  { id: "detail.R7.nulls.ops", actor: "ops", call: { operation: "requestDetail", method: "GET", path: "/requests/REQ-P0000007", defaultMessage: "detail_failed" } },
  { id: "detail.missing.ops", actor: "ops", call: { operation: "requestDetail", method: "GET", path: "/requests/REQ-NOPE", defaultMessage: "detail_failed" } },
  { id: "detail.tooLong.ops", actor: "ops", call: { operation: "requestDetail", method: "GET", path: `/requests/${LONG_ID}`, defaultMessage: "detail_failed" } },
  { id: "checklist.R1.empty.ops", actor: "ops", call: { operation: "checklistRead", method: "GET", path: "/requests/REQ-P0000001/checklist", defaultMessage: "checklist_failed" } },
  { id: "checklist.missing.ops", actor: "ops", call: { operation: "checklistRead", method: "GET", path: "/requests/REQ-NOPE/checklist", defaultMessage: "checklist_failed" } },
  { id: "checklist.tooLong.ops", actor: "ops", call: { operation: "checklistRead", method: "GET", path: `/requests/${LONG_ID}/checklist`, defaultMessage: "checklist_failed" } },
  { id: "lastAllocation.C-3.notOwned.avery", actor: "avery", call: { operation: "lastAllocation", method: "GET", path: `/requests/last-allocation/${C3}`, defaultMessage: "allocation_failed" } },
  { id: "lastAllocation.C-3.none.ops", actor: "ops", call: { operation: "lastAllocation", method: "GET", path: `/requests/last-allocation/${C3}`, defaultMessage: "allocation_failed" } },
  { id: "lastAllocation.C-2.viaClientIds.avery", actor: "avery", call: { operation: "lastAllocation", method: "GET", path: `/requests/last-allocation/${C2}`, defaultMessage: "allocation_failed" } },
  { id: "lastAllocation.C-1.noIdentity.nora", actor: "nora", call: { operation: "lastAllocation", method: "GET", path: `/requests/last-allocation/${C1}`, defaultMessage: "allocation_failed" } },
  { id: "lastAllocation.tooLong.ops", actor: "ops", call: { operation: "lastAllocation", method: "GET", path: `/requests/last-allocation/${LONG_ID}`, defaultMessage: "allocation_failed" } },
  { id: "notifications.unreadOnly.avery", actor: "avery", call: { operation: "notificationsList", method: "GET", path: "/notifications", query: { limit: 50, unreadOnly: "true" }, defaultMessage: "bell_unavailable", channel: "bell" } },
  { id: "notifications.blake", actor: "blake", call: { operation: "notificationsList", method: "GET", path: "/notifications", query: { limit: 100 }, defaultMessage: "bell_unavailable", channel: "bell" } },
  { id: "notifications.limitTooHigh.avery", actor: "avery", call: { operation: "notificationsList", method: "GET", path: "/notifications", query: { limit: 101 }, defaultMessage: "bell_unavailable", channel: "bell" } },
  { id: "notifications.noIdentity.nora", actor: "nora", call: { operation: "notificationsList", method: "GET", path: "/notifications", query: { limit: 100 }, defaultMessage: "bell_unavailable", channel: "bell" } },
  { id: "households.noParams.ops", actor: "ops", call: { operation: "householdResolve", method: "GET", path: "/households/resolve", defaultMessage: "household_lookup_failed" } },
  { id: "households.badAccount.ops", actor: "ops", call: { operation: "householdResolve", method: "GET", path: "/households/resolve", query: { accountIds: "bad" }, defaultMessage: "household_lookup_failed" } },
  { id: "households.tooMany.ops", actor: "ops", call: { operation: "householdResolve", method: "GET", path: "/households/resolve", query: { clientIds: Array.from({ length: 51 }, (_, i) => `C-${i + 1}`).join(",") }, defaultMessage: "household_lookup_failed" } },
  { id: "clientExclusions.none.ops", actor: "ops", call: { operation: "clientExclusions", method: "GET", path: `/clients/${C9}/exclusions`, defaultMessage: "exclusions_failed" } },
  { id: "clientExclusions.tooLong.ops", actor: "ops", call: { operation: "clientExclusions", method: "GET", path: `/clients/${"c".repeat(101)}/exclusions`, defaultMessage: "exclusions_failed" } },
  { id: "clientsLookup.empty.ops", actor: "ops", call: { operation: "clientsExclusionsLookup", method: "POST", path: "/clients/exclusions/bulk", body: { clientIds: [] }, defaultMessage: "lookup_failed" } },
  { id: "accountLookup.empty.ops", actor: "ops", call: { operation: "accountExclusionsLookup", method: "POST", path: "/clients/account-exclusions/bulk", body: { accountIds: [] }, defaultMessage: "account_lookup_failed" } },
  { id: "exportExclusions.firmwide.ops", actor: "ops", call: { operation: "exportExclusions", method: "GET", path: "/clients/exclusions/export", defaultMessage: "export_failed" } },
  { id: "counts.viewer", actor: "viewer", call: { operation: "requestCounts", method: "GET", path: "/requests/counts", defaultMessage: "counts_failed" } },
  { id: "list.clientService", actor: "service", call: { operation: "listRequests", method: "GET", path: "/requests", query: { limit: 50 }, defaultMessage: "list_failed" } },
];

export const PARITY_CASES: readonly ParityCase[] = [...matrix(), ...EDGES];
