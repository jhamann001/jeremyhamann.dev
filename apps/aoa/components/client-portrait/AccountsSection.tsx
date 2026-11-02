"use client";

import { Fragment, useState } from "react";
import {
  previewLinkedHoldings,
  type PreviewLinkedHoldingsResult,
} from "@/app/(authenticated)/client-portrait/[id]/actions";
import type { ClientAccounts } from "@/lib/data/types";
import {
  Card,
  CardHeader,
  CardBody,
  Button,
  Pill,
  PreviewBadge,
  Table,
  THead,
  TBody,
  TR,
  TH,
  TD,
} from "@/components/ui";
import { usdCompact, usdCents } from "@/lib/format";
import {
  accountBalanceState,
  accountStatusTone,
} from "@/components/households/accounts-helpers";
import {
  apexBalancesAvailable,
  apexTotal,
  extTotal,
  linkedDisplayedTotal,
  groupBeneficiaries,
} from "./portrait-helpers";
import { Toast, useToast } from "@/components/prep/Toast";
import styles from "./AccountsSection.module.css";

// Core Financial accounts stack (P1, ticket — mockup `#n2accts`
// renderAccounts): Apex investment accounts + Beneficiaries + Plaid-connected
// accounts. Performance-report entry points are intentionally absent while the
// reports are not approved for client use. Link-via-Plaid remains a Phase
// C-posture stub (toast, no writes) — the Plaid link flow arrives with Phase D
// data.

type HoldingsPreviewState =
  | { status: "loading" }
  | { status: "failed" }
  | { status: "ok"; result: Extract<PreviewLinkedHoldingsResult, { ok: true }> };

