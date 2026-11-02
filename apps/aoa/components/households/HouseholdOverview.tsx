"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import type { HouseholdMember } from "@/lib/data/types";
import { usdCents as usd } from "@/lib/format";
import {
  Card,
  CardHeader,
  CardBody,
  Avatar,
  Pill,
  Table,
  THead,
  TBody,
  TR,
  TH,
  TD,
} from "@/components/ui";
import {
  accountStatusTone,
  currentAccountsSummary,
  accountBalanceState,
  accountCountLabel,
  isEmptyAccount,
  type CombinedAccount,
} from "./accounts-helpers";
import {
  accountTypeOptions,
  matchesAccountStatus,
  normalizedFilterValue,
  type AccountStatusFilter,
} from "./filters-helpers";
import styles from "./HouseholdOverview.module.css";

// Household detail 2-col grid (mockup renderHousehold :4003–4012). Everything
// here is now REAL: members arrive from the page's RLS-scoped getHousehold read,
// and the Combined-accounts table is the household's Apex accounts from
// mirror.client_account_aum (lib/data/account-aum apexAccountsForHousehold,
// RLS-scoped to the caller's book). Performance-report entry points are
// intentionally absent while the reports are not approved for client use.
//
// The directory read remains server/RLS scoped; this component is a small
// client surface so account filters can update a shareable URL without another
// data request. It receives only the page's already-authorized lean rows.

