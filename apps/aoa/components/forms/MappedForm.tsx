"use client";

import { useEffect, useRef, useState } from "react";
import { Button, Card, CardBody, CardHeader, Pill } from "@/components/ui";
import { mappedInputs, type MappedFormInput, type MappedFormSpec } from "@/lib/forms/mapped-form-spec";
import { formatMappedInput } from "@/lib/forms/mapped-form-validation";
import { formDownloadResponseIssue } from "./ira-beneficiary-ui";
import styles from "./MappedForm.module.css";

type AccountOption = { accountId: string; maskedAccountNumber: string; accountType: string; status: string };
type Issue = { path: string; message: string };

export function MappedForm({ spec, clientId, clientName, accounts }: {
  spec: MappedFormSpec; clientId: string; clientName: string; accounts: AccountOption[];
}) {
  const inputs = mappedInputs(spec);
  const initialFields = () => Object.fromEntries(inputs.filter(input => input.source !== "accountNumber").map(input => [input.key, input.source === "clientName" ? clientName : ""]));
  const [accountId, setAccountId] = useState(accounts[0]?.accountId ?? "");
  const [values, setValues] = useState<Record<string, string>>(initialFields);
  const [confirmAccount, setConfirmAccount] = useState(false);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [generated, setGenerated] = useState(false);
  const [busy, setBusy] = useState(false);
  const activeRequest = useRef<AbortController | null>(null);
  useEffect(() => () => { activeRequest.current?.abort(); activeRequest.current = null; }, []);
  const clearResult = () => { setIssues([]); setGenerated(false); };
  const update = (input: MappedFormInput, value: string) => {
    if (values[input.key] === value) return;
    setValues(previous => ({ ...previous, [input.key]: value }));
    if (input.source === "clientName") setConfirmAccount(false);
    clearResult();
  };

  const generate = async () => {
    if (activeRequest.current) return;
    const controller = new AbortController();
    activeRequest.current = controller;
    setBusy(true); clearResult();
    try {
      const response = await fetch("/api/forms/generate", {
        method: "POST", headers: { "Content-Type": "application/json" }, cache: "no-store",
        signal: controller.signal,
        body: JSON.stringify({ formId: spec.definition.id, clientId, accountIds: [accountId], values: { fields: values, confirmAccount } }),
      });
      const responseIssue = formDownloadResponseIssue({ status: response.status, redirected: response.redirected, contentType: response.headers.get("content-type") });
      if (responseIssue) { setIssues([{ path: "form", message: responseIssue }]); return; }
      if (!response.ok) {
        const payload = await response.json().catch(() => null) as { details?: Issue[] } | null;
        setIssues(payload?.details?.length ? payload.details : [{ path: "form", message: "The form could not be generated. Verify the selected account and try again." }]);
        return;
      }
      const blob = await response.blob();
      if (controller.signal.aborted || activeRequest.current !== controller) return;
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = /filename="([^"]+)"/.exec(response.headers.get("content-disposition") ?? "")?.[1] ?? `${spec.definition.entryPathSegment}.pdf`;
      document.body.appendChild(anchor); anchor.click(); anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
      setGenerated(true);
    } catch { if (!controller.signal.aborted) setIssues([{ path: "form", message: "The form could not be generated. Try again." }]); }
    finally { if (activeRequest.current === controller) { activeRequest.current = null; setBusy(false); } }
  };

  function renderInput(input: MappedFormInput) {
    if (input.source === "accountNumber") return null;
    const sensitive = input.kind === "taxId" || input.kind === "taxIdLast4";
    const issue = issues.find(item => item.path === input.key);
    const errorId = `mapped-${spec.definition.id}-${input.key}-error`;
    return <label className={styles.field} key={input.key}>
      <span className={styles.label}>{input.label} {input.requiredForDraft ? "" : "(optional)"}</span>
      {input.kind === "choice" ? <select aria-label={input.label} aria-invalid={Boolean(issue)} aria-describedby={issue ? errorId : undefined} className={styles.input} disabled={busy} value={values[input.key] ?? ""} onChange={event => update(input, event.target.value)}>
        <option value="">Leave blank for completion</option>
        {input.options?.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select> : <input aria-label={input.label} aria-invalid={Boolean(issue)} aria-describedby={issue ? errorId : undefined} className={styles.input} disabled={busy} value={values[input.key] ?? ""}
        type={sensitive ? "password" : "text"} autoComplete={sensitive ? "new-password" : "off"}
        spellCheck={false}
        inputMode={["taxId", "taxIdLast4", "routing", "date"].includes(input.kind) ? "numeric" : input.kind === "phone" ? "tel" : ["money", "percent"].includes(input.kind) ? "decimal" : "text"}
        placeholder={input.kind === "date" ? "MM/DD/YYYY" : input.kind === "phone" ? "XXX-XXX-XXXX" : undefined}
        onChange={event => update(input, event.target.value)} onBlur={event => update(input, formatMappedInput(input.kind, event.target.value))} />}
      {input.source === "clientName" ? <span className={styles.hint}>AoA name suggestion — verify the legal name against the selected account.</span> : null}
      {input.hint ? <span className={styles.hint}>{input.hint}</span> : null}
      {sensitive ? <span className={styles.hint}>Leave blank for the client if unavailable. No SSN lookup or storage.</span> : null}
      {issue ? <span id={errorId} className={styles.fieldError}>{issue.message}</span> : null}
    </label>;
  }

  return <div className={styles.stack}>
    <div className={styles.notice}>Enter only the information you know and are authorized to use in AoA. Leave the rest for client or CS completion, then review before sending. Generating a form is not approval to sign or submit. Values are not saved to the client profile. No CRM lookup, electronic signing, submission or money movement occurs.</div>
    <Card>
      <CardHeader><h2>Choose the Account</h2><Pill tone="gold">Review Required</Pill></CardHeader>
      <CardBody>
        <label className={styles.field}><span className={styles.label}>{spec.accountLabel}</span>
          <select aria-label={spec.accountLabel} disabled={busy} className={styles.input} value={accountId} onChange={event => {
            setAccountId(event.target.value); setValues(initialFields()); setConfirmAccount(false); clearResult();
          }}>
            {accounts.map(account => <option key={account.accountId} value={account.accountId}>{account.accountType} · {account.maskedAccountNumber} · {account.status || "Status unavailable"}</option>)}
          </select>
          <span className={styles.hint}>The PDF uses the server-verified Apex account number. Changing accounts clears all manual entries.</span>
        </label>
      </CardBody>
    </Card>
    {spec.sections.map(section => {
      const sectionFields = section.fields.filter(input => input.source !== "accountNumber");
      if (!sectionFields.length) return null;
      const entered = sectionFields.filter(input => values[input.key]?.trim()).length;
      return <Card key={section.title}><CardBody><details open={section.collapsed ? issues.some(issue => sectionFields.some(input => input.key === issue.path)) || undefined : true}>
        <summary className={styles.summary}>{section.title}{section.collapsed ? <span className={styles.hint}> · {entered ? `${entered} fields entered` : "Leave blank or enter known details"}</span> : null}</summary>
        {section.description ? <p className={styles.hint}>{section.description}</p> : null}
        <div className={styles.grid}>{section.fields.map(renderInput)}</div>
      </details></CardBody></Card>;
    })}
    <Card><CardHeader><h2>Review and Completion</h2></CardHeader><CardBody>
      <ul className={styles.checklist}>{spec.completionChecklist.map(item => <li key={item}>{item}</li>)}</ul>
      <p className={styles.hint}>Blank PDF fields remain editable. Configure applicable required fields in your signing tool; generating a form does not enforce client completion or confirm eligibility.</p>
      <details><summary>Template and Form Limitations</summary><ul className={styles.checklist}>{spec.definition.warnings.map(item => <li key={item}>{item}</li>)}</ul></details>
      <label className={styles.confirm}><input type="checkbox" checked={confirmAccount} disabled={busy} onChange={event => { setConfirmAccount(event.target.checked); clearResult(); }} /><span>{spec.confirmation}</span></label>
    </CardBody></Card>
    {issues.length ? <ul className={styles.errors} aria-live="polite">{issues.map((issue, index) => <li key={`${issue.path}-${index}`}>{inputs.find(input => input.key === issue.path)?.label ? `${inputs.find(input => input.key === issue.path)!.label}: ` : ""}{issue.message}</li>)}</ul> : null}
    {generated ? <p className={styles.success} role="status">Form downloaded · Client/CS completion and human review required · Values were not saved</p> : null}
    <div className={styles.actions}><span className={styles.hint}>Ready for Human Review only · No signature or submission</span><Button onClick={generate} disabled={busy || !accounts.length}>{busy ? "Generating…" : "Generate PDF"}</Button></div>
  </div>;
}
