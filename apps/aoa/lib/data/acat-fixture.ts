import "server-only";
import type { AcatListRow, AcatStatus } from "./acat-status";

// DEV-ONLY ACAT fixtures (ticket lane). The tracker's machine endpoints are
// OIDC-gated and mint their ID token from the ambient identity — on Cloud Run
// the aoa-run@ metadata identity, which does NOT exist locally. So the live
// reads (`fetchAcatList` / `getAcatStatus`) can never resolve on a dev laptop.
//
// ticket: every `status` below is a REAL RAW tracker enum value (PascalCase,
// e.g. "PendingSettlement", "ToCome") — mirroring exactly what the tracker
// returns — plus one deliberately UNMAPPED value ("AwaitingCustodian") to
// exercise the catalog's safe fallback. Friendly labels are derived at render
// time via lib/data/acat-status-catalog.ts, never stored here.
//
// This module supplies SYNTHETIC rows so the lane + detail render locally.
// It is consulted ONLY when `NODE_ENV !== "production" && ACAT_FIXTURE === "1"`
// (see `acatFixtureEnabled()` in acat-status.ts) and is pulled in via a dynamic
// import() from the live-read path, so it never lands in a production bundle.
// No PII concern: every value here is invented. The masked-number convention
// mirrors the real redacted projection (e.g. "********ZHLK").