export function HouseholdOverview({
  name,
  members,
  accounts,
  initialAccountStatus = "open",
  initialAccountType = "",
  initialShowEmptyAccounts = false,
}: {
  name: string;
  members: HouseholdMember[];
  accounts: CombinedAccount[];
  initialAccountStatus?: AccountStatusFilter;
  initialAccountType?: string;
  initialShowEmptyAccounts?: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [accountStatus, setAccountStatus] = useState(initialAccountStatus);
  const [accountType, setAccountType] = useState(initialAccountType);
  const [showEmptyAccounts, setShowEmptyAccounts] = useState(initialShowEmptyAccounts);
  useEffect(() => setAccountStatus(initialAccountStatus), [initialAccountStatus]);
  useEffect(() => setAccountType(initialAccountType), [initialAccountType]);
  useEffect(() => setShowEmptyAccounts(initialShowEmptyAccounts), [initialShowEmptyAccounts]);
  const total = currentAccountsSummary(accounts);
  const hasAccounts = accounts.length > 0;
  const types = useMemo(() => accountTypeOptions(accounts), [accounts]);
  const visibleAccounts = useMemo(
    () =>
      accounts.filter(
        (account) =>
          matchesAccountStatus(account.status, accountStatus) &&
          (!accountType || normalizedFilterValue(account.type) === accountType) &&
          (showEmptyAccounts || !isEmptyAccount(account)),
      ),
    [accounts, accountStatus, accountType, showEmptyAccounts],
  );
  const visibleTotal = currentAccountsSummary(visibleAccounts);
  // Summary provenance always comes from the full authorized population.
  const currentAccounts = accounts.filter((account) => accountBalanceState(account) === "CURRENT");
  const balanceDates = currentAccounts.flatMap((account) => account.balanceAsOf ? [account.balanceAsOf] : []).sort();
  const firstBalanceDate = balanceDates[0];
  const lastBalanceDate = balanceDates.at(-1);
  const freshness = currentAccounts.length === 0
    ? "No current balances"
    : balanceDates.length !== currentAccounts.length
      ? "Some balance dates unavailable"
      : firstBalanceDate === lastBalanceDate
        ? `As of ${dateLabel(firstBalanceDate)}`
        : `As of ${dateLabel(firstBalanceDate)} – ${dateLabel(lastBalanceDate)}`;

  function dateLabel(value: string | null | undefined): string {
    if (!value) return "—";
    return new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      timeZone: "UTC",
    }).format(new Date(`${value}T00:00:00Z`));
  }

  function updateAccountFilters(status: AccountStatusFilter, type: string, showEmpty = showEmptyAccounts) {
    setAccountStatus(status);
    setAccountType(type);
    setShowEmptyAccounts(showEmpty);
    const params = new URLSearchParams(window.location.search);
    if (status !== "open") params.set("accountStatus", status); else params.delete("accountStatus");
    if (type) params.set("accountType", type); else params.delete("accountType");
    if (showEmpty) params.set("showEmptyAccounts", "1"); else params.delete("showEmptyAccounts");
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }

  return (
    <div className={styles.grid}>
      <Card>
        <CardHeader>
          <h2 className={styles.cardTitle}>Members</h2>
        </CardHeader>
        <CardBody>
          {members.length === 0 ? (
            <p className={styles.empty}>No members in this household.</p>
          ) : (
            <ul className={styles.members}>
              {members.map((m) => (
                <li key={m.sf_id}>
                  <Link className={styles.member} href={`/client-portrait/${m.sf_id}`}>
                    <Avatar name={m.name || m.email || "?"} />
                    <span className={styles.memberName}>{m.name || m.email || m.sf_id}</span>
                    {m.employeeStatus ? (
                      <Pill tone={m.employeeStatus === "ACTIVE" ? "green" : "gray"}>
                        {m.employeeStatus === "ACTIVE" ? "Employee" : "Former employee"}
                      </Pill>
                    ) : null}
                    <span className={styles.memberArrow} aria-hidden="true">
                      ›
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>

      <details className={styles.accountsCard}>
        <summary className={styles.accountsSummary}>
          <h2 className={styles.cardTitle}>Combined accounts</h2>
          <span className={styles.headerMeta}>
            <Pill tone="gray">{accountCountLabel(accounts.length)} total</Pill>
            <Pill tone="gray">
              Current AUM {total.available ? usd(total.value) : "— · Balance refresh pending"}
            </Pill>
            {hasAccounts && <span className={styles.freshness}>{freshness}</span>}
          </span>
          <span className={styles.disclosure} aria-hidden="true">＋</span>
        </summary>
        {hasAccounts ? (
          <>
            <div className={styles.accountFilters}>
              <div className={styles.accountStatusChips} role="group" aria-label="Filter accounts by status">
                {(["open", "closed", "all"] as const).map((option) => (
                  <button
                    key={option}
                    type="button"
                    className={`${styles.filterChip} ${accountStatus === option ? styles.filterChipActive : ""}`.trim()}
                    aria-pressed={accountStatus === option}
                    onClick={() => updateAccountFilters(option, accountType)}
                  >
                    {option[0].toUpperCase() + option.slice(1)}
                  </button>
                ))}
              </div>
              <label className={styles.accountTypeFilter}>
                <span>Account type</span>
                <select
                  value={accountType}
                  onChange={(event) => updateAccountFilters(accountStatus, event.target.value)}
                  aria-label="Filter combined accounts by account type"
                >
                  <option value="">All account types</option>
                  {types.map((type) => (
                    <option key={normalizedFilterValue(type)} value={normalizedFilterValue(type)}>
                      {type}
                    </option>
                  ))}
                </select>
              </label>
              <label className={styles.emptyAccountsFilter}>
                <input
                  type="checkbox"
                  checked={showEmptyAccounts}
                  onChange={(event) => updateAccountFilters(accountStatus, accountType, event.target.checked)}
                />
                Show empty accounts
              </label>
              <button
                type="button"
                className={styles.clearAccountFilters}
                disabled={accountStatus === "open" && !accountType && !showEmptyAccounts}
                onClick={() => updateAccountFilters("open", "", false)}
              >
                Clear filters
              </button>
              <span className={styles.visibleSummary}>
                {visibleAccounts.length} of {accounts.length} shown · Visible current AUM{" "}
                {visibleTotal.available ? usd(visibleTotal.value) : "— · Balance refresh pending"}
              </span>
            </div>
            {visibleAccounts.length > 0 ? <div className={styles.tableWrap}>
              <Table>
              <THead>
                <TR>
                  <TH>Owner</TH>
                  <TH>Account</TH>
                  <TH>Custodian</TH>
                  <TH>Acct #</TH>
                  <TH>Status</TH>
                  <TH className={styles.valueCol}>Cash</TH>
                  <TH className={styles.valueCol}>Securities</TH>
                  <TH className={styles.valueCol}>Total</TH>
                  <TH>Date</TH>
                </TR>
              </THead>
              <TBody>
                {visibleAccounts.map((a) => (
                  <TR key={a.id ?? `${a.custodian ?? "Apex"}:${a.num}`}>
                    <TD className={styles.ownerCell}>{a.owner}</TD>
                    <TD className={styles.acctType}>{a.type}</TD>
                    <TD>{a.custodian ?? "Apex"}</TD>
                    <TD className={styles.mutedCell}>{a.num}</TD>
                    <TD>
                      <Pill tone={accountStatusTone(a.status)} dot>
                        {a.status ?? "—"}
                      </Pill>
                    </TD>
                    <TD className={styles.valueCell}>{accountBalanceState(a) === "REFRESH_PENDING" ? "—" : usd(a.cash)}</TD>
                    <TD className={styles.valueCell}>{accountBalanceState(a) === "REFRESH_PENDING" ? "—" : usd(a.securities)}</TD>
                    <TD className={styles.valueCell}>{accountBalanceState(a) === "REFRESH_PENDING" ? "—" : usd(a.value)}</TD>
                    <TD className={styles.mutedCell}>
                      {accountBalanceState(a) === "CURRENT" ? (
                        <>As of {dateLabel(a.balanceAsOf)}</>
                      ) : accountBalanceState(a) === "CLOSED" ? (
                        <>
                          Closed {dateLabel(a.closeDate)}
                          {a.closeDateSource === "PROVISIONAL_OVERRIDE" ? " · operational fallback" : ""}
                        </>
                      ) : (
                        <>Balance refresh pending · last as of {dateLabel(a.balanceAsOf)}</>
                      )}
                    </TD>
                  </TR>
                ))}
                <TR className={styles.totalRow}>
                  <TD colSpan={7} className={styles.totalLabel}>
                    Visible current AUM{accountStatus === "closed" ? " · closed accounts excluded" : ""}
                  </TD>
                  <TD className={styles.totalValue}>
                    {visibleTotal.available ? usd(visibleTotal.value) : "—"}
                  </TD>
                  <TD />
                </TR>
              </TBody>
              </Table>
            </div> : (
              <CardBody>
                <p className={styles.empty}>No accounts match these filters.</p>
              </CardBody>
            )}
          </>
        ) : (
          <CardBody>
            <p className={styles.empty}>No investment accounts on file for this household.</p>
          </CardBody>
        )}
      </details>
    </div>
  );
}
