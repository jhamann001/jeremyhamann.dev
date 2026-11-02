import type { HouseholdMemberBreakdown } from "@/lib/twr/household";
import { usd, pct } from "@/lib/twr/engine";
import { maskedAccountNumber } from "@/lib/twr/report-presentation";
import styles from "./report.module.css";

// "Accounts" breakdown table for the household-level Performance report:
// one row per member account — label, number, ending value, share of the
// household, and that account's OWN since-inception TWR (or "—" when it has
// no funded return history). Purely presentational; the numbers arrive
// pre-computed from lib/twr/household.ts. Client-facing copy never names the
// custodian (the label rule), and the browser/PDF receives only a fixed
// last-four display rather than the full custodian account number.

export function HouseholdAccountsTable({
  members,
}: {
  members: HouseholdMemberBreakdown[];
}) {
  const total = members.reduce((s, m) => s + m.endingValue, 0);
  return (
    <table className={styles.perf}>
      <thead>
        <tr>
          <th className={styles.l}>Account</th>
          <th className={styles.l}>Number</th>
          <th>Ending Value</th>
          <th>% of Household</th>
          <th>Since Incep. (TWR)</th>
        </tr>
      </thead>
      <tbody>
        {members.map((m) => (
          <tr key={m.apexAcct}>
            <td className={styles.l}>{m.label}</td>
            <td className={styles.l}>{maskedAccountNumber(m.apexAcct)}</td>
            <td>{usd(m.endingValue)}</td>
            <td>{m.weightPct.toFixed(1)}%</td>
            <td className={styles.port}>
              {m.sinceInceptionTwr == null ? "—" : pct(m.sinceInceptionTwr)}
            </td>
          </tr>
        ))}
        <tr>
          <td className={styles.l} style={{ fontWeight: 700, color: "#111827" }}>
            Household total
          </td>
          <td className={styles.l} />
          <td style={{ fontWeight: 700 }}>{usd(total)}</td>
          <td style={{ fontWeight: 700 }}>{total === 0 ? "—" : "100.0%"}</td>
          <td />
        </tr>
      </tbody>
    </table>
  );
}