// Shape (show-all-in-flight — owner decision 2026-07-15):
//   • 2 rows LINK to seeded IN_TRANSFER transfers (prisma/seed.ts DEMO-T-0008 /
//     DEMO-T-0009): Neil (Accepted, in flight) + Sam (Rejected, TERMINAL).
//   • 5 RESIDUAL/UNLINKED rows match no visible transfer; 4 are in the LIVE
//     bucket, the 5th (Completed) is terminal.
// For a firm-wide role (OPERATIONS/ADMIN) the In Transfer lane now renders EVERY
// in-flight ACAT as a card: Neil (linked) + the 5 live residuals (ACT-UNLINKED-1,
// ACT-RES-2..5) = 6 cards, and the count chip = firm-wide in-flight = 6, so
// count == visible cards. Sam (Rejected) and ACT-RES-6 (Completed) are terminal
// → NOT rendered (Sam still shows as a transfer card above the divider). A non-
// firm role sees only its linked in-flight ACAT (Neil).
//
// EVERY row carries a tracker record `id` — the always-present stable identity
// from the #88 list projection (`redactAcatForMachineList` returns `id`). TWO
// rows (Reynold Hayes + Obie Armstrong) deliberately share the NON-UNIQUE
// PLACEHOLDER `acatTransferId: "N/A"` while carrying DISTINCT record ids +
// distinct client/amount. This exercises the wrong-modal fix: the drawer now
// fetches detail BY RECORD `id` (getAcatStatusByRecordId), so each "N/A" row
// resolves to its OWN record — where the old by-acatTransferId read collapsed
// every "N/A" row onto one record. Both are non-linkable ("N/A" is a known
// placeholder in the isLinkableAcatTransferId denylist) and surface only on the
// /acat-tracking page: buildAcatChipMap gates chips on isLinkableAcatTransferId,
// so a placeholder acatTransferId produces NO board chip.
//
// The Rejected row (Sam) is TERMINAL and is now HIDDEN from the /acat-tracking
// tab by buildAcatTracking's display-level filter; it is unaffected on the
// transfer board (chip map + card) and still reachable via the external tracker.
export const ACAT_LIST_FIXTURE: AcatListRow[] = [
  {
    // Linked → DEMO-T-0008 (Neil Walker). Accepted, fully mapped, clean.
    id: "rec-lee-8",
    acatTransferId: "ACT-NEIL-8",
    clientName: "Neil Walker",
    controlNumber: "CTRL-88213",
    direction: "Incoming",
    type: "Full account transfer",
    accountType: "Individual brokerage",
    status: "Accepted",
    transferringContra: "Fidelity",
    statementAmount: 1871000,
    acatDate: "2026-07-10",
    lastActivityAt: "2026-07-13T15:42:00.000Z",
    apexAccountId: "********ZHLK",
    statementAccountNumber: "****9384",
    dtccNumber: "****9236",
    assetMap: { total: 41, mapped: 41, unmapped: 0, pending: 0, expected: 41 },
  },
  {
    // Linked → DEMO-T-0009 (Sam Stone). Rejected, 2-of-4 positions in exception.
    // Rejected is TERMINAL and is now hidden from the ACAT Tracking tab (still
    // visible as a transfer card on the In Transfer board and via the external
    // tracker link).
    id: "rec-sam-9",
    acatTransferId: "ACT-SAM-9",
    clientName: "Sam Stone",
    controlNumber: "CTRL-90114",
    direction: "Incoming",
    type: "Full account transfer",
    accountType: "Traditional IRA",
    status: "Rejected",
    transferringContra: "Schwab",
    statementAmount: 2182000,
    acatDate: "2026-07-11",
    lastActivityAt: "2026-07-14T09:05:00.000Z",
    apexAccountId: "********TL8F",
    statementAccountNumber: "****7788",
    dtccNumber: "****9627",
    assetMap: { total: 4, mapped: 2, unmapped: 2, pending: 0, expected: 4 },
  },
  {
    // RESIDUAL/UNLINKED — matches no visible transfer. PendingSettlement (RAW
    // tracker enum, ticket) → friendly "Pending Settlement" group. Carries a
    // REAL UUID-shaped acatTransferId, so it is LINKABLE (the link picker shows)
    // and its by-record detail renders a real position table — the "a real-UUID
    // ACAT still shows its positions" proof for the wrong-modal fix.
    id: "rec-unlinked-1",
    acatTransferId: "1f0c9a2e-3b4d-4e5f-8a9b-0c1d2e3f4a5b",
    clientName: "Priya Nair",
    controlNumber: "CTRL-77650",
    direction: "Incoming",
    type: "Partial transfer",
    accountType: "Joint brokerage",
    status: "PendingSettlement",
    transferringContra: "Vanguard",
    statementAmount: 640500,
    acatDate: "2026-07-12",
    lastActivityAt: "2026-07-14T12:20:00.000Z",
    apexAccountId: "********WG16",
    statementAccountNumber: "****8878",
    dtccNumber: "****5635",
    assetMap: { total: 12, mapped: 9, unmapped: 0, pending: 3, expected: 12 },
  },
  {
    // RESIDUAL/UNLINKED, Submitted → LIVE (firm-role card + firm-wide count).
    id: "rec-res-2",
    acatTransferId: "ACT-RES-2",
    clientName: "Dev Anand",
    controlNumber: "CTRL-77712",
    direction: "Incoming",
    type: "Full account transfer",
    accountType: "Roth IRA",
    status: "Submitted",
    transferringContra: "Merrill",
    statementAmount: 512300,
    acatDate: "2026-07-12",
    lastActivityAt: "2026-07-14T13:05:00.000Z",
    apexAccountId: "********NP06",
    statementAccountNumber: "****3571",
    dtccNumber: "****8820",
    assetMap: { total: 8, mapped: 8, unmapped: 0, pending: 0, expected: 8 },
  },
  {
    // RESIDUAL/UNLINKED, PendingBookkeeping (RAW enum) → "Pending Bookkeeping".
    id: "rec-res-3",
    acatTransferId: "ACT-RES-3",
    clientName: "Gavin Carver",
    controlNumber: "CTRL-77720",
    direction: "Incoming",
    type: "Partial transfer",
    accountType: "Individual brokerage",
    status: "PendingBookkeeping",
    transferringContra: "E*Trade",
    statementAmount: 297000,
    acatDate: "2026-07-13",
    lastActivityAt: "2026-07-14T14:40:00.000Z",
    apexAccountId: "********DZ60",
    statementAccountNumber: "****2716",
    dtccNumber: "****2222",
    assetMap: { total: 6, mapped: 5, unmapped: 1, pending: 0, expected: 6 },
  },
  {
    // RESIDUAL/UNLINKED, ToCome (RAW enum) → friendly "To Come".
    id: "rec-res-4",
    acatTransferId: "ACT-RES-4",
    clientName: "Abby Baumbach",
    controlNumber: "CTRL-77731",
    direction: "Incoming",
    type: "Full account transfer",
    accountType: "Joint brokerage",
    status: "ToCome",
    transferringContra: "Fidelity",
    statementAmount: 1044000,
    acatDate: "2026-07-11",
    lastActivityAt: "2026-07-14T15:20:00.000Z",
    apexAccountId: "********GZ47",
    statementAccountNumber: "****6865",
    dtccNumber: "****7268",
    assetMap: { total: 22, mapped: 22, unmapped: 0, pending: 0, expected: 22 },
  },
  {
    // RESIDUAL/UNLINKED, an UNKNOWN/unmapped raw value (ticket) → proves the
    // safe fallback humanizes it ("Awaiting Custodian") and keeps it visible in
    // its own group rather than crashing or dropping it.
    id: "rec-res-5",
    acatTransferId: "ACT-RES-5",
    clientName: "Abraham Bergnaum",
    controlNumber: "CTRL-77744",
    direction: "Incoming",
    type: "Full account transfer",
    accountType: "Traditional IRA",
    status: "AwaitingCustodian",
    transferringContra: "Schwab",
    statementAmount: 833500,
    acatDate: "2026-07-10",
    lastActivityAt: "2026-07-14T16:02:00.000Z",
    apexAccountId: "********NK47",
    statementAccountNumber: "****9087",
    dtccNumber: "****5353",
    assetMap: { total: 15, mapped: 15, unmapped: 0, pending: 0, expected: 15 },
  },
  {
    // RESIDUAL/UNLINKED, Completed → TERMINAL → must NOT count firm-wide.
    id: "rec-res-6",
    acatTransferId: "ACT-RES-6",
    clientName: "Abagail Barton",
    controlNumber: "CTRL-77758",
    direction: "Incoming",
    type: "Full account transfer",
    accountType: "Individual brokerage",
    status: "Completed",
    transferringContra: "TD Ameritrade",
    statementAmount: 456000,
    acatDate: "2026-07-05",
    lastActivityAt: "2026-07-13T10:15:00.000Z",
    apexAccountId: "********OL73",
    statementAccountNumber: "****5836",
    dtccNumber: "****7127",
    assetMap: { total: 9, mapped: 9, unmapped: 0, pending: 0, expected: 9 },
  },
  {
    // PLACEHOLDER acatTransferId "N/A" #1 (Reynold Hayes). Shares the exact
    // non-unique value with Obie Armstrong below, but has a DISTINCT record `id`
    // and distinct client/amount. The drawer fetches BY RECORD `id`, so this
    // resolves to ITS OWN by-record detail (rec-manual-hayes) — proving the
    // wrong-modal bug is fixed. Not linkable ("N/A" is not id-shaped).
    id: "rec-manual-hayes",
    acatTransferId: "N/A",
    clientName: "Reynold Hayes",
    controlNumber: "Manual",
    direction: "Incoming",
    type: "Partial transfer",
    accountType: "Individual brokerage",
    status: "PendingSettlement",
    transferringContra: "Vanguard",
    statementAmount: 742900,
    acatDate: "2026-07-08",
    lastActivityAt: "2026-07-14T10:30:00.000Z",
    apexAccountId: "********KH42",
    statementAccountNumber: "****3717",
    dtccNumber: "****5635",
    assetMap: { total: 7, mapped: 7, unmapped: 0, pending: 0, expected: 7 },
  },
  {
    // PLACEHOLDER acatTransferId "N/A" #2 (Obie Armstrong) — mirrors the shape of a
    // prod record (Victory Funds, PendingSettlement, control "Manual"). Same
    // "N/A" value as Reynold Hayes but a DISTINCT record `id` + distinct
    // client/amount, resolving to its OWN by-record detail (rec-manual-armstrong).
    // Not linkable ("N/A" is not id-shaped).
    id: "rec-manual-armstrong",
    acatTransferId: "N/A",
    clientName: "Obie Armstrong",
    controlNumber: "Manual",
    direction: "Incoming",
    type: "Full account transfer",
    accountType: "Roth IRA",
    status: "PendingSettlement",
    transferringContra: "Victory Funds",
    statementAmount: 218400,
    acatDate: "2026-07-09",
    lastActivityAt: "2026-07-14T11:00:00.000Z",
    apexAccountId: "********PO13",
    statementAccountNumber: "****5684",
    dtccNumber: "****0087",
    assetMap: { total: 5, mapped: 5, unmapped: 0, pending: 0, expected: 5 },
  },
];