export function AccountsSection({
  accounts,
  clientName,
  clientSfId,
  canPreviewHoldings = false,
}: {
  accounts: ClientAccounts;
  clientName: string;
  clientSfId?: string;
  /** Decided on the server from the preview switch and the caller's role. */
  canPreviewHoldings?: boolean;
}) {
  const { toast, showToast } = useToast();
  const firstName = clientName.split(" ")[0];
  // Page memory only: previews vanish on navigation or refresh.
  const [previews, setPreviews] = useState<Record<string, HoldingsPreviewState>>({});
  const showPreview = canPreviewHoldings && Boolean(clientSfId);

  async function loadPreview(externalAccountId: string) {
    if (!clientSfId) return;
    setPreviews((current) => ({ ...current, [externalAccountId]: { status: "loading" } }));
    let next: HoldingsPreviewState;
    try {
      const result = await previewLinkedHoldings({ clientSfId, externalAccountId });
      next = result.ok ? { status: "ok", result } : { status: "failed" };
    } catch {
      next = { status: "failed" };
    }
    setPreviews((current) => ({ ...current, [externalAccountId]: next }));
  }
  const beneGroups = groupBeneficiaries(accounts.bene);
  // Legacy previews have an authoritative value but no component evidence.
  // Unknown cash/securities must not be invented as zero or derived from total.
  const investment = accounts.investment ?? accounts.apex.map((a) => ({
    ...a, custodian: "Apex" as const, cash: null, securities: null,
    balanceAsOf: null, balanceCurrent: a.balanceCurrent !== false,
    closeDate: null, closeDateSource: null,
  }));
  const apexSum = apexTotal(investment);
  const apexAvailable = apexBalancesAvailable(investment);
  const extSum = extTotal(accounts.ext);
  const plaidLive = accounts.plaidSummariesLive === true;
  // Live display total sums the holdings total rendered on each row. Rows
  // with no rendered total are omitted. Institution balance is not summed,
  // and this figure is not added to AUM.
  const linkedTotal = linkedDisplayedTotal(accounts.ext);
  const extSumAvailable = !plaidLive || linkedTotal != null;
  const shownExtSum = plaidLive ? linkedTotal ?? 0 : extSum;

  return (
    <div className={styles.stack}>
      {/* Confirmed custodial investment accounts */}
      <Card>
        <CardHeader>
          <h2>Investment accounts</h2>
          <Pill tone="gray">
            {investment.length} account{investment.length === 1 ? "" : "s"} ·{" "}
            {apexAvailable ? usdCompact(apexSum) : "Balance refresh pending"}
          </Pill>
          {/* RLS-scoped live balance rows; beneficiaries + Plaid stay deferred. */}
        </CardHeader>
        {investment.length > 0 ? (
          <>
            <div className={styles.tableWrap} role="region" aria-label="Investment account balances" tabIndex={0}>
              <Table className={styles.investmentTable} aria-label="Investment account balances">
                <THead>
                  <TR>
                    <TH>Account type</TH>
                    <TH>Custodian</TH>
                    <TH>Account #</TH>
                    <TH>Status</TH>
                    <TH className={styles.num}>Cash</TH>
                    <TH className={styles.num}>Securities</TH>
                    <TH className={styles.num}>Total</TH>
                    <TH>Balance date</TH>
                  </TR>
                </THead>
                <TBody>
                  {investment.map((a) => {
                    const balanceState = accountBalanceState(a);
                    const pending = balanceState === "REFRESH_PENDING";
                    return (
                      <TR key={("id" in a ? a.id : undefined) ?? `${a.custodian}:${a.num}`}>
                        <TD className={styles.strong}>{a.type}</TD>
                        <TD>{a.custodian}</TD>
                        <TD className={styles.mutedCell}>{a.num}</TD>
                        <TD>
                          <Pill tone={accountStatusTone(a.status)} dot>
                            {a.status.trim() || "—"}
                          </Pill>
                        </TD>
                        <TD className={styles.num}>{pending ? "—" : usdCents(a.cash)}</TD>
                        <TD className={styles.num}>{pending ? "—" : usdCents(a.securities)}</TD>
                        <TD className={`${styles.num} ${styles.strong}`}>
                          {pending ? "—" : usdCents(a.value)}
                        </TD>
                        <TD className={styles.mutedCell}>
                          {a.balanceAsOf ?? "—"}
                          {pending ? (
                            <span className={styles.balanceContext}>Balance refresh pending</span>
                          ) : balanceState === "CLOSED" ? (
                            <span className={styles.balanceContext}>
                              Closed {a.closeDate ?? "—"}
                              {a.closeDateSource === "PROVISIONAL_OVERRIDE" ? " · operational fallback" : ""}
                            </span>
                          ) : null}
                        </TD>
                      </TR>
                    );
                  })}
                  <TR className={styles.totalRow}>
                    <TD colSpan={6} className={styles.totalLabel}>
                      Current investment total
                    </TD>
                    <TD className={`${styles.num} ${styles.totalLabel}`}>
                      {apexAvailable ? usdCents(apexSum) : "—"}
                    </TD>
                    <TD />
                  </TR>
                </TBody>
              </Table>
            </div>
            <p className={styles.balanceNote}>— = unavailable. Current total excludes closed accounts.</p>
          </>
        ) : (
          <CardBody>
            <p className={styles.emptyCopy}>
              {accounts.prospect
                ? "No investment accounts yet — accounts open once the prospect converts and funding begins."
                : "No confirmed investment accounts on file."}
            </p>
          </CardBody>
        )}
      </Card>

      {/* Beneficiaries */}
      <Card>
        <CardHeader>
          <h2>Beneficiaries</h2>
          <Pill tone="gray">
            {beneGroups.length > 0
              ? `${beneGroups.length} account${beneGroups.length === 1 ? "" : "s"}`
              : "none on file"}
          </Pill>
          <PreviewBadge />
        </CardHeader>
        {beneGroups.length > 0 ? (
          <div>
            {beneGroups.map((g) => (
              <div key={g.num} className={styles.beneGroup}>
                <div className={styles.beneAcct}>
                  {g.acct} <span className={styles.beneNum}>· {g.num}</span>
                </div>
                <Table>
                  <THead>
                    <TR>
                      <TH>Name</TH>
                      <TH>Relationship</TH>
                      <TH className={styles.num}>Benefit %</TH>
                      <TH>Date of birth</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {g.list.map((b) => (
                      <TR key={`${b.name}-${b.pct}`}>
                        <TD className={styles.strong}>{b.name}</TD>
                        <TD className={styles.mutedCell}>{b.rel}</TD>
                        <TD className={`${styles.num} ${styles.strong}`}>{b.pct}%</TD>
                        <TD className={styles.mutedCell}>{b.dob}</TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              </div>
            ))}
          </div>
        ) : (
          <CardBody>
            <p className={styles.emptyCopy}>
              {accounts.prospect
                ? "No beneficiaries yet — added once accounts are opened."
                : "No beneficiaries on file."}
            </p>
          </CardBody>
        )}
      </Card>

      {/* Plaid-connected accounts */}
      <Card>
        <CardHeader>
          <h2>Plaid-connected accounts</h2>
          {accounts.plaidLinked && accounts.ext.length > 0 ? (
            <Pill tone="green" dot>
              {accounts.ext.length} linked · {extSumAvailable ? (plaidLive ? usdCents(shownExtSum) : usdCompact(shownExtSum)) : "total unavailable"}
            </Pill>
          ) : (
            <Pill tone="gray">not linked</Pill>
          )}
          {plaidLive && accounts.ext.length > 0 ? null : <PreviewBadge />}
        </CardHeader>
        {plaidLive && accounts.ext.length > 0 ? (
          <>
            <div className={styles.tableWrap} role="region" aria-label="Plaid-linked account summaries" tabIndex={0}>
              <Table aria-label="Plaid-linked account summaries">
                <THead>
                  <TR>
                    <TH>Institution</TH>
                    <TH>Type</TH>
                    <TH>Account #</TH>
                    <TH className={styles.num}>Cash</TH>
                    <TH className={styles.num}>Securities</TH>
                    <TH className={styles.num}>Total</TH>
                    <TH>As-of</TH>
                    {showPreview ? <TH>Holdings</TH> : null}
                  </TR>
                </THead>
                <TBody>
                  {accounts.ext.map((a) => {
                    const previewId = a.externalAccountId;
                    const preview = showPreview && previewId ? previews[previewId] : undefined;
                    return (
                      <Fragment key={previewId ?? a.num}>
                        <TR>
                          <TD className={styles.strong}>{a.inst}</TD>
                          <TD className={styles.mutedCell}>{a.type}</TD>
                          <TD className={styles.mutedCell}>{a.num}</TD>
                          <TD className={styles.num}>{usdCents(a.cash)}</TD>
                          <TD className={styles.num}>{usdCents(a.securities)}</TD>
                          <TD className={`${styles.num} ${styles.strong}`}>
                            {usdCents(a.holdingsTotal)}
                          </TD>
                          <TD className={styles.mutedCell}>{a.asOf?.slice(0, 10) ?? "—"}</TD>
                          {showPreview ? (
                            <TD>
                              {previewId ? (
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  disabled={preview?.status === "loading"}
                                  onClick={() => loadPreview(previewId)}
                                >
                                  {preview?.status === "loading" ? "Loading holdings…" : "Preview holdings"}
                                </Button>
                              ) : null}
                            </TD>
                          ) : null}
                        </TR>
                        {preview?.status === "failed" ? (
                          <TR>
                            <TD colSpan={8}>
                              <p className={styles.previewFailed} role="status">
                                Preview failed. The account summary above is unchanged.
                              </p>
                            </TD>
                          </TR>
                        ) : preview?.status === "ok" ? (
                          <TR>
                            <TD colSpan={8}>
                              <HoldingsPreviewPanel
                                label={`Holdings preview for ${a.inst} ${a.num}`}
                                result={preview.result}
                              />
                            </TD>
                          </TR>
                        ) : null}
                      </Fragment>
                    );
                  })}
                  <TR className={styles.totalRow}>
                    <TD colSpan={5} className={styles.totalLabel}>
                      External total
                    </TD>
                    <TD className={`${styles.num} ${styles.totalLabel}`}>
                      {extSumAvailable ? usdCents(shownExtSum) : "—"}
                    </TD>
                    <TD />
                    {showPreview ? <TD /> : null}
                  </TR>
                </TBody>
              </Table>
            </div>
            <p className={styles.balanceNote}>
              — = unavailable. Held-away balances from the latest Plaid sync; not included in AUM.
            </p>
          </>
        ) : accounts.plaidLinked && accounts.ext.length > 0 ? (
          <div className={styles.tableWrap}>
            <Table>
              <THead>
                <TR>
                  <TH>Institution</TH>
                  <TH>Type</TH>
                  <TH>Account #</TH>
                  <TH className={styles.num}>Balance</TH>
                </TR>
              </THead>
              <TBody>
                {accounts.ext.map((a) => (
                  <TR key={a.num}>
                    <TD className={styles.strong}>{a.inst}</TD>
                    <TD className={styles.mutedCell}>{a.type}</TD>
                    <TD className={styles.mutedCell}>{a.num}</TD>
                    <TD className={`${styles.num} ${styles.strong}`}>
                      {usdCompact(a.balance)}
                    </TD>
                  </TR>
                ))}
                <TR className={styles.totalRow}>
                  <TD colSpan={3} className={styles.totalLabel}>
                    External total
                  </TD>
                  <TD className={`${styles.num} ${styles.totalLabel}`}>
                    {usdCompact(shownExtSum)}
                  </TD>
                </TR>
              </TBody>
            </Table>
          </div>
        ) : (
          <CardBody>
            <div className={styles.plaidEmpty}>
              <p className={styles.emptyCopy}>
                No external accounts linked. Connect {firstName}&rsquo;s outside bank &amp;
                brokerage accounts via Plaid to see held-away balances here.
              </p>
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  showToast(`Plaid link flow (stub) — external accounts would sync for ${firstName}`)
                }
              >
                Link via Plaid
              </Button>
            </div>
          </CardBody>
        )}
      </Card>

      <Toast message={toast} />
    </div>
  );
}

function transferabilityPhrase(label: string | undefined): string {
  if (label === "likely_transferable") return "Likely transferable";
  if (label === "likely_not") return "Likely not transferable";
  return "Unknown";
}

const TRANSFERABILITY_REASONS: Record<string, string> = {
  omni: "Omni mutual fund",
  mutual_fund_non_omni: "Mutual fund is not Omni",
  mutual_fund_unlisted: "Mutual fund is not on the restriction list",
  missing_symbol: "No ticker",
  missing_security_type: "Security type unavailable",
  unrecognized_security_type: "Security type not classified",
  rules_unavailable: "Transfer rules unavailable",
  fixed_income: "Fixed income is liquidated",
  apex_asset_unsupported: "Asset type is not supported",
  standard_security: "Standard security",
  cash: "Cash transfers with the account",
  needs_review: "Needs review",
};

function transferabilityReasonPhrase(reason: string | undefined): string {
  if (!reason) return "Unknown";
  return TRANSFERABILITY_REASONS[reason] ?? "Unknown";
}

function HoldingsPreviewPanel({
  label,
  result,
}: {
  label: string;
  result: Extract<PreviewLinkedHoldingsResult, { ok: true }>;
}) {
  return (
    <div className={styles.holdingsPreview} role="region" aria-label={label}>
      <div className={styles.holdingsSummary}>
        <span className={styles.holdingsPrimary}>
          Holdings sum {usdCents(result.holdingsTotal)}
        </span>
        <span>Institution balance {usdCents(result.institutionBalance)}</span>
        <span>Difference {usdCents(result.difference)}</span>
        <span className={styles.mutedCell}>As-of {result.asOf?.slice(0, 10) ?? "—"}</span>
      </div>
      {result.rows.length > 0 ? (
        <Table aria-label={label}>
          <THead>
            <TR>
              <TH>Symbol</TH>
              <TH>Name</TH>
              <TH className={styles.num}>Quantity</TH>
              <TH className={styles.num}>Value</TH>
              <TH>Transferability</TH>
            </TR>
          </THead>
          <TBody>
            {result.rows.map((row, index) => (
              <TR key={`${row.symbol ?? "holding"}-${index}`}>
                <TD className={styles.strong}>{row.symbol ?? "—"}</TD>
                <TD className={styles.mutedCell}>{row.name ?? "—"}</TD>
                <TD className={styles.num}>
                  {row.quantity == null ? "—" : row.quantity.toLocaleString("en-US")}
                </TD>
                <TD className={styles.num}>{usdCents(row.value)}</TD>
                <TD>
                  <div>{transferabilityPhrase(row.label)}</div>
                  <div className={styles.mutedCell}>{transferabilityReasonPhrase(row.reason)}</div>
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      ) : (
        <p className={styles.emptyCopy}>No holdings returned for this account.</p>
      )}
      <p className={styles.balanceNote}>
        Current holdings from the latest Plaid sync. Preview only: not saved in AoA and not included in AUM.
      </p>
    </div>
  );
}
