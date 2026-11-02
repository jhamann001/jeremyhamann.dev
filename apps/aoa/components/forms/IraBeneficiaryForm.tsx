"use client";

import { useState } from "react";
import { Button, Card, CardBody, CardHeader, Pill } from "@/components/ui";
import { IRA_BENEFICIARY_DEFINITION } from "@/lib/forms/ira-beneficiary-definition";
import { accountHolderNameSource, beneficiaryDraftValues, hasBeneficiaryValues, formDownloadResponseIssue, formatBeneficiaryDateInput, formatBeneficiaryPhoneInput, formatIraBeneficiaryIssue, type EditableBeneficiary, type FieldSource } from "./ira-beneficiary-ui";
import styles from "./IraBeneficiaryForm.module.css";

type AccountOption = {
  accountId: string;
  maskedAccountNumber: string;
  accountType: string;
  status: string;
};

type ApiIssue = { path: string; message: string };

const emptyBeneficiary = (): EditableBeneficiary => ({
  fullName: "",
  relationship: "",
  dateOfBirth: "",
  telephoneNumber: "",
  sharePercentage: "",
  address: "",
  emailAddress: "",
  taxId: "",
});

function FieldLabel({ children, source = "manual" }: { children: React.ReactNode; source?: FieldSource }) {
  return (
    <span className={styles.labelLine}>
      <span>{children}</span>
      <span className={source === "aoa" ? styles.source : styles.manual}>
        {source === "aoa" ? "AoA source" : source === "correction" ? "Manual correction" : source === "client" ? "Required from client" : "Manual"}
      </span>
    </span>
  );
}

function BeneficiaryRow({
  kind,
  index,
  value,
  canRemove,
  needsCompletion,
  onChange,
  onRemove,
}: {
  kind: "Primary" | "Contingent";
  index: number;
  value: EditableBeneficiary;
  canRemove: boolean;
  needsCompletion: boolean;
  onChange: (next: EditableBeneficiary) => void;
  onRemove: () => void;
}) {
  const update = (key: keyof EditableBeneficiary, next: string) =>
    onChange({ ...value, [key]: next });
  const source = (key: keyof EditableBeneficiary): FieldSource =>
    needsCompletion && !value[key].trim() ? "client" : "manual";
  return (
    <div className={styles.beneficiaryRow}>
      <div className={styles.rowTitle}>
        <span>{kind} beneficiary {index + 1}</span>
        {canRemove ? (
          <button type="button" className={styles.remove} onClick={onRemove}>
            Remove
          </button>
        ) : null}
      </div>
      <div className={styles.grid}>
        <label className={styles.field}>
          <FieldLabel source={source("fullName")}>Full legal name</FieldLabel>
          <input className={styles.input} value={value.fullName} onChange={(event) => update("fullName", event.target.value)} autoComplete="off" />
        </label>
        <label className={styles.field}>
          <FieldLabel source={source("relationship")}>Relationship</FieldLabel>
          <input className={styles.input} value={value.relationship} onChange={(event) => update("relationship", event.target.value)} autoComplete="off" />
        </label>
        <label className={styles.field}>
          <FieldLabel source={source("dateOfBirth")}>Date of birth</FieldLabel>
          <input className={styles.input} value={value.dateOfBirth} onChange={(event) => update("dateOfBirth", event.target.value)} onBlur={(event) => { const formatted = formatBeneficiaryDateInput(event.target.value); if (formatted !== value.dateOfBirth) update("dateOfBirth", formatted); }} placeholder="MM/DD/YYYY" inputMode="numeric" autoComplete="off" />
          <span className={styles.fieldHint}>Type 8 digits as MMDDYYYY; slashes are added when you leave this field.</span>
        </label>
        <label className={styles.field}>
          <FieldLabel source={source("telephoneNumber")}>Telephone number</FieldLabel>
          <input className={styles.input} value={value.telephoneNumber} onChange={(event) => update("telephoneNumber", event.target.value)} onBlur={(event) => { const formatted = formatBeneficiaryPhoneInput(event.target.value); if (formatted !== value.telephoneNumber) update("telephoneNumber", formatted); }} placeholder="XXX-XXX-XXXX" inputMode="tel" autoComplete="off" />
          <span className={styles.fieldHint}>10-digit phone numbers are formatted when you leave this field.</span>
        </label>
        <label className={styles.field}>
          <FieldLabel source={source("sharePercentage")}>Share percentage</FieldLabel>
          <input className={styles.input} value={value.sharePercentage} onChange={(event) => update("sharePercentage", event.target.value)} inputMode="numeric" autoComplete="off" />
        </label>
        <label className={styles.field}>
          <FieldLabel source={source("emailAddress")}>Email address</FieldLabel>
          <input className={styles.input} value={value.emailAddress} onChange={(event) => update("emailAddress", event.target.value)} inputMode="email" autoComplete="off" />
        </label>
        <label className={`${styles.field} ${styles.fieldFull}`}>
          <FieldLabel source={source("address")}>Address</FieldLabel>
          <input className={styles.input} value={value.address} onChange={(event) => update("address", event.target.value)} autoComplete="off" />
        </label>
        <label className={styles.field}>
          <FieldLabel source={source("taxId")}>SSN or TIN</FieldLabel>
          <input className={styles.input} type="password" value={value.taxId} onChange={(event) => update("taxId", event.target.value)} inputMode="numeric" autoComplete="new-password" />
          <span className={styles.fieldHint}>Leave blank for the client. Do not enter a partial or masked SSN.</span>
        </label>
      </div>
    </div>
  );
}