// Per-record detail projections (the by-id endpoint shape, AcatStatus). Defined
// as named consts so BOTH lookup maps below can reference the SAME object — one
// keyed by acatTransferId (the unchanged getAcatStatus path: linked-transfer
// click-through via <AcatStatusSection>), one keyed by record id (the drawer's
// new getAcatStatusByRecordId path).
const detailLee: AcatStatus = {
  acatTransferId: "ACT-NEIL-8",
  controlNumber: "CTRL-88213",
  direction: "Incoming",
  type: "Full account transfer",
  accountType: "Individual brokerage",
  status: "Accepted",
  transferringContra: "Fidelity",
  statementAmount: 1871000,
  methodRequested: "ACATS",
  feeCharged: true,
  feeAmount: 75,
  acatDate: "2026-07-10",
  apexAccountId: "********ZHLK",
  statementAccountNumber: "****9384",
  dtccNumber: "****9236",
  assets: [
    { symbol: "VTI", description: "Vanguard Total Stock Market ETF", cusip: "****4303", expectedQty: 1200, actualQty: 1200, mapStatus: "Mapped", issue: null, amount: 312000, assetClass: "EQUITY" },
    { symbol: "BND", description: "Vanguard Total Bond ETF", cusip: "****3537", expectedQty: 900, actualQty: 900, mapStatus: "Mapped", issue: null, amount: 65000, assetClass: "FI-ETF" },
    { symbol: "AAPL", description: "Apple Inc", cusip: "****5316", expectedQty: 300, actualQty: 300, mapStatus: "Mapped", issue: null, amount: 63000, assetClass: "EQUITY" },
  ],
};

