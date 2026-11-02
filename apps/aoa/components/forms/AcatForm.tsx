"use client";

import { useState } from "react";
import { Button, Card, CardBody, CardHeader, Pill } from "@/components/ui";
import { ACAT_DEFINITION } from "@/lib/forms/acat-definition";
import { formDownloadResponseIssue } from "./ira-beneficiary-ui";
import styles from "./AcatForm.module.css";

type AccountOption = { accountId: string; maskedAccountNumber: string; accountType: string; status: string };
type Issue = { path: string; message: string };
const issueLabels: Record<string, string> = {
  accountHolderName: "Receiving account title",
  accountHolderTaxId: "Account-holder SSN or TIN",
  confirmAccountTitle: "Account title confirmation",
  accountIds: "Receiving Apex account",
};

export function AcatForm({ clientId, clientName, accounts }: {
  clientId: string; clientName: string; accounts: AccountOption[];
}) {
  const [accountId, setAccountId] = useState(accounts[0]?.accountId ?? "");
  const [accountHolderName, setAccountHolderName] = useState(clientName);
  const [accountHolderTaxId, setAccountHolderTaxId] = useState("");
  const [confirmAccountTitle, setConfirmAccountTitle] = useState(false);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [generated, setGenerated] = useState(false);
  const [busy, setBusy] = useState(false);
  const clearResult = () => { setIssues([]); setGenerated(false); };

  const generate = async () => {
    setBusy(true);
    clearResult();
    try {
      const response = await fetch("/api/forms/generate", {
        method: "POST", headers: { "Content-Type": "application/json" }, cache: "no-store",
        body: JSON.stringify({
          formId: ACAT_DEFINITION.id, clientId, accountIds: [accountId],
          values: { accountHolderName, accountHolderTaxId, confirmAccountTitle },
        }),
      });
      const responseIssue = formDownloadResponseIssue({
        status: response.status, redirected: response.redirected, contentType: response.headers.get("content-type"),
      });
      if (responseIssue) { setIssues([{ path: "form", message: responseIssue }]); return; }
      if (!response.ok) {
        const payload = await response.json().catch(() => null) as { details?: Issue[] } | null;
        setIssues(payload?.details?.length ? payload.details : [{ path: "form", message: "The form could not be generated" }]);
        return;
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const filename = /filename="([^"]+)"/.exec(response.headers.get("content-disposition") ?? "")?.[1] ?? "acat-transfer.pdf";
      const anchor = document.createElement("a");
      anchor.href = url; anchor.download = filename;
      document.body.appendChild(anchor); anchor.click(); anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
      setGenerated(true);
    } catch {
      setIssues([{ path: "form", message: "The form could not be generated. Try again." }]);
    } finally { setBusy(false); }
  };

  return <div className={styles.stack}>
    <div className={styles.notice}>
      Receiving information only. This form is not ready to send until the remaining
      transfer information has been completed and reviewed. No transfer is created or submitted, no signature
      envelope is created, and entered values are not saved. There is no CRM or Transfer Tracker lookup.
      Enter only information authorized for use in AoA.
    </div>
    <Card>
      <CardHeader><h2>Receiving Account Information</h2><Pill tone="gray">ACAT Transfer</Pill></CardHeader>
      <CardBody>
        <div className={styles.grid}>
          <label className={styles.field}>
            <span className={styles.label}>Receiving Apex account <span className={styles.source}>AoA source</span></span>
            <select aria-label="Receiving Apex account" className={styles.input} disabled={busy} value={accountId}
              onChange={event => { setAccountId(event.target.value); setAccountHolderTaxId(""); setConfirmAccountTitle(false); clearResult(); }}>
              {accounts.map(account => <option key={account.accountId} value={account.accountId}>
                {account.accountType} · {account.maskedAccountNumber} · {account.status || "Status unavailable"}
              </option>)}
            </select>
            <span className={styles.hint}>The PDF uses the selected account’s verified Apex number. This list does not confirm transfer eligibility.</span>
          </label>
          <label className={styles.field}>
            <span className={styles.label}>Receiving account title <span className={styles.source}>{accountHolderName === clientName ? "AoA name suggestion" : "Manual correction"}</span></span>
            <input aria-label="Receiving account title" className={styles.input} disabled={busy} value={accountHolderName} autoComplete="off"
              onChange={event => { setAccountHolderName(event.target.value); setConfirmAccountTitle(false); clearResult(); }} />
            <span className={styles.hint}>The client’s display name is a starting point, not a verified legal registration. Confirm the full account title, including joint owners or an entity name.</span>
          </label>
          <label className={styles.field}>
            <span className={styles.label}>Account-holder SSN or TIN (optional) <span className={styles.source}>Manual</span></span>
            <input aria-label="Account-holder SSN or TIN (optional)" className={styles.input} type="password" disabled={busy} value={accountHolderTaxId}
              inputMode="numeric" autoComplete="new-password" onChange={event => { setAccountHolderTaxId(event.target.value); clearResult(); }} />
            <span className={styles.hint}>Leave blank if unavailable. If entered, use the correct tax ID for the receiving account. Required completion must be checked before sending.</span>
          </label>
        </div>
        <label className={styles.confirm}>
          <input type="checkbox" disabled={busy} checked={confirmAccountTitle} onChange={event => { setConfirmAccountTitle(event.target.checked); clearResult(); }} />
          <span>I confirmed the full receiving account title against the account record, including all owners or the entity name.</span>
        </label>
      </CardBody>
    </Card>
    <Card>
      <CardHeader><h2>Before Sending</h2><Pill tone="gold">CS Review Required</Pill></CardHeader>
      <CardBody>
        <ul className={styles.remaining}>
          <li>Delivering account title and number, firm and clearing details, using the current client statement.</li>
          <li>Explicit transfer instructions and any required asset details. No full/partial, in-kind, liquidation or reinvestment choice is selected.</li>
          <li>Any missing tax ID, current statement attachment, and applicable authorization requirements.</li>
          <li>Signatures and signature dates through your existing manual signing process.</li>
        </ul>
        <p className={styles.hint}>All other fields remain blank and editable, including the conditional letter of authorization and office-use sections. Firm-address boxes refer to the delivering firm, not the client’s address.</p>
        <p className={styles.hint}>This uses the blank template already held in the Transfer Tracker, captured for this pilot. Confirm current form and custodian-specific requirements before use; this does not replace the Tracker’s transfer logic.</p>
      </CardBody>
    </Card>
    {issues.length > 0 ? <ul className={styles.errors} aria-live="polite">{issues.map((issue, index) =>
      <li key={`${issue.path}-${index}`}>{issueLabels[issue.path] ? `${issueLabels[issue.path]}: ` : ""}{issue.message}</li>,
    )}</ul> : null}
    {generated ? <p className={styles.success} role="status">Form downloaded · Receiving information only · Complete and review transfer details before sending · Values were not saved</p> : null}
    <div className={styles.actions}>
      <span className={styles.hint}>Ready for Human Review only · No sending, signing or submission</span>
      <Button onClick={generate} disabled={busy || accounts.length === 0}>{busy ? "Generating…" : "Generate PDF"}</Button>
    </div>
  </div>;
}