function ShareSummary({ rows, kind }: { rows: EditableBeneficiary[]; kind: "Primary" | "Contingent" }) {
  const used = rows.filter(hasBeneficiaryValues);
  if (kind === "Contingent" && used.length === 0) return null;
  const entered = used.map((row) => row.sharePercentage.trim()).filter(Boolean);
  const valid = entered.every((share) => /^\d+$/.test(share) && Number(share) >= 1 && Number(share) <= 100);
  const total = entered.reduce((sum, share) => sum + Number(share), 0);
  return (
    <p className={styles.fieldHint}>
      {entered.length === 0 ? "No percentages entered. " : valid ? `${kind} percentages entered: ${total}%. ` : "Review the entered percentages. "}
      Before signing, {kind.toLowerCase()} shares must total 100%.
      {valid && total <= 100 && (total < 100 || entered.length < used.length)
        ? " The client must complete or confirm the allocation; you can still generate the form."
        : valid && total > 100 ? " Reduce the entered total before generating the form." : ""}
    </p>
  );
}

export function IraBeneficiaryForm({
  clientId,
  clientName,
  accounts,
}: {
  clientId: string;
  clientName: string;
  accounts: AccountOption[];
}) {
  const [accountId, setAccountId] = useState(accounts[0]?.accountId ?? "");
  const [accountHolderName, setAccountHolderName] = useState(clientName);
  const [accountHolderTaxId, setAccountHolderTaxId] = useState("");
  const [certifyNotMarried, setCertifyNotMarried] = useState(false);
  const [primary, setPrimary] = useState<EditableBeneficiary[]>([emptyBeneficiary()]);
  const [contingent, setContingent] = useState<EditableBeneficiary[]>([]);
  const [issues, setIssues] = useState<ApiIssue[]>([]);
  const [generated, setGenerated] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const updateRow = (
    setter: React.Dispatch<React.SetStateAction<EditableBeneficiary[]>>,
    index: number,
    next: EditableBeneficiary,
  ) => { setter((rows) => rows.map((row, rowIndex) => (rowIndex === index ? next : row))); setGenerated(null); };

  const removeRow = (
    setter: React.Dispatch<React.SetStateAction<EditableBeneficiary[]>>,
    index: number,
  ) => { setter((rows) => rows.filter((_, rowIndex) => rowIndex !== index)); setGenerated(null); };

  const generate = async () => {
    setBusy(true);
    setIssues([]);
    setGenerated(null);
    try {
      const response = await fetch("/api/forms/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        cache: "no-store",
        body: JSON.stringify({
          formId: IRA_BENEFICIARY_DEFINITION.id,
          clientId,
          accountIds: [accountId],
          values: {
            accountHolderName,
            accountHolderTaxId,
            certifyNotMarried,
            // The single entry flow permits any known details, including none.
            beneficiaryCompletion: "partial",
            primary: beneficiaryDraftValues(primary),
            contingent: beneficiaryDraftValues(contingent),
          },
        }),
      });
      const responseIssue = formDownloadResponseIssue({
        status: response.status,
        redirected: response.redirected,
        contentType: response.headers.get("content-type"),
      });
      if (responseIssue) {
        setIssues([{ path: "form", message: responseIssue }]);
        return;
      }
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { details?: ApiIssue[] } | null;
        setIssues(payload?.details?.length ? payload.details : [{ path: "form", message: "The form could not be generated" }]);
        return;
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const disposition = response.headers.get("content-disposition") ?? "";
      const filename = /filename="([^"]+)"/.exec(disposition)?.[1] ?? `${IRA_BENEFICIARY_DEFINITION.code}.pdf`;
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
      const state = response.headers.get("x-aoa-review-state");
      const clientCompletionRequired = response.headers.get("x-aoa-client-completion-required") === "true";
      setGenerated(
        clientCompletionRequired
          ? "Form downloaded · Client completion required · Ready for Human Review · Values were not saved"
          : state === "ready_for_human_review"
          ? "Form downloaded · Ready for Human Review · Values were not saved"
          : "Form downloaded · Values were not saved",
      );
    } catch {
      setIssues([{ path: "form", message: "The form could not be generated. Try again." }]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={styles.stack}>
      <div className={styles.notice}>
        Enter the details you know, then download the form for completion and human review. This does not save
        the beneficiary or tax-ID values, create a signature envelope, or submit anything.
        {" "}There is no CRM lookup. Enter only information authorized for use in AoA.
      </div>

      <Card>
        <CardHeader>
          <h2>Account Holder</h2>
          <Pill tone="gray">
            {IRA_BENEFICIARY_DEFINITION.code} · Version {IRA_BENEFICIARY_DEFINITION.version}
          </Pill>
        </CardHeader>
        <CardBody>
          <div className={styles.grid}>
            <label className={styles.field}>
              <FieldLabel source="aoa">IRA account</FieldLabel>
              <select className={styles.select} value={accountId} onChange={(event) => { setAccountId(event.target.value); setAccountHolderTaxId(""); setIssues([]); setGenerated(null); }}>
                {accounts.map((account) => (
                  <option key={account.accountId} value={account.accountId}>
                    {account.accountType} · {account.maskedAccountNumber} · {account.status || "Status unavailable"}
                  </option>
                ))}
              </select>
            </label>
            <label className={styles.field}>
              <FieldLabel source={accountHolderNameSource(clientName, accountHolderName)}>Account-holder name</FieldLabel>
              <input className={styles.input} value={accountHolderName} onChange={(event) => setAccountHolderName(event.target.value)} autoComplete="off" />
              <span className={styles.fieldHint}>Prefilled from the AoA display name. Confirm the legal account-holder name; corrections apply only to this form.</span>
            </label>
            <label className={styles.field}>
              <FieldLabel>Account-holder SSN or TIN (optional)</FieldLabel>
              <input aria-describedby="account-holder-tax-id-hint" className={styles.input} type="password" value={accountHolderTaxId} onChange={(event) => { setAccountHolderTaxId(event.target.value); setGenerated(null); }} inputMode="numeric" autoComplete="new-password" />
              <span id="account-holder-tax-id-hint" className={styles.fieldHint}>Leave blank for the client to complete. Do not enter only the last four digits or a masked SSN. An optional full SSN or TIN is used only for this form and is not saved.</span>
            </label>
          </div>
          {!accountHolderTaxId.trim() ? (
            <div className={styles.clientCompletion}>
              <h3>Account-holder SSN or TIN · Required from client</h3>
              <p>You can generate the form without it. The field will be blank and editable in the PDF, and the client must enter their full SSN or TIN before signing.</p>
              <p className={styles.fieldHint}>Before sending for signature, assign this field to the account holder and make it required in your signing tool. The PDF marker alone does not enforce completion.</p>
            </div>
          ) : null}
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <h2>Primary Beneficiaries</h2>
          <Pill tone="gray">Complete before signing</Pill>
        </CardHeader>
        <CardBody>
          <p className={styles.instructions}>Enter any beneficiary details you know. Leave the rest blank for the client—even all fields. Use each beneficiary’s own information, not the account holder’s.</p>
          <div className={styles.sectionHeader}>
            <h3>Enter Known Details</h3>
            {primary.length < IRA_BENEFICIARY_DEFINITION.limits.primaryBeneficiaries ? (
              <button type="button" className={styles.add} onClick={() => { setPrimary((rows) => [...rows, emptyBeneficiary()]); setGenerated(null); }}>
                Add primary
              </button>
            ) : null}
          </div>
          {primary.map((row, index) => (
            <BeneficiaryRow
              key={`primary-${index}`}
              kind="Primary"
              index={index}
              value={row}
              canRemove={primary.length > 1}
              needsCompletion={hasBeneficiaryValues(row) || (index === 0 && !primary.some(hasBeneficiaryValues))}
              onChange={(next) => updateRow(setPrimary, index, next)}
              onRemove={() => removeRow(setPrimary, index)}
            />
          ))}
          <ShareSummary rows={primary} kind="Primary" />
          <p className={styles.fieldHint}>Before signing, at least one primary beneficiary must be complete. Fields labeled “Required from client” stay blank and editable in the PDF; unused rows can stay blank.</p>
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <h2>Contingent Beneficiaries</h2>
          <Pill tone="gray">Optional · complete used rows before signing</Pill>
        </CardHeader>
        <CardBody>
          <div className={styles.sectionHeader}>
            <h3>{contingent.length === 0 ? "None added" : "Optional"}</h3>
            {contingent.length < IRA_BENEFICIARY_DEFINITION.limits.contingentBeneficiaries ? (
              <button type="button" className={styles.add} onClick={() => { setContingent((rows) => [...rows, emptyBeneficiary()]); setGenerated(null); }}>
                Add contingent
              </button>
            ) : null}
          </div>
          {contingent.map((row, index) => (
            <BeneficiaryRow
              key={`contingent-${index}`}
              kind="Contingent"
              index={index}
              value={row}
              canRemove
              needsCompletion={hasBeneficiaryValues(row)}
              onChange={(next) => updateRow(setContingent, index, next)}
              onRemove={() => removeRow(setContingent, index)}
            />
          ))}
          <ShareSummary rows={contingent} kind="Contingent" />
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <h2>Certification</h2>
        </CardHeader>
        <CardBody>
          <p className={styles.instructions}>Before sending for signature, assign missing fields to the client and make them required in your signing tool. PDF markers do not enforce completion or create a signing envelope.</p>
          <label className={styles.checkLine}>
            <input type="checkbox" checked={certifyNotMarried} onChange={(event) => setCertifyNotMarried(event.target.checked)} />
            <span>The account holder has confirmed “I certify that I am not married.” Leave unchecked unless they explicitly confirm; this does not determine whether spousal consent is required.</span>
          </label>
        </CardBody>
      </Card>

      {issues.length > 0 ? (
        <ul className={styles.errors} aria-live="polite">
          {issues.map((issue, index) => (
            <li key={`${issue.path}-${index}`}>{formatIraBeneficiaryIssue(issue)}</li>
          ))}
        </ul>
      ) : null}

      {generated ? (
        <p className={styles.success} role="status">
          {generated}
        </p>
      ) : null}

      <div className={styles.actions}>
        <p className={styles.actionsNote}>
          Generate with known details only. The client must complete missing fields and confirm beneficiary allocations before signing.
          {!accountHolderTaxId.trim() ? " The account-holder SSN or TIN remains required from the client." : ""}
        </p>
        <Button onClick={generate} disabled={busy || accounts.length === 0}>
          {busy ? "Generating…" : "Generate PDF"}
        </Button>
      </div>
    </div>
  );
}