const detailSam: AcatStatus = {
  acatTransferId: "ACT-SAM-9",
  controlNumber: "CTRL-90114",
  direction: "Incoming",
  type: "Full account transfer",
  accountType: "Traditional IRA",
  status: "Rejected",
  transferringContra: "Schwab",
  statementAmount: 2182000,
  methodRequested: "ACATS",
  feeCharged: false,
  feeAmount: null,
  acatDate: "2026-07-11",
  apexAccountId: "********TL8F",
  statementAccountNumber: "****7788",
  dtccNumber: "****9627",
  // 4 positions, 2 in exception → "2 of 4 need attention".
  assets: [
    { symbol: "SPY", description: "SPDR S&P 500 ETF", cusip: "****9246", expectedQty: 400, actualQty: 400, mapStatus: "Mapped", issue: null, amount: 210000, assetClass: "EQUITY" },
    { symbol: "MSFT", description: "Microsoft Corp", cusip: "****0884", expectedQty: 500, actualQty: 500, mapStatus: "Mapped", issue: null, amount: 205000, assetClass: "EQUITY" },
    { symbol: "GHIJ", description: "Legacy mutual fund (non-transferable)", cusip: "****7744", expectedQty: 300, actualQty: 0, mapStatus: "Unmapped", issue: "Position not received", amount: 0, assetClass: "MUTUAL_FUND" },
    { symbol: "VTIP", description: "Vanguard Short-Term TIPS ETF", cusip: "****9087", expectedQty: 200, actualQty: 150, mapStatus: "Unmapped", issue: "Quantity mismatch", amount: 7500, assetClass: "FI-ETF" },
  ],
};

// Priya Nair — the REAL-UUID unlinked row (acatTransferId is the UUID on the
// list row above). Proves a real-UUID ACAT still resolves to its own positions.
const detailPriya: AcatStatus = {
  acatTransferId: "1f0c9a2e-3b4d-4e5f-8a9b-0c1d2e3f4a5b",
  controlNumber: "CTRL-77650",
  direction: "Incoming",
  type: "Partial transfer",
  accountType: "Joint brokerage",
  // RAW enum — the modal resolves this to "Pending Settlement", identical to
  // the list row (ticket).
  status: "PendingSettlement",
  transferringContra: "Vanguard",
  statementAmount: 640500,
  methodRequested: "ACATS",
  feeCharged: false,
  feeAmount: null,
  acatDate: "2026-07-12",
  apexAccountId: "********WG16",
  statementAccountNumber: "****8878",
  dtccNumber: "****5635",
  assets: [
    { symbol: "QQQ", description: "Invesco QQQ Trust", cusip: "****6186", expectedQty: 220, actualQty: null, mapStatus: "Pending", issue: null, amount: null, assetClass: "EQUITY" },
    { symbol: "SCHD", description: "Schwab US Dividend Equity ETF", cusip: "****4558", expectedQty: 500, actualQty: null, mapStatus: "Pending", issue: null, amount: null, assetClass: "EQUITY" },
    { symbol: "TLT", description: "iShares 20+ Year Treasury Bond ETF", cusip: "****8878", expectedQty: 150, actualQty: null, mapStatus: "Pending", issue: null, amount: null, assetClass: "FI-ETF" },
  ],
};

