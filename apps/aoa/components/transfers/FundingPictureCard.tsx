import { Suspense } from "react";
import Link from "next/link";
import { Card, CardBody, CardHeader, FieldList, type Field } from "@/components/ui";
import type { DealRow } from "@/lib/data/deal-types";
import { stageLabel as dealStageLabel } from "@/lib/data/deal-types";
import type { TransferRow } from "@/lib/data/transfer-types";
import { isAcatFunding } from "@/lib/data/transfer-types";
import type { AssignedAssetMapDetail } from "@/lib/data/transfer-asset-map";
import { usd } from "@/lib/format";
import { assetMapTransferLinkEnabled } from "@/lib/flags";
import { dealRollup } from "./funding-rollup";
import {
  assignedMapExpandable,
  assignedPositionsRollup,
  dealRowMode,
  hasAcatLink,
  isAcatLinked,
  tradeRequestRowVisible,
} from "./funding-picture";
import {
  TradeRequestsSection,
  TradeRequestsSkeleton,
} from "@/components/client-portrait";
import { CollapsibleRow } from "./CollapsibleRow";
import { AcatStatusSection } from "./AcatStatusSection";
import { AcatStatusSkeleton } from "./AcatStatusSkeleton";
import { AcatAssetSummaryRow } from "./AcatAssetSummaryRow";
import { AssetMapLinkControl } from "./AssetMapLinkControl";
import { TransferAcatPicker } from "./TransferAcatPicker";
import styles from "./FundingPictureCard.module.css";

// "Full funding picture" HUB (owner rework, follows #185/#186/#187/#189/#190).
// Server component inside Information & linked records on transfer detail.
// Each LINKED integration row is COLLAPSED by
// default and user-expandable via <CollapsibleRow> (native <details> —
// client-side toggle only, collapsed on every visit, no persistence, D2);
// unlinked rows keep their pre-hub state with NO expand affordance. Rows:
//   • Deal — linked deal → collapsed `name · $amount · stage` line expanding
//     to Stage/Amount/Owner/Expected close + the "Open deal →" deep link (the
//     link lives INSIDE the expansion — interactive elements never render in a
//     <summary>). No linked deal → the household `dealRollup` link row /
//     empty state, byte-identical to the pre-hub card.
//   • ACAT link — linked-id line, or the shared transfer-scoped ACAT picker
//     for eligible Ops/Admin callers; no navigation away to find the record.
//     Affordances remain rail-dependent (isAcatLinked). Funding method is edited
//     only in Funding plan & positions; the overview shows the saved method.
//   • ACAT status — full tracker detail (a compact status also stays visible in
//     the page overview using the same cached reader). Gated on hasAcatLink (ids
//     alone, ANY funding type — the standalone section's contract; the ACAT-
//     link writer never sets funding_type): collapsed static id line,
//     expanding to <AcatStatusSection> inside the card's OWN <Suspense>
//     (PR #133 — the tracker call never blocks the shell) with the three #187
//     outcomes (card / missing-link note / unavailable note) verbatim.
//   • Asset Mapping — ONE section (#189 merge; ops read the old two rows as
//     one thing). Flag ON (ASSET_MAP_TRANSFER_LINK): the <AssetMapLinkControl>
//     link/change/unlink control is primary (S4: a mapping account is REUSABLE
//     across transfers), the tracker's redacted in-flight positions line
//     streams beneath once id-linked, and when this transfer carries the
//     assignment triple a collapsed "Assigned map" expansion shows the
//     assigned account's facts + positions from the mirror tables
//     (assignedMapDetail, masked number only; stale assignment → a visible
//     "not found" note). Flag OFF: the original positions-only row (no link
//     at all → "No asset map linked"). A missing link does not imply cash funding.
//     Both tracker-backed fragments self-defer via <AcatAssetSummaryRow> and
//     share the request-memoized reader with the ACAT expansion — ONE tracker
//     call per request.
//   • Trade requests (S4) — collapsed row of the client's live trade requests
//     (client_sf_id → cedar_ridge_user_id), Suspense-deferred; only when a client
//     id resolves.

const EM_DASH = "—";

// Date idiom copied from DealDetail.tsx — `date` columns are UTC midnights.
const day = (d: Date | null) =>
  d == null
    ? EM_DASH
    : d.toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
        timeZone: "UTC",
      });

