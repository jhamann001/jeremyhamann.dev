import "server-only";
import type { TradeRequestSummary } from "./trade-requests";

// DEV-ONLY trade-request fixtures (trade-request-linking S1). The Trade-Request
// app's machine endpoint is OIDC-gated and mints its ID token from the ambient
// identity — on Cloud Run the aoa-run@ metadata identity, which does NOT exist
// locally. So the live read (`getTradeRequestsForUser` / `…ForUsers`) can never
// resolve on a dev laptop.
//
// This module supplies SYNTHETIC rows so the client/household/transfer surfaces
// render locally. It is consulted ONLY when
// `NODE_ENV !== "production" && TRADE_REQUEST_FIXTURE === "1"` (see
// `tradeRequestFixtureEnabled()` in trade-requests.ts) and is pulled in via a
// dynamic import() from the live-read path, so it never lands in a production
// bundle. No PII concern: every value here is invented. Account numbers use the
// masked `****NNNN` convention to mirror the real redacted projection.
//
// Rows (invented `user-<uuid>` client ids):
//   • ROW 1 — single-client, Approved buy.
//   • ROW 2 — single-client, Pending Review liquidation (same client as ROW 1
//     so a portrait shows more than one request).
//   • ROW 3 — MULTI-CLIENT household rebalance: `clientIds` has length 2, so it
//     surfaces on each member's portrait AND once at the household level. This
//     exercises the membership match S2/S3 rely on.
const CLIENT_A = "user-11111111-1111-4111-8111-111111111111";
const CLIENT_B = "user-22222222-2222-4222-8222-222222222222";

export function tradeRequestFixture(): TradeRequestSummary[] {
  return [
    {
      id: "tr-fixture-0001",
      clientId: CLIENT_A,
      clientIds: [CLIENT_A],
      status: "Approved",
      tradeType: "Buy",
      priority: "Normal",
      createdAt: "2026-07-14T15:20:00.000Z",
      updatedAt: "2026-07-15T09:05:00.000Z",
      totalValue: 84200,
      advisor: "Rachel Moss",
      householdId: 4101,
      householdName: "Moss Family",
      selectedAccounts: ["****1234"],
      accounts: [
        { accountNumber: "****1234", accountType: "Individual", balance: 84200 },
      ],
      liquidateOption: null,
      liquidationApproval: null,
    },
    {
      id: "tr-fixture-0002",
      clientId: CLIENT_A,
      clientIds: [CLIENT_A],
      status: "Pending Review",
      tradeType: "Sell",
      priority: "High",
      createdAt: "2026-07-18T13:40:00.000Z",
      updatedAt: "2026-07-18T13:40:00.000Z",
      totalValue: 15750,
      advisor: "Rachel Moss",
      householdId: 4101,
      householdName: "Moss Family",
      selectedAccounts: ["****1234"],
      accounts: [
        { accountNumber: "****1234", accountType: "Individual", balance: 99950 },
      ],
      liquidateOption: "Partial",
      liquidationApproval: "Pending",
    },
    {
      id: "tr-fixture-0003",
      clientId: CLIENT_A,
      clientIds: [CLIENT_A, CLIENT_B], // household rebalance — spans two clients
      status: "Approved",
      tradeType: "Rebalance",
      priority: "Normal",
      createdAt: "2026-07-10T18:00:00.000Z",
      updatedAt: "2026-07-11T11:30:00.000Z",
      totalValue: 262000,
      advisor: "Rachel Moss",
      householdId: 4101,
      householdName: "Moss Family",
      selectedAccounts: ["****1234", "****9876"],
      accounts: [
        { accountNumber: "****1234", accountType: "Individual", balance: 131000 },
        { accountNumber: "****9876", accountType: "Joint", balance: 131000 },
      ],
      liquidateOption: null,
      liquidationApproval: null,
    },
  ];
}