// Reynold Hayes — "N/A" placeholder #1. DISTINCT detail (client/amount/
// positions) from Obie Armstrong despite sharing acatTransferId "N/A". Keyed
// ONLY by record id: two "N/A" details CANNOT coexist in an acatTransferId-keyed
// map — which is exactly the collision that caused the wrong-modal bug.
const detailHayes: AcatStatus = {
  acatTransferId: "N/A",
  controlNumber: "Manual",
  direction: "Incoming",
  type: "Partial transfer",
  accountType: "Individual brokerage",
  status: "PendingSettlement",
  transferringContra: "Vanguard",
  statementAmount: 742900,
  methodRequested: "ACATS",
  feeCharged: false,
  feeAmount: null,
  acatDate: "2026-07-08",
  apexAccountId: "********KH42",
  statementAccountNumber: "****3717",
  dtccNumber: "****5635",
  assets: [
    { symbol: "IVV", description: "iShares Core S&P 500 ETF", cusip: "****9929", expectedQty: 800, actualQty: 800, mapStatus: "Mapped", issue: null, amount: 452000, assetClass: "EQUITY" },
    { symbol: "VXUS", description: "Vanguard Total International Stock ETF", cusip: "****9004", expectedQty: 1500, actualQty: 1500, mapStatus: "Mapped", issue: null, amount: 290900, assetClass: "EQUITY" },
  ],
};

// Obie Armstrong — "N/A" placeholder #2. Mirrors the real prod record (Victory
// Funds). DISTINCT detail from Reynold Hayes; keyed only by record id.
const detailArmstrong: AcatStatus = {
  acatTransferId: "N/A",
  controlNumber: "Manual",
  direction: "Incoming",
  type: "Full account transfer",
  accountType: "Roth IRA",
  status: "PendingSettlement",
  transferringContra: "Victory Funds",
  statementAmount: 218400,
  methodRequested: "ACATS",
  feeCharged: false,
  feeAmount: null,
  acatDate: "2026-07-09",
  apexAccountId: "********PO13",
  statementAccountNumber: "****5684",
  dtccNumber: "****0087",
  assets: [
    { symbol: "USSPX", description: "Victory US Large Cap Index Fund", cusip: "****1545", expectedQty: 3200, actualQty: 3200, mapStatus: "Mapped", issue: null, amount: 218400, assetClass: "MUTUAL_FUND" },
  ],
};

// Keyed by acatTransferId — the UNCHANGED getAcatStatus path (linked-transfer
// click-through via <AcatStatusSection>, which is handed a REAL acatTransferId).
// Only entries with a real, unique acatTransferId belong here — the two "N/A"
// details are deliberately absent (they can only be keyed by record id).
const DETAILS: Record<string, AcatStatus> = {
  "ACT-NEIL-8": detailLee,
  "ACT-SAM-9": detailSam,
  "1f0c9a2e-3b4d-4e5f-8a9b-0c1d2e3f4a5b": detailPriya,
};

// Keyed by RECORD id — the drawer's getAcatStatusByRecordId path. Every row that
// has a by-record detail appears here; the two "N/A" rows resolve to DISTINCT
// records. Rows with no entry (rec-res-2..6) return null → an empty state, not a
// wrong record.
const DETAILS_BY_RECORD_ID: Record<string, AcatStatus> = {
  "rec-lee-8": detailLee,
  "rec-sam-9": detailSam,
  "rec-unlinked-1": detailPriya,
  "rec-manual-hayes": detailHayes,
  "rec-manual-armstrong": detailArmstrong,
};

/** DEV-ONLY: the synthetic firm-wide in-flight ACAT list. */
export function acatListFixture(): AcatListRow[] {
  return ACAT_LIST_FIXTURE;
}

/** DEV-ONLY: the synthetic by-id projection keyed by acatTransferId (null when
 *  unknown — mirrors the tracker's 404 → null contract). Backs the UNCHANGED
 *  getAcatStatus path. */
export function acatStatusFixture(acatTransferId: string): AcatStatus | null {
  return DETAILS[acatTransferId] ?? null;
}

/** DEV-ONLY: the synthetic by-id projection keyed by RECORD id (null when
 *  unknown — mirrors the tracker's 404 → null contract). Backs the drawer's
 *  getAcatStatusByRecordId path, so two rows sharing acatTransferId "N/A"
 *  resolve to their OWN distinct detail. */
export function acatStatusFixtureByRecordId(recordId: string): AcatStatus | null {
  return DETAILS_BY_RECORD_ID[recordId] ?? null;
}