const qty = (n: number | null): string =>
  n == null ? EM_DASH : n.toLocaleString("en-US", { maximumFractionDigits: 4 });

export function FundingPictureCard({
  transfer,
  deal,
  deals,
  assignedMapDetail,
  tradeRequestUserId,
  canWrite,
  canLinkAcat = false,
  canLinkAssetMap = false,
}: {
  transfer: TransferRow;
  deal: DealRow | null;
  deals: DealRow[] | null;
  /** The ASSIGNED account's facts+positions (page-fetched, RLS-scoped).
   *  null = flag off / unassigned / stale assignment — which of those applies
   *  is derived here from the flag + the transfer's assignment triple. */
  assignedMapDetail: AssignedAssetMapDetail | null;
  /** The transfer client's cedar_ridge_user_id (page-resolved, RLS-scoped) for the
   *  Trade-requests row, or null when there's no client/id. SERVER-ONLY join key
   *  — consumed only by the deferred TradeRequestsSection below; never rendered,
   *  never on TransferRow, never forwarded to a client child. */
  tradeRequestUserId: string | null;
  canWrite: boolean;
  /** Firm-wide ACAT candidates require a separate Ops/Admin permission. */
  canLinkAcat?: boolean;
  /** Material source edits require Operations/Admin and active Preparation. */
  canLinkAssetMap?: boolean;
}) {
  const rollup = deals ? dealRollup(deals) : null;
  // Rail-dependent ACAT link affordances; independent of the plan editor.
  const acatLinked = isAcatLinked(
    transfer.funding_type,
    transfer.acat_transfer_id,
    transfer.acat_record_id,
  );
  // Id-presence alone (ANY funding type) — gates the ACAT-status row and the
  // tracker-count fragments, preserving the removed standalone section's
  // ids-only contract (H1).
  const acatIdLinked = hasAcatLink(
    transfer.acat_transfer_id,
    transfer.acat_record_id,
  );
  const mode = dealRowMode(deal != null, rollup?.count ?? 0);

  // Asset-map link (rework S3/S4) — flag-gated merged Asset-mapping section.
  // `current` is the linked mapping account, masked for display (§6); null =
  // unlinked. (S4: the same account may back other transfers too.)
  const assetMapLinkEnabled = assetMapTransferLinkEnabled();
  const assetMapCurrent =
    transfer.asset_map_folder_id && transfer.asset_map_custodian
      ? {
          custodian: transfer.asset_map_custodian,
          // S5: a linked account may have no number — show the type then.
          accountNumberMasked: transfer.asset_map_account_number
            ? `••••${transfer.asset_map_account_number.slice(-4)}`
            : null,
          accountType: transfer.asset_map_account_type,
        }
      : null;
  const mapExpandable = assignedMapExpandable(
    assetMapLinkEnabled,
    transfer.asset_map_folder_id,
    transfer.asset_map_custodian,
  );
  const mapRollup = assignedMapDetail
    ? assignedPositionsRollup(assignedMapDetail.positions)
    : null;

  return (
    <Card>
      <CardHeader>Full funding picture</CardHeader>
      <CardBody>
        <div className={styles.rows}>
          {/* Deal — linked deal expands to the deal summary + deep link (D5);
              no linked deal → the household rollup / empty state unchanged. */}
          {mode === "linked" && deal ? (
            <CollapsibleRow
              label="Deal"
              summary={`${deal.name} · ${usd(deal.amount)} · ${dealStageLabel(deal.stage)}`}
            >
              <FieldList
                items={
                  [
                    { label: "Stage", value: dealStageLabel(deal.stage) },
                    { label: "Amount", value: usd(deal.amount) },
                    { label: "Owner", value: deal.owner_name ?? EM_DASH },
                    { label: "Expected close", value: day(deal.close_date) },
                  ] satisfies Field[]
                }
              />
              <Link href={`/deals/${deal.id}`} className={styles.expandLink}>
                Open deal →
              </Link>
            </CollapsibleRow>
          ) : (
            <Link href="/deals" className={styles.row}>
              <span className={styles.rowLabel}>Deal</span>
              {mode === "rollup" && rollup ? (
                <span className={styles.rowValue}>
                  {rollup.count} {rollup.count === 1 ? "deal" : "deals"} ·{" "}
                  {usd(rollup.total)}
                  {rollup.topStage ? ` · ${dealStageLabel(rollup.topStage)}` : ""}
                </span>
              ) : (
                <span className={styles.rowEmpty}>
                  {deals === null
                    ? "No household on file yet"
                    : "No deals for this household"}
                </span>
              )}
              <span className={styles.rowGo} aria-hidden>
                →
              </span>
            </Link>
          )}

          {/* Retain the ACAT link without duplicating the funding-plan editor. */}
          {isAcatFunding(transfer.funding_type) && (
            <div className={styles.rowStack}>
              <span className={styles.rowLabel}>ACAT link</span>

              {acatLinked ? (
                <div className={styles.acatLinked}>
                  {/* UUID rows unchanged; a UUID-less (record-id-only) link
                      shows the tracker record PK instead (D5) — the acatLinked
                      gate guarantees at least one id is present. */}
                  <span className={styles.acatId}>
                    {transfer.acat_transfer_id
                      ? `ACAT ${transfer.acat_transfer_id}`
                      : `ACAT record ${transfer.acat_record_id}`}
                  </span>
                  <Link href="/acat-tracking" className={styles.acatLink}>
                    View in ACAT Tracking →
                  </Link>
                </div>
              ) : canLinkAcat && !transfer.archived_at && transfer.stage !== "FUNDED" ? (
                <TransferAcatPicker transferId={transfer.id} variant="inline" />
              ) : (
                <span className={styles.rowEmpty}>No linked ACAT yet</span>
              )}
            </div>
          )}

          {/* Full ACAT status. Gated on
              hasAcatLink (ids alone, ANY funding type — H1): the ACAT-link
              writer never sets funding_type, so an id-linked CHECK/WIRE/ACH/
              unchosen transfer must still show its live status. Collapsed
              summary is static transfer-row data (never suspends); the
              expansion streams behind the card's own Suspense boundary, so a
              user expanding mid-stream sees the skeleton, never a blank. No
              id at all → no row (the ACAT-link row above carries the
              unlinked affordances). */}
          {acatIdLinked && (
            <CollapsibleRow
              label="ACAT status"
              summary={
                <span className={styles.acatId}>
                  {transfer.acat_transfer_id
                    ? `ACAT ${transfer.acat_transfer_id}`
                    : `ACAT record ${transfer.acat_record_id}`}
                </span>
              }
            >
              <Suspense fallback={<AcatStatusSkeleton />}>
                <AcatStatusSection
                  acatRecordId={transfer.acat_record_id}
                  acatTransferId={transfer.acat_transfer_id}
                />
              </Suspense>
            </CollapsibleRow>
          )}

          {/* Asset mapping — ONE section (#189 merge; ops read the old two
              rows as one thing). Flag ON: the link control (link/change/unlink
              the pre-transfer mapping account — reusable across transfers, S4)
              is the primary content; beneath it, once the transfer is
              id-linked, the tracker's redacted in-flight positions line
              streams in (self-deferred, hasAcatLink gate — H1); and when this
              transfer carries the assignment triple, the collapsed "Assigned
              map" expansion (D4) shows the assigned account's facts +
              positions. Flag OFF: the original positions-only row, so the card
              degrades to prior behavior unchanged. The control stays OUTSIDE
              any <summary>. */}
          {assetMapLinkEnabled ? (
            <div className={styles.rowStack}>
              <div className={styles.rowInline}>
                <span className={styles.rowLabel}>Asset mapping</span>
                <AssetMapLinkControl
                  transferId={transfer.id}
                  canWrite={canLinkAssetMap}
                  hrqjSbevsbySbin8={deal?.account_last4 ?? null}
                  current={assetMapCurrent}
                />
              </div>
              {/* In-flight positions from the tracker's redacted map, only
                  once an ACAT id is linked (later in the lifecycle than the
                  mapping-account plan above). */}
              {acatIdLinked && (
                <Suspense
                  fallback={
                    <span className={styles.rowEmpty}>
                      Loading in-flight positions…
                    </span>
                  }
                >
                  <AcatAssetSummaryRow
                    acatRecordId={transfer.acat_record_id}
                    acatTransferId={transfer.acat_transfer_id}
                    variant="inFlight"
                  />
                </Suspense>
              )}
              {mapExpandable &&
                (assignedMapDetail != null && mapRollup != null ? (
                  <CollapsibleRow
                    label="Assigned map"
                    summary={`${assignedMapDetail.custodian} ${assignedMapDetail.accountNumberMasked} · ${mapRollup.count} ${
                      mapRollup.count === 1 ? "position" : "positions"
                    } · ${usd(mapRollup.totalValue)}`}
                  >
                    <FieldList
                      items={
                        [
                          {
                            label: "Holder",
                            value: assignedMapDetail.accountHolder ?? EM_DASH,
                          },
                          {
                            label: "Household",
                            value: assignedMapDetail.householdName ?? EM_DASH,
                          },
                          {
                            label: "Account type",
                            value: assignedMapDetail.accountType ?? EM_DASH,
                          },
                          {
                            label: "Statement date",
                            value:
                              assignedMapDetail.statementDate == null
                                ? EM_DASH
                                : day(new Date(assignedMapDetail.statementDate)),
                          },
                          {
                            label: "Total value",
                            value:
                              assignedMapDetail.totalValue == null
                                ? EM_DASH
                                : usd(assignedMapDetail.totalValue),
                          },
                          {
                            label: "Cash balance",
                            value:
                              assignedMapDetail.cashBalance == null
                                ? EM_DASH
                                : usd(assignedMapDetail.cashBalance),
                          },
                        ] satisfies Field[]
                      }
                    />
                    {assignedMapDetail.positions.length === 0 ? (
                      <p className={styles.empty}>
                        No positions on file for this account.
                      </p>
                    ) : (
                      <div className={styles.positionsScroller}>
                        <table className={styles.positionsTable}>
                          <thead>
                            <tr>
                              <th>Symbol</th>
                              <th className={styles.num}>Qty</th>
                              <th className={styles.num}>Market value</th>
                              <th>Eligibility</th>
                            </tr>
                          </thead>
                          <tbody>
                            {assignedMapDetail.positions.map((p, i) => (
                              <tr key={`${p.symbol ?? "row"}-${i}`}>
                                <td>
                                  <span className={styles.positionSymbol}>
                                    {p.symbol ?? EM_DASH}
                                  </span>
                                  {p.description && (
                                    <span className={styles.positionDesc}>
                                      {p.description}
                                    </span>
                                  )}
                                </td>
                                <td className={styles.num}>{qty(p.quantity)}</td>
                                <td className={styles.num}>
                                  {p.marketValue == null
                                    ? EM_DASH
                                    : usd(p.marketValue)}
                                </td>
                                <td>{p.eligibility ?? EM_DASH}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </CollapsibleRow>
                ) : (
                  <span className={styles.rowEmpty}>
                    Assigned map not found in the current asset-map mirror.
                  </span>
                ))}
            </div>
          ) : !acatIdLinked ? (
            <div className={styles.row}>
              <span className={styles.rowLabel}>Asset mapping</span>
              <span className={styles.rowEmpty}>No asset map linked</span>
            </div>
          ) : (
            <Suspense
              fallback={
                <div className={styles.row}>
                  <span className={styles.rowLabel}>Asset mapping</span>
                  <span className={styles.rowEmpty}>Loading asset map…</span>
                </div>
              }
            >
              <AcatAssetSummaryRow
                acatRecordId={transfer.acat_record_id}
                acatTransferId={transfer.acat_transfer_id}
                variant="row"
              />
            </Suspense>
          )}

          {/* Trade requests (S4) — LINKED by the transfer's client
              (client_sf_id → cedar_ridge_user_id, resolved server-side on the
              page). Collapsed by default; the live app read is Suspense-deferred
              so it never blocks the hub (the ACAT-row pattern). No resolvable
              client id → no row. */}
          {tradeRequestRowVisible(tradeRequestUserId) && (
            <CollapsibleRow
              label="Trade requests"
              summary={
                <span className={styles.rowEmpty}>Linked to this client</span>
              }
            >
              <Suspense fallback={<TradeRequestsSkeleton />}>
                <TradeRequestsSection cedarRidgeUserId={tradeRequestUserId!} />
              </Suspense>
            </CollapsibleRow>
          )}
        </div>
      </CardBody>
    </Card>
  );
}
