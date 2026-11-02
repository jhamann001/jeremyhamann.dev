"use client";

import { useActionState } from "react";
import { reviewSchwabMappingAction } from "./actions";
import styles from "./page.module.css";

const MESSAGES = {
  saved: "Mappings saved. They will be applied by the next successful Schwab snapshot. No balances were imported here.",
  invalid: "Nothing was saved. Check the input format, or refresh and preview again.",
  forbidden: "Only Operations and Admins can review mappings.",
  target_mismatch: "Nothing was saved. A target was not found or the contact does not belong to that source household.",
  conflict: "Nothing was saved. A mapping changed since preview. Create a fresh preview before saving.",
};

export function MappingReview() {
  const [state, action, pending] = useActionState(reviewSchwabMappingAction, null);
  return <section className={styles.section}>
    <h2>Review exact account assignments</h2>
    <p>Paste up to 100 rows. Use full eight-digit Schwab account numbers and original CRM IDs, not names.
      Numbers are used only to derive a stable account key; the preview returns only the last four digits.</p>
    <p><code>account_number,household_sf_id,client_sf_id,scope</code><br />
      Scope is <code>CLIENT</code> or <code>FIRM_OPERATING</code>. Leave the contact empty for a joint household-only link.
      Firm operating rows must leave both IDs empty. Client-owned companies still use CLIENT.</p>
    <form action={action} className={styles.form}>
      <label htmlFor="schwab-csv">Reviewed crosswalk (CSV)</label>
      <textarea id="schwab-csv" name="csv" rows={6} maxLength={32768} required autoComplete="off" spellCheck={false} />
      <button className="btn" type="submit" name="intent" value="preview" disabled={pending}>Preview mappings</button>
    </form>
    {state && state.status !== "preview" && <p role="status">{MESSAGES[state.status]}</p>}
    {state?.status === "preview" && <>
      <h3>Confirm every row before saving</h3>
      <p>Lost Client and other source stages are shown as-is. An explicit mapping does not change CRM status.
        Check the full number in your source before approving: last-four matches are not identity proof.</p>
      <div className={styles.tableWrap}><table><thead><tr>
        <th>Schwab</th><th>Classification</th><th>Contact</th><th>Source household / stage</th><th>Previous decision</th>
      </tr></thead><tbody>{state.rows.map((row) => <tr key={row.accountId}>
        <td>••••{row.accountNumberLast4}</td><td>{row.accountScope}</td>
        <td>{row.clientName ?? (row.accountScope === "CLIENT" ? "Household only" : "Not a client")}<small>{row.clientSfId}</small></td>
        <td>{row.householdName ?? "Firm operating"}<small>{row.householdSfId}</small><small>{row.stage}</small></td>
        <td>{row.previous ? <>{row.previous.accountScope}<small>Contact: {row.previous.clientSfId ?? "none"}</small>
          <small>Household: {row.previous.householdSfId ?? "none"}</small><small>Version {row.previous.version}</small></> : "New mapping"}</td>
      </tr>)}</tbody></table></div>
      <form action={action} className={styles.form}>
        <input type="hidden" name="rows" value={JSON.stringify(state.rows.map(({ accountId, accountNumberLast4, clientSfId, householdSfId, accountScope, version }) =>
          ({ accountId, accountNumberLast4, clientSfId, householdSfId, accountScope, version })))} />
        <label><input type="checkbox" name="confirmed" value="yes" required /> I verified the exact accounts, people, households and firm classification above.</label>
        <button className="btn" type="submit" name="intent" value="save" disabled={pending}>Save reviewed mappings</button>
      </form>
    </>}
  </section>;
}
